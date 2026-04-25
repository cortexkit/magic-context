import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import type { ContextUsage } from "./types";

interface PersistedUsageRow {
    last_context_percentage: number;
    last_input_tokens: number;
    last_response_time: number;
}

interface PersistedReasoningWatermarkRow {
    cleared_reasoning_through_tag: number;
}

interface PersistedNudgePlacementRow {
    nudge_anchor_message_id: string;
    nudge_anchor_text: string;
}

interface PersistedStickyTurnReminderRow {
    sticky_turn_reminder_text: string;
    sticky_turn_reminder_message_id: string;
}

interface PersistedNoteNudgeRow {
    note_nudge_trigger_pending: number;
    note_nudge_trigger_message_id: string;
    note_nudge_sticky_text: string;
    note_nudge_sticky_message_id: string;
}

interface PersistedHistorianFailureRow {
    historian_failure_count: number;
    historian_last_error: string | null;
    historian_last_failure_at: number | null;
}

export interface PersistedStickyTurnReminder {
    text: string;
    messageId: string | null;
}

export interface PersistedNoteNudge {
    triggerPending: boolean;
    triggerMessageId: string | null;
    stickyText: string | null;
    stickyMessageId: string | null;
}

export interface PersistedHistorianFailureState {
    failureCount: number;
    lastError: string | null;
    lastFailureAt: number | null;
}

function isPersistedUsageRow(row: unknown): row is PersistedUsageRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        typeof r.last_response_time === "number"
    );
}

function isPersistedReasoningWatermarkRow(row: unknown): row is PersistedReasoningWatermarkRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.cleared_reasoning_through_tag === "number";
}

function isPersistedNudgePlacementRow(row: unknown): row is PersistedNudgePlacementRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.nudge_anchor_message_id === "string" && typeof r.nudge_anchor_text === "string";
}

function isPersistedStickyTurnReminderRow(row: unknown): row is PersistedStickyTurnReminderRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.sticky_turn_reminder_text === "string" &&
        typeof r.sticky_turn_reminder_message_id === "string"
    );
}

function isPersistedNoteNudgeRow(row: unknown): row is PersistedNoteNudgeRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.note_nudge_trigger_pending === "number" &&
        typeof r.note_nudge_trigger_message_id === "string" &&
        typeof r.note_nudge_sticky_text === "string" &&
        typeof r.note_nudge_sticky_message_id === "string"
    );
}

function isPersistedHistorianFailureRow(row: unknown): row is PersistedHistorianFailureRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.historian_failure_count === "number" &&
        (typeof r.historian_last_error === "string" || r.historian_last_error === null) &&
        (typeof r.historian_last_failure_at === "number" || r.historian_last_failure_at === null)
    );
}

function getDefaultPersistedNoteNudge(): PersistedNoteNudge {
    return {
        triggerPending: false,
        triggerMessageId: null,
        stickyText: null,
        stickyMessageId: null,
    };
}

function getDefaultHistorianFailureState(): PersistedHistorianFailureState {
    return {
        failureCount: 0,
        lastError: null,
        lastFailureAt: null,
    };
}

export function loadPersistedUsage(
    db: Database,
    sessionId: string,
): { usage: ContextUsage; updatedAt: number } | null {
    const result = db
        .prepare(
            "SELECT last_context_percentage, last_input_tokens, last_response_time FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (
        !isPersistedUsageRow(result) ||
        (result.last_context_percentage === 0 && result.last_input_tokens === 0)
    ) {
        return null;
    }

    return {
        usage: {
            percentage: result.last_context_percentage,
            inputTokens: result.last_input_tokens,
        },
        updatedAt: result.last_response_time || Date.now(),
    };
}

