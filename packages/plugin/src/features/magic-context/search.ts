import { log } from "../../shared/logger";
import { cleanSearchText, keywordRelevance, matchedSearchSnippet } from "../../shared/search-text";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    loadCompartmentChunkEmbeddingsForSearch,
    peekCompartmentChunkSearchPool,
    type StoredCompartmentChunkEmbedding,
    warmCompartmentChunkSearchPool,
} from "./compartment-chunk-embedding";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";
import {
    ensureMemoryEmbeddings,
    getMemoriesByProject,
    getMemoriesByProjects,
    getProjectEmbeddings,
    type Memory,
    ModuleMemoryAuthorityError,
    searchMemoriesFTS,
    searchMemoriesFTSUnion,
    updateMemoryRetrievalCount,
} from "./memory";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { embedText, getProjectEmbeddingSnapshot, isEmbeddingEnabled } from "./memory/embedding";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import { relaxedFtsQuery, sanitizeFtsQuery } from "./memory/storage-memory-fts";
import {
    MESSAGE_FTS_SESSION_FILTER_SQL,
    withMessageFtsSessionFilter,
} from "./message-fts-session-filter";
import { getIndexedMessageCorpusSize } from "./message-index";
import { getMessageIndexEpoch, isMessageIndexSearchable } from "./message-index-async";
import { recordShadowMeasurement } from "./search-measurement";
import {
    candidateTexts,
    emptySearchLanes,
    fuseSearchLanes,
    isProseQuery,
    logRerankFallback,
    prepareReranker,
    remoteRerankSkipped,
    rerankSearchResults,
    type SearchLanes,
} from "./search-rerank";
import { getNotes, type Note } from "./storage-notes";
import { getActivePrimers, type Primer } from "./storage-primers";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
    type WorkspaceIdentitySet,
} from "./workspaces";

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
/**
 * Upper bound on the results one search returns. The limit comes from the
 * model, and each tier fetches three times it, so without a bound a call like
 * `limit: 1e6` could dump the whole archive into one tool result. Matches the
 * Rust module's ctx_search clamp.
 */
export const MAX_UNIFIED_SEARCH_LIMIT = 25;
const FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/** Source boost multipliers for unified ranking.
 *
 * Memories are curated, hand-written summaries — strongest signal.
 * Git commits are terse human-written descriptions — high signal.
 * Messages are raw history that survived compression — boosted above baseline
 * because by definition these are the specific details the historian didn't
 * preserve as memories or compartments. The 1.275 calibration improved
 * conversation recall while preserving fact/rule recall. */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.275;
const GIT_COMMIT_SOURCE_BOOST = 1.2;
const PRIMER_SOURCE_BOOST = 1.25;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
    suppressedCount?: number;
    summaryOnly?: number;
    ftsRank?: number;
}

interface BatchedMessageSearchRow extends MessageSearchRow {
    queryIndex?: number;
    ftsRank?: number;
}

