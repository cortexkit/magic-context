import {
    clampProducerAtomChars,
    producerInputTokenLimit,
} from "../../../hooks/magic-context/producer-window-guard";
import { cleanUserText } from "../../../hooks/magic-context/read-session-chunk";
import {
    estimateTokens,
    hasMeaningfulUserText,
} from "../../../hooks/magic-context/read-session-formatting";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { openOpenCodeDb } from "./open-opencode-db";
import { buildFrictionGatePrompt, FRICTION_GATE_SYSTEM_PROMPT } from "./task-prompts";

export const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;
// Cap the number of oldest eligible sessions scanned per run. The first run
// (watermark=0) would otherwise fan out over the project's entire session
// history; this bounds the scan/IO regardless of how many sessions exist.
export const RETROSPECTIVE_MAX_SESSIONS_PER_RUN = 20;
/**
 * A pasted log is one semantic message, not an entitlement to the whole child
 * window. The 8,000 ceiling mirrors the historian's `HISTORIAN_CHUNK_MIN`
 * convention, but applies it as a stricter character cap to avoid per-message
 * tokenizing. Its head+tail shape is shared with the historian atomic guard.
 */
export const RETROSPECTIVE_MAX_USER_MESSAGE_CHARS = 8_000;
export const RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER =
    "\n[… middle of user message truncated by Magic Context …]\n";

export type RetrospectiveMessageRole = "user" | "assistant" | "tool";

export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}

export interface RetrospectiveRawMessage {
    sessionId: string;
    ordinal: number;
    role: RetrospectiveMessageRole;
    text: string;
    /** True when an earlier user turn has an assistant reply before this line. */
    followsAssistantReply?: boolean;
    toolName?: string;
    isError?: boolean;
    ts: number;
}

/** A per-session since-read. `truncated` is the EXACT saturation signal (the
 *  underlying read hit `capPerSession` with more rows available) — never inferred
 *  from `messages.length`, because normalization both drops rows (assistant/empty)
 *  and adds rows (one assistant message → many tool rows), so a length-based guess
 *  can false-NEGATIVE and lose data. */
export interface RetrospectiveSinceRead {
    messages: RetrospectiveRawMessage[];
    truncated: boolean;
    /** Timestamp of the first raw row beyond the per-session cap, before normalization. */
    firstOmittedTs?: number;
}

export interface RetrospectiveRawProvider {
    listProjectSessions(
        projectIdentity: string,
    ): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead | Promise<RetrospectiveSinceRead>;
    /** Oldest raw message timestamp still pending per session. Providers with an
     *  indexed store use this to order the bounded session scan by true backlog
     *  frontier, not by coarse session updated_at. */
    readOldestMessageTimesSince?(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> | null | Promise<Map<string, number> | null>;
    /** The ~`count` most recent typed USER messages at or before `beforeMs` — the
     *  run-boundary overlap so friction spanning two runs isn't missed. */
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** Release any reused resources (e.g. a pooled DB handle) after a run. */
    dispose?(): void;
}

interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** Test-only shortcut: when provided, this connection is not closed by the provider. */
    opencodeDb?: Database;
}

interface SessionProjectRow {
    session_id: string;
    updated_at?: number | null;
}

interface OpenCodeMessageRow {
    id: string;
    data: string;
    time_created: number;
    has_prior_assistant_reply?: number;
}

interface OpenCodePartRow {
    message_id: string;
    data: string;
}

