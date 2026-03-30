import type { Database } from "bun:sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";
import type { ContextUsage } from "./types";

interface PersistedUsageRow {
    last_context_percentage: number;
    last_input_tokens: number;
    last_response_time: number;
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

function isPersistedUsageRow(row: unknown): row is PersistedUsageRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.last_context_percentage === "number" &&
        typeof r.last_input_tokens === "number" &&
        typeof r.last_response_time === "number"
    );
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

function getDefaultPersistedNoteNudge(): PersistedNoteNudge {
    return {
        triggerPending: false,
        triggerMessageId: null,
        stickyText: null,
        stickyMessageId: null,
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
