/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */

export interface RpcNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

let queue: RpcNotification[] = [];
let nextNotificationId = 1;

/**
 * A connected TUI notification sink — one per authenticated WebSocket. The RPC
 * server registers a sink when a TUI socket authenticates (hello) and removes
 * it on close. `send` is sink-agnostic (the server owns the actual WS socket)
 * so this module stays free of Bun/WS types.
 */
export interface NotificationSink {
    /** The TUI's active session at connect time (its hello scope). */
    sessionId?: string;
    /** Protocol 2 clients use strict session scoping; absent means legacy behavior. */
    protocol?: number;
    /** Deliver one notification over this sink's live socket. */
    send: (notification: RpcNotification) => void;
}

// Live sinks replace the old poll-drain-timestamp inference. "TUI connected for
// a session" is now exact socket liveness — accurate and immediate — instead of
// "did a 500ms poll drain within the last 3s". Per-session scoping still matters:
// one process can serve MANY sessions (a TUI on session A plus an OpenCode
// Desktop opened on session B for the same project, whose newer RPC server this
// TUI's port discovery then selects). Each sink carries ITS session, so a
// B-scoped producer (`/ctx-status`, upgrade reminder) only sees B's TUI as
// connected and routes its dialog there, never to A.
const sinks = new Set<NotificationSink>();

/** Register a live TUI sink. Returns an unregister fn (call on socket close). */
export function registerNotificationSink(sink: NotificationSink): () => void {
    sinks.add(sink);
    return () => {
        sinks.delete(sink);
    };
}

/** Whether a notification may be delivered to a sink. Protocol 2 makes a
 * session-less socket global-only; legacy sockets retain broad compatibility. */
function notificationMatchesSink(notification: RpcNotification, sink: NotificationSink): boolean {
    if (notification.sessionId === undefined) return true;
    if (sink.sessionId !== undefined) return notification.sessionId === sink.sessionId;
    return sink.protocol !== 2;
}

/** Display-only notices go to the terminal showing the session, never to the replay queue. */
export function pushLiveNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId: string,
): boolean {
    const notification: RpcNotification = { id: nextNotificationId++, type, payload, sessionId };
    let delivered = false;
    for (const sink of sinks) {
        if (sink.sessionId !== sessionId) continue;
        try {
            sink.send(notification);
            delivered = true;
        } catch {
            // A socket that closed during the send has no live terminal to notify.
        }
    }
    return delivered;
}

/** Push a notification to the TUI. Fans out to any live WS sink immediately and
 *  normally enqueues it so a TUI that is momentarily disconnected (reconnecting, or
 *  not yet connected) still receives it on its next hello via the backlog drain.
 *  At-least-once: a live push that the socket drops is re-delivered from the
 *  queue on reconnect (pruned only when the client acknowledges it). Live-only
 *  notifications are not kept for replay. */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
    options?: { liveOnly?: boolean },
): void {
    const notification: RpcNotification = { id: nextNotificationId++, type, payload, sessionId };
    if (!options?.liveOnly) queue.push(notification);
    // Fan out to every live sink this notification is scoped to. A delivery throw
    // (dead socket mid-send) must not block other sinks or the caller.
    for (const sink of sinks) {
        if (!notificationMatchesSink(notification, sink)) continue;
        try {
            sink.send(notification);
        } catch {
            // Socket died between liveness check and send; the close handler will
            // unregister it. Only queued notifications replay on reconnect.
        }
    }
    // Keep a strict global bound. Reserve the newest item for at most 25 recently
    // active scopes, then evict the oldest unreserved item. This protects a quiet
    // session from one noisy peer without allowing one item per session to grow
    // the queue without limit.
    if (!options?.liveOnly && queue.length > 100) {
        const reservedIds = new Set<number>();
        const reservedScopes = new Set<string>();
        for (let i = queue.length - 1; i >= 0 && reservedScopes.size < 25; i -= 1) {
            const candidate = queue[i];
            const scope = candidate.sessionId ?? "\0global";
            if (reservedScopes.has(scope)) continue;
            reservedScopes.add(scope);
            reservedIds.add(candidate.id);
        }
        const evictionIndex = queue.findIndex((candidate) => !reservedIds.has(candidate.id));
        queue.splice(evictionIndex >= 0 ? evictionIndex : 0, 1);
    }
}