interface BatchedFtsCountRow {
    queryIndex?: number;
    count?: number;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithDateRange = new WeakMap<
    Database,
    Map<"all" | "cutoff", PreparedStatement>
>();
const messageSearchDiagnosticStatements = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchDiagnosticStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchDiagnosticStatementsWithDateRange = new WeakMap<Database, PreparedStatement>();
const batchedMessageSearchStatements = new WeakMap<Database, Map<string, PreparedStatement>>();
const batchedFtsCountStatements = new WeakMap<Database, Map<string, PreparedStatement>>();

export type SearchSource = "memory" | "message" | "git_commit" | "primer" | "note";

export interface CapturedQueryEmbedding {
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
}

export interface UnifiedSearchDiagnostics {
    suppressedVisibleMemoryIds: number[];
    suppressedLiveMessageMatches: number;
    gitCommitUnavailable: "no_git_repository" | null;
}

export function createUnifiedSearchDiagnostics(): UnifiedSearchDiagnostics {
    return {
        suppressedVisibleMemoryIds: [],
        suppressedLiveMessageMatches: 0,
        gitCommitUnavailable: null,
    };
}

export interface UnifiedSearchOptions {
    limit?: number;
    /** For automatic hints, score the share of query terms present instead of their relative FTS rank. */
    autoHint?: boolean;
    excludeMessageId?: string;
    /** Explicit searches alone may rerank; automatic hints never enter this path. */
    rerank?: boolean;
    rerankConnectionFile?: string;
    /** Optional service for offline comparisons and protocol tests. Null explicitly represents an unavailable Synapse service. */
    rerankClient?: SynapseClientLike | null;
    rerankConfig?: import("../../config/schema/magic-context").RerankConfig;
    onRerankSkipped?: (line: string) => void;
    /** Optional offline measurement sink, populated without repeating the original retrieval passes. */
    captureRerankLanes?: (lanes: SearchLanes) => void;
    /** Earliest persisted source timestamp in epoch milliseconds (inclusive). */
    from?: number;
    /** Latest persisted source timestamp in epoch milliseconds (inclusive). */
    to?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /** Deprecated: message search no longer reads raw messages on the hot path. */
    readMessages?: (sessionId: string) => unknown[];
    embedQuery?: (
        text: string,
        signal?: AbortSignal,
    ) => Promise<CapturedQueryEmbedding | Float32Array | null>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Include indexed git commits in the result set. Default false — the
     *  feature is gated behind experimental.git_commit_indexing config. */
    gitCommitsEnabled?: boolean;
    /** Restrict results to these sources. Omit or pass undefined to search all
     *  enabled sources. Empty array is treated as "no sources enabled" → [].
     *  Facts are NOT a source — they're already always rendered in the
     *  <session-history> block injected into message[0]. */
    sources?: SearchSource[];
    /** Hard-filter memories already rendered in <session-history>. The agent
     *  can see them in message[0] — surfacing them via ctx_search wastes
     *  tokens and crowds out high-signal raw-history hits. Pass null or omit
     *  to disable filtering (for callers outside the transform context that
     *  can't resolve the visible set). */
    visibleMemoryIds?: Set<number> | null;
    /** Optional mutable diagnostic sink for explicit tool calls. Search fills it
     *  from the same candidate sets used by visibility filters; background
     *  callers can omit it and retain the lean result-only path. */
    diagnostics?: UnifiedSearchDiagnostics;
    /** Whether the calling directory has git metadata. False lets the formatter
     *  distinguish an unavailable commit corpus from a genuine empty search. */
    gitRepositoryAvailable?: boolean;
    /** Abort signal — if provided, cancels in-flight embedding requests
     *  (and any downstream HTTP calls) when the caller gives up. Used by
     *  transform-hot-path callers like auto-search whose own 3s timeout
     *  needs to cancel the 30s embedding fetch. */
    signal?: AbortSignal;
    /** When true (default), increment retrieval_count on memory hits. Explicit
     *  `ctx_search` tool calls from the agent SHOULD count — the agent asked
     *  for the memory, saw it, and used it. Plugin-internal automatic surfacing
     *  (e.g. auto-search hints appended to every user prompt) should NOT count
     *  because the agent may never actually consume the hint, and even if they
     *  do, automatic surfacing doesn't indicate usefulness. Mis-counting drives
     *  spurious retrieval-count-based memory promotion decisions. */
    countRetrievals?: boolean;
    /** Automatic hints rank only stored vectors. Their backfill is a separate job. */
    backfillMemoryEmbeddings?: boolean;
    /** When true, run multi-probe message search: extract literal symbol/command/
     *  path probes from the query and query each one separately (RRF-fused) so a
     *  message containing the exact literal but not the query's other tokens is
     *  still recalled. Default false — only explicit `ctx_search` tool calls opt
     *  in; the auto-search hot path stays single-probe to protect its latency
     *  budget. NL queries with no extractable probes are unaffected either way. */
    explicitSearch?: boolean;
    /** Disables production search metrics while running an offline shadow quality comparison. */
    measurementDisabled?: boolean;
    embeddingModelIdOverride?: string;
    chunkModelIdOverride?: string;
    /**
     * Run the message-history lane somewhere other than the calling thread,
     * typically a worker with its own read-only connection. It must answer with
     * {@link searchMessageHistory} on the same store, so results and ranking are
     * those of the in-process lane. Resolving null (no file-backed store, or the
     * worker failed) runs the lane in process instead.
     */
    searchMessageHistory?: (
        request: MessageHistorySearchRequest,
    ) => Promise<MessageHistorySearchOutcome | null>;
    /**
     * Search the history-chunk vectors only when this thread's decoded pool for
     * the session is already warm (see `peekCompartmentChunkSearchPool`). A cold
     * pool leaves those vectors out of this search and starts a background warm
     * on this thread. Automatic hints set it, so a turn never waits for a pool
     * build.
     */
    chunkPoolWarmOnly?: boolean;
    /** Optional sink for how long each lane took. Durations and states only. */
    stepTimings?: UnifiedSearchStepTimings;
}

/** Durations, in milliseconds, of the parts of one {@link unifiedSearch}. */
export interface UnifiedSearchStepTimings {
    /** The message-history full-text lane. */
    messageMs?: number;
    /** Waiting for the query embedding after the message lane finished. */
    vectorWaitMs?: number;
    /** The history-chunk vector lane, including any pool load. */
    chunkMs?: number;
    /**
     * warm: searched an already decoded pool; cold: the pool was not warm, so
     * the lane was skipped; loaded: the pool was loaded (and refreshed) for this
     * search; no-vector: there was no query vector; off: the lane did not run.
     */
    chunkPool?: "warm" | "cold" | "loaded" | "no-vector" | "off";
    /** Memory, git-commit, primer and note lanes, which run together. */
    otherLanesMs?: number;
}

/** Everything the message-history lane needs, in a form a worker can receive. */
export interface MessageHistorySearchRequest {
    sessionId: string;
    query: string;
    limit: number;
    captureLimit?: number;
    maxOrdinal?: number;
    probes: string[];
    relaxedRecall?: boolean;
    /** The caller wants diagnostics; this also selects the diagnostic statements. */
    collectDiagnostics: boolean;
    dateRange: { from: number; to: number } | null;
}

export interface MessageHistorySearchOutcome {
    results: MessageSearchResult[];
    laneResults?: MessageSearchResult[];
    suppressedLiveMessageMatches: number;
}

/** The message-history lane of {@link unifiedSearch}, callable from a worker. */
export function searchMessageHistory(
    db: Database,
    request: MessageHistorySearchRequest,
): MessageHistorySearchOutcome {
    if (!isMessageIndexSearchable(request.sessionId))
        return { results: [], suppressedLiveMessageMatches: 0 };
    const diagnostics = request.collectDiagnostics ? createUnifiedSearchDiagnostics() : undefined;
    const capture = request.captureLimit
        ? { limit: request.captureLimit, results: [] as MessageSearchResult[] }
        : undefined;
    const results = searchMessages({
        db,
        sessionId: request.sessionId,
        query: request.query,
        limit: request.limit,
        maxOrdinal: request.maxOrdinal,
        probes: request.probes,
        relaxedRecall: request.relaxedRecall,
        diagnostics,
        dateRange: request.dateRange,
        capture,
    });
    return {
        results,
        laneResults: capture?.results,
        suppressedLiveMessageMatches: diagnostics?.suppressedLiveMessageMatches ?? 0,
    };
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    memoryId: number;
    category: string;
    matchType: "semantic" | "fts" | "hybrid";
    sourceName?: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
}

export interface CompartmentSearchResult {
    source: "compartment";
    content: string;
    score: number;
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    matchType: "semantic" | "hybrid";
    snippet?: string;
}

export interface GitCommitSearchResult {
    source: "git_commit";
    content: string;
    score: number;
    sha: string;
    shortSha: string;
    author: string | null;
    committedAtMs: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface PrimerSearchResult {
    source: "primer";
    content: string;
    score: number;
    primerId: number;
    question: string;
    support: number;
    lastObservedAt: number | null;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface NoteSearchResult {
    source: "note";
    content: string;
    score: number;
    noteId: number;
    status: Note["status"];
    createdAt: number;
    anchorOrdinal: number | null;
    sourceSessionId: string | null;
}

export type UnifiedSearchResult = (
    | MemorySearchResult
    | MessageSearchResult
    | CompartmentSearchResult
    | GitCommitSearchResult
    | PrimerSearchResult
    | NoteSearchResult
) & { relevanceScore?: number };

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.min(MAX_UNIFIED_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

interface InclusiveDateRange {
    from: number;
    to: number;
}

function normalizeDateRange(from?: number, to?: number): InclusiveDateRange | null {
    if (from === undefined && to === undefined) return null;
    return {
        from:
            typeof from === "number" && Number.isSafeInteger(from) ? from : Number.MIN_SAFE_INTEGER,
        to: typeof to === "number" && Number.isSafeInteger(to) ? to : Number.MAX_SAFE_INTEGER,
    };
}

function timestampIsInRange(timestamp: number, range: InclusiveDateRange | null): boolean {
    return range === null || (timestamp >= range.from && timestamp <= range.to);
}

// ID-shaped short-circuit: when the whole trimmed query is one memory id (with
// or without a leading `#`) or a comma/space-separated list of up to
// `ID_SHAPED_QUERY_MAX_TOKENS` such tokens, we treat it as a direct id lookup.
// Anything else — `"fix bug 1234"`, a quoted sentence containing a number — is
// left alone so the normal lexical+semantic lanes still run. Reused by
// ctx_search and any future consumer that needs to decide whether a query
// should bypass the normal search pipeline.
export const ID_SHAPED_QUERY_MAX_TOKENS = 5;
// Matches one ID token: an optional leading `#` followed by one or more digits.
// The `+` requires at least one digit, so a bare `#` does not match.
const ID_SHAPED_TOKEN = /^#?\d+$/;

export function parseIdShapedQuery(query: string): number[] | null {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return null;
    }
    const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
    if (tokens.length === 0 || tokens.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        return null;
    }
    const ids: number[] = [];
    for (const token of tokens) {
        if (!ID_SHAPED_TOKEN.test(token)) {
            return null;
        }
        const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null;
        }
        ids.push(parsed);
    }
    return ids;
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

interface SearchWorkspaceContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

function resolveSearchWorkspaceContext(
    db: Database,
    projectPath: string,
    identitySet?: WorkspaceIdentitySet,
): SearchWorkspaceContext {
    const resolved = identitySet ?? resolveWorkspaceIdentitySet(db, projectPath);
    const isWorkspaced = resolved.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(resolved.identities.map((identity) => [identity, identity]));
    const ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === projectPath,
    );
    return {
        identities: resolved.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced ? resolveWorkspaceShareCategories(db, projectPath) : null,
        namesByIdentity: resolved.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

function memoryWorkspaceIdentity(memory: Memory, workspace: SearchWorkspaceContext): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

function sourceNamesForSearchMemories(args: {
    memories: readonly Memory[];
    projectPath: string;
    workspace: SearchWorkspaceContext;
}): Map<number, string> | undefined {
    if (!args.workspace.isWorkspaced) return undefined;
    const sourceNames = new Map<number, string>();
    for (const memory of args.memories) {
        const source = sourceNameForMemory(
            memory.projectPath,
            args.projectPath,
            args.workspace.identities,
            args.workspace.namesByIdentity,
            args.workspace.canonicalIdentityByStoredPath,
        );
        if (source) sourceNames.set(memory.id, source);
    }
    return sourceNames.size > 0 ? sourceNames : undefined;
}

function getMessageSearchStatement(db: Database, sessionFirst: boolean): PreparedStatement {
    const statements = sessionFirst ? sessionFirstMessageSearchStatements : messageSearchStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}session_id = ?1 AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/**
 * Cutoff-aware variant: filters `message_ordinal <= cutoff` IN SQL, BEFORE the
 * LIMIT. The JS-side post-filter in runMessageFtsQuery applies the cutoff AFTER
 * fetching `LIMIT` rows, so when the top-ranked rows are all live-tail (above the
 * cutoff) they're fetched-then-discarded and older eligible hits below the limit
 * are never seen — explicit ctx_search could then return nothing. Pushing the
 * predicate into SQL makes LIMIT count only already-eligible rows.
 */
function getMessageSearchStatementWithCutoff(
    db: Database,
    sessionFirst: boolean,
): PreparedStatement {
    const statements = sessionFirst
        ? sessionFirstMessageSearchStatementsWithCutoff
        : messageSearchStatementsWithCutoff;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}session_id = ?1 AND message_history_fts MATCH ? AND CAST(message_ordinal AS INTEGER) <= ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/** Date predicates join through the rowid sidecar so NULL legacy times are excluded before LIMIT. */
function getMessageSearchStatementWithDateRange(
    db: Database,
    withCutoff: boolean,
): PreparedStatement {
    let statements = messageSearchStatementsWithDateRange.get(db);
    if (!statements) {
        statements = new Map();
        messageSearchStatementsWithDateRange.set(db, statements);
    }
    const key = withCutoff ? "cutoff" : "all";
    let statement = statements.get(key);
    if (!statement) {
        statement = db.prepare(
            `SELECT message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content
               FROM message_history_fts
               JOIN message_fts_rowid_map AS map
                 ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid
              WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}message_history_fts.session_id = ?1
                 AND message_history_fts MATCH ?
                 AND map.message_time_ms BETWEEN ? AND ?
                ${withCutoff ? "AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?" : ""}
              ORDER BY bm25(message_history_fts),
                       CAST(message_history_fts.message_ordinal AS INTEGER) ASC
              LIMIT ?`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Explicit tool searches need both eligible rows and the exact number of
 * matching live-tail rows. Materializing the FTS match set once keeps that
 * diagnostic from issuing a second search query, while the ordinary hot path
 * continues to use the narrower cutoff statement above. */
function getMessageSearchDiagnosticStatement(
    db: Database,
    sessionFirst: boolean,
): PreparedStatement {
    const statements = sessionFirst
        ? sessionFirstMessageSearchDiagnosticStatements
        : messageSearchDiagnosticStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_ordinal AS messageOrdinal,
                    message_id AS messageId,
                    role,
                    content,
                    CAST(message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}session_id = ?1 AND message_history_fts MATCH ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
        statements.set(db, stmt);
    }
    return stmt;
}

function getMessageSearchDiagnosticStatementWithDateRange(db: Database): PreparedStatement {
    let statement = messageSearchDiagnosticStatementsWithDateRange.get(db);
    if (!statement) {
        statement = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content,
                    CAST(message_history_fts.message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                JOIN message_fts_rowid_map AS map
                  ON map.session_id = message_history_fts.session_id
                 AND map.fts_rowid = message_history_fts.rowid
                WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}message_history_fts.session_id = ?1
                   AND message_history_fts MATCH ?
                   AND map.message_time_ms BETWEEN ? AND ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
        messageSearchDiagnosticStatementsWithDateRange.set(db, statement);
    }
    return statement;
}

function getBatchedFtsCountStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): PreparedStatement {
    let statements = batchedFtsCountStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedFtsCountStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}:${sessionFirst}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql =
            cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
        const joinSql =
            dateRange === null
                ? ""
                : ` JOIN message_fts_rowid_map AS map
                         ON map.session_id = message_history_fts.session_id
                        AND map.fts_rowid = message_history_fts.rowid`;
        const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
        statement = db.prepare(
            Array.from(
                { length: queryCount },
                (_, index) =>
                    `SELECT ${index} AS queryIndex, COUNT(*) AS count
                       FROM message_history_fts${joinSql}
                      WHERE ${sessionFirst || dateRange !== null ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ${index === 0 ? "?1" : "?"}
                         AND message_history_fts MATCH ?${dateSql}${cutoffSql}`,
            ).join("\nUNION ALL\n"),
        );
        statements.set(key, statement);
    }
    return statement;
}

/**
 * Restrict a sanitized message FTS query to the `content` column. The table
 * also indexes `role`, so a bare query for "user" or "assistant" (or any term
 * porter-stemming to them, such as "users") would otherwise match every message
 * of that role. Applied to the bound MATCH value so the SQL text is unchanged.
 */
function contentOnlyMessageQuery(ftsQuery: string): string {
    return ftsQuery.length === 0 ? "" : `content : (${ftsQuery})`;
}

/** Read all per-probe document frequencies in one SQLite statement. */
function countSessionFtsMatchesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): number[] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(sessionId, contentOnlyMessageQuery(query));
        if (dateRange !== null) bindings.push(dateRange.from, dateRange.to);
        if (cutoff !== null) bindings.push(cutoff);
    }
    try {
        const rows = getBatchedFtsCountStatement(
            db,
            ftsQueries.length,
            cutoff,
            dateRange,
            sessionFirst,
        ).all(...bindings) as BatchedFtsCountRow[];
        const counts = Array.from({ length: ftsQueries.length }, () => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        // Malformed FTS syntax that survived sanitization is non-discriminative.
        return Array.from({ length: ftsQueries.length }, () => 0);
    }
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

async function getSemanticScores(args: {
    db: Database;
    projectPath: string;
    memories: Memory[];
    /** Pre-computed query embedding. Pass `null` to skip semantic scoring
     *  (e.g. embedding disabled, query embed failed, runtime not ready).
     *  unifiedSearch is responsible for computing this once and passing the
     *  same vector to memory + git-commit searches so we never embed the
     *  same query twice in parallel. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
    backfillMemoryEmbeddings?: boolean;
}): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (
        !args.queryEmbedding ||
        args.memories.length === 0 ||
        !args.queryModelId ||
        args.queryModelId === "off"
    ) {
        return semanticScores;
    }

    if (!args.workspace?.isWorkspaced) {
        const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
        const embeddings =
            args.backfillMemoryEmbeddings === false
                ? cachedEmbeddings
                : await ensureMemoryEmbeddings({
                      db: args.db,
                      projectIdentity: args.projectPath,
                      memories: args.memories,
                      existingEmbeddings: cachedEmbeddings,
                  });

        for (const memory of args.memories) {
            const memoryEmbedding = embeddings.get(memory.id);
            if (!memoryEmbedding) {
                continue;
            }

            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }

        return semanticScores;
    }

    const workspace = args.workspace;
    const memoriesByIdentity = new Map<string, Memory[]>();
    for (const memory of args.memories) {
        const identity = memoryWorkspaceIdentity(memory, workspace);
        if (!identity) continue;
        const list = memoriesByIdentity.get(identity) ?? [];
        list.push(memory);
        memoriesByIdentity.set(identity, list);
    }

    const ownMemories = memoriesByIdentity.get(args.projectPath) ?? [];
    if (ownMemories.length > 0 && args.backfillMemoryEmbeddings !== false) {
        const ownEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
        await ensureMemoryEmbeddings({
            db: args.db,
            projectIdentity: args.projectPath,
            memories: ownMemories,
            existingEmbeddings: ownEmbeddings,
        });
    }

    for (const identity of workspace.identities) {
        const memberMemories = memoriesByIdentity.get(identity) ?? [];
        if (memberMemories.length === 0) continue;
        const cachedEmbeddings = getProjectEmbeddings(args.db, identity, args.queryModelId);
        for (const memory of memberMemories) {
            const memoryEmbedding = cachedEmbeddings.get(memory.id);
            if (!memoryEmbedding || memoryEmbedding.modelId !== args.queryModelId) continue;
            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }
    }

    return semanticScores;
}

function getFtsMatches(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    workspace?: SearchWorkspaceContext;
    dateRange: InclusiveDateRange | null;
}): Memory[] {
    try {
        return args.workspace?.isWorkspaced
            ? searchMemoriesFTSUnion(
                  args.db,
                  args.workspace.expandedIdentities,
                  args.query,
                  args.limit,
                  args.workspace.ownIdentities,
                  args.workspace.shareCategories,
                  args.dateRange,
              )
            : searchMemoriesFTS(args.db, args.projectPath, args.query, args.limit, args.dateRange);
    } catch (error) {
        log(
            `[search] FTS query failed for "${args.query}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}

function getFtsScores(matches: Memory[]): Map<number, number> {
    return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
}

function selectSemanticCandidates(args: {
    db: Database;
    memories: Memory[];
    projectPath: string;
    ftsMatches: Memory[];
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
}): Memory[] {
    if (args.ftsMatches.length === 0) {
        return args.memories;
    }

    const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
    if (args.queryModelId && args.queryModelId !== "off") {
        const embeddingProjects = args.workspace?.isWorkspaced
            ? args.workspace.identities
            : [args.projectPath];
        for (const projectPath of embeddingProjects) {
            // Load (not peek) the stored vectors: a cold or expired cache would
            // otherwise shrink the candidate set to the FTS hits alone and drop
            // every memory that only matches by meaning.
            const storedEmbeddings = getProjectEmbeddings(args.db, projectPath, args.queryModelId);
            for (const memoryId of storedEmbeddings.keys()) {
                candidateIds.add(memoryId);
            }
        }
    }

    return args.memories.filter((memory) => candidateIds.has(memory.id));
}

function mergeMemoryResults(args: {
    memories: Memory[];
    semanticScores: Map<number, number>;
    ftsScores: Map<number, number>;
    limit: number;
    visibleMemoryIds?: Set<number> | null;
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
    singleSourcePenalty?: number;
}): { results: MemorySearchResult[]; suppressedVisibleIds: number[] } {
    const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
    const results: MemorySearchResult[] = [];
    const suppressedVisibleIds: number[] = [];

    for (const id of candidateIds) {
        const memory = memoryById.get(id);
        if (!memory) {
            continue;
        }

        const semanticScore = args.semanticScores.get(id);
        const ftsScore = args.ftsScores.get(id);
        let score = 0;
        let matchType: MemorySearchResult["matchType"] = "fts";

        if (semanticScore !== undefined && ftsScore !== undefined) {
            score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
            matchType = "hybrid";
        } else if (semanticScore !== undefined) {
            score = semanticScore * (args.singleSourcePenalty ?? SINGLE_SOURCE_PENALTY);
            matchType = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            matchType = "fts";
        }

        if (score <= 0) {
            continue;
        }

        // Record candidates before dropping them so an empty result can explain
        // that search worked and the matching memories are already in context.
        if (args.visibleMemoryIds?.has(id)) {
            suppressedVisibleIds.push(id);
            continue;
        }

        results.push({
            source: "memory",
            content: previewText(memory.content),
            score,
            memoryId: memory.id,
            category: memory.category,
            matchType,
            sourceName: args.sourceNameByMemoryId?.get(memory.id),
        });
    }

    return {
        results: results
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                return left.memoryId - right.memoryId;
            })
            .slice(0, args.limit),
        suppressedVisibleIds: suppressedVisibleIds.sort((left, right) => left - right),
    };
}

async function searchMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    memoryEnabled: boolean;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchGitCommitsAsync — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
    visibleMemoryIds?: Set<number> | null;
    dateRange: InclusiveDateRange | null;
    backfillMemoryEmbeddings?: boolean;
    lanes?: SearchLanes;
}): Promise<{ results: MemorySearchResult[]; suppressedVisibleIds: number[] }> {
    if (!args.memoryEnabled) {
        return { results: [], suppressedVisibleIds: [] };
    }

    const unfilteredMemories = args.workspace?.isWorkspaced
        ? getMemoriesByProjects(
              args.db,
              args.workspace.expandedIdentities,
              ["active", "permanent"],
              Date.now(),
              args.workspace.ownIdentities,
              args.workspace.shareCategories,
          )
        : getMemoriesByProject(args.db, args.projectPath);
    const memories = unfilteredMemories.filter((memory) =>
        timestampIsInRange(memory.createdAt, args.dateRange),
    );
    if (memories.length === 0) {
        return { results: [], suppressedVisibleIds: [] };
    }

    const ftsMatches = getFtsMatches({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
        workspace: args.workspace,
        dateRange: args.dateRange,
    });
    const ftsScores = getFtsScores(ftsMatches);
    const semanticCandidates = selectSemanticCandidates({
        db: args.db,
        memories,
        projectPath: args.projectPath,
        ftsMatches,
        queryModelId: args.queryModelId,
        workspace: args.workspace,
    });
    const semanticScores = await getSemanticScores({
        db: args.db,
        projectPath: args.projectPath,
        memories: semanticCandidates,
        backfillMemoryEmbeddings: args.backfillMemoryEmbeddings,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        workspace: args.workspace,
    });

    const sourceNameByMemoryId = sourceNamesForSearchMemories({
        memories,
        projectPath: args.projectPath,
        workspace: args.workspace ?? {
            identities: [args.projectPath],
            expandedIdentities: [args.projectPath],
            namesByIdentity: new Map(),
            canonicalIdentityByStoredPath: new Map([[args.projectPath, args.projectPath]]),
            ownIdentities: [args.projectPath],
            shareCategories: null,
            isWorkspaced: false,
        },
    });
    if (args.lanes) {
        args.lanes.memory_fts = mergeMemoryResults({
            memories,
            semanticScores: new Map(),
            ftsScores,
            sourceNameByMemoryId,
            limit: 25,
            visibleMemoryIds: args.visibleMemoryIds,
        }).results;
        args.lanes.memory_vector = mergeMemoryResults({
            memories,
            semanticScores,
            ftsScores: new Map(),
            sourceNameByMemoryId,
            singleSourcePenalty: 1,
            limit: 25,
            visibleMemoryIds: args.visibleMemoryIds,
        }).results;
    }
    return mergeMemoryResults({
        memories,
        semanticScores,
        ftsScores,
        limit: args.limit,
        visibleMemoryIds: args.visibleMemoryIds,
        sourceNameByMemoryId,
    });
}

/** Linear decay message scoring.
 *
 * The old formula (1 / (rank+1)) collapsed quickly: rank-0 = 1.0, rank-1 = 0.5,
 * rank-2 = 0.33, rank-5 = 0.17. In practice only the #1 message hit could
 * compete with boosted memories, so all secondary message matches got buried.
 *
 * Linear decay (1 - rank/limit) keeps signal across the returned window:
 * rank-0 = 1.0, rank-1 = 0.9, rank-2 = 0.8, rank-9 = 0.1. Combined with the
 * bumped MESSAGE_SOURCE_BOOST this lets raw-history hits actually compete. */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    content: string;
}

/** Convert one FTS row into the validated shape consumed by message ranking. */
function normalizeMessageSearchRow(
    row: MessageSearchRow,
    cutoff: number | null,
): NormalizedMessageRow | null {
    const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
    if (
        messageOrdinal === null ||
        typeof row.messageId !== "string" ||
        typeof row.role !== "string" ||
        typeof row.content !== "string"
    ) {
        return null;
    }
    // Defense-in-depth: every SQL path applies the cutoff before LIMIT.
    if (cutoff !== null && messageOrdinal > cutoff) return null;
    return {
        messageOrdinal,
        messageId: row.messageId,
        role: row.role,
        content: row.content,
    };
}

/** Run one FTS query and return ordinal-cutoff-filtered, validated rows in
 * bm25 rank order. `ftsQuery` must already be sanitized. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    let rawRows: unknown[];
    const matchQuery = contentOnlyMessageQuery(ftsQuery);
    if (dateRange !== null) {
        const bindings: unknown[] = [sessionId, matchQuery, dateRange.from, dateRange.to];
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
        rawRows = getMessageSearchStatementWithDateRange(db, cutoff !== null).all(...bindings);
    } else {
        rawRows =
            cutoff !== null
                ? getMessageSearchStatementWithCutoff(db, sessionFirst).all(
                      sessionId,
                      matchQuery,
                      cutoff,
                      fetchLimit,
                  )
                : getMessageSearchStatement(db, sessionFirst).all(
                      sessionId,
                      matchQuery,
                      fetchLimit,
                  );
    }
    const rows = rawRows.map((row) => row as MessageSearchRow);

    const result: NormalizedMessageRow[] = [];
    for (const row of rows) {
        const normalized = normalizeMessageSearchRow(row, cutoff);
        if (normalized) result.push(normalized);
    }
    return result;
}

function runMessageFtsQueryWithDiagnostics(args: {
    db: Database;
    sessionId: string;
    ftsQuery: string;
    fetchLimit: number;
    cutoff: number;
    dateRange: InclusiveDateRange | null;
    sessionFirst: boolean;
}): { rows: NormalizedMessageRow[]; suppressedCount: number } {
    if (args.ftsQuery.length === 0) return { rows: [], suppressedCount: 0 };
    const matchQuery = contentOnlyMessageQuery(args.ftsQuery);
    const rawRows = (
        args.dateRange === null
            ? getMessageSearchDiagnosticStatement(args.db, args.sessionFirst).all(
                  args.sessionId,
                  matchQuery,
                  args.cutoff,
                  args.fetchLimit,
                  args.cutoff,
              )
            : getMessageSearchDiagnosticStatementWithDateRange(args.db).all(
                  args.sessionId,
                  matchQuery,
                  args.dateRange.from,
                  args.dateRange.to,
                  args.cutoff,
                  args.fetchLimit,
                  args.cutoff,
              )
    ).map((row) => row as MessageSearchRow);
    const suppressedCount = rawRows[0]?.suppressedCount ?? 0;
    const rows: NormalizedMessageRow[] = [];
    for (const row of rawRows) {
        if (row.summaryOnly === 1) continue;
        const normalized = normalizeMessageSearchRow(row, args.cutoff);
        if (normalized) rows.push(normalized);
    }
    return { rows, suppressedCount };
}

function getBatchedMessageSearchStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): PreparedStatement {
    let statements = batchedMessageSearchStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedMessageSearchStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}:${sessionFirst}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql =
            cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
        const joinSql =
            dateRange === null
                ? ""
                : ` JOIN message_fts_rowid_map AS map
                         ON map.session_id = message_history_fts.session_id
                        AND map.fts_rowid = message_history_fts.rowid`;
        const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
        const branches = Array.from(
            { length: queryCount },
            (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_history_fts.message_ordinal AS messageOrdinal,
                       message_history_fts.message_id AS messageId,
                       message_history_fts.role AS role,
                       message_history_fts.content AS content,
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts${joinSql}
                 WHERE ${sessionFirst || dateRange !== null ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ${index === 0 ? "?1" : "?"}
                    AND message_history_fts MATCH ?${dateSql}${cutoffSql}
                 ORDER BY ftsRank
                 LIMIT ?
            )`,
        );
        statement = db.prepare(
            `${branches.join("\nUNION ALL\n")}\nORDER BY queryIndex ASC, ftsRank ASC`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Run all base/probe result queries as one compound SQLite statement. */
function runMessageFtsQueriesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    fetchLimit: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): NormalizedMessageRow[][] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(sessionId, contentOnlyMessageQuery(query));
        if (dateRange !== null) bindings.push(dateRange.from, dateRange.to);
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
    }
    const rows = getBatchedMessageSearchStatement(
        db,
        ftsQueries.length,
        cutoff,
        dateRange,
        sessionFirst,
    ).all(...bindings) as BatchedMessageSearchRow[];
    const result = Array.from({ length: ftsQueries.length }, () => [] as NormalizedMessageRow[]);
    for (const row of rows) {
        if (
            typeof row.queryIndex !== "number" ||
            row.queryIndex < 0 ||
            row.queryIndex >= result.length
        ) {
            continue;
        }
        const normalized = normalizeMessageSearchRow(row, cutoff);
        if (normalized) result[row.queryIndex].push(normalized);
    }
    return result;
}