export class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly openDb: () => Database | null;
    // One read-only opencode.db handle reused across the run's per-session reads
    // (opened lazily on the first read, closed via dispose()). Avoids opening +
    // closing the DB once per session, which on a large project meant many
    // open/close cycles per scheduled run.
    private sharedDb: Database | null = null;
    private sharedDbOpened = false;

    constructor(private readonly deps: OpenCodeRetrospectiveRawProviderDeps) {
        this.openDb = deps.openOpenCodeDb ?? openOpenCodeDb;
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        // ROOT sessions only. The retrospective learns from USER friction, but a
        // subagent child (oracle / mason / historian / dreamer) has no user — its
        // "user messages" are agent-authored task prompts whose audit/spec wording
        // ("fail", "error", "wrong", "no padding") trips the frustration regex and
        // whose tool fan-out trips repeated-tool-call. In a delegation-heavy period
        // children also outnumber roots ~30:1, so a bounded session scan can be
        // entirely consumed by them and the real user session is never scanned.
        // is_subagent lives in session_meta (same DB); missing meta → treat as root.
        const rows = this.deps.contextDb
            .prepare<[string], SessionProjectRow>(
                `SELECT sp.session_id, CAST(activity.value AS INTEGER) AS updated_at
                   FROM session_projects sp
                   JOIN schema_migrations_meta activity
                     ON activity.key = 'retrospective_activity:' || sp.session_id
                   LEFT JOIN session_meta m ON m.session_id = sp.session_id
                  WHERE sp.project_path = ? AND sp.harness = 'opencode'
                    AND COALESCE(m.is_subagent, 0) = 0
                  ORDER BY updated_at ASC, sp.session_id ASC`,
            )
            .all(projectIdentity);
        return rows.map((row) => ({
            sessionId: row.session_id,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        }));
    }

    private resolveDb(): Database | null {
        if (this.deps.opencodeDb) return this.deps.opencodeDb;
        if (!this.sharedDbOpened) {
            this.sharedDbOpened = true;
            this.sharedDb = this.openDb();
        }
        return this.sharedDb;
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        const db = this.resolveDb();
        if (!db) return { messages: [], truncated: false };
        return readOpenCodeMessagesSince(db, sessionId, sinceMs, capPerSession);
    }

    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> | null {
        const db = this.resolveDb();
        if (!db) return null;
        if (sessionIds.length === 0) return new Map();
        return readOpenCodeOldestMessageTimesSince(db, sessionIds, sinceMs);
    }

    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        const db = this.resolveDb();
        if (!db) return [];
        try {
            return readOpenCodeUserMessagesBefore(db, sessionId, beforeMs, count);
        } catch {
            return [];
        }
    }

    /** Close the reused read-only handle. Safe to call multiple times. */
    dispose(): void {
        if (this.sharedDb && !this.deps.opencodeDb) {
            closeQuietly(this.sharedDb);
        }
        this.sharedDb = null;
        this.sharedDbOpened = false;
    }
}

export interface RetrospectiveScanWindow {
    /** All admitted messages (user rows + tool metadata), oldest→newest. Includes
     *  only overlap rows that also fit the child prompt budget. */
    messages: RetrospectiveRawMessage[];
    /** The max message ts ACTUALLY admitted this run (the content watermark to
     *  persist on completion). A recency cutoff may move it past expired rows. */
    maxScannedTs: number;
    /** Exact estimate for the gate system+user prompt assembled from `messages`. */
    promptTokens: number;
    /** Usable child-model input after reserving the shared estimator's 3% safety margin. */
    promptInputLimitTokens?: number;
    /** True when the token budget, rather than a count cap, cut the since prefix. */
    budgetTruncated: boolean;
}

function clampRetrospectiveMessage(message: RetrospectiveRawMessage): RetrospectiveRawMessage {
    if (message.role !== "user" || message.text.length <= RETROSPECTIVE_MAX_USER_MESSAGE_CHARS) {
        return message;
    }
    return {
        ...message,
        text: clampProducerAtomChars(
            message.text,
            RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
            RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER,
        ),
    };
}

function retrospectiveGatePrompt(messages: readonly RetrospectiveRawMessage[]): string {
    const userLines = messages
        .map((message, index) => ({ ...message, ordinal: index + 1 }))
        .filter((message) => message.role === "user")
        .map((message) => `${message.ordinal}: ${message.text}`);
    return `${FRICTION_GATE_SYSTEM_PROMPT}\n${buildFrictionGatePrompt({ userLines })}`;
}

function retrospectiveGatePromptTokens(messages: readonly RetrospectiveRawMessage[]): number {
    return estimateTokens(retrospectiveGatePrompt(messages));
}

