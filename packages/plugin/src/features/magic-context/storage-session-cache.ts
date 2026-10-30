import type { Database } from "../../shared/sqlite";
import {
    clearHostTokenBreakdownMemo,
    markHostTokenPrefixChanged,
} from "./host-token-breakdown-state";
import { sessionPayloadStatement } from "./storage-session-collection-state";

export const SESSION_RENDER_CACHE_DDL = `CREATE TABLE IF NOT EXISTS session_render_cache (
    session_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    value BLOB,
    PRIMARY KEY (session_id, cache_key)
) WITHOUT ROWID`;

export const SESSION_RENDER_CACHE_COLUMNS = [
    "cached_m0_bytes",
    "cached_m1_bytes",
    "cached_m0_mural_data_url",
    "memory_block_cache",
    "cached_m0_upgrade_state",
] as const;

export type SessionRenderCacheColumn = (typeof SESSION_RENDER_CACHE_COLUMNS)[number];

export function isSessionRenderCacheColumn(column: string): column is SessionRenderCacheColumn {
    return (SESSION_RENDER_CACHE_COLUMNS as readonly string[]).includes(column);
}

/** Correlate a payload read with the surrounding session_meta snapshot. */
export function sessionRenderCacheValueSql(
    column: SessionRenderCacheColumn,
    db?: Pick<Database, "prepare">,
): string {
    const value = `(SELECT value FROM session_render_cache WHERE session_id = session_meta.session_id AND cache_key = '${column}')`;
    if (
        db &&
        (db.prepare("PRAGMA table_info(session_meta)").all() as { name: string }[]).some(
            (row) => row.name === column,
        )
    ) {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_render_cache'").get()
            ? `(CASE WHEN EXISTS (SELECT 1 FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='${column}') THEN ${value} ELSE ${column} END)`
            : column;
    }
    return column === "memory_block_cache"
        ? `(CASE WHEN EXISTS (SELECT 1 FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='${column}') THEN ${value} ELSE '' END)`
        : value;
}

export function sessionRenderCacheSelect(
    column: SessionRenderCacheColumn,
    alias: string = column,
    db?: Pick<Database, "prepare">,
): string {
    const value = sessionRenderCacheValueSql(column, db);
    return `${value} AS ${alias}`;
}

export function readSessionRenderCache(
    db: Pick<Database, "prepare">,
    sessionId: string,
    column: SessionRenderCacheColumn,
): Buffer | Uint8Array | string | number | null {
    const row = sessionPayloadStatement(
        db,
        "SELECT value FROM session_render_cache WHERE session_id = ? AND cache_key = ?",
    ).get(sessionId, column) as { value: Buffer | Uint8Array | string | number | null } | undefined;
    return row ? row.value : column === "memory_block_cache" ? "" : null;
}

/** Each payload has its own record: even a growing m[1] cannot rewrite m[0]'s overflow pages. */
export function writeSessionRenderCache(
    db: Pick<Database, "prepare">,
    sessionId: string,
    column: SessionRenderCacheColumn,
    value: Buffer | Uint8Array | string | number | null,
): void {
    if (
        (value === null && column !== "memory_block_cache") ||
        (column === "memory_block_cache" && value === "")
    ) {
        const deleted = sessionPayloadStatement(
            db,
            "DELETE FROM session_render_cache WHERE session_id = ? AND cache_key = ?",
        ).run(sessionId, column);
        if (deleted.changes > 0 && (column === "cached_m0_bytes" || column === "cached_m1_bytes"))
            markHostTokenPrefixChanged(db, sessionId);
        return;
    }
    const binding =
        typeof value === "number" && column !== "cached_m0_bytes" && column !== "cached_m1_bytes"
            ? "CAST(? AS TEXT)"
            : "?";
    const written = sessionPayloadStatement(
        db,
        `INSERT INTO session_render_cache (session_id, cache_key, value)
        SELECT ?, ?, ${binding} WHERE EXISTS (SELECT 1 FROM session_meta WHERE session_id=?)
        ON CONFLICT(session_id, cache_key) DO UPDATE SET value = excluded.value
        WHERE value IS NOT excluded.value`,
    ).run(sessionId, column, value, sessionId);
    if (written.changes > 0 && (column === "cached_m0_bytes" || column === "cached_m1_bytes"))
        markHostTokenPrefixChanged(db, sessionId);
}

export function clearSessionRenderCache(db: Pick<Database, "prepare">, sessionId: string): void {
    db.prepare("DELETE FROM session_render_cache WHERE session_id = ?").run(sessionId);
    clearHostTokenBreakdownMemo(db, sessionId);
}