// Reciprocal-rank-fusion constant. 60 is the canonical RRF k; it dampens the
// reward gap between rank-0 and rank-1 so a candidate that appears in several
// probe lists outranks one that tops a single list.
const RRF_K = 60;
// Verbatim containment is worth one extra rank-0 list appearance — the same
// 1/RRF_K currency as the fused lists. The previous flat +0.5 bonus lived 30×
// above the RRF scale (max list contribution is 1/60 ≈ 0.017), so every
// verbatim hit saturated; after divide-by-max normalization all scores
// flattened into a ~0.95–1.0 band, and at the unified layer those ~1.0 scores
// × MESSAGE_SOURCE_BOOST crowded every memory hit out of the result set.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
// Probe discrimination weighting: a probe matching a large share of the
// session's corpus (common acronyms, generic identifiers) carries near-zero
// signal — bm25 over a single common term is nearly flat, so its ranked list
// is noise. Weight each probe list (and its verbatim bonus) by a smooth
// document-frequency falloff: w = 1 / (1 + IDF_FALLOFF · df/N).
// df/N = 0.1% → 0.91, 1% → 0.50, 2% → 0.33, 10% → 0.09.
const IDF_FALLOFF = 100;

/** Smooth document-frequency weight for one probe within a session corpus. */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
    /** Literal probes to additionally query (multi-probe recall). Empty = the
     * original single-query behavior (unchanged for NL queries / hot path). */
    probes?: string[];
    relaxedRecall?: boolean;
    diagnostics?: UnifiedSearchDiagnostics;
    dateRange: InclusiveDateRange | null;
    capture?: { limit: number; results: MessageSearchResult[] };
}): MessageSearchResult[] {
    return withMessageFtsSessionFilter(args.db, args.sessionId, (sessionFirst) =>
        searchMessagesInSnapshot(args, sessionFirst),
    );
}

