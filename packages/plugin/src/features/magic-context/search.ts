import { readRawSessionMessages } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import {
    ensureMemoryEmbeddings,
    getMemoriesByProject,
    getProjectEmbeddings,
    type Memory,
    peekProjectEmbeddings,
    searchMemoriesFTS,
    updateMemoryRetrievalCount,
} from "./memory";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { embedText, isEmbeddingEnabled } from "./memory/embedding";
import { sanitizeFtsQuery } from "./memory/storage-memory-fts";
import { ensureMessagesIndexed } from "./message-index";

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
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
 * (1.15 in this release, up from 1.0) because by definition these are the
 * specific details the historian didn't preserve as memories or compartments,
 * which is exactly what ctx_search is most useful for. */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.15;
const GIT_COMMIT_SOURCE_BOOST = 1.2;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();

export type SearchSource = "memory" | "message" | "git_commit";

export interface UnifiedSearchOptions {
    limit?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    readMessages?: (sessionId: string) => RawMessage[];
    embedQuery?: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
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
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    memoryId: number;
    category: string;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
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

export type UnifiedSearchResult = MemorySearchResult | MessageSearchResult | GitCommitSearchResult;

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.max(1, Math.floor(limit));
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

function getMessageSearchStatement(db: Database): PreparedStatement {
    let stmt = messageSearchStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
        );
        messageSearchStatements.set(db, stmt);
    }
    return stmt;
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
    query: string;
    memories: Memory[];
    embeddingEnabled: boolean;
    embedQuery: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
    signal?: AbortSignal;
}): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (!args.embeddingEnabled || !args.isEmbeddingRuntimeEnabled() || args.memories.length === 0) {
        return semanticScores;
    }

    const queryEmbedding = await args.embedQuery(args.query, args.signal);
    if (!queryEmbedding) {
        return semanticScores;
    }

    const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath);
    const embeddings = await ensureMemoryEmbeddings({
        db: args.db,
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
            normalizeCosineScore(cosineSimilarity(queryEmbedding, memoryEmbedding)),
        );
    }

    return semanticScores;
}

function getFtsMatches(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
}): Memory[] {
    try {
        return searchMemoriesFTS(args.db, args.projectPath, args.query, args.limit);
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
    memories: Memory[];
    projectPath: string;
    ftsMatches: Memory[];
}): Memory[] {
    if (args.ftsMatches.length === 0) {
        return args.memories;
    }

    const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
    const cachedEmbeddings = peekProjectEmbeddings(args.projectPath);

    if (cachedEmbeddings) {
        for (const memoryId of cachedEmbeddings.keys()) {
            candidateIds.add(memoryId);
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
}): MemorySearchResult[] {
    const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
    const results: MemorySearchResult[] = [];

    for (const id of candidateIds) {
        // Hard-filter: memory is already rendered in <session-history>, so the
        // agent sees it in message[0]. Returning it from ctx_search wastes
        // output tokens and displaces high-signal raw-history hits.
        if (args.visibleMemoryIds?.has(id)) {
            continue;
        }

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
            score = semanticScore * SINGLE_SOURCE_PENALTY;
            matchType = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            matchType = "fts";
        }

        if (score <= 0) {
            continue;
        }

        results.push({
            source: "memory",
            content: previewText(memory.content),
            score,
            memoryId: memory.id,
            category: memory.category,
            matchType,
        });
    }

    return results
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.memoryId - right.memoryId;
        })
        .slice(0, args.limit);
}

