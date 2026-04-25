import { join } from "node:path";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";

interface RawCountRow {
    count?: number;
}

function getOpenCodeDbPath(): string {
    return join(getDataDir(), "opencode", "opencode.db");
}

let cachedReadOnlyDb: { path: string; db: Database } | null = null;

function closeCachedReadOnlyDb(): void {
    if (!cachedReadOnlyDb) {
        return;
    }

    try {
        closeQuietly(cachedReadOnlyDb.db);
    } catch (error) {
        log("[magic-context] failed to close cached OpenCode read-only DB:", error);
    } finally {
        cachedReadOnlyDb = null;
    }
}

function getReadOnlySessionDb(): Database {
    const dbPath = getOpenCodeDbPath();
    if (cachedReadOnlyDb?.path === dbPath) {
        return cachedReadOnlyDb.db;
    }

    closeCachedReadOnlyDb();
    const db = new Database(dbPath, { readonly: true });
    cachedReadOnlyDb = { path: dbPath, db };
    return db;
}

export function withReadOnlySessionDb<T>(fn: (db: Database) => T): T {
    return fn(getReadOnlySessionDb());
}

// Intentional: exported for tests; production relies on process-exit cleanup (same as closeDatabase)
export function closeReadOnlySessionDb(): void {
    closeCachedReadOnlyDb();
}

export function getRawSessionMessageCountFromDb(db: Database, sessionId: string): number {
    // Exclude compaction summary messages injected by magic-context.
    // These are structural markers for OpenCode's filterCompacted, not real user/assistant content.
    // Use COALESCE to handle NULL json_extract results (messages without summary/finish fields).
    const row = db
        .prepare(
            `SELECT COUNT(*) as count FROM message WHERE session_id = ?
             AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                      AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')`,
        )
        .get(sessionId) as RawCountRow | null;
    return typeof row?.count === "number" ? row.count : 0;
}

interface AssistantModelRow {
    providerID?: string;
    modelID?: string;
}

/**
 * Read the provider/model of the most recent assistant message for a session
 * directly from OpenCode's SQLite DB. Used as a fallback when the in-memory
 * `liveModelBySession` map is empty — for example when `/ctx-status` is invoked
 * before any transform pass has populated the map after restart.
 *
 * Returns null for brand-new sessions with no assistant turn yet.
 */
interface MessageTimeRow {
    id?: string;
    time_created?: number;
}

/**
 * Resolve `time_created` (ms since epoch) for a set of OpenCode message IDs.
 * Returns a Map keyed by message ID. Missing IDs are simply omitted.
 *
 * Used by temporal-awareness to map compartment start/end message IDs to
 * wall-clock dates for the `start="YYYY-MM-DD"` / `end="YYYY-MM-DD"` attrs
 * on the `<compartment>` elements in `<session-history>`.
 */
export function getMessageTimesFromOpenCodeDb(
    sessionId: string,
    messageIds: readonly string[],
): Map<string, number> {
    const result = new Map<string, number>();
    if (messageIds.length === 0) return result;

    try {
        withReadOnlySessionDb((db) => {
            // SQLite limits on IN (?, ?, ...) are high (~999 by default) so a
            // single batched query is safe for any realistic compartment count.
            const placeholders = messageIds.map(() => "?").join(",");
            const rows = db
                .prepare(
                    `SELECT id, time_created FROM message WHERE session_id = ? AND id IN (${placeholders})`,
                )
                .all(sessionId, ...messageIds) as MessageTimeRow[];
            for (const row of rows) {
                if (typeof row.id === "string" && typeof row.time_created === "number") {
                    result.set(row.id, row.time_created);
                }
            }
        });
    } catch (error) {
        log("[magic-context] failed to resolve message times from OpenCode DB:", error);
    }

    return result;
}

export function findLastAssistantModelFromOpenCodeDb(
    sessionId: string,
): { providerID: string; modelID: string } | null {
    try {
        return withReadOnlySessionDb((db) => {
            const row = db
                .prepare(
                    `SELECT json_extract(data, '$.providerID') as providerID,
                            json_extract(data, '$.modelID') as modelID
                     FROM message
                     WHERE session_id = ?
                       AND json_extract(data, '$.role') = 'assistant'
                       AND json_extract(data, '$.providerID') IS NOT NULL
                       AND json_extract(data, '$.modelID') IS NOT NULL
                     ORDER BY time_created DESC
                     LIMIT 1`,
                )
                .get(sessionId) as AssistantModelRow | null;
            if (!row || typeof row.providerID !== "string" || typeof row.modelID !== "string") {
                return null;
            }
            return { providerID: row.providerID, modelID: row.modelID };
        });
    } catch (error) {
        log("[magic-context] failed to recover live model from OpenCode DB:", error);
        return null;
    }
}
