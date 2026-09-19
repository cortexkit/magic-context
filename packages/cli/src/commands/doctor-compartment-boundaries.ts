import {
    detectOpenCodeStoreGeneration,
    type OpenCodeHostGeneration,
} from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";

interface BoundaryRow {
    session_id: string;
    sequence: number;
    start_message_id: string;
    end_message_id: string;
}

export interface DanglingCompartmentBoundary {
    sessionId: string;
    sequence: number;
    missingStartMessageId: string | null;
    missingEndMessageId: string | null;
}

/** Read-only comparison of durable compartment ids with the active OpenCode store. */
export function listDanglingCompartmentBoundaries(
    contextDb: Pick<Database, "prepare">,
    openCodeDb: Pick<Database, "prepare">,
    hostGeneration?: OpenCodeHostGeneration,
): DanglingCompartmentBoundary[] {
    // The running host decides which table is live. A store OpenCode 2 migrated keeps its v1
    // tables frozen at the migration point (detection still calls it v1), and a store an
    // OpenCode 1.x host uses again after an upgrade keeps a frozen session_message.
    const generation = hostGeneration ?? detectOpenCodeStoreGeneration(openCodeDb);
    if (generation === "unknown") {
        throw new Error("OpenCode session database has an unrecognized schema");
    }
    const rows = contextDb
        .prepare(
            `SELECT c.session_id, c.sequence, c.start_message_id, c.end_message_id
               FROM compartments AS c
               LEFT JOIN session_meta AS sm ON sm.session_id = c.session_id
              WHERE sm.harness IS NULL OR sm.harness IN ('opencode', 'opencode2')
              ORDER BY c.session_id ASC, c.sequence ASC`,
        )
        .all() as BoundaryRow[];
    const statement = openCodeDb.prepare(
        generation === "v2"
            ? "SELECT 1 AS found FROM session_message WHERE session_id = ? AND id = ? LIMIT 1"
            : "SELECT 1 AS found FROM message WHERE session_id = ? AND id = ? LIMIT 1",
    );
    const exists = (sessionId: string, messageId: string): boolean =>
        statement.get(sessionId, messageId) != null;

    return rows.flatMap((row) => {
        const missingStart = !exists(row.session_id, row.start_message_id);
        const missingEnd = !exists(row.session_id, row.end_message_id);
        if (!missingStart && !missingEnd) return [];
        return [
            {
                sessionId: row.session_id,
                sequence: row.sequence,
                missingStartMessageId: missingStart ? row.start_message_id : null,
                missingEndMessageId: missingEnd ? row.end_message_id : null,
            },
        ];
    });
}

export function formatDanglingCompartmentBoundary(boundary: DanglingCompartmentBoundary): string {
    const missing = [
        boundary.missingStartMessageId
            ? `start_message_id=${boundary.missingStartMessageId}`
            : null,
        boundary.missingEndMessageId ? `end_message_id=${boundary.missingEndMessageId}` : null,
    ].filter((value): value is string => value !== null);
    return `session=${boundary.sessionId} sequence=${boundary.sequence} missing ${missing.join(" ")}`;
}
