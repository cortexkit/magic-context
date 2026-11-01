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
    deliverNoteNudgeAtomic,
    getNoteLastReadAt,
    getNoteNudgeAnchors,
    getPersistedNoteNudge,
    type NoteNudgeDeliveryOutcome,
    setPersistedNoteNudgeTrigger,
    setPersistedNoteNudgeTriggerMessageId,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getReadySmartNotes,
    getSessionNotes,
    type Note,
} from "../../features/magic-context/storage-notes";
import { updateSessionMetaCollection } from "../../features/magic-context/storage-session-collections";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { formatNoteNudge, noteNudgePickIndex, noteTouchedAt } from "../../tools/ctx-note/render";

export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";

export interface NoteNudgeDeliveryEligibility {
    isFirstServe: boolean;
    prefixRewriteCoversAnchor: boolean;
}

// A cold observer cannot prove that its input was never served by an earlier
// plugin version. Seed that window conservatively; only later, unseen live-tail
// users can receive fresh nudges on defer. Retaining every observed user fences
// off earlier users reintroduced by a branch/window change. Observation is read-
// only: replay must not acquire a database write lock just to suppress a nudge.
const observedUsers = new WeakMap<Database, Map<string, Set<string>>>();

export function observeNoteNudgeServe(args: {
    db: Database;
    sessionId: string;
    userMessageIds: readonly string[];
    anchorMessageId: string | null;
    isLiveTail: boolean;
    /** Already changing provider-visible bytes at or before the target user message,
     * without invalidating any signed thinking the request must retain. */
    prefixRewriteCoversAnchor: boolean;
}): NoteNudgeDeliveryEligibility {
    let sessions = observedUsers.get(args.db);
    if (!sessions) {
        sessions = new Map();
        observedUsers.set(args.db, sessions);
    }
    let seen = sessions.get(args.sessionId);
    const warm = seen !== undefined && seen.size > 0;
    if (!seen) seen = new Set();
    const firstServe = args.anchorMessageId !== null && !seen.has(args.anchorMessageId);
    // Reserve before appending or serving anything. An aborted request may miss
    // one nudge rather than changing a message a previous request could have sent.
    for (const id of args.userMessageIds) seen.add(id);
    sessions.set(args.sessionId, seen);
    return {
        isFirstServe: warm && args.isLiveTail && firstServe,
        prefixRewriteCoversAnchor: args.anchorMessageId !== null && args.prefixRewriteCoversAnchor,
    };
}

const NOTE_NUDGE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// In-memory delivery timestamp per session. Deliberately not persisted: after
// a restart the cooldown resets, which can at worst re-surface the nudge once
// early. Entries are useless once the cooldown has passed, so they are pruned
// then; without that the map kept one entry for every session that ever got a
// nudge for the life of the process.
const lastDeliveredAt = new Map<string, number>();

function isCoolingDown(deliveredAt: number, now: number): boolean {
    return now - deliveredAt < NOTE_NUDGE_COOLDOWN_MS;
}

function getNoteNudgeDeliveredAt(sessionId: string): number {
    const deliveredAt = lastDeliveredAt.get(sessionId);
    if (deliveredAt === undefined) return 0;
    if (!isCoolingDown(deliveredAt, Date.now())) {
        lastDeliveredAt.delete(sessionId);
        return 0;
    }
    return deliveredAt;
}

export function recordNoteNudgeDeliveryTime(sessionId: string): void {
    const now = Date.now();
    for (const [otherSessionId, deliveredAt] of lastDeliveredAt) {
        if (!isCoolingDown(deliveredAt, now)) lastDeliveredAt.delete(otherSessionId);
    }
    lastDeliveredAt.set(sessionId, now);
}

/** Number of sessions holding a cooldown entry; for tests. */
export function getNoteNudgeCooldownCountForTest(): number {
    return lastDeliveredAt.size;
}

/**
 * Signal that a trigger event occurred. Call from hook layer when any of the 3 triggers fire.
 */
export function onNoteTrigger(db: Database, sessionId: string, trigger: NoteNudgeTrigger): void {
    let transactionStartedAt = 0;
    db.transaction(() => {
        transactionStartedAt = performance.now();
        setPersistedNoteNudgeTrigger(db, sessionId);
    }).immediate();
    logSlowWriteTransaction("note_nudge_trigger", transactionStartedAt);
    sessionLog(sessionId, `note-nudge: trigger fired (${trigger}), triggerPending=true`);
}

