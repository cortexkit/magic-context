import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";

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
        cachedReadOnlyDb.db.close(false);
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
    const row = db
        .prepare("SELECT COUNT(*) as count FROM message WHERE session_id = ?")
        .get(sessionId) as RawCountRow | null;
    return typeof row?.count === "number" ? row.count : 0;
}
