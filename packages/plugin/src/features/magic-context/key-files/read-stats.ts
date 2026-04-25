import type { Database } from "../../../shared/sqlite";

export interface FileReadStat {
    filePath: string;
    fullReadCount: number;
    /** Number of distinct compartment ranges the reads span across */
    spreadAcrossCompartments: number;
    /** Number of times the file was edited (write/edit tool) in this session */
    editCount: number;
    /** Byte size of the most recent full read output */
    latestReadBytes: number;
    /** Approximate token count of the most recent full read (~3.5 chars per token) */
    latestReadTokens: number;
}

/**
 * Query file read patterns from OpenCode's DB for a specific session.
 * Returns files that were fully read (no line range) at least `minReads` times,
 * sorted by read frequency descending.
 */
export function getSessionReadStats(
    openCodeDb: Database,
    sessionId: string,
    minReads: number,
): FileReadStat[] {
    // Step 1: Get all full-read file paths with counts and latest output size
    const fullReads = openCodeDb
        .prepare(
            `
        WITH full_reads AS (
            SELECT 
                json_extract(json_extract(data, '$.state'), '$.input.filePath') as file_path,
                LENGTH(json_extract(json_extract(data, '$.state'), '$.output')) as output_bytes,
                p.time_created,
                ROW_NUMBER() OVER (
                    PARTITION BY json_extract(json_extract(data, '$.state'), '$.input.filePath') 
                    ORDER BY p.time_created DESC
                ) as rn
            FROM part p
            WHERE p.session_id = ?
                AND json_extract(data, '$.type') = 'tool'
                AND json_extract(data, '$.tool') = 'read'
                AND json_extract(json_extract(data, '$.state'), '$.input.filePath') IS NOT NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.startLine') IS NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.start_line') IS NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.endLine') IS NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.end_line') IS NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.offset') IS NULL
                AND json_extract(json_extract(data, '$.state'), '$.input.limit') IS NULL
        ),
        file_counts AS (
            SELECT file_path, COUNT(*) as full_read_count
            FROM full_reads
            GROUP BY file_path
            HAVING full_read_count >= ?
        )
        SELECT 
            r.file_path,
            fc.full_read_count,
            r.output_bytes as latest_read_bytes
        FROM full_reads r
        JOIN file_counts fc ON r.file_path = fc.file_path
        WHERE r.rn = 1
        ORDER BY fc.full_read_count DESC
    `,
        )
        .all(sessionId, minReads) as Array<{
        file_path: string;
        full_read_count: number;
        latest_read_bytes: number;
    }>;

    if (fullReads.length === 0) return [];

    // Step 2: Count edits per file
    const editCounts = new Map<string, number>();
    const editRows = openCodeDb
        .prepare(
            `
        SELECT 
            json_extract(json_extract(data, '$.state'), '$.input.filePath') as file_path,
            COUNT(*) as edit_count
        FROM part p
        WHERE p.session_id = ?
            AND json_extract(data, '$.type') = 'tool'
            AND json_extract(data, '$.tool') IN ('edit', 'write', 'mcp_edit', 'mcp_write')
            AND json_extract(json_extract(data, '$.state'), '$.input.filePath') IS NOT NULL
        GROUP BY file_path
    `,
        )
        .all(sessionId) as Array<{ file_path: string; edit_count: number }>;

    for (const row of editRows) {
        editCounts.set(row.file_path, row.edit_count);
    }

    return fullReads.map((row) => ({
        filePath: row.file_path,
        fullReadCount: row.full_read_count,
        spreadAcrossCompartments: 0, // TODO: compute from compartment boundaries if needed
        editCount: editCounts.get(row.file_path) ?? 0,
        latestReadBytes: row.latest_read_bytes ?? 0,
        // Rough estimate from byte size — we don't have the file content at
        // this layer. Used only for dreamer's key-file budget-fit filtering,
        // where approximate bucketing is sufficient. Intentional: bytes/3.5.
        latestReadTokens: Math.ceil((row.latest_read_bytes ?? 0) / 3.5),
    }));
}