/**
 * Peek at whether a note nudge should be injected during this transform pass.
 * Returns the nudge text if yes, null if no.
 * Does NOT clear triggerPending — call markNoteNudgeDelivered() after successful placement.
 *
 * @param currentUserMessageId - The user message that will receive the nudge.
 * @param eligibility - Hosts must supply first-serve/covering-rewrite evidence from
 *   observeNoteNudgeServe on every pass. Trigger-time deferral is retained only
 *   for legacy callers that do not have a wire window.
 * @param projectIdentity - Project identity for resolving ready smart notes.
 * @param noteReadStillVisible - True if the agent currently has a non-stripped
 *   `ctx_note(action="read")` tool call in their visible message context. When
 *   the agent has read the latest note state AND that read is still visible,
 *   the nudge is suppressed (no value re-surfacing what's already on screen).
 *   When the read has been dropped (compactified, ctx_reduce'd, age-cleaned),
 *   the nudge fires again at the next work boundary so the agent regains
 *   visibility into deferred intentions. Caller computes this via
 *   `hasVisibleNoteReadCall(messages)` AFTER drops are materialized.
 * @param projectLookupUnavailable - Keep undisplayed work pending when project
 *   notes cannot be read and no session note can be delivered.
 */
export function peekNoteNudgeText(
    db: Database,
    sessionId: string,
    currentUserMessageId?: string | null,
    projectIdentity?: string,
    noteReadStillVisible?: boolean,
    eligibility?: NoteNudgeDeliveryEligibility,
    projectLookupUnavailable = false,
): string | null {
    const state = getPersistedNoteNudge(db, sessionId);

    if (!state.triggerPending) return null;

    // Trigger-time identity is not evidence of first serve. In particular a
    // rebuilt/tagged window may resolve a different user than the raw window.
    // Hosts observe every pass, including those with no pending trigger.
    if (eligibility && !eligibility.isFirstServe && !eligibility.prefixRewriteCoversAnchor) {
        sessionLog(
            sessionId,
            "note-nudge: deferring — user already served or first serve unproven",
        );
        return null;
    }

    // On first peek after trigger, record the current user message as the
    // trigger-time message. This is filled here (not in onNoteTrigger) because
    // hook callers like tool.execute.after don't have access to the message array.
    if (!eligibility && !state.triggerMessageId && currentUserMessageId) {
        setPersistedNoteNudgeTriggerMessageId(db, sessionId, currentUserMessageId);
        state.triggerMessageId = currentUserMessageId;
    }

    // Defer delivery until a NEW user message arrives after the trigger.
    // Injecting into the trigger-time message would bust the cached prefix.
    if (
        !eligibility &&
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
    const deliveredAt = getNoteNudgeDeliveredAt(sessionId);
    if (deliveredAt > 0) {
        sessionLog(
            sessionId,
            `note-nudge: suppressing — last delivered ${Math.round((Date.now() - deliveredAt) / 1000)}s ago (cooldown ${NOTE_NUDGE_COOLDOWN_MS / 60000}m)`,
        );
        clearNoteNudgeTriggerOnly(db, sessionId);
        return null;
    }

    // Check if there are actually notes to remind about
    const notes = getSessionNotes(db, sessionId);
    const readySmartNotes = projectIdentity ? getReadySmartNotes(db, projectIdentity) : [];
    const totalCount = notes.length + readySmartNotes.length;
    // An unavailable project scope is not evidence that there are no notes.
    if (projectLookupUnavailable && totalCount === 0) return null;
    if (totalCount === 0) {
        sessionLog(sessionId, "note-nudge: triggerPending but no notes found, skipping");
        clearNoteNudgeTriggerOnly(db, sessionId);
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
            clearNoteNudgeTriggerOnly(db, sessionId);
            return null;
        }
    }

    const failureNotice = notes.find((note) =>
        /^Smart note #\d+ cannot be checked\.\nCondition: /.test(note.content),
    );
    if (failureNotice) {
        const reason =
            failureNotice.content.split("\nReason: ")[1]?.split("\n")[0] ?? "check unavailable";
        return `Smart note check unavailable: ${reason}. Read ctx_note #${failureNotice.id} for the condition and repair instructions; this is NOT evidence that the condition is met.`;
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
    return formatNoteNudge({
        readyCount: readySmartNotes.length,
        activeCount: notes.length,
        oldestActiveTouchedAt: oldestTouchedAt(notes),
        shown: pickNudgeNote({ db, sessionId, activeNotes: notes, readySmartNotes }),
        nowMs: Date.now(),
    });
}

/** The oldest `updated_at` (or `created_at` when never updated) across a batch
 *  of notes, or null when the batch is empty. */
function oldestTouchedAt(notes: Note[]): number | null {
    return notes.reduce<number | null>((min, note) => {
        const touchedAt = noteTouchedAt(note);
        return min === null || touchedAt < min ? touchedAt : min;
    }, null);
}

/**
 * The note the nudge shows a title for. Ready smart notes are the pool when any
 * exist — they are the ones the agent can act on now. Otherwise the pool is the
 * active session notes ordered by id, and the stateless pick walks that pool so
 * successive nudges surface different notes.
 *
 * The pick is a pure function of the session id and the delivery counter, so a
 * delivery that is replayed later renders the same bytes: the text is stored
 * with its anchor and never recomputed on replay.
 */
function pickNudgeNote(args: {
    db: Database;
    sessionId: string;
    activeNotes: Note[];
    readySmartNotes: Note[];
}): Note | null {
    const pool =
        args.readySmartNotes.length > 0
            ? [...args.readySmartNotes].sort((left, right) => left.id - right.id)
            : [...args.activeNotes].sort((left, right) => left.id - right.id);
    if (pool.length === 0) return null;
    // The persisted delivery record is the counter: one anchor per delivered
    // nudge, so the first delivery picks with 0 and the next with 1. No new
    // column, and the value is stable across the peeks that precede delivery.
    const counter = getNoteNudgeAnchors(args.db, args.sessionId).length;
    return pool[noteNudgePickIndex(args.sessionId, counter, pool.length)] ?? null;
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
): NoteNudgeDeliveryOutcome {
    if (!messageId) {
        clearNoteNudgeTriggerAndCooldown(db, sessionId);
        sessionLog(sessionId, "note-nudge: marked delivered without anchor");
        return { ok: true, kind: "already-present" };
    }

    const outcome = db
        .transaction(() => {
            const delivered = deliverNoteNudgeAtomic(db, sessionId, messageId, text);
            // Both hosts persist the instruction envelope, not the bare nudge.
            // Match its contents so a delivered warning is acknowledged instead
            // of being selected again at every later work boundary.
            const nudgeText = text?.replace(/^\s*<instruction name="deferred_notes">/, "") ?? "";
            const noticeId = nudgeText.match(
                /^Smart note check unavailable: [\s\S]*Read ctx_note #(\d+) for the condition/,
            );
            if (delivered.ok && noticeId) {
                // A persisted anchor is the receipt. Acknowledge the separate failure
                // notice, never the pending smart note whose condition is still unmet.
                db.prepare(`UPDATE notes SET status = 'dismissed', updated_at = ?
                WHERE id = ? AND type = 'session' AND session_id = ?
                  AND content LIKE 'Smart note #% cannot be checked.%'`).run(
                    Date.now(),
                    Number(noticeId[1]),
                    sessionId,
                );
            }
            return delivered;
        })
        .immediate();
    if (outcome.ok) {
        recordNoteNudgeDeliveryTime(sessionId);
    }
    sessionLog(
        sessionId,
        outcome.ok
            ? `note-nudge: marked delivered, sticky anchor=${messageId} (${outcome.kind})`
            : `note-nudge: delivery not persisted for anchor=${messageId} (${outcome.kind})`,
    );
    return outcome;
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
        clearAllNoteNudgeState(db, sessionId);
    }
    lastDeliveredAt.delete(sessionId); // also reset in-memory cooldown
    observedUsers.get(db)?.delete(sessionId);
}

export function clearAllNoteNudgeState(db: Database, sessionId: string): void {
    db.transaction(() => {
        updateSessionMetaCollection(db, sessionId, "note_nudge_anchors", "[]");
        db.prepare(
            `UPDATE session_meta
             SET note_nudge_trigger_pending = 0,
                 note_nudge_trigger_message_id = '',
                 note_nudge_sticky_text = '',
                 note_nudge_sticky_message_id = ''
             WHERE session_id = ?`,
        ).run(sessionId);
    }).immediate();
    lastDeliveredAt.delete(sessionId);
}

export function clearNoteNudgeTriggerAndCooldown(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
    lastDeliveredAt.delete(sessionId);
}

export function resetNoteNudgeCooldownOnly(sessionId: string): void {
    lastDeliveredAt.delete(sessionId);
}

export function clearNoteNudgeTriggerOnly(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}