function searchMessagesInSnapshot(
    args: Parameters<typeof searchMessages>[0],
    sessionFirst: boolean,
): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const baselineFetchLimit = cutoff !== null ? args.limit * 3 : args.limit;
    const captureFetchLimit = args.capture
        ? cutoff !== null
            ? args.capture.limit * 3
            : args.capture.limit
        : 0;
    const fetchLimit = Math.max(baselineFetchLimit, captureFetchLimit);

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];

    // No probes → original single-query path, byte-identical scoring. This is
    // the hot path (auto-search) and every plain natural-language query.
    if (probes.length === 0) {
        const outcome =
            args.diagnostics && cutoff !== null
                ? runMessageFtsQueryWithDiagnostics({
                      db: args.db,
                      sessionId: args.sessionId,
                      ftsQuery: baseQuery,
                      fetchLimit,
                      cutoff,
                      dateRange: args.dateRange,
                      sessionFirst,
                  })
                : {
                      rows: runMessageFtsQuery(
                          args.db,
                          args.sessionId,
                          baseQuery,
                          fetchLimit,
                          cutoff,
                          args.dateRange,
                          sessionFirst,
                      ),
                      suppressedCount: 0,
                  };
        if (args.diagnostics) {
            args.diagnostics.suppressedLiveMessageMatches = outcome.suppressedCount;
        }
        // Exact conjunctions remain the ranking authority; only empty searches
        // need a disjunction to recover a relevant term from a long question.
        const rows =
            outcome.rows.length > 0 || !args.relaxedRecall
                ? outcome.rows
                : runMessageFtsQuery(
                      args.db,
                      args.sessionId,
                      relaxedFtsQuery(args.query),
                      fetchLimit,
                      cutoff,
                      args.dateRange,
                      sessionFirst,
                  );
        const renderRows = (limit: number) => {
            const filtered = rows.slice(0, limit);
            return filtered.map(
                (row, rank): MessageSearchResult => ({
                    source: "message",
                    content:
                        matchedSearchSnippet(row.content, args.query) || previewText(row.content),
                    score: linearDecayScore(rank, filtered.length),
                    messageOrdinal: row.messageOrdinal,
                    messageId: row.messageId,
                    role: row.role,
                }),
            );
        };
        if (args.capture) args.capture.results = renderRows(args.capture.limit);
        return renderRows(args.limit);
    }

    // Multi-probe: run the full query plus every literal probe as separate FTS
    // rankings, but batch each phase into one compound SQLite statement. This
    // preserves independent bm25 ranks while avoiding statement amplification.
    const sanitizedProbes = probes
        .map((probe) => ({ probe, query: sanitizeFtsQuery(probe) }))
        .filter((entry) => entry.query.length > 0);
    const corpusSize = getIndexedMessageCorpusSize(args.db, args.sessionId, cutoff);
    const probeCounts = countSessionFtsMatchesBatch(
        args.db,
        args.sessionId,
        sanitizedProbes.map((entry) => entry.query),
        cutoff,
        args.dateRange,
        sessionFirst,
    );
    const collectBaseDiagnostics = args.diagnostics !== undefined && cutoff !== null;
    const baseOutcome =
        collectBaseDiagnostics && baseQuery.length > 0
            ? runMessageFtsQueryWithDiagnostics({
                  db: args.db,
                  sessionId: args.sessionId,
                  ftsQuery: baseQuery,
                  fetchLimit,
                  cutoff,
                  dateRange: args.dateRange,
                  sessionFirst,
              })
            : null;
    if (args.diagnostics) {
        args.diagnostics.suppressedLiveMessageMatches = baseOutcome?.suppressedCount ?? 0;
    }
    const searchQueries = [
        ...(!collectBaseDiagnostics && baseQuery.length > 0 ? [baseQuery] : []),
        ...sanitizedProbes.map((entry) => entry.query),
    ];
    const rowsByQuery = runMessageFtsQueriesBatch(
        args.db,
        args.sessionId,
        searchQueries,
        fetchLimit,
        cutoff,
        args.dateRange,
        sessionFirst,
    );

    const queryLists: Array<{ rows: NormalizedMessageRow[]; weight: number }> = [];
    let queryIndex = 0;
    if (baseQuery.length > 0) {
        queryLists.push({
            rows: baseOutcome?.rows ?? rowsByQuery[queryIndex] ?? [],
            // The full query is AND-joined and inherently discriminative.
            weight: 1,
        });
        if (!collectBaseDiagnostics) queryIndex += 1;
    }
    const probeWeights = new Map<string, number>();
    sanitizedProbes.forEach((entry, probeIndex) => {
        const weight = probeDiscriminationWeight(probeCounts[probeIndex] ?? 0, corpusSize);
        probeWeights.set(entry.probe, weight);
        queryLists.push({ rows: rowsByQuery[queryIndex] ?? [], weight });
        queryIndex += 1;
    });

    const rankProbeLists = (rowLimit: number, resultLimit: number) => {
        const fused = new Map<string, { row: NormalizedMessageRow; score: number }>();
        for (const list of queryLists) {
            list.rows.slice(0, rowLimit).forEach((row, rank) => {
                const rrf = list.weight / (RRF_K + rank);
                const existing = fused.get(row.messageId);
                if (existing) {
                    existing.score += rrf;
                } else {
                    fused.set(row.messageId, { row, score: rrf });
                }
            });
        }

        // Verbatim matches get one extra first-place contribution from their most
        // discriminative probe, rather than a large fixed bonus that would flatten
        // the differences between ranks.
        for (const entry of fused.values()) {
            let best = 0;
            for (const probe of probes) {
                const weight = probeWeights.get(probe) ?? 0;
                if (weight > best && containsProbeVerbatim(entry.row.content, [probe])) {
                    best = weight;
                }
            }
            if (best > 0) {
                entry.score += best * VERBATIM_RANK_BONUS;
            }
        }

        const ranked = [...fused.values()]
            .sort((a, b) =>
                b.score !== a.score
                    ? b.score - a.score
                    : a.row.messageOrdinal - b.row.messageOrdinal,
            )
            .slice(0, resultLimit);

        // Convert probe-fused message ranks to the same linear scores as ordinary
        // message FTS results, preserving comparability with the other sources.
        return ranked.map((entry, rank) => ({
            source: "message" as const,
            content:
                matchedSearchSnippet(entry.row.content, args.query) ||
                previewText(entry.row.content),
            score: linearDecayScore(rank, ranked.length),
            messageOrdinal: entry.row.messageOrdinal,
            messageId: entry.row.messageId,
            role: entry.row.role,
        }));
    };
    if (args.capture) args.capture.results = rankProbeLists(captureFetchLimit, args.capture.limit);
    return rankProbeLists(baselineFetchLimit, args.limit);
}