export function acknowledgeNotifications(ids: readonly number[]): void {
    const acknowledged = new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
    if (acknowledged.size === 0) return;
    // Exact removal preserves an earlier notification when a later handler finishes
    // first or the earlier handler declines to consume its notification.
    queue = queue.filter((notification) => !acknowledged.has(notification.id));
}

/** Reset process-local state to simulate a fresh server module in protocol tests. */
export function __resetNotificationStateForTests(): void {
    queue = [];
    nextNotificationId = 1;
    sinks.clear();
}

export interface DrainNotificationsOptions {
    /**
     * Cursor for global notifications when a session-scoped client sends separate
     * session and global watermarks.
     */
    globalLastReceivedId?: number;
    /** Ack/drain only the named session, not global notifications. */
    sessionOnly?: boolean;
    /** Ack/drain only session-less global notifications. */
    globalOnly?: boolean;
}

function cursor(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Return pending notifications after pruning only the scopes the client acked.
 *
 *  Session-scoped and global notifications have independent cursors. A TUI can
 *  switch from session A to session B after handling a high id in A; that high
 *  watermark must never prune B's lower, still-unseen ids. Global notifications
 *  are also tracked separately so a global dialog does not become a session
 *  watermark. Legacy callers that omit options keep the original single-cursor
 *  behavior.
 *
 *  Delivery is at-least-once (non-destructive return + prune-on-ack): a returned
 *  notification stays queued until an exact acknowledgement or a legacy cursor
 *  removes it, so a dropped WS socket re-delivers unhandled backlog on reconnect. */
export function drainNotifications(
    lastReceivedId = 0,
    sessionId?: string,
    options: DrainNotificationsOptions = {},
): RpcNotification[] {
    const sessionCursor = cursor(lastReceivedId);

    if (options.globalOnly) {
        queue = queue.filter(
            (notification) =>
                notification.sessionId !== undefined || notification.id > sessionCursor,
        );
        return queue.filter(
            (notification) =>
                notification.sessionId === undefined && notification.id > sessionCursor,
        );
    }

    if (options.sessionOnly) {
        if (sessionId === undefined) return [];
        queue = queue.filter(
            (notification) =>
                notification.sessionId !== sessionId || notification.id > sessionCursor,
        );
        return queue.filter(
            (notification) =>
                notification.sessionId === sessionId && notification.id > sessionCursor,
        );
    }

    if (sessionId !== undefined && options.globalLastReceivedId !== undefined) {
        const globalCursor = cursor(options.globalLastReceivedId);
        queue = queue.filter((notification) => {
            if (notification.sessionId === undefined) return notification.id > globalCursor;
            if (notification.sessionId === sessionId) return notification.id > sessionCursor;
            return true;
        });
        return queue.filter((notification) => {
            if (notification.sessionId === undefined) return notification.id > globalCursor;
            return notification.sessionId === sessionId && notification.id > sessionCursor;
        });
    }

    const matchesClient = (notification: RpcNotification): boolean =>
        sessionId === undefined ||
        notification.sessionId === undefined ||
        notification.sessionId === sessionId;
    if (sessionCursor > 0) {
        // Legacy single-cursor mode prunes the scopes this client can see. New WS
        // clients pass dual cursors above so cross-session watermarks stay isolated.
        queue = queue.filter(
            (notification) => !(notification.id <= sessionCursor && matchesClient(notification)),
        );
    }
    return queue.filter(
        (notification) => notification.id > sessionCursor && matchesClient(notification),
    );
}

/** Whether a TUI client is connected via a live notification socket.
 *  Now exact socket liveness (a registered WS sink), not a poll-drain timestamp.
 *
 *  Pass `sessionId` (preferred) to ask whether a TUI is connected FOR THAT
 *  SESSION — this is what producers (`/ctx-status`, `/ctx-recomp`, the upgrade
 *  reminder) must use to decide dialog-vs-message, so a TUI on a different
 *  session in the same process does not misroute their delivery. A modern
 *  session-less sink is global-only; a legacy sink retains broad compatibility.
 *  Omit `sessionId` only for callers with no session context. */
export function isTuiConnected(sessionId?: string): boolean {
    if (sinks.size === 0) return false;
    if (sessionId === undefined) return true;
    for (const sink of sinks) {
        if (sink.sessionId === sessionId) return true;
        if (sink.sessionId === undefined && sink.protocol !== 2) return true;
    }
    return false;
}
