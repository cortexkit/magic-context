import type { Database } from "../../shared/sqlite";

/**
 * SQLite-backed message bus for TUI ↔ server plugin communication.
 *
 * Both the server plugin and TUI plugin share the same `context.db`.
 * Messages are written by one side and consumed by the other via polling.
 *
 * Directions:
 *   - "server_to_tui": Server sends toasts, dialogs, state updates to TUI
 *   - "tui_to_server": TUI sends dialog confirmations, action triggers to server
 *
 * Message types:
 *   - "toast": Show a toast notification { message, variant?, duration? }
 *   - "dialog_confirm": Show a confirmation dialog { id, title, message }
 *   - "dialog_result": TUI response to a dialog { id, confirmed }
 *   - "state_update": State change hint { key, value }
 *
 * Messages are auto-cleaned after 5 minutes to prevent table bloat.
 */

export type MessageDirection = "server_to_tui" | "tui_to_server";

export type MessageType = "toast" | "dialog_confirm" | "dialog_result" | "state_update" | "action";

export interface PluginMessage {
    id: number;
    direction: MessageDirection;
    type: MessageType;
    payload: Record<string, unknown>;
    sessionId: string | null;
    createdAt: number;
    consumedAt: number | null;
}

interface PluginMessageRow {
    id: number;
    direction: string;
    type: string;
    payload: string;
    session_id: string | null;
    created_at: number;
    consumed_at: number | null;
}

function isPluginMessageRow(row: unknown): row is PluginMessageRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.direction === "string" &&
        typeof r.type === "string" &&
        typeof r.payload === "string" &&
        typeof r.created_at === "number"
    );
}

function toPluginMessage(row: PluginMessageRow): PluginMessage {
    let payload: Record<string, unknown> = {};
    try {
        payload = JSON.parse(row.payload);
    } catch {
        // Intentional: malformed payload treated as empty
    }
    return {
        id: row.id,
        direction: row.direction as MessageDirection,
        type: row.type as MessageType,
        payload,
        sessionId: row.session_id,
        createdAt: row.created_at,
        consumedAt: row.consumed_at,
    };
}

/** Auto-cleanup threshold: messages older than 5 minutes are deleted on consume */
const CLEANUP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Send a message from server to TUI.
 */
export function sendToTui(
    db: Database,
    type: MessageType,
    payload: Record<string, unknown>,
    sessionId?: string,
): number {
    const result = db
        .prepare(
            "INSERT INTO plugin_messages (direction, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("server_to_tui", type, JSON.stringify(payload), sessionId ?? null, Date.now());
    return Number(result.lastInsertRowid);
}

/**
 * Send a message from TUI to server.
 */
export function sendToServer(
    db: Database,
    type: MessageType,
    payload: Record<string, unknown>,
    sessionId?: string,
): number {
    const result = db
        .prepare(
            "INSERT INTO plugin_messages (direction, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("tui_to_server", type, JSON.stringify(payload), sessionId ?? null, Date.now());
    return Number(result.lastInsertRowid);
}

/**
 * Consume unconsumed messages for a given direction.
 * Marks consumed messages and returns them.
 * Also cleans up old messages (>5min) to prevent table bloat.
 */
export function consumeMessages(
    db: Database,
    direction: MessageDirection,
    options?: { type?: MessageType; sessionId?: string },
): PluginMessage[] {
    const now = Date.now();

    // Build query with optional filters
    const conditions = ["direction = ?", "consumed_at IS NULL"];
    const params: (string | number)[] = [direction];

    if (options?.type) {
        conditions.push("type = ?");
        params.push(options.type);
    }
    if (options?.sessionId) {
        conditions.push("session_id = ?");
        params.push(options.sessionId);
    }

    const query = `SELECT * FROM plugin_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;

    // Atomic read+mark: transaction prevents TUI and server from consuming the same messages
    const messages = db.transaction(() => {
        const rows = db.prepare(query).all(...params);
        const result = rows.filter(isPluginMessageRow).map(toPluginMessage);

        if (result.length > 0) {
            const ids = result.map((m) => m.id);
            db.prepare(
                `UPDATE plugin_messages SET consumed_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
            ).run(now, ...ids);
        }

        return result;
    })();

    // Periodic cleanup of old messages (outside transaction — non-critical)
    db.prepare("DELETE FROM plugin_messages WHERE created_at < ?").run(now - CLEANUP_THRESHOLD_MS);

    return messages;
}

/**
 * Peek at unconsumed messages without consuming them.
 */
export function peekMessages(
    db: Database,
    direction: MessageDirection,
    options?: { type?: MessageType; sessionId?: string },
): PluginMessage[] {
    const conditions = ["direction = ?", "consumed_at IS NULL"];
    const params: (string | number)[] = [direction];

    if (options?.type) {
        conditions.push("type = ?");
        params.push(options.type);
    }
    if (options?.sessionId) {
        conditions.push("session_id = ?");
        params.push(options.sessionId);
    }

    const query = `SELECT * FROM plugin_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
    return db
        .prepare(query)
        .all(...params)
        .filter(isPluginMessageRow)
        .map(toPluginMessage);
}

/**
 * Convenience: send a toast to TUI.
 */
export function sendTuiToast(
    db: Database,
    message: string,
    options?: {
        variant?: "info" | "warning" | "error" | "success";
        duration?: number;
        sessionId?: string;
    },
): number {
    return sendToTui(
        db,
        "toast",
        {
            message,
            variant: options?.variant ?? "info",
            duration: options?.duration ?? 5000,
        },
        options?.sessionId,
    );
}

/**
 * Convenience: send a confirmation dialog request to TUI.
 * Returns the message ID which the TUI will reference in its dialog_result response.
 */
export function sendTuiConfirmDialog(
    db: Database,
    id: string,
    title: string,
    message: string,
    sessionId?: string,
): number {
    return sendToTui(db, "dialog_confirm", { id, title, message }, sessionId);
}

/**
 * Convenience: check for a dialog result from TUI.
 * Returns the confirmation result or null if not yet responded.
 */
export function checkDialogResult(db: Database, dialogId: string): { confirmed: boolean } | null {
    const messages = consumeMessages(db, "tui_to_server", { type: "dialog_result" });
    const match = messages.find((m) => m.payload.id === dialogId);
    if (!match) return null;
    return { confirmed: match.payload.confirmed === true };
}
