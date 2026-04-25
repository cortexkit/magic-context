/**
 * Note nudge state machine.
 *
 * State: idle → (trigger fires + notes exist) → nudged → (any trigger fires again) → nudged → ...
 * Suppression: after a nudge fires, suppress until the NEXT trigger event (any of 3).
 *
 * Triggers:
 *   1. Post-historian completion — compartments just compressed history
 *   2. Post-commit detection — agent committed work, natural boundary
 *   3. Todos complete — agent finished planned work, receptive to deferred items
 *
 * The nudge itself is a short reminder folded into the existing nudge anchor.
 * It does NOT include note content — just a count and "use ctx_note read" hint.
 */

import {
    clearPersistedNoteNudge,
    getNoteLastReadAt,
    getPersistedNoteNudge,
    setPersistedDeliveredNoteNudge,
    setPersistedNoteNudgeTrigger,
    setPersistedNoteNudgeTriggerMessageId,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getReadySmartNotes,
    getSessionNotes,
    type Note,
} from "../../features/magic-context/storage-notes";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";

const NOTE_NUDGE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// In-memory delivery timestamp per session. Doesn't need to survive restart —
// if the app restarts, cooldown resets, which is acceptable.
const lastDeliveredAt = new Map<string, number>();

function getPersistedNoteNudgeDeliveredAt(_db: unknown, sessionId: string): number {
    return lastDeliveredAt.get(sessionId) ?? 0;
}

function recordNoteNudgeDeliveryTime(sessionId: string): void {
    lastDeliveredAt.set(sessionId, Date.now());
}

/**
 * Signal that a trigger event occurred. Call from hook layer when any of the 3 triggers fire.
 */
export function onNoteTrigger(db: Database, sessionId: string, trigger: NoteNudgeTrigger): void {
    setPersistedNoteNudgeTrigger(db, sessionId);
    sessionLog(sessionId, `note-nudge: trigger fired (${trigger}), triggerPending=true`);
}

/**
 * Peek at whether a note nudge should be injected during this transform pass.
 * Returns the nudge text if yes, null if no.
 * Does NOT clear triggerPending — call markNoteNudgeDelivered() after successful placement.
 *
 * @param currentUserMessageId - The latest user message ID in this transform pass.
 *   If it matches the trigger-time message, delivery is deferred to avoid busting
 *   the Anthropic prompt-cache prefix (the trigger fired during the agent's turn,
 *   so injecting into the current user message would mutate cached content).
 * @param projectIdentity - Project identity for resolving ready smart notes.
 * @param noteReadStillVisible - True if the agent currently has a non-stripped
 *   `ctx_note(action="read")` tool call in their visible message context. When
 *   the agent has read the latest note state AND that read is still visible,
 *   the nudge is suppressed (no value re-surfacing what's already on screen).
 *   When the read has been dropped (compactified, ctx_reduce'd, age-cleaned),
 *   the nudge fires again at the next work boundary so the agent regains
 *   visibility into deferred intentions. Caller computes this via
 *   `hasVisibleNoteReadCall(messages)` AFTER drops are materialized.
 */