function admitRetrospectiveCohorts(
    rows: RetrospectiveRawMessage[],
    firstUnreadTs: number,
    maxMessages: number,
    promptInputLimitTokens: number | undefined,
): {
    kept: RetrospectiveRawMessage[];
    budgetTruncated: boolean;
    oversized?: { ts: number; rows: RetrospectiveRawMessage[] };
} {
    const kept: RetrospectiveRawMessage[] = [];
    let start = 0;
    for (let first = rows[start]; first && first.ts < firstUnreadTs; first = rows[start]) {
        const ts = first.ts;
        let end = start + 1;
        while (end < rows.length && rows[end]?.ts === ts) end += 1;
        const cohort = rows.slice(start, end);
        const tooManyRows = end > maxMessages;
        const tooManyTokens =
            !tooManyRows &&
            promptInputLimitTokens !== undefined &&
            retrospectiveGatePromptTokens([...kept, ...cohort]) > promptInputLimitTokens;
        if (tooManyRows || tooManyTokens) {
            return {
                kept,
                budgetTruncated: tooManyTokens,
                // If earlier cohorts used some of the budget, retry the whole
                // group in a fresh window rather than declaring it too large.
                ...(kept.length === 0 ? { oversized: { ts, rows: cohort } } : {}),
            };
        }
        kept.push(...cohort);
        start = end;
    }
    return { kept, budgetTruncated: false };
}

function logSkippedRetrospectiveCohort(
    sessionIds: Iterable<string>,
    ts: number,
    count: number,
    lowerBound: boolean,
): void {
    const sessions = [...new Set(sessionIds)].join(",");
    log(
        `[dreamer] retrospective: oversized timestamp cohort sessionIds=${sessions} timestamp=${ts} ${lowerBound ? "skippedAtLeast" : "skipped"}=${count}`,
    );
}

