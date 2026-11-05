import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * Sessions moved to mode 3 by ck-mc's offline move (`ck-mc offline
 * move-session`). The move writes one record per session into context.db's
 * `schema_migrations_meta` key/value table, last, as its commit point. From then
 * on the session belongs to the session runner and ck-mc, and this plugin must
 * not manage it. The key spelling is shared with
 * `crates/mc-module/src/offline_move.rs`.
 */
export const MODE3_MOVE_RECORD_PREFIX = "mode3_move:opencode:";

/** The one message a user sees when this plugin meets a moved session. */
export const MOVED_SESSION_MESSAGE =
    "Magic Context: this session was moved to Magic Context mode 3 and is now managed by its session runner, not by this plugin. Open it through the runner (THALAMUS). This plugin will not read or change it.";

/** Whether context.db records that `sessionId` was moved to mode 3. */
export function isSessionMovedToMode3(db: Database, sessionId: string): boolean {
    const row = db
        .prepare("SELECT 1 AS moved FROM schema_migrations_meta WHERE key = ?")
        .get(`${MODE3_MOVE_RECORD_PREFIX}${sessionId}`);
    return row !== null && row !== undefined;
}

/**
 * A per-process check for moved sessions. A session can be moved while this
 * host keeps running, so "not moved" is asked again on every call; only
 * "moved" is cached, because a move is never undone. While storage is not open
 * yet the check answers "not moved" and asks again on the next call.
 */
export function createMovedSessionCheck(
    openDb: () => Database | null,
): (sessionId: unknown) => boolean {
    const known = new Map<string, boolean>();
    return (sessionId) => {
        if (typeof sessionId !== "string" || sessionId.length === 0) return false;
        const cached = known.get(sessionId);
        if (cached !== undefined) return cached;
        let db: Database | null;
        try {
            db = openDb();
        } catch {
            return false;
        }
        if (!db) return false;
        try {
            const moved = isSessionMovedToMode3(db, sessionId);
            if (moved) {
                known.set(sessionId, true);
                log(`[magic-context] session ${sessionId} was moved to mode 3; standing down`);
            }
            return moved;
        } catch (error) {
            log(`[magic-context] moved-session check failed for ${sessionId}`, error);
            return false;
        }
    };
}