export function getPersistedReasoningWatermark(db: Database, sessionId: string): number {
    const result = db
        .prepare("SELECT cleared_reasoning_through_tag FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    return isPersistedReasoningWatermarkRow(result) ? result.cleared_reasoning_through_tag : 0;
}

export function setPersistedReasoningWatermark(
    db: Database,
    sessionId: string,
    tagNumber: number,
): void {
    ensureSessionMetaRow(db, sessionId);
    db.prepare(
        "UPDATE session_meta SET cleared_reasoning_through_tag = ? WHERE session_id = ?",
    ).run(tagNumber, sessionId);
}

/**
 * Reset the persisted reasoning watermark for a session.
 *
 * The watermark is model-specific because non-interleaved models may safely
 * rewrite/remove typed reasoning parts while providers that expose
 * `capabilities.interleaved.field` need those same parts to survive until
 * OpenCode's provider transform serializes them onto the wire.
 */
export function clearPersistedReasoningWatermark(db: Database, sessionId: string): void {
    setPersistedReasoningWatermark(db, sessionId, 0);
}

export function getPersistedNudgePlacement(
    db: Database,
    sessionId: string,
): { messageId: string; nudgeText: string } | null {
    const result = db
        .prepare(
            "SELECT nudge_anchor_message_id, nudge_anchor_text FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedNudgePlacementRow(result)) {
        return null;
    }

    if (result.nudge_anchor_message_id.length === 0 || result.nudge_anchor_text.length === 0) {
        return null;
    }

    return {
        messageId: result.nudge_anchor_message_id,
        nudgeText: result.nudge_anchor_text,
    };
}

export function setPersistedNudgePlacement(
    db: Database,
    sessionId: string,
    messageId: string,
    nudgeText: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET nudge_anchor_message_id = ?, nudge_anchor_text = ? WHERE session_id = ?",
        ).run(messageId, nudgeText, sessionId);
    })();
}

export function clearPersistedNudgePlacement(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET nudge_anchor_message_id = '', nudge_anchor_text = '' WHERE session_id = ?",
    ).run(sessionId);
}

export function getPersistedStickyTurnReminder(
    db: Database,
    sessionId: string,
): PersistedStickyTurnReminder | null {
    const result = db
        .prepare(
            "SELECT sticky_turn_reminder_text, sticky_turn_reminder_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedStickyTurnReminderRow(result)) {
        return null;
    }

    if (result.sticky_turn_reminder_text.length === 0) {
        return null;
    }

    return {
        text: result.sticky_turn_reminder_text,
        messageId:
            result.sticky_turn_reminder_message_id.length > 0
                ? result.sticky_turn_reminder_message_id
                : null,
    };
}

export function setPersistedStickyTurnReminder(
    db: Database,
    sessionId: string,
    text: string,
    messageId = "",
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET sticky_turn_reminder_text = ?, sticky_turn_reminder_message_id = ? WHERE session_id = ?",
        ).run(text, messageId, sessionId);
    })();
}

export function clearPersistedStickyTurnReminder(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET sticky_turn_reminder_text = '', sticky_turn_reminder_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}

export function getPersistedNoteNudge(db: Database, sessionId: string): PersistedNoteNudge {
    const result = db
        .prepare(
            "SELECT note_nudge_trigger_pending, note_nudge_trigger_message_id, note_nudge_sticky_text, note_nudge_sticky_message_id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedNoteNudgeRow(result)) {
        return getDefaultPersistedNoteNudge();
    }

    return {
        triggerPending: result.note_nudge_trigger_pending === 1,
        triggerMessageId:
            result.note_nudge_trigger_message_id.length > 0
                ? result.note_nudge_trigger_message_id
                : null,
        stickyText: result.note_nudge_sticky_text.length > 0 ? result.note_nudge_sticky_text : null,
        stickyMessageId:
            result.note_nudge_sticky_message_id.length > 0
                ? result.note_nudge_sticky_message_id
                : null,
    };
}

export function setPersistedNoteNudgeTrigger(
    db: Database,
    sessionId: string,
    triggerMessageId = "",
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_pending = 1, note_nudge_trigger_message_id = ?, note_nudge_sticky_text = '', note_nudge_sticky_message_id = '' WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function setPersistedNoteNudgeTriggerMessageId(
    db: Database,
    sessionId: string,
    triggerMessageId: string,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_message_id = ? WHERE session_id = ?",
        ).run(triggerMessageId, sessionId);
    })();
}

export function setPersistedDeliveredNoteNudge(
    db: Database,
    sessionId: string,
    text: string,
    messageId = "",
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '', note_nudge_sticky_text = ?, note_nudge_sticky_message_id = ? WHERE session_id = ?",
        ).run(text, messageId, sessionId);
    })();
}