export function peekNoteNudgeText(
    db: Database,
    sessionId: string,
    currentUserMessageId?: string | null,
    projectIdentity?: string,
    noteReadStillVisible?: boolean,
): string | null {
    const state = getPersistedNoteNudge(db, sessionId);

    if (!state.triggerPending) return null;

    // On first peek after trigger, record the current user message as the
    // trigger-time message. This is filled here (not in onNoteTrigger) because
    // hook callers like tool.execute.after don't have access to the message array.
    if (!state.triggerMessageId && currentUserMessageId) {
        setPersistedNoteNudgeTriggerMessageId(db, sessionId, currentUserMessageId);
        state.triggerMessageId = currentUserMessageId;
    }

    // Defer delivery until a NEW user message arrives after the trigger.
    // Injecting into the trigger-time message would bust the cached prefix.
    if (
        state.triggerMessageId &&
        currentUserMessageId &&
        state.triggerMessageId === currentUserMessageId
    ) {
        sessionLog(
            sessionId,
            `note-nudge: deferring — current user message ${currentUserMessageId} is same as trigger-time message`,
        );
        return null;
    }

    // Suppress if we delivered a nudge recently (within 15 minutes).
    // Prevents the same notes from being re-surfaced on every commit/todo boundary
    // in quick succession during active work.
    // Check unconditionally — a new trigger clears sticky fields, so gating on
    // stickyText presence would let triggers bypass the cooldown window.
    const deliveredAt = getPersistedNoteNudgeDeliveredAt(db, sessionId);
    if (deliveredAt > 0 && Date.now() - deliveredAt < NOTE_NUDGE_COOLDOWN_MS) {
        sessionLog(
            sessionId,
            `note-nudge: suppressing — last delivered ${Math.round((Date.now() - deliveredAt) / 1000)}s ago (cooldown ${NOTE_NUDGE_COOLDOWN_MS / 60000}m)`,
        );
        clearPersistedNoteNudge(db, sessionId);
        return null;
    }

    // Check if there are actually notes to remind about
    const notes = getSessionNotes(db, sessionId);
    const readySmartNotes = projectIdentity ? getReadySmartNotes(db, projectIdentity) : [];
    const totalCount = notes.length + readySmartNotes.length;
    if (totalCount === 0) {
        sessionLog(sessionId, "note-nudge: triggerPending but no notes found, skipping");
        clearPersistedNoteNudge(db, sessionId);
        return null;
    }

    // Suppress only when BOTH conditions hold:
    //   1. The agent already ran ctx_note(read) AFTER the most recent note
    //      activity — they've seen the current note state.
    //   2. That ctx_note(read) tool call is STILL VISIBLE in their message
    //      context (caller passes `noteReadStillVisible` after computing it
    //      against the post-drop messages array).
    //
    // Both must hold because either alone produces wrong behavior:
    //   - Timestamp-only suppression (#1 alone) keeps suppressing forever
    //     once the read result has been compactified, ctx_reduce'd, or
    //     age-cleaned out of context. The agent loses visibility into
    //     deferred intentions and we never re-surface them.
    //   - Visibility-only suppression (#2 alone) re-nudges immediately even
    //     when the agent just read the latest state — pestering them with
    //     content they already see.
    //
    // The combined check is what your original design intended: re-surface
    // notes at work boundaries when the prior read is no longer in front
    // of the agent.
    const lastReadAt = getNoteLastReadAt(db, sessionId);
    if (lastReadAt > 0 && noteReadStillVisible) {
        const mostRecentNoteActivity = maxNoteActivityTime([...notes, ...readySmartNotes]);
        // Strict > so same-millisecond races favor the newer note. If a note
        // write and a ctx_note(read) land in the same ms, we can't tell which
        // happened first; err on the side of surfacing the note once more
        // rather than silently suppressing a potentially new reminder.
        if (mostRecentNoteActivity > 0 && lastReadAt > mostRecentNoteActivity) {
            sessionLog(
                sessionId,
                `note-nudge: suppressing — agent ran ctx_note(read) at ${new Date(
                    lastReadAt,
                ).toISOString()} and the read is still visible; no new notes since ${new Date(
                    mostRecentNoteActivity,
                ).toISOString()}`,
            );
            clearPersistedNoteNudge(db, sessionId);
            return null;
        }
    }

    const parts: string[] = [];
    if (notes.length > 0) {
        parts.push(`${notes.length} deferred note${notes.length === 1 ? "" : "s"}`);
    }
    if (readySmartNotes.length > 0) {
        parts.push(
            `${readySmartNotes.length} ready smart note${readySmartNotes.length === 1 ? "" : "s"}`,
        );
    }
    sessionLog(sessionId, `note-nudge: delivering nudge for ${parts.join(" and ")}`);
    return `You have ${parts.join(" and ")}. Review with ctx_note read — some may be actionable now.`;
}

/**
 * Return the latest `updated_at` or `ready_at` timestamp across a batch of
 * notes. Used to compare against the agent's last ctx_note(read) watermark
 * so we skip nudges when the current note state was already read.
 *
 * `ready_at` matters for smart notes that were pending at read time and just
 * transitioned to ready — even if their `updated_at` happens to be older, the
 * ready transition is new information the agent hasn't seen.
 */
function maxNoteActivityTime(notes: Note[]): number {
    let max = 0;
    for (const note of notes) {
        if (note.updatedAt > max) max = note.updatedAt;
        if (note.readyAt !== null && note.readyAt > max) max = note.readyAt;
    }
    return max;
}

/**
 * Mark the note nudge as delivered after successful placement.
 * Only call after appendReminderToLatestUserMessage returns an anchor (or null if no user message exists).
 */
export function markNoteNudgeDelivered(
    db: Database,
    sessionId: string,
    text: string,
    messageId: string | null,
): void {
    setPersistedDeliveredNoteNudge(db, sessionId, messageId ? text : "", messageId ?? "");
    recordNoteNudgeDeliveryTime(sessionId);
    sessionLog(
        sessionId,
        messageId
            ? `note-nudge: marked delivered, sticky anchor=${messageId}`
            : "note-nudge: marked delivered without anchor",
    );
}

/**
 * Get sticky note nudge for replay on subsequent transform passes.
 * Returns { text, messageId } if a delivered nudge needs re-injection, null otherwise.
 */
export function getStickyNoteNudge(
    db: Database,
    sessionId: string,
): { text: string; messageId: string } | null {
    const state = getPersistedNoteNudge(db, sessionId);
    if (!state.stickyText || !state.stickyMessageId) return null;
    return { text: state.stickyText, messageId: state.stickyMessageId };
}

/**
 * Legacy wrapper — peek + mark in one call.
 * Kept for tests; prefer peekNoteNudgeText + markNoteNudgeDelivered in production.
 */
export function getNoteNudgeText(db: Database, sessionId: string): string | null {
    const text = peekNoteNudgeText(db, sessionId);
    if (text) {
        markNoteNudgeDelivered(db, sessionId, text, null);
    }
    return text;
}

/**
 * Call when session is deleted or notes are read to clear persisted state.
 */
export function clearNoteNudgeState(
    db: Database,
    sessionId: string,
    options?: { persist?: boolean },
): void {
    if (options?.persist !== false) {
        clearPersistedNoteNudge(db, sessionId);
    }
    lastDeliveredAt.delete(sessionId); // also reset in-memory cooldown
}