const NOTE_SEARCHABLE_STATUSES: Note["status"][] = ["active", "pending", "ready"];
const MAX_NOTE_KEYWORD_SCORE = 3.5;

function noteSearchText(note: Note): string {
    const reason = note.readyReason?.trim();
    return reason
        ? `${note.content}
Reason: ${reason}`
        : note.content;
}

function tokenizeKeywordNeedle(text: string): string[] {
    const matches = text.toLowerCase().match(/[a-z0-9/._:-]+/g) ?? [];
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const match of matches) {
        if (match.length <= 1 || !/[a-z0-9]/.test(match) || seen.has(match)) {
            continue;
        }
        seen.add(match);
        tokens.push(match);
    }
    return tokens;
}

interface RankedNoteMatch {
    note: Note;
    score: number;
    text: string;
}

function normalizeNoteKeywordScore(score: number): number {
    return normalizeCosineScore(score / MAX_NOTE_KEYWORD_SCORE) * SINGLE_SOURCE_PENALTY;
}

function rankNotesForNeedle(notes: readonly Note[], needle: string): RankedNoteMatch[] {
    const normalizedNeedle = needle.trim().toLowerCase();
    if (normalizedNeedle.length === 0) {
        return [];
    }
    const needleTokens = tokenizeKeywordNeedle(normalizedNeedle);
    const ranked: RankedNoteMatch[] = [];
    for (const note of notes) {
        const text = noteSearchText(note);
        const normalizedText = text.toLowerCase();
        const noteTokens = new Set(tokenizeKeywordNeedle(normalizedText));
        const exact = normalizedText.includes(normalizedNeedle);
        const matchedTokens = needleTokens.filter((token) => noteTokens.has(token)).length;
        if (!exact && matchedTokens === 0) {
            continue;
        }
        const matchedUniqueTokens = new Set(needleTokens.filter((token) => noteTokens.has(token)))
            .size;
        const coverage = needleTokens.length > 0 ? matchedTokens / needleTokens.length : 0;
        const density = noteTokens.size > 0 ? matchedUniqueTokens / noteTokens.size : 0;
        const exactPhrase =
            exact && (needleTokens.length > 1 || normalizedText.trim() === normalizedNeedle);
        const allTokens = needleTokens.length > 1 && matchedTokens === needleTokens.length;
        const score = (exactPhrase ? 2 : 0) + coverage * density + (allTokens ? 0.5 * density : 0);
        ranked.push({ note, score, text });
    }
    return ranked.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        if (right.note.createdAt !== left.note.createdAt) {
            return right.note.createdAt - left.note.createdAt;
        }
        return left.note.id - right.note.id;
    });
}

function searchNotes(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    query: string;
    limit: number;
    probes?: string[];
    dateRange: InclusiveDateRange | null;
}): NoteSearchResult[] {
    if (args.limit <= 0) {
        return [];
    }

    const notes = [
        ...getNotes(args.db, {
            sessionId: args.sessionId,
            type: "session",
            status: NOTE_SEARCHABLE_STATUSES,
        }),
        ...getNotes(args.db, {
            projectPath: args.projectPath,
            type: "smart",
            status: NOTE_SEARCHABLE_STATUSES,
        }),
    ].filter((note) => timestampIsInRange(note.createdAt, args.dateRange));
    if (notes.length === 0) {
        return [];
    }

    const baseList = rankNotesForNeedle(notes, args.query);
    const probes = args.probes ?? [];

    if (probes.length === 0) {
        const ranked = baseList.slice(0, args.limit);
        return ranked.map((entry) => ({
            source: "note" as const,
            content: previewText(entry.text),
            score: normalizeNoteKeywordScore(entry.score),
            noteId: entry.note.id,
            status: entry.note.status,
            createdAt: entry.note.createdAt,
            anchorOrdinal: entry.note.anchorOrdinal,
            sourceSessionId: entry.note.sessionId,
        }));
    }

    const queryLists: Array<{ rows: RankedNoteMatch[]; weight: number }> = [];
    if (baseList.length > 0) {
        queryLists.push({ rows: baseList, weight: 1 });
    }
    for (const probe of probes) {
        const rows = rankNotesForNeedle(notes, probe);
        if (rows.length === 0) {
            continue;
        }
        const weight = probeDiscriminationWeight(rows.length, notes.length);
        queryLists.push({ rows, weight });
    }

    const fused = new Map<number, { entry: RankedNoteMatch; score: number }>();
    for (const list of queryLists) {
        for (const row of list.rows) {
            const relevance = row.score * list.weight;
            const existing = fused.get(row.note.id);
            if (existing) {
                if (relevance > existing.score) {
                    existing.entry = row;
                    existing.score = relevance;
                }
            } else {
                fused.set(row.note.id, { entry: row, score: relevance });
            }
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            if (right.entry.note.createdAt !== left.entry.note.createdAt) {
                return right.entry.note.createdAt - left.entry.note.createdAt;
            }
            return left.entry.note.id - right.entry.note.id;
        })
        .slice(0, args.limit);

    return ranked.map((entry) => ({
        source: "note" as const,
        content: previewText(entry.entry.text),
        score: normalizeNoteKeywordScore(entry.score),
        noteId: entry.entry.note.id,
        status: entry.entry.note.status,
        createdAt: entry.entry.note.createdAt,
        anchorOrdinal: entry.entry.note.anchorOrdinal,
        sourceSessionId: entry.entry.note.sessionId,
    }));
}

