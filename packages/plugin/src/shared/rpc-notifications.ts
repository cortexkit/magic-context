/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */

export interface RpcNotification {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

let queue: RpcNotification[] = [];
// Timestamp of last drain — used to detect if TUI is actively polling.
// The TUI polls every 500ms; we consider it connected if it polled within
// the last 3 seconds (6× the poll interval, tolerates transient delays).
let lastDrainAt = 0;
const TUI_CONNECTED_WINDOW_MS = 3_000;

/** Push a notification for TUI to pick up via polling. */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    queue.push({ type, payload, sessionId });
    // Cap queue size to prevent unbounded growth if TUI is not polling
    if (queue.length > 100) {
        queue = queue.slice(-50);
    }
}

/** Drain and return all pending notifications atomically.
 *  Updates lastDrainAt so isTuiConnected() reflects recent activity. */
export function drainNotifications(): RpcNotification[] {
    lastDrainAt = Date.now();
    const result = queue;
    queue = [];
    return result;
}

/** Whether a TUI client is actively polling for notifications.
 *  Returns true only if the TUI has drained within the last 3 seconds.
 *  This prevents stale-connected state after TUI closes or disconnects. */
export function isTuiConnected(): boolean {
    return lastDrainAt > 0 && Date.now() - lastDrainAt < TUI_CONNECTED_WINDOW_MS;
}
