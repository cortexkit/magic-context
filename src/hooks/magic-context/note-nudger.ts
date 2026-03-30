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

import type { Database } from "bun:sqlite";
import {
    clearPersistedNoteNudge,
    getPersistedNoteNudge,
    setPersistedDeliveredNoteNudge,
    setPersistedNoteNudgeTrigger,
    setPersistedNoteNudgeTriggerMessageId,
} from "../../features/magic-context/storage-meta-persisted";
import { getSessionNotes } from "../../features/magic-context/storage-notes";
import { getReadySmartNotes } from "../../features/magic-context/storage-smart-notes";
import { sessionLog } from "../../shared/logger";

export type NoteNudgeTrigger = "historian_complete" | "commit_detected" | "todos_complete";

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
 */
export function peekNoteNudgeText(
    db: Database,
    sessionId: string,
    currentUserMessageId?: string | null,
    projectIdentity?: string,
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

    // Check if there are actually notes to remind about
    const notes = getSessionNotes(db, sessionId);
    const readySmartCount = projectIdentity ? getReadySmartNotes(db, projectIdentity).length : 0;
    const totalCount = notes.length + readySmartCount;
    if (totalCount === 0) {
        sessionLog(sessionId, "note-nudge: triggerPending but no notes found, skipping");
        return null;
    }

    const parts: string[] = [];
    if (notes.length > 0) {
        parts.push(`${notes.length} deferred note${notes.length === 1 ? "" : "s"}`);
    }
    if (readySmartCount > 0) {
        parts.push(`${readySmartCount} ready smart note${readySmartCount === 1 ? "" : "s"}`);
    }
    sessionLog(sessionId, `note-nudge: delivering nudge for ${parts.join(" and ")}`);
    return `You have ${parts.join(" and ")}. Review with ctx_note read — some may be actionable now.`;
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
export function clearNoteNudgeState(db: Database, sessionId: string): void {
    clearPersistedNoteNudge(db, sessionId);
}