export async function readRetrospectiveScanWindow(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    watermarkMs: number,
    overlapUserCount: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
        maxSessionsPerRun?: number;
        /** Child model's already-output-reserved usable input window. */
        usableInputTokens?: number;
        /** Oldest timestamp still eligible. Rows below it expire without collection. */
        recencyCutoffMs?: number;
    },
): Promise<RetrospectiveScanWindow> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const sessionLimit = Math.max(
        1,
        Math.floor(options?.maxSessionsPerRun ?? RETROSPECTIVE_MAX_SESSIONS_PER_RUN),
    );
    const recencyCutoffMs =
        typeof options?.recencyCutoffMs === "number" && Number.isFinite(options.recencyCutoffMs)
            ? Math.floor(options.recencyCutoffMs)
            : Number.NEGATIVE_INFINITY;
    // Providers read `ts > sinceMs`. cutoff−1 therefore admits an exact-boundary
    // row while advancing the durable frontier past every expired row.
    const scanSinceMs = Math.max(watermarkMs, recencyCutoffMs - 1);
    const promptInputLimitTokens = producerInputTokenLimit(options?.usableInputTokens, 0);

    try {
        const allSessions = await provider.listProjectSessions(projectIdentity);
        const eligibleSessions = allSessions
            .map((session, index) => ({ session, index }))
            .filter(({ session }) => (session.updatedAt ?? Number.POSITIVE_INFINITY) > scanSinceMs);
        const oldestBySession = provider.readOldestMessageTimesSince
            ? await provider.readOldestMessageTimesSince(
                  eligibleSessions.map(({ session }) => session.sessionId),
                  scanSinceMs,
              )
            : null;
        const sessions = (
            oldestBySession
                ? eligibleSessions.filter(({ session }) => oldestBySession.has(session.sessionId))
                : eligibleSessions
        ).sort((a, b) => {
            const aFrontier = oldestBySession?.get(a.session.sessionId);
            const bFrontier = oldestBySession?.get(b.session.sessionId);
            if (aFrontier !== undefined || bFrontier !== undefined) {
                return (
                    (aFrontier ?? Number.POSITIVE_INFINITY) -
                        (bFrontier ?? Number.POSITIVE_INFINITY) || a.index - b.index
                );
            }
            const aUpdated = a.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const bUpdated = b.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const byUpdated = aUpdated - bUpdated;
            return byUpdated || a.index - b.index;
        });
        const sessionsToRead = sessions.slice(0, sessionLimit).map(({ session }) => session);
        const firstExcludedSession = sessions[sessionLimit]?.session;
        const firstExcludedPendingTs = firstExcludedSession
            ? oldestBySession?.get(firstExcludedSession.sessionId)
            : undefined;
        const sinceReads: RetrospectiveSinceRead[] = [];
        if (sessionsToRead.length > 0) {
            sinceReads.push(
                ...(await Promise.all(
                    sessionsToRead.map((session) =>
                        provider.readUserMessagesSince(
                            session.sessionId,
                            scanSinceMs,
                            capPerSession,
                        ),
                    ),
                )),
            );
        }

        const allSince = sinceReads
            .flatMap((read) => read.messages)
            .filter((message) => message.ts > scanSinceMs)
            .map(clampRetrospectiveMessage)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);

        let unknownBoundary = !!firstExcludedSession && firstExcludedPendingTs === undefined;
        let firstUnreadTs = firstExcludedPendingTs ?? Number.POSITIVE_INFINITY;
        const oversizedSessions = new Map<string, number>();
        for (const [index, read] of sinceReads.entries()) {
            if (!read.truncated) continue;
            // Without a reported first omitted timestamp, the final kept timestamp
            // is the earliest possible omission and is not safe to send itself.
            const unreadTs = read.firstOmittedTs ?? read.messages.at(-1)?.ts;
            if (unreadTs === undefined) {
                unknownBoundary = true;
                continue;
            }
            firstUnreadTs = Math.min(firstUnreadTs, unreadTs);
            const sessionId = sessionsToRead[index]?.sessionId;
            if (
                sessionId !== undefined &&
                read.firstOmittedTs !== undefined &&
                read.firstOmittedTs === oldestBySession?.get(sessionId)
            ) {
                oversizedSessions.set(sessionId, read.firstOmittedTs);
            }
        }

        // Read and prompt limits may split a timestamp, but a timestamp-only
        // watermark cannot. Admit only complete cohorts before the first unread row.
        const {
            kept: keptSince,
            budgetTruncated,
            oversized,
        } = admitRetrospectiveCohorts(
            allSince,
            unknownBoundary ? scanSinceMs : firstUnreadTs,
            maxMessages,
            promptInputLimitTokens,
        );
        const lastKept = keptSince.at(-1);
        let maxScannedTs = scanSinceMs;
        if (!unknownBoundary) {
            if (oversized) {
                maxScannedTs = oversized.ts;
                logSkippedRetrospectiveCohort(
                    oversized.rows.map(({ sessionId }) => sessionId),
                    maxScannedTs,
                    oversized.rows.length,
                    false,
                );
            } else if (lastKept) {
                maxScannedTs = lastKept.ts;
            } else if (Number.isFinite(firstUnreadTs)) {
                const blockedSessions = sessions.filter(
                    ({ session }) => oldestBySession?.get(session.sessionId) === firstUnreadTs,
                );
                const hitSessionReadCap = blockedSessions.some(
                    ({ session }) => oversizedSessions.get(session.sessionId) === firstUnreadTs,
                );
                if (hitSessionReadCap || blockedSessions.length > sessionLimit) {
                    // A session already overflowed on that one timestamp, or the
                    // group spans too many sessions. Unseen rows prevent an exact count.
                    maxScannedTs = firstUnreadTs;
                    logSkippedRetrospectiveCohort(
                        blockedSessions.map(({ session }) => session.sessionId),
                        maxScannedTs,
                        Math.max(blockedSessions.length, hitSessionReadCap ? capPerSession + 1 : 0),
                        true,
                    );
                } else {
                    maxScannedTs = Math.max(scanSinceMs, firstUnreadTs - 1);
                }
            } else if (oldestBySession && allSince.length === 0) {
                // Without pending user rows, pass observed assistant-only activity.
                for (const { session } of eligibleSessions) {
                    maxScannedTs = Math.max(maxScannedTs, session.updatedAt ?? scanSinceMs);
                }
            }
        }

        const keptSessionIds = new Set(keptSince.map((message) => message.sessionId));
        const overlapSessions = sessionsToRead.filter((session) =>
            keptSessionIds.has(session.sessionId),
        );
        const overlapBatches =
            overlapUserCount > 0 && watermarkMs > 0 && watermarkMs >= recencyCutoffMs
                ? await Promise.all(
                      overlapSessions.map((session) =>
                          provider.readUserMessagesBefore(
                              session.sessionId,
                              watermarkMs,
                              overlapUserCount,
                          ),
                      ),
                  )
                : [];

        const seen = new Set<string>();
        const merged = [...keptSince];
        const appendUnique = (row: RetrospectiveRawMessage): boolean => {
            const key = `${row.sessionId}\u0000${row.ts}\u0000${row.role}\u0000${row.toolName ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            merged.push(row);
            return true;
        };
        // Overlap is context only. Admit each row only if it leaves the same exact
        // child request below budget; dropping overlap never changes the frontier.
        const overlapRows = overlapBatches
            .flat()
            .filter((message) => message.ts >= recencyCutoffMs && message.ts <= watermarkMs)
            .map(clampRetrospectiveMessage)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        for (const row of overlapRows) {
            const beforeLength = merged.length;
            if (!appendUnique(row)) continue;
            merged.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
            if (
                promptInputLimitTokens !== undefined &&
                retrospectiveGatePromptTokens(merged) > promptInputLimitTokens
            ) {
                merged.splice(merged.indexOf(row), 1);
                seen.delete(
                    `${row.sessionId}\u0000${row.ts}\u0000${row.role}\u0000${row.toolName ?? ""}`,
                );
            }
            if (merged.length === beforeLength) continue;
        }
        merged.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        const promptTokens = retrospectiveGatePromptTokens(merged);

        return {
            messages: merged,
            maxScannedTs,
            promptTokens,
            ...(promptInputLimitTokens === undefined ? {} : { promptInputLimitTokens }),
            budgetTruncated,
        };
    } finally {
        provider.dispose?.();
    }
}

function readOpenCodeMessagesSince(
    db: Database,
    sessionId: string,
    sinceMs: number,
    capPerSession: number,
): RetrospectiveSinceRead {
    const limit = Math.max(1, Math.floor(capPerSession));
    // OLDEST-first: the cap must keep the OLDEST post-watermark messages so the
    // watermark advances forward through a backlog one bounded chunk per run.
    // Reading newest-first (the old behavior) dropped the oldest friction while
    // the watermark jumped to the newest → permanent loss of the gap.
    // Read limit+1 so a FULL limit is distinguishable from "exactly limit rows
    // exist" — the (limit+1)th row's existence is the exact truncation signal.
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT current.id, current.data, current.time_created,
                    EXISTS (
                        SELECT 1 FROM message assistant_reply
                         WHERE assistant_reply.session_id = current.session_id
                           AND json_valid(assistant_reply.data)
                           AND json_extract(assistant_reply.data, '$.role') = 'assistant'
                           AND (assistant_reply.time_created < current.time_created
                                OR (assistant_reply.time_created = current.time_created
                                    AND assistant_reply.id < current.id))
                           AND EXISTS (
                               SELECT 1 FROM message prior_user
                                WHERE prior_user.session_id = current.session_id
                                  AND json_valid(prior_user.data)
                                  AND json_extract(prior_user.data, '$.role') = 'user'
                                  AND (prior_user.time_created < assistant_reply.time_created
                                       OR (prior_user.time_created = assistant_reply.time_created
                                           AND prior_user.id < assistant_reply.id))
                           )
                    ) AS has_prior_assistant_reply
               FROM message current
              WHERE current.session_id = ? AND current.time_created > ?
              ORDER BY current.time_created ASC, current.id ASC
              LIMIT ?`,
        )
        .all(sessionId, sinceMs, limit + 1);
    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    const firstOmitted = rows[limit];
    return {
        messages: normalizeOpenCodeRows(db, sessionId, kept),
        truncated,
        ...(firstOmitted ? { firstOmittedTs: firstOmitted.time_created } : {}),
    };
}

