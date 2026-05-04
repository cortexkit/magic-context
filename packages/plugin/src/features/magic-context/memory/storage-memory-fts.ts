import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { COLUMN_MAP, isMemoryRow, toMemory } from "./storage-memory";
import type { Memory } from "./types";

const DEFAULT_SEARCH_LIMIT = 10;
const searchStatements = new WeakMap<Database, PreparedStatement>();

function getSearchStatement(db: Database): PreparedStatement {
    let stmt = searchStatements.get(db);
    if (!stmt) {
        const selectColumns = Object.entries(COLUMN_MAP)
            .map(([property, column]) => `memories.${column} AS ${property}`)
            .join(", ");

        stmt = db.prepare(
            `SELECT ${selectColumns} FROM memories_fts INNER JOIN memories ON memories.id = memories_fts.rowid WHERE memories.project_path = ? AND memories.status IN ('active', 'permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?`,
        );
        searchStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 *
 * FTS5 interprets characters like `-`, `:`, `*`, `(`, `)` as operators.
 * This wraps each whitespace-delimited token in double quotes so special
 * characters are treated as literal content rather than query syntax.
 */
export function sanitizeFtsQuery(query: string): string {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return "";

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

export function searchMemoriesFTS(
    db: Database,
    projectPath: string,
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
): Memory[] {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || limit <= 0) {
        return [];
    }

    const sanitized = sanitizeFtsQuery(trimmedQuery);
    if (sanitized.length === 0) {
        return [];
    }

    const rows = getSearchStatement(db)
        .all(projectPath, Date.now(), sanitized, limit)
        .filter(isMemoryRow);

    return rows.map(toMemory);
}
