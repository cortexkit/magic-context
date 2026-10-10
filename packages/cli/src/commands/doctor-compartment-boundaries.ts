import type { OpenCodeHostGeneration } from "@magic-context/core/shared/opencode-db-path";
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
    /**
     * False when the OpenCode store holds no message at all for the session,
     * so the whole session is gone from the store rather than a few rows.
     */
    sessionInStore: boolean;
}

type BoundaryMessageTable = "message" | "session_message";

interface BoundaryMessageTableSelection {
    table: BoundaryMessageTable;
    diagnostic: string | null;
}

function selectBoundaryMessageTable(
    openCodeDb: Pick<Database, "prepare">,
    hostGeneration?: OpenCodeHostGeneration,
): BoundaryMessageTableSelection {
    const rows = openCodeDb
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session_message', 'session_v2')",
        )
        .all() as Array<{ name?: unknown }>;
    const tables = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
    const hasV1Messages = tables.has("message") && tables.has("part");
    const hasV2Messages = tables.has("session_message") && tables.has("session_v2");

    if (hostGeneration === "v1") {
        if (!hasV1Messages) {
            throw new Error("OpenCode session database has no v1 message tables");
        }
        return { table: "message", diagnostic: null };
    }

    if (hostGeneration === "v2") {
        if (hasV2Messages) return { table: "session_message", diagnostic: null };
        if (hasV1Messages) {
            return {
                table: "message",
                diagnostic:
                    "Compartment boundary check: OpenCode 2 pre-migration window; using message table",
            };
        }
        throw new Error("OpenCode session database has an unrecognized schema");
    }

    // When Desktop provides no host version, the same tables can mean migrated v2 or downgraded
    // v1. Choosing populated v2 history fixes migrated Desktop stores but may read frozen v2
    // history after a downgrade, so this branch is deliberately only a heuristic.
    const hasV2Rows =
        hasV2Messages && openCodeDb.prepare("SELECT 1 FROM session_message LIMIT 1").get() != null;
    if (hasV2Rows) return { table: "session_message", diagnostic: null };
    if (hasV1Messages) return { table: "message", diagnostic: null };
    throw new Error("OpenCode session database has an unrecognized schema");
}

/** Read-only comparison of durable compartment ids with the active OpenCode store. */
export function listDanglingCompartmentBoundaries(
    contextDb: Pick<Database, "prepare">,
    openCodeDb: Pick<Database, "prepare">,
    hostGeneration?: OpenCodeHostGeneration,
    onDiagnostic?: (line: string) => void,
): DanglingCompartmentBoundary[] {
    const selection = selectBoundaryMessageTable(openCodeDb, hostGeneration);
    if (selection.diagnostic) onDiagnostic?.(selection.diagnostic);

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
        `SELECT 1 AS found FROM ${selection.table} WHERE session_id = ? AND id = ? LIMIT 1`,
    );
    const exists = (sessionId: string, messageId: string): boolean =>
        statement.get(sessionId, messageId) != null;
    const sessionStatement = openCodeDb.prepare(
        `SELECT 1 AS found FROM ${selection.table} WHERE session_id = ? LIMIT 1`,
    );
    const sessionPresence = new Map<string, boolean>();
    const sessionInStore = (sessionId: string): boolean => {
        let present = sessionPresence.get(sessionId);
        if (present === undefined) {
            present = sessionStatement.get(sessionId) != null;
            sessionPresence.set(sessionId, present);
        }
        return present;
    };

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
                sessionInStore: sessionInStore(row.session_id),
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

/** How many sessions and example compartments doctor prints without `--verbose`. */
export const DANGLING_BOUNDARY_EXAMPLE_LIMIT = 10;

export interface DanglingBoundarySessionCount {
    sessionId: string;
    count: number;
    sessionInStore: boolean;
}

/** Dangling compartments per session, largest first, ties by session id. */
export function countDanglingCompartmentBoundariesBySession(
    boundaries: DanglingCompartmentBoundary[],
): DanglingBoundarySessionCount[] {
    const bySession = new Map<string, DanglingBoundarySessionCount>();
    for (const boundary of boundaries) {
        const entry = bySession.get(boundary.sessionId);
        if (entry) entry.count++;
        else
            bySession.set(boundary.sessionId, {
                sessionId: boundary.sessionId,
                count: 1,
                sessionInStore: boundary.sessionInStore,
            });
    }
    return [...bySession.values()].sort(
        (a, b) => b.count - a.count || a.sessionId.localeCompare(b.sessionId),
    );
}

/**
 * The first line of the dangling-boundary report, saying whether the user has
 * to act. On a store OpenCode 2 converted, ids the conversion dropped are
 * expected and Magic Context places those compartments itself, so the line is
 * informational; on any other store the ids should resolve, so it is a warning.
 */
export function formatDanglingCompartmentBoundaryHeadline(
    boundaries: DanglingCompartmentBoundary[],
    store: "opencode2" | "other",
): string {
    const sessions = countDanglingCompartmentBoundariesBySession(boundaries);
    const absent = sessions.filter((session) => !session.sessionInStore).length;
    const scope = `${boundaries.length} compartment(s) in ${sessions.length} session(s)`;
    const absentNote =
        absent > 0
            ? ` ${absent} of those session(s) have no messages in this store at all, so OpenCode cannot open them from it and their compartments are not used.`
            : "";
    if (store === "opencode2") {
        return `Informational, no action needed: ${scope} point at OpenCode message ids that are not in the OpenCode 2 store.${absentNote} Magic Context places these from the neighbouring compartments; any it cannot place are listed as excluded from range recovery below.`;
    }
    return `${scope} have dangling OpenCode boundary ids.${absentNote}`;
}

/**
 * Detail lines under the headline: counts by session and example compartments,
 * each capped at `limit` unless `verbose`, plus a hint when anything was cut.
 * A converted store can carry tens of thousands of these, one per compartment.
 */
export function formatDanglingCompartmentBoundaryDetails(
    boundaries: DanglingCompartmentBoundary[],
    options: { verbose?: boolean; limit?: number } = {},
): string[] {
    const limit = options.verbose
        ? Number.POSITIVE_INFINITY
        : (options.limit ?? DANGLING_BOUNDARY_EXAMPLE_LIMIT);
    const sessions = countDanglingCompartmentBoundariesBySession(boundaries);
    const lines: string[] = [];
    lines.push(
        options.verbose || sessions.length <= limit
            ? "By session:"
            : `By session (largest ${limit} of ${sessions.length}):`,
    );
    for (const session of sessions.slice(0, limit)) {
        lines.push(
            `  session=${session.sessionId}: ${session.count} compartment(s)${session.sessionInStore ? "" : " (session has no messages in this store)"}`,
        );
    }
    if (sessions.length > limit) {
        lines.push(`  … and ${sessions.length - limit} more session(s)`);
    }
    lines.push(
        options.verbose || boundaries.length <= limit
            ? "Compartments:"
            : `Examples (${limit} of ${boundaries.length}):`,
    );
    for (const boundary of boundaries.slice(0, limit)) {
        lines.push(`  ${formatDanglingCompartmentBoundary(boundary)}`);
    }
    if (sessions.length > limit || boundaries.length > limit) {
        lines.push(
            `Run \`magic-context doctor --verbose\` for the full list of ${boundaries.length} compartment(s).`,
        );
    }
    return lines;
}