export function clearPersistedNoteNudge(db: Database, sessionId: string): void {
    db.prepare(
        "UPDATE session_meta SET note_nudge_trigger_pending = 0, note_nudge_trigger_message_id = '', note_nudge_sticky_text = '', note_nudge_sticky_message_id = '' WHERE session_id = ?",
    ).run(sessionId);
}

/**
 * Return the timestamp of the most recent ctx_note(read) call for this session,
 * or 0 when the session has never called it. Used by note-nudger to suppress
 * reminders when the agent has already seen notes in recent context.
 */
export function getNoteLastReadAt(db: Database, sessionId: string): number {
    try {
        const result = db
            .prepare("SELECT note_last_read_at FROM session_meta WHERE session_id = ?")
            .get(sessionId);
        if (!result || typeof result !== "object") return 0;
        const value = (result as { note_last_read_at?: unknown }).note_last_read_at;
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
        // Column may not exist yet on a DB that hasn't gone through
        // ensureColumn (e.g. minimal test schemas). The watermark is a
        // suppression hint, not required for correctness — return 0 so
        // the nudge flow proceeds as if ctx_note(read) has never been called.
        return 0;
    }
}

/**
 * Record that ctx_note(read) was just called for this session. The watermark is
 * compared against note updated_at / created_at on each nudge decision.
 */
export function setNoteLastReadAt(db: Database, sessionId: string, at = Date.now()): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET note_last_read_at = ? WHERE session_id = ?").run(
            at,
            sessionId,
        );
    })();
}

export function getHistorianFailureState(
    db: Database,
    sessionId: string,
): PersistedHistorianFailureState {
    const result = db
        .prepare(
            "SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (!isPersistedHistorianFailureRow(result)) {
        return getDefaultHistorianFailureState();
    }

    return {
        failureCount: result.historian_failure_count,
        lastError:
            typeof result.historian_last_error === "string" &&
            result.historian_last_error.length > 0
                ? result.historian_last_error
                : null,
        lastFailureAt:
            typeof result.historian_last_failure_at === "number"
                ? result.historian_last_failure_at
                : null,
    };
}

export function incrementHistorianFailure(db: Database, sessionId: string, error: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        const current = getHistorianFailureState(db, sessionId);
        const nextCount = current.failureCount + 1;
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = ?, historian_last_error = ?, historian_last_failure_at = ? WHERE session_id = ?",
        ).run(nextCount, error, Date.now(), sessionId);
        // Normalize error to single line for log greppability
        const reason = error.replace(/\s+/g, " ").trim().slice(0, 300);
        sessionLog(sessionId, `historian failure recorded: count=${nextCount} reason="${reason}"`);
    })();
}

export function clearHistorianFailureState(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET historian_failure_count = 0, historian_last_error = NULL, historian_last_failure_at = NULL WHERE session_id = ?",
        ).run(sessionId);
    })();
}

// ── Overflow detection state ──
//
// When a provider returns a context-overflow error, we persist two signals:
//   - detected_context_limit: the real limit reported in the error (when we
//     can parse one). Used as the highest-priority source in the context
//     limit resolver — the model itself is more authoritative than models.dev.
//   - needs_emergency_recovery: a one-shot flag that tells the next transform
//     pass to enter the 95% emergency recovery path (block, abort current
//     request, fire historian + aggressive drops) even if pressure math says
//     we are below 95%. Cleared once recovery succeeds or session is cleared.

export interface PersistedOverflowState {
    /** Provider-reported context limit from the overflow error; 0 means none detected. */
    detectedContextLimit: number;
    /** True while recovery is still required after an overflow. */
    needsEmergencyRecovery: boolean;
}