function readOpenCodeOldestMessageTimesSince(
    db: Database,
    sessionIds: readonly string[],
    sinceMs: number,
): Map<string, number> {
    const result = new Map<string, number>();
    const uniqueIds = Array.from(new Set(sessionIds.filter((id) => id.length > 0)));
    const chunkSize = 500;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
            .prepare<unknown[], { session_id: string; oldest_ts: number }>(
                `SELECT session_id, MIN(time_created) AS oldest_ts
                   FROM message
                  WHERE time_created > ? AND session_id IN (${placeholders})
                  GROUP BY session_id`,
            )
            .all(sinceMs, ...chunk);
        for (const row of rows) {
            if (typeof row.oldest_ts === "number") result.set(row.session_id, row.oldest_ts);
        }
    }
    return result;
}

/**
 * The ~N most recent typed USER messages at or before `beforeMs` (the run
 * overlap). Lets the next run re-see friction that straddles the watermark
 * boundary. Over-reads a window of mixed rows (user/assistant/tool) then keeps
 * the newest `count` USER rows. Returns user-only — it feeds the gate's U-line
 * overlap, nothing else.
 */
function readOpenCodeUserMessagesBefore(
    db: Database,
    sessionId: string,
    beforeMs: number,
    count: number,
): RetrospectiveRawMessage[] {
    const want = Math.max(1, Math.floor(count));
    const window = Math.max(want * 5, 32);
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created <= ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, beforeMs, window)
        .reverse();
    const userRows = normalizeOpenCodeRows(db, sessionId, rows).filter((r) => r.role === "user");
    return userRows.slice(-want);
}

