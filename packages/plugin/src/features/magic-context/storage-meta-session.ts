import type { Database } from "bun:sqlite";
import { clearIndexedMessages } from "./message-index";
import {
    BOOLEAN_META_KEYS,
    ensureSessionMetaRow,
    getDefaultSessionMeta,
    isSessionMetaRow,
    META_COLUMNS,
    toSessionMeta,
} from "./storage-meta-shared";
import type { SessionMeta } from "./types";

export function getOrCreateSessionMeta(db: Database, sessionId: string): SessionMeta {
    const result = db
        .prepare(
            "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, times_execute_threshold_reached, compartment_in_progress, system_prompt_hash, system_prompt_tokens, cleared_reasoning_through_tag FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);

    if (isSessionMetaRow(result)) {
        return toSessionMeta(result);
    }

    const defaults = getDefaultSessionMeta(sessionId);
    ensureSessionMetaRow(db, sessionId);
    return defaults;
}

export function updateSessionMeta(
    db: Database,
    sessionId: string,
    updates: Partial<SessionMeta>,
): void {
    const setClauses: string[] = [];
    const values: Array<string | number> = [];

    for (const [key, column] of Object.entries(META_COLUMNS)) {
        const value = updates[key as keyof SessionMeta];
        if (value === undefined) continue;

        if (value === null) {
            setClauses.push(`${column} = ?`);
            values.push("");
        } else if (BOOLEAN_META_KEYS.has(key)) {
            setClauses.push(`${column} = ?`);
            values.push(value ? 1 : 0);
        } else if (typeof value === "string" || typeof value === "number") {
            setClauses.push(`${column} = ?`);
            values.push(value);
        }
    }

    if (setClauses.length === 0) {
        return;
    }

    db.transaction(() => {
        ensureSessionMetaRow(db, sessionId);
        db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")} WHERE session_id = ?`).run(
            ...values,
            sessionId,
        );
    })();
}

export function clearSession(db: Database, sessionId: string): void {
    db.transaction(() => {
        db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM source_contents WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_notes WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        clearIndexedMessages(db, sessionId);
    })();
}