export function getOverflowState(db: Database, sessionId: string): PersistedOverflowState {
    const result = db
        .prepare(
            "SELECT detected_context_limit, needs_emergency_recovery FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | { detected_context_limit?: number; needs_emergency_recovery?: number }
        | undefined;
    if (!result) {
        return { detectedContextLimit: 0, needsEmergencyRecovery: false };
    }
    const limit =
        typeof result.detected_context_limit === "number" && result.detected_context_limit > 0
            ? result.detected_context_limit
            : 0;
    const needs =
        typeof result.needs_emergency_recovery === "number" && result.needs_emergency_recovery > 0;
    return { detectedContextLimit: limit, needsEmergencyRecovery: needs };
}

/**
 * Record that a provider reported an overflow. Sets the recovery flag
 * unconditionally; also persists the real limit if one was extracted from the
 * error message. Transactional so the two fields always agree.
 */
export function recordOverflowDetected(
    db: Database,
    sessionId: string,
    reportedLimit: number | undefined,
): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        if (typeof reportedLimit === "number" && reportedLimit > 0) {
            db.prepare(
                "UPDATE session_meta SET detected_context_limit = ?, needs_emergency_recovery = 1 WHERE session_id = ?",
            ).run(reportedLimit, sessionId);
        } else {
            db.prepare(
                "UPDATE session_meta SET needs_emergency_recovery = 1 WHERE session_id = ?",
            ).run(sessionId);
        }
    })();
}

/**
 * Record the real provider-reported context limit WITHOUT arming emergency
 * recovery. Used for subagent overflow: the limit is useful data for accurate
 * pressure math (consumed by `resolveContextLimit()` via `getOverflowState()`),
 * but subagents can't run historian so the recovery flag would be orphan state.
 */
export function recordDetectedContextLimit(
    db: Database,
    sessionId: string,
    reportedLimit: number,
): void {
    if (!(reportedLimit > 0)) return;
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET detected_context_limit = ? WHERE session_id = ?").run(
            reportedLimit,
            sessionId,
        );
    })();
}

/** Clear the recovery flag. Keeps the detected limit (valuable even after recovery). */
export function clearEmergencyRecovery(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET needs_emergency_recovery = 0 WHERE session_id = ?").run(
            sessionId,
        );
    })();
}

/**
 * Clear the detected limit. Called when the session switches to a different
 * model — the old limit is no longer relevant.
 */
export function clearDetectedContextLimit(db: Database, sessionId: string): void {
    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare("UPDATE session_meta SET detected_context_limit = 0 WHERE session_id = ?").run(
            sessionId,
        );
    })();
}

// ── Compaction marker state ──

export interface PersistedCompactionMarkerState {
    boundaryMessageId: string;
    summaryMessageId: string;
    compactionPartId: string;
    summaryPartId: string;
    /** The raw ordinal at which the boundary was set */
    boundaryOrdinal: number;
}

export function getPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
): PersistedCompactionMarkerState | null {
    const row = db
        .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { compaction_marker_state?: string } | null;
    const raw = row?.compaction_marker_state;
    if (!raw || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.boundaryMessageId === "string" &&
            typeof parsed.summaryMessageId === "string" &&
            typeof parsed.compactionPartId === "string" &&
            typeof parsed.summaryPartId === "string" &&
            typeof parsed.boundaryOrdinal === "number"
        ) {
            return parsed as PersistedCompactionMarkerState;
        }
    } catch {
        // Intentional: corrupt JSON → treat as empty
    }
    return null;
}

export function setPersistedCompactionMarkerState(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    const json = state ? JSON.stringify(state) : "";
    db.prepare("UPDATE session_meta SET compaction_marker_state = ? WHERE session_id = ?").run(
        json,
        sessionId,
    );
}

// ── Stripped placeholder message IDs ──

export function getStrippedPlaceholderIds(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT stripped_placeholder_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { stripped_placeholder_ids?: string } | null;
    const raw = row?.stripped_placeholder_ids;
    if (!raw || raw.length === 0) return new Set();
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return new Set(parsed.filter((v: unknown) => typeof v === "string"));
    } catch {
        // Intentional: corrupt JSON → treat as empty
    }
    return new Set();
}

export function setStrippedPlaceholderIds(db: Database, sessionId: string, ids: Set<string>): void {
    ensureSessionMetaRow(db, sessionId);
    const json = ids.size > 0 ? JSON.stringify([...ids]) : "";
    db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(
        json,
        sessionId,
    );
}

export function removeStrippedPlaceholderId(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    const ids = getStrippedPlaceholderIds(db, sessionId);
    if (!ids.delete(messageId)) {
        return false;
    }

    setStrippedPlaceholderIds(db, sessionId, ids);
    return true;
}