async function searchCompartmentChunks(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    queryEmbedding: Float32Array | null;
    limit: number;
    maxOrdinal?: number;
    modelId?: string | null;
    dateRange: InclusiveDateRange | null;
    warmOnly?: boolean;
    signal?: AbortSignal;
    timings?: UnifiedSearchStepTimings;
}): Promise<CompartmentSearchResult[]> {
    if (args.limit <= 0 || !args.modelId || args.modelId === "off") {
        if (args.timings) args.timings.chunkPool = "off";
        return [];
    }
    if (!args.queryEmbedding) {
        if (args.timings) args.timings.chunkPool = "no-vector";
        // A late query vector is common for automatic hints. Warm the pool now
        // anyway, so a later turn whose vector does arrive finds it ready.
        if (args.warmOnly)
            void warmCompartmentChunkSearchPool(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
            );
        return [];
    }
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    let rows: StoredCompartmentChunkEmbedding[];
    if (args.warmOnly) {
        const warm = peekCompartmentChunkSearchPool(
            args.db,
            args.sessionId,
            args.projectPath,
            args.modelId,
            args.dateRange,
        );
        if (warm === null) {
            if (args.timings) args.timings.chunkPool = "cold";
            // Never throws. It runs between this thread's later work, which
            // already yields between pages and batches.
            void warmCompartmentChunkSearchPool(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
            );
            return [];
        }
        if (args.timings) args.timings.chunkPool = "warm";
        rows = warm;
    } else {
        try {
            rows = await loadCompartmentChunkEmbeddingsForSearch(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
                args.dateRange,
                args.signal,
            );
        } catch (error) {
            // The caller gave up; the caller's own abort check discards the search.
            if (args.signal?.aborted) return [];
            throw error;
        }
        if (args.timings) args.timings.chunkPool = "loaded";
    }
    if (rows.length === 0) return [];

    const byCompartment = new Map<
        number,
        { row: StoredCompartmentChunkEmbedding; score: number }
    >();
    let sliceStarted = performance.now();
    for (const row of rows) {
        if (performance.now() - sliceStarted >= 4) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            sliceStarted = performance.now();
        }
        if (cutoff !== null && row.endOrdinal > cutoff) {
            continue;
        }
        const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
        if (score <= 0) continue;
        const existing = byCompartment.get(row.compartmentId);
        if (!existing || score > existing.score) {
            byCompartment.set(row.compartmentId, { row, score });
        }
    }

    return [...byCompartment.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.row.startOrdinal - right.row.startOrdinal,
        )
        .slice(0, args.limit)
        .map(({ row, score }) => ({
            source: "compartment" as const,
            content: previewText(row.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.startOrdinal,
            endOrdinal: row.endOrdinal,
            matchType: "semantic" as const,
        }));
}

function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): Array<MessageSearchResult | CompartmentSearchResult> {
    if (args.compartments.length === 0) return args.messages;
    if (args.messages.length === 0) return args.compartments;

    const fused = new Map<
        string,
        {
            result: MessageSearchResult | CompartmentSearchResult;
            score: number;
            tieOrdinal: number;
            snippetScore: number;
        }
    >();

    const add = (
        key: string,
        result: MessageSearchResult | CompartmentSearchResult,
        score: number,
        tieOrdinal: number,
    ) => {
        const existing = fused.get(key);
        if (existing) {
            existing.score += score;
            return existing;
        }
        const entry = { result, score, tieOrdinal, snippetScore: -1 };
        fused.set(key, entry);
        return entry;
    };

    args.compartments.forEach((compartment, rank) => {
        add(
            `compartment:${compartment.compartmentId}`,
            compartment,
            1 / (RRF_K + rank),
            compartment.startOrdinal,
        );
    });

    for (const [rank, message] of args.messages.entries()) {
        const containing = args.compartments.find(
            (compartment) =>
                message.messageOrdinal >= compartment.startOrdinal &&
                message.messageOrdinal <= compartment.endOrdinal,
        );
        const contribution = 1 / (RRF_K + rank);
        if (!containing) {
            add(`message:${message.messageId}`, message, contribution, message.messageOrdinal);
            continue;
        }

        const entry = add(
            `compartment:${containing.compartmentId}`,
            containing,
            contribution,
            containing.startOrdinal,
        );
        if (message.score > entry.snippetScore && entry.result.source === "compartment") {
            entry.snippetScore = message.score;
            entry.result = {
                ...entry.result,
                matchType: "hybrid",
                snippet: message.content,
            };
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.tieOrdinal - right.tieOrdinal,
        )
        .slice(0, args.limit);

    // Fusion decides ordering, not relevance. In particular, rank one must not
    // turn a weak cosine match into a perfect similarity score.
    return ranked.map((entry) => entry.result);
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
            return MEMORY_SOURCE_BOOST;
        case "message":
        case "compartment":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
        case "primer":
            return PRIMER_SOURCE_BOOST;
        case "note":
            return 1;
    }
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * getSourceBoost(left);
    const rightEffective = right.score * getSourceBoost(right);

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (left.source === "memory" && right.source === "memory") {
        return left.memoryId - right.memoryId;
    }

    if (left.source === "message" && right.source === "message") {
        return left.messageOrdinal - right.messageOrdinal;
    }

    if (left.source === "compartment" && right.source === "compartment") {
        return left.startOrdinal - right.startOrdinal;
    }

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
    }

    if (left.source === "primer" && right.source === "primer") {
        return right.support - left.support || left.primerId - right.primerId;
    }

    if (left.source === "note" && right.source === "note") {
        return right.createdAt - left.createdAt || left.noteId - right.noteId;
    }

    return 0;
}

function toGitCommitResult(hit: GitCommitSearchHit): GitCommitSearchResult {
    return {
        source: "git_commit",
        content: previewText(hit.commit.message),
        score: hit.score,
        sha: hit.commit.sha,
        shortSha: hit.commit.shortSha,
        author: hit.commit.author,
        committedAtMs: hit.commit.committedAtMs,
        matchType: hit.matchType,
    };
}

function searchGitCommits(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchMemories — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    dateRange: InclusiveDateRange | null;
    lanes?: SearchLanes;
}): GitCommitSearchResult[] {
    if (args.limit <= 0) return [];

    const lanes = args.lanes;
    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        from: args.dateRange?.from,
        to: args.dateRange?.to,
        captureLanes: lanes
            ? (fts, vector) => {
                  lanes.git_fts = fts.map(toGitCommitResult);
                  lanes.git_vector = vector.map(toGitCommitResult);
              }
            : undefined,
    });
    return hits.map(toGitCommitResult);
}

function primerText(primer: Primer): string {
    const answer = primer.answer.trim();
    return answer ? `Q: ${primer.question}\nA: ${answer}` : `Q: ${primer.question}`;
}

function searchPrimers(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    queryEmbedding: Float32Array | null;
    queryModelId: string | null;
    dateRange: InclusiveDateRange | null;
    lanes?: SearchLanes;
}): PrimerSearchResult[] {
    const primers = getActivePrimers(args.db, args.projectPath).filter((primer) =>
        timestampIsInRange(primer.createdAt, args.dateRange),
    );
    if (primers.length === 0 || args.limit <= 0) return [];
    const ftsQuery = sanitizeFtsQuery(args.query);
    const ftsRanks = new Map<number, number>();
    if (ftsQuery) {
        const rows = args.db
            .prepare(
                `SELECT p.id AS id, bm25(primers_fts) AS rank
                 FROM primers_fts
                 JOIN primers p ON p.id = primers_fts.rowid
                  WHERE primers_fts MATCH ? AND p.project_path = ? AND p.status = 'active'
                    ${args.dateRange === null ? "" : "AND p.created_at BETWEEN ? AND ?"}
                  ORDER BY rank ASC
                  LIMIT ?`,
            )
            .all(
                ftsQuery,
                args.projectPath,
                ...(args.dateRange === null ? [] : [args.dateRange.from, args.dateRange.to]),
                args.lanes ? Math.max(args.limit * 3, 225) : args.limit * 3,
            ) as Array<{ id: number; rank: number }>;
        const baselineRows = rows.slice(0, args.limit * 3);
        baselineRows.forEach((row, index) => {
            ftsRanks.set(row.id, linearDecayScore(index, baselineRows.length));
        });
        if (args.lanes) {
            const byId = new Map(primers.map((primer) => [primer.id, primer]));
            args.lanes.primer_fts = rows
                .flatMap((row, index) => {
                    const primer = byId.get(row.id);
                    return primer
                        ? [
                              {
                                  source: "primer" as const,
                                  primerId: primer.id,
                                  content: previewText(primerText(primer)),
                                  question: primer.question,
                                  support: primer.totalSupport,
                                  lastObservedAt: primer.lastObservedAt,
                                  matchType: "fts" as const,
                                  score: linearDecayScore(index, rows.length),
                              },
                          ]
                        : [];
                })
                .slice(0, 25);
        }
    }
    const vectorResults: PrimerSearchResult[] = [];
    const scored = primers
        .map((primer) => {
            const semantic =
                args.queryEmbedding &&
                primer.questionEmbedding &&
                primer.questionEmbeddingModelId === args.queryModelId
                    ? normalizeCosineScore(
                          cosineSimilarity(args.queryEmbedding, primer.questionEmbedding),
                      )
                    : 0;
            if (args.lanes && semantic > 0)
                vectorResults.push({
                    source: "primer",
                    primerId: primer.id,
                    content: previewText(primerText(primer)),
                    question: primer.question,
                    support: primer.totalSupport,
                    lastObservedAt: primer.lastObservedAt,
                    matchType: "semantic",
                    score: semantic,
                });
            const fts = ftsRanks.get(primer.id) ?? 0;
            if (semantic <= 0 && fts <= 0) return null;
            const score =
                semantic > 0 && fts > 0
                    ? semantic * SEMANTIC_WEIGHT + fts * FTS_WEIGHT
                    : Math.max(semantic, fts);
            return {
                source: "primer" as const,
                content: previewText(primerText(primer)),
                score,
                primerId: primer.id,
                question: primer.question,
                support: primer.totalSupport,
                lastObservedAt: primer.lastObservedAt,
                matchType: semantic > 0 && fts > 0 ? "hybrid" : semantic > 0 ? "semantic" : "fts",
            } satisfies PrimerSearchResult;
        })
        .filter((result): result is PrimerSearchResult => result !== null)
        .sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId)
        .slice(0, args.limit);
    if (args.lanes)
        args.lanes.primer_vector = vectorResults
            .sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId)
            .slice(0, 25);
    return scored;
}