function normalizeOpenCodeRows(
    db: Database,
    sessionId: string,
    rows: OpenCodeMessageRow[],
): RetrospectiveRawMessage[] {
    if (rows.length === 0) return [];

    // Restrict the part read to the capped, globally unique message IDs we kept.
    // Unary `+` keeps the session check for cross-session safety while making the
    // bounded message-id predicate drive the stock OpenCode part index.
    const messageIds = rows.map((row) => row.id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const userIds = rows
        .filter((row) => parseJsonRecord(row.data)?.role === "user")
        .map((row) => row.id);
    const userPlaceholders = userIds.map(() => "?").join(", ") || "NULL";
    // Evaluate output/error evidence inside SQLite: returning full tool payloads
    // only to discard them after privacy filtering can exhaust the JS heap.
    const output = `CASE json_type(data, '$.state.output')
        WHEN 'text' THEN json_extract(data, '$.state.output')
        WHEN 'null' THEN '' ELSE COALESCE(data -> '$.state.output', '') END`;
    const error = `CASE json_type(data, '$.state.error')
        WHEN 'text' THEN json_extract(data, '$.state.error')
        WHEN 'null' THEN '' ELSE COALESCE(data -> '$.state.error', '') END`;
    const containsError = (value: string) =>
        ["error", "failed", "exception", "traceback"]
            .map((word) => `(' ' || lower(${value}) || ' ') GLOB '*[^a-z0-9_]${word}[^a-z0-9_]*'`)
            .join(" OR ");
    // JSON.stringify decodes escaped characters and re-escapes string leaves.
    // Inspect leaves/keys in SQL so object output has the same word boundaries.
    const errorWords = `CASE WHEN json_type(data, '$.state.output') IN ('object', 'array')
        THEN EXISTS (SELECT 1 FROM json_tree(data, '$.state.output') AS leaf
            WHERE (leaf.type = 'text' AND (${containsError("json_quote(leaf.atom)")}))
               OR (typeof(leaf.key) = 'text' AND (${containsError("json_quote(leaf.key)")})))
        WHEN instr(CAST(${output} AS BLOB), x'00') > 0 THEN EXISTS (
            WITH RECURSIVE segments(rest, piece) AS (
                SELECT CAST(${output} AS BLOB), x''
                UNION ALL
                SELECT CASE WHEN instr(rest, x'00') > 0
                           THEN substr(rest, instr(rest, x'00') + 1) ELSE NULL END,
                       CASE WHEN instr(rest, x'00') > 0
                           THEN substr(rest, 1, instr(rest, x'00') - 1) ELSE rest END
                  FROM segments WHERE rest IS NOT NULL
            ) SELECT 1 FROM segments WHERE (${containsError("CAST(piece AS TEXT)")}))
        ELSE (${containsError(output)}) END`;
    // JavaScript trim's whitespace set, not SQLite's space-only default.
    const whitespace =
        "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const partRows = db
        .prepare<string[], OpenCodePartRow>(
            `SELECT message_id, CASE json_extract(data, '$.type')
                WHEN 'text' THEN CASE WHEN message_id IN (${userPlaceholders}) THEN json_object(
                    'type', 'text', 'text', data -> '$.text',
                    'synthetic', data -> '$.synthetic', 'ignored', data -> '$.ignored') ELSE '{}' END
                WHEN 'tool' THEN json_object(
                    'type', 'tool', 'tool', data -> '$.tool',
                    'state', json_object('isError', json(CASE WHEN
                        json_type(data, '$.state.isError') = 'true'
                        OR lower(json_extract(data, '$.state.status')) = 'error'
                        OR length(CAST(trim(${error}, ?) AS BLOB)) > 0 OR ${errorWords}
                        THEN 'true' ELSE 'false' END)))
                ELSE '{}' END AS data
               FROM part
              WHERE +session_id = ? AND json_valid(data)
                AND likelihood(message_id IN (${placeholders}), 0.000001)
              ORDER BY time_created ASC, id ASC`,
        )
        .all(...userIds, whitespace, sessionId, ...messageIds);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessageId.get(row.message_id) ?? [];
        const parsed = parseJson(row.data);
        if (parsed !== null) parts.push(parsed);
        partsByMessageId.set(row.message_id, parts);
    }

    return rows.flatMap((row, index) => {
        const messageData = parseJsonRecord(row.data);
        if (!messageData) return [];
        if (messageData.summary === true && messageData.finish === "stop") return [];
        const role = typeof messageData.role === "string" ? messageData.role : "unknown";
        const parts = partsByMessageId.get(row.id) ?? [];
        const ordinal = index + 1;
        return normalizeOpenCodeMessage({
            sessionId,
            ordinal,
            role,
            parts,
            ts: row.time_created,
            followsAssistantReply: row.has_prior_assistant_reply === 1,
        });
    });
}