async function searchMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    embedQuery: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
    visibleMemoryIds?: Set<number> | null;
    signal?: AbortSignal;
}): Promise<MemorySearchResult[]> {
    if (!args.memoryEnabled) {
        return [];
    }

    const memories = getMemoriesByProject(args.db, args.projectPath);
    if (memories.length === 0) {
        return [];
    }

    const ftsMatches = getFtsMatches({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
    });
    const ftsScores = getFtsScores(ftsMatches);
    const semanticCandidates = selectSemanticCandidates({
        memories,
        projectPath: args.projectPath,
        ftsMatches,
    });
    const semanticScores = await getSemanticScores({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        memories: semanticCandidates,
        embeddingEnabled: args.embeddingEnabled,
        embedQuery: args.embedQuery,
        isEmbeddingRuntimeEnabled: args.isEmbeddingRuntimeEnabled,
        signal: args.signal,
    });

    return mergeMemoryResults({
        memories,
        semanticScores,
        ftsScores,
        limit: args.limit,
        visibleMemoryIds: args.visibleMemoryIds,
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

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    readMessages: (sessionId: string) => RawMessage[];
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
}): MessageSearchResult[] {
    ensureMessagesIndexed(args.db, args.sessionId, args.readMessages);

    const sanitizedQuery = sanitizeFtsQuery(args.query.trim());
    if (sanitizedQuery.length === 0) {
        return [];
    }

    // Fetch more rows than needed so post-filter still has enough results
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.limit * 3 : args.limit;
    const rows = getMessageSearchStatement(args.db)
        .all(args.sessionId, sanitizedQuery, fetchLimit)
        .map((row) => row as MessageSearchRow);

    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;

    const filtered = rows
        .map((row) => {
            const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
            if (
                messageOrdinal === null ||
                typeof row.messageId !== "string" ||
                typeof row.role !== "string" ||
                typeof row.content !== "string"
            ) {
                return null;
            }

            // Skip messages still in the live context (not yet compartmentalized)
            if (cutoff !== null && messageOrdinal > cutoff) {
                return null;
            }

            return {
                messageOrdinal,
                messageId: row.messageId,
                role: row.role,
                content: row.content,
            };
        })
        .filter(
            (
                result,
            ): result is {
                messageOrdinal: number;
                messageId: string;
                role: string;
                content: string;
            } => result !== null,
        )
        .slice(0, args.limit);

    // Score with linear decay over the final returned count (not the raw
    // FTS fetch count) so a small result set still gets strong scores.
    return filtered.map((row, rank) => ({
        source: "message" as const,
        content: previewText(row.content),
        score: linearDecayScore(rank, filtered.length),
        messageOrdinal: row.messageOrdinal,
        messageId: row.messageId,
        role: row.role,
    }));
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
            return MEMORY_SOURCE_BOOST;
        case "message":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
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

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
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

async function searchGitCommitsAsync(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    embeddingEnabled: boolean;
    embedQuery: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
    signal?: AbortSignal;
}): Promise<GitCommitSearchResult[]> {
    if (args.limit <= 0) return [];

    let queryEmbedding: Float32Array | null = null;
    if (args.embeddingEnabled && args.isEmbeddingRuntimeEnabled()) {
        try {
            queryEmbedding = await args.embedQuery(args.query, args.signal);
        } catch (error) {
            log(
                `[search] git commit query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding,
    });
    return hits.map(toGitCommitResult);
}

function resolveSources(sources: SearchSource[] | undefined): Set<SearchSource> {
    if (sources === undefined) {
        // Default: search all three sources. Facts are deliberately NOT a
        // source — they're always rendered in <session-history> so searching
        // them returns content the agent already sees.
        return new Set<SearchSource>(["memory", "message", "git_commit"]);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (source === "memory" || source === "message" || source === "git_commit") {
            set.add(source);
        }
    }
    return set;
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
    const activeSources = resolveSources(options.sources);

    const runMemory = activeSources.has("memory") && (options.memoryEnabled ?? true);
    const runMessages = activeSources.has("message");
    const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;

    const [memoryResults, messageResults, gitCommitResults] = await Promise.all([
        runMemory
            ? searchMemories({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  memoryEnabled: true,
                  embeddingEnabled,
                  embedQuery,
                  isEmbeddingRuntimeEnabled,
                  visibleMemoryIds: options.visibleMemoryIds,
                  signal: options.signal,
              })
            : Promise.resolve([] as MemorySearchResult[]),
        runMessages
            ? Promise.resolve(
                  searchMessages({
                      db,
                      sessionId,
                      query: trimmedQuery,
                      limit: tierLimit,
                      readMessages: options.readMessages ?? readRawSessionMessages,
                      maxOrdinal: options.maxMessageOrdinal,
                  }),
              )
            : Promise.resolve([] as MessageSearchResult[]),
        runGitCommits
            ? searchGitCommitsAsync({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  embeddingEnabled,
                  embedQuery,
                  isEmbeddingRuntimeEnabled,
                  signal: options.signal,
              })
            : Promise.resolve([] as GitCommitSearchResult[]),
    ]);

    const results = [...memoryResults, ...messageResults, ...gitCommitResults]
        .sort(compareUnifiedResults)
        .slice(0, limit);

    // Only count retrievals for explicit agent-driven searches. Plugin-internal
    // automatic surfacing (auto-search hints) should not inflate retrieval_count
    // because the agent may never actually consume the hint.
    const countRetrievals = options.countRetrievals ?? true;
    if (countRetrievals) {
        const memoryIds = results
            .filter((result): result is MemorySearchResult => result.source === "memory")
            .map((result) => result.memoryId);

        if (memoryIds.length > 0) {
            db.transaction(() => {
                for (const memoryId of memoryIds) {
                    updateMemoryRetrievalCount(db, memoryId);
                }
            })();
        }
    }

    return results;
}