function resolveSources(sources: SearchSource[] | undefined): Set<SearchSource> {
    if (sources === undefined) {
        // Default: search all recall sources. Facts are deliberately NOT a
        // source — they're always rendered in <session-history> so searching
        // them returns content the agent already sees.
        return new Set<SearchSource>(["memory", "message", "git_commit", "primer", "note"]);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (
            source === "memory" ||
            source === "message" ||
            source === "git_commit" ||
            source === "primer" ||
            source === "note"
        ) {
            set.add(source);
        }
    }
    return set;
}

/** Turn memories already filtered through the visibility predicate into
 *  MemorySearchResult rows. Used by the ctx_search ID short-circuit so the
 *  direct-by-id path can return the same shape the normal search lanes emit
 *  (and reuse formatResult without a second code path). */
function memoriesToIdLookupResults(args: {
    memories: readonly Memory[];
    limit: number;
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}): MemorySearchResult[] {
    // Preserve the caller's order so a `parseIdShapedQuery` result like
    // `["#12", "34"]` renders hits in the same order the user typed them.
    const ordered = args.memories.slice(0, args.limit);
    return ordered.map((memory, rank) => ({
        source: "memory",
        content: previewText(memory.content),
        score: 1 - rank * 0.01,
        memoryId: memory.id,
        category: memory.category,
        matchType: "fts" as const,
        sourceName: args.sourceNameByMemoryId?.get(memory.id),
    }));
}

/** Resolve a parsed id list through the session's visibility scope. Returns
 *  MemorySearchResult rows in the caller's id order, or `null` when nothing
 *  resolved (signals the caller to fall through to the normal search lanes). */
export function resolveMemoriesByIdsForSearch(args: {
    db: Database;
    projectPath: string;
    ids: readonly number[];
    limit: number;
    /** Optional filter mirroring the m[0] hard-filter — already-rendered
     *  memories are skipped so the agent doesn't see the same content twice. */
    visibleMemoryIds?: Set<number> | null;
    diagnostics?: UnifiedSearchDiagnostics;
    from?: number;
    to?: number;
}): MemorySearchResult[] | null {
    if (args.diagnostics) {
        args.diagnostics.suppressedVisibleMemoryIds = [];
    }
    if (args.ids.length === 0) {
        return null;
    }
    const workspace = resolveSearchWorkspaceContext(args.db, args.projectPath);
    const fetched = workspace.isWorkspaced
        ? getMemoriesByProjects(
              args.db,
              workspace.expandedIdentities,
              ["active", "permanent", "archived"],
              Date.now(),
              workspace.ownIdentities,
              workspace.shareCategories,
          )
        : getMemoriesByProject(args.db, args.projectPath, ["active", "permanent", "archived"]);
    if (fetched.length === 0) {
        return null;
    }
    const dateRange = normalizeDateRange(args.from, args.to);
    const memoriesById = new Map(
        fetched
            .filter((memory) => timestampIsInRange(memory.createdAt, dateRange))
            .map((memory) => [memory.id, memory]),
    );
    const ordered: Memory[] = [];
    const suppressedVisibleIds = new Set<number>();
    for (const id of args.ids) {
        const memory = memoriesById.get(id);
        if (!memory) continue;
        if (args.visibleMemoryIds?.has(id)) {
            suppressedVisibleIds.add(id);
            continue;
        }
        ordered.push(memory);
        if (ordered.length >= args.limit) break;
    }
    if (args.diagnostics) {
        args.diagnostics.suppressedVisibleMemoryIds = [...suppressedVisibleIds].sort(
            (left, right) => left - right,
        );
    }
    if (ordered.length === 0) {
        return null;
    }
    return memoriesToIdLookupResults({
        memories: ordered,
        limit: args.limit,
        sourceNameByMemoryId: sourceNamesForSearchMemories({
            memories: ordered,
            projectPath: args.projectPath,
            workspace,
        }),
    });
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const messageIndexEpoch = getMessageIndexEpoch(sessionId);
    const messageIndexWasSearchable = isMessageIndexSearchable(sessionId);
    const messageIndexStillCurrent = () =>
        messageIndexWasSearchable &&
        isMessageIndexSearchable(sessionId) &&
        getMessageIndexEpoch(sessionId) === messageIndexEpoch;
    const trimmedQuery = query.trim();
    const measurementStartedAt = Date.now();
    if (trimmedQuery.length === 0 || options.signal?.aborted) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const reranker =
        options.explicitSearch && options.rerank !== false && isProseQuery(trimmedQuery)
            ? await prepareReranker(
                  projectPath,
                  sessionId,
                  options.rerankConnectionFile,
                  options.rerankClient,
                  options.rerankConfig,
              )
            : null;
    const lanes = reranker || options.captureRerankLanes ? emptySearchLanes() : undefined;
    const dateRange = normalizeDateRange(options.from, options.to);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);
    if (options.diagnostics) {
        options.diagnostics.suppressedVisibleMemoryIds = [];
        options.diagnostics.suppressedLiveMessageMatches = 0;
        options.diagnostics.gitCommitUnavailable = null;
    }

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
    const activeSources = resolveSources(options.sources);

    const memoryFeatureEnabled = options.memoryEnabled ?? true;
    const runMemory = activeSources.has("memory") && memoryFeatureEnabled;
    const runMessages = activeSources.has("message");
    const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;
    if (
        options.diagnostics &&
        activeSources.has("git_commit") &&
        options.gitRepositoryAvailable === false
    ) {
        options.diagnostics.gitCommitUnavailable = "no_git_repository";
    }
    const runPrimers = activeSources.has("primer") && memoryFeatureEnabled;
    const runNotes = activeSources.has("note");
    // Semantic history search is not a memory feature: it runs whenever
    // embedding is on, whatever `memory.enabled` says.
    const runCompartmentChunks = runMessages && embeddingEnabled;

    // Embed the query ONCE at the top — both memory and git-commit searches
    // need the same vector. Previously each search called `embedQuery`
    // independently, producing two parallel HTTP requests for the same
    // input text (visible in LMStudio logs as duplicate `/v1/embeddings`
    // entries) which serialized at the model and doubled latency on
    // single-GPU embedding endpoints.
    //
    // We start the embed BEFORE running the synchronous `searchMessages`
    // path. JavaScript evaluates `Promise.all` arguments left-to-right, so
    // any synchronous call inside an arg expression blocks the event loop
    // and prevents in-flight `fetch()` work from being processed by the
    // runtime — even though the request was technically dispatched. On
    // long sessions `searchMessages` can do seconds of indexing work
    // (`ensureMessagesIndexed` walks raw OpenCode session history); doing
    // that BEFORE the embed call meant the embed fetch couldn't start
    // until indexing finished.
    const needsEmbedding =
        (runMemory || runGitCommits || runCompartmentChunks || runPrimers) &&
        embeddingEnabled &&
        isEmbeddingRuntimeEnabled();

    const queryEmbeddingPromise: Promise<CapturedQueryEmbedding | Float32Array | null> =
        needsEmbedding
            ? embedQuery(trimmedQuery, options.signal).catch((error) => {
                  log(
                      `[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
              })
            : Promise.resolve(null);

    // Yield to the event loop so the embed fetch's request gets a chance
    // to be dispatched at the runtime level before we run any synchronous
    // work. This is the crucial line that unblocks the auto-search 3-second
    // delay observed in production: without it, `searchMessages` runs
    // before the embed fetch is processed, and the embedding HTTP request
    // doesn't actually leave the process until we await later.
    await Promise.resolve();
    if (options.signal?.aborted) return [];

    // Run the synchronous message-FTS SELECT now that the embed fetch is
    // in flight. Message indexing is event-driven and never runs here;
    // unreconciled sessions simply return no message hits until the async
    // first-touch reconciliation finishes.
    // Multi-probe recall is opt-in for explicit searches only. NL queries
    // yield no probes, so this is a no-op for them regardless of the flag.
    const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
    const timings = options.stepTimings;
    let stepStartedAt = performance.now();
    let messageResults: MessageSearchResult[] = [];
    if (runMessages && messageIndexStillCurrent()) {
        const messageRequest: MessageHistorySearchRequest = {
            sessionId,
            query: trimmedQuery,
            limit: tierLimit,
            captureLimit: lanes ? 75 : undefined,
            maxOrdinal: options.maxMessageOrdinal,
            probes: messageProbes,
            relaxedRecall: options.explicitSearch,
            collectDiagnostics: options.diagnostics !== undefined,
            dateRange,
        };
        // Explicit searches with literal probes count every probe's matches
        // across the session; a caller can move that work off its thread.
        const delegated = options.searchMessageHistory
            ? await options.searchMessageHistory(messageRequest).catch((error) => {
                  log(
                      `[search] off-thread message search failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
              })
            : null;
        if (delegated && options.signal?.aborted) return [];
        const outcome = delegated ?? searchMessageHistory(db, messageRequest);
        if (options.diagnostics) {
            options.diagnostics.suppressedLiveMessageMatches = outcome.suppressedLiveMessageMatches;
        }
        messageResults = outcome.results.filter(
            (result) => result.messageId !== options.excludeMessageId,
        );
        if (lanes) lanes.message_fts = (outcome.laneResults ?? outcome.results).slice(0, 25);
        if (timings) timings.messageMs = performance.now() - stepStartedAt;
    }

    // Wait for the single embed call (if any) and then run the two
    // embedding-dependent searches in parallel using the same vector.
    stepStartedAt = performance.now();
    const capturedQuery = await queryEmbeddingPromise;
    if (timings && needsEmbedding) timings.vectorWaitMs = performance.now() - stepStartedAt;
    // A provider may ignore cancellation and resolve after the hint deadline.
    // Do not turn that late vector into another synchronous database scan.
    if (options.signal?.aborted) return [];
    const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
    const queryContract =
        capturedQuery instanceof Float32Array || capturedQuery === null ? null : capturedQuery;
    const generationIsCurrent =
        queryContract === null ||
        (embeddingSnapshot !== null && embeddingSnapshot.generation === queryContract.generation);
    const queryEmbedding = generationIsCurrent
        ? (queryContract?.vector ?? (capturedQuery instanceof Float32Array ? capturedQuery : null))
        : null;
    const workspace = resolveSearchWorkspaceContext(db, projectPath);
    const embeddingModelId =
        queryContract?.modelId ?? options.embeddingModelIdOverride ?? embeddingSnapshot?.modelId;
    const chunkModelId =
        queryContract?.chunkModelId ??
        options.chunkModelIdOverride ??
        embeddingSnapshot?.chunkModelId;
    stepStartedAt = performance.now();
    if (timings) timings.chunkPool = "off";
    const compartmentResults = runCompartmentChunks
        ? await searchCompartmentChunks({
              db,
              sessionId,
              projectPath,
              queryEmbedding,
              limit: lanes ? Math.max(tierLimit, 25) : tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
              dateRange,
              warmOnly: options.chunkPoolWarmOnly,
              signal: options.signal,
              timings,
          })
        : [];
    if (timings && runCompartmentChunks) timings.chunkMs = performance.now() - stepStartedAt;
    stepStartedAt = performance.now();
    if (lanes) lanes.chunk_vector = compartmentResults.slice(0, 25);
    const messageLikeResults = mergeMessageAndCompartmentResults({
        messages: messageResults,
        compartments: compartmentResults.slice(0, tierLimit),
        limit: tierLimit,
    });

    const [memoryOutcome, gitCommitResults, primerResults, noteResults] = await Promise.all([
        runMemory
            ? searchMemories({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  memoryEnabled: true,
                  queryEmbedding,
                  queryModelId:
                      embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                  workspace,
                  visibleMemoryIds: options.visibleMemoryIds,
                  backfillMemoryEmbeddings: options.backfillMemoryEmbeddings,
                  lanes,
                  dateRange,
              })
            : Promise.resolve({
                  results: [] as MemorySearchResult[],
                  suppressedVisibleIds: [] as number[],
              }),
        runGitCommits
            ? Promise.resolve(
                  searchGitCommits({
                      db,
                      projectPath,
                      query: trimmedQuery,
                      limit: tierLimit,
                      queryEmbedding,
                      queryModelId:
                          embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                      dateRange,
                      lanes,
                  }),
              )
            : Promise.resolve([] as GitCommitSearchResult[]),
        runPrimers
            ? Promise.resolve(
                  searchPrimers({
                      db,
                      projectPath,
                      query: trimmedQuery,
                      limit: tierLimit,
                      queryEmbedding,
                      queryModelId:
                          embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                      dateRange,
                      lanes,
                  }),
              )
            : Promise.resolve([] as PrimerSearchResult[]),
        runNotes
            ? Promise.resolve(
                  searchNotes({
                      db,
                      sessionId,
                      projectPath,
                      query: trimmedQuery,
                      limit: lanes ? Math.max(tierLimit, 25) : tierLimit,
                      probes: messageProbes,
                      dateRange,
                  }),
              )
            : Promise.resolve([] as NoteSearchResult[]),
    ]);

    if (timings) timings.otherLanesMs = performance.now() - stepStartedAt;
    if (options.diagnostics) {
        options.diagnostics.suppressedVisibleMemoryIds = memoryOutcome.suppressedVisibleIds;
    }
    let results = [
        ...memoryOutcome.results,
        ...primerResults,
        ...messageLikeResults,
        ...gitCommitResults,
        ...noteResults,
    ]
        .sort(compareUnifiedResults)
        .slice(0, limit);

    const originalResults = results;
    const originalLatencyMs = Date.now() - measurementStartedAt;
    if (lanes) {
        lanes.notes = noteResults.slice(0, 25);
        options.captureRerankLanes?.(lanes);
    }
    if (reranker && lanes) {
        const pool = fuseSearchLanes(lanes).slice(
            0,
            "remote" in reranker ? reranker.remote.top_n : 20,
        );
        try {
            results = await rerankSearchResults(
                reranker,
                trimmedQuery,
                results,
                pool,
                candidateTexts(db, sessionId, projectPath, pool),
                limit,
                options.signal,
                options.onRerankSkipped,
            );
        } catch {
            if ("remote" in reranker)
                remoteRerankSkipped("candidate_validation", options.onRerankSkipped);
            else logRerankFallback("candidate_validation");
        }
    }

    if (!options.measurementDisabled) {
        void recordShadowMeasurement({
            db,
            sessionId,
            projectPath,
            query: trimmedQuery,
            options: { ...options, rerank: false, captureRerankLanes: undefined },
            primaryResults: originalResults,
            primaryQuery: queryContract,
            primaryLatencyMs: originalLatencyMs,
            search: unifiedSearch,
        });
    }

    // Only count retrievals for explicit agent-driven searches. Plugin-internal
    // automatic surfacing (auto-search hints) should not inflate retrieval_count
    // because the agent may never actually consume the hint.
    // retrieval_count is telemetry, not correctness: under MODULE authority the
    // TS write path is fenced, so skip the bump rather than failing the search.
    const countRetrievals = options.countRetrievals ?? true;
    if (countRetrievals) {
        const memoryIds = results
            .filter((result): result is MemorySearchResult => result.source === "memory")
            .map((result) => result.memoryId);

        if (memoryIds.length > 0) {
            db.transaction(() => {
                for (const memoryId of memoryIds) {
                    try {
                        updateMemoryRetrievalCount(db, memoryId);
                    } catch (error) {
                        // Telemetry only — module-managed rows must not fail the search.
                        if (error instanceof ModuleMemoryAuthorityError) continue;
                        throw error;
                    }
                }
            }).immediate();
        }
    }

    // Worker, embedding and reranking awaits can outlive a tree navigation.
    // Only raw-message hits depend on this index; retain every other lane.
    if (!messageIndexStillCurrent())
        results = results.filter((result) => result.source !== "message");

    if (options.autoHint) {
        return results.map((result) => ({
            ...result,
            relevanceScore:
                cleanSearchText(result.source === "compartment" ? result.title : result.content)
                    .length === 0
                    ? 0
                    : result.source === "message" ||
                        ("matchType" in result &&
                            result.source !== "compartment" &&
                            result.matchType !== "semantic")
                      ? keywordRelevance(trimmedQuery, result.content)
                      : result.score,
        }));
    }
    return results;
}