function normalizeOpenCodeMessage(args: {
    sessionId: string;
    ordinal: number;
    role: string;
    parts: unknown[];
    ts: number;
    followsAssistantReply: boolean;
}): RetrospectiveRawMessage[] {
    const rows: RetrospectiveRawMessage[] = [];
    // PRIVACY: retrospective reads OTHER sessions' raw history. Only genuine
    // typed USER text may carry its content into the friction window — that is
    // the friction the user expressed. Assistant text and raw tool OUTPUT can
    // contain file contents / secrets / paths from prior sessions, so we never
    // emit them. Tool rows carry metadata ONLY (name + error flag), which is all
    // the friction detectors need (repeated-call / error-burst); their `text`
    // stays empty so no raw output can reach the prompt. (Pi already returns
    // user-only — this keeps the two providers aligned.)
    if (args.role === "user") {
        const text = extractGenuineUserText(args.parts);
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "user",
                text,
                ts: args.ts,
                ...(args.followsAssistantReply ? { followsAssistantReply: true } : {}),
            });
        }
    }

    for (const tool of extractToolRows(args.parts)) {
        rows.push({
            sessionId: args.sessionId,
            ordinal: args.ordinal,
            role: "tool",
            text: "",
            toolName: tool.toolName,
            isError: tool.isError,
            ts: args.ts,
        });
    }

    return rows;
}

function extractGenuineUserText(parts: unknown[]): string {
    const nonSyntheticParts = parts.filter((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return true;
        const record = part as Record<string, unknown>;
        return record.synthetic !== true;
    });
    if (!hasMeaningfulUserText(nonSyntheticParts)) return "";
    return extractPlainText(nonSyntheticParts)
        .map((text) => cleanUserText(text))
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
}

function extractPlainText(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "text") continue;
        if (record.ignored === true || record.synthetic === true) continue;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
            texts.push(record.text.trim());
        }
    }
    return texts;
}

function extractToolRows(parts: unknown[]): Array<{
    toolName: string;
    text: string;
    isError: boolean;
}> {
    const rows: Array<{ toolName: string; text: string; isError: boolean }> = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool" || typeof record.tool !== "string") continue;
        const state = record.state;
        const stateRecord =
            state && typeof state === "object" ? (state as Record<string, unknown>) : {};
        const output = stringifyToolOutput(stateRecord.output);
        const errorText = stringifyToolOutput(stateRecord.error);
        const status = typeof stateRecord.status === "string" ? stateRecord.status : "";
        const isError =
            stateRecord.isError === true ||
            status.toLowerCase() === "error" ||
            errorText.length > 0 ||
            /\b(error|failed|exception|traceback)\b/i.test(output);
        rows.push({
            toolName: record.tool,
            text: output || errorText || `tool ${record.tool}`,
            isError,
        });
    }
    return rows;
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}