const SEARCH_NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

function formatSearchAge(timestampMs: number): string {
    const ageMs = Date.now() - timestampMs;
    if (ageMs < 0) return "future";
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatUnifiedSearchResult(
    result: UnifiedSearchResult,
    index: number,
    currentSessionId: string,
): string {
    if (result.source === "memory") {
        const source = result.sourceName ? ` source=${result.sourceName}` : "";
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category}${source} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "git_commit") {
        return [
            `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatSearchAge(result.committedAtMs)} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "primer") {
        return [
            `[${index}] [primer] score=${result.score.toFixed(2)} id=${result.primerId} support=${result.support} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "note") {
        const anchor =
            result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId
                ? ` @msg ${result.anchorOrdinal}`
                : "";
        return [
            `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatSearchAge(result.createdAt)}${anchor}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "compartment") {
        return [
            `[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
            result.snippet ? `Snippet: ${result.snippet}` : result.content,
        ].join("\n");
    }
    const expandStart = Math.max(1, result.messageOrdinal - 3);
    const expandEnd = result.messageOrdinal + 3;
    return [
        `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
        result.content,
    ].join("\n");
}

function formatSearchDiagnosticLines(
    results: UnifiedSearchResult[],
    diagnostics: UnifiedSearchDiagnostics | undefined,
): string[] {
    if (!diagnostics) return [];
    const lines: string[] = [];
    const visibleIds = [...diagnostics.suppressedVisibleMemoryIds].sort(
        (left, right) => left - right,
    );
    if (visibleIds.length > 0) {
        const count = visibleIds.length;
        const noun = count === 1 ? "match" : "matches";
        const ids = visibleIds.join(", ");
        if (results.some((result) => result.source === "memory")) {
            lines.push(
                `Memories: ${count} additional ${noun} suppressed because ${count === 1 ? "it is" : "they are"} already visible in your project-memory block (ids ${ids}).`,
            );
        } else {
            lines.push(
                `Memories: ${count} ${noun} found, all already visible in your project-memory block (ids ${ids}).`,
            );
        }
    }
    if (diagnostics.suppressedLiveMessageMatches > 0) {
        const count = diagnostics.suppressedLiveMessageMatches;
        lines.push(
            `Message history: ${count} raw-message ${count === 1 ? "match is" : "matches are"} newer than the last compartment boundary (already in your context).`,
        );
    }
    if (diagnostics.gitCommitUnavailable === "no_git_repository") {
        lines.push("Git commits: no git repository — commit search unavailable for this project.");
    }
    return lines;
}

/** Render output for explicit `ctx_search` callers in OpenCode and Pi. Include
 * diagnostics so intentional visibility suppression is explained while genuine
 * empty corpora retain their established wording. */
export function formatSearchResults(
    query: string,
    results: UnifiedSearchResult[],
    currentSessionId: string,
    diagnostics?: UnifiedSearchDiagnostics,
): string {
    const diagnosticLines = formatSearchDiagnosticLines(results, diagnostics);
    if (results.length === 0) {
        if (diagnosticLines.length > 0) {
            return `No hidden results found for "${query}".\n\n${diagnosticLines.join("\n")}`;
        }
        return `No results found for "${query}" across notes, memories, primers, git commits, or message history.`;
    }

    const bodyParts = results.map((result, index) =>
        formatUnifiedSearchResult(result, index + 1, currentSessionId),
    );
    if (diagnosticLines.length > 0) bodyParts.push(diagnosticLines.join("\n"));
    if (results.some((result) => result.source === "message" || result.source === "compartment")) {
        bodyParts.push(
            "Use ctx_expand(start, end) with the range from any message result above to read the conversation context. If the host no longer holds those messages, ctx_expand returns indexed text from the search archive only, with no surrounding messages or tool output.",
        );
    }
    if (
        results.some(
            (result) =>
                result.source === "note" &&
                result.anchorOrdinal !== null &&
                result.sourceSessionId === currentSessionId,
        )
    ) {
        bodyParts.push(SEARCH_NOTE_EXPAND_HINT);
    }
    return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${bodyParts.join("\n\n")}`;
}
