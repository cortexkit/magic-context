import { Worker } from "node:worker_threads";
import type { CompartmentChunkPoolWarmReport } from "../../features/magic-context/compartment-chunk-embedding";
import {
    embedBatchForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import type { EmbeddingPurpose } from "../../features/magic-context/memory/embedding-provider";
import {
    getMessageIndexEpoch,
    isMessageIndexSearchable,
} from "../../features/magic-context/message-index-async";
import type {
    CapturedQueryEmbedding,
    MessageHistorySearchOutcome,
    MessageHistorySearchRequest,
    UnifiedSearchOptions,
    UnifiedSearchResult,
    UnifiedSearchStepTimings,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintDecision,
    appendAutoSearchHintDecision,
} from "../../features/magic-context/storage-meta-persisted";
import {
    forgetUnpublishedAutoSearchNoHint,
    getUnpublishedAutoSearchNoHint,
    registerAutoSearchWork,
    rememberUnpublishedAutoSearchNoHint,
} from "../../shared/auto-search-lifecycle";
import { isEmbeddingHostBusy } from "../../shared/embedding-activity";
import { getHarness, type HarnessId } from "../../shared/harness";
import { log } from "../../shared/logger";
import {
    assertTransformWrite,
    type Database,
    getSqliteDatabasePath,
    isTransientSqliteError,
} from "../../shared/sqlite";
import { createWorkerShutdown, type WorkerShutdown } from "../../shared/worker-shutdown";
import {
    AUTO_SEARCH_TIMEOUT_MS,
    AUTO_SEARCH_VECTOR_TIMEOUT_MS,
    autoSearchDeadlineUnixMs,
} from "./auto-search-deadline";

const pendingRegistrations = new WeakMap<Database, Set<string>>();
const pendingTurns = new WeakMap<
    Database,
    Map<string, Map<string, { promise: Promise<unknown>; signal: AbortSignal }>>
>();

/** Same-turn passes join one search, then replay the owner's served decision. */
export async function coalesceAutoSearchTurn<T>(
    db: Database,
    sessionId: string,
    messageId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    replay: () => void,
): Promise<T> {
    let sessions = pendingTurns.get(db);
    if (!sessions) {
        sessions = new Map();
        pendingTurns.set(db, sessions);
    }
    let turns = sessions.get(sessionId);
    if (!turns) {
        turns = new Map();
        sessions.set(sessionId, turns);
    }
    const pending = turns.get(messageId);
    if (pending && !pending.signal.aborted) {
        const result = await pending.promise;
        if (!pending.signal.aborted) replay();
        return result as T;
    }
    const lifecycle = registerAutoSearchWork(sessionId);
    const work = Promise.resolve().then(() => operation(lifecycle.signal));
    const turn = { promise: work, signal: lifecycle.signal };
    turns.set(messageId, turn);
    try {
        return await work;
    } finally {
        lifecycle.done();
        if (turns.get(messageId) === turn) turns.delete(messageId);
        if (turns.size === 0) sessions.delete(sessionId);
    }
}

/** Cold optional hints skip immediately. Registration starts after the served
 * stage, and is deduplicated until it settles; warm hints never load config or
 * drain embedding-identity maintenance. Startup/tools own configuration refresh. */
export function queueAutoSearchRegistration(
    db: Database,
    projectPath: string,
    register?: () => Promise<void>,
): void {
    if (!register) return;
    let pending = pendingRegistrations.get(db);
    if (!pending) {
        pending = new Set();
        pendingRegistrations.set(db, pending);
    }
    if (pending.has(projectPath)) return;
    pending.add(projectPath);
    const timer = setTimeout(() => {
        if (getProjectEmbeddingSnapshot(projectPath)) {
            pending.delete(projectPath);
            return;
        }
        void Promise.resolve()
            .then(register)
            .catch((error) =>
                log(
                    `[auto-search] background registration failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            )
            .finally(() => pending.delete(projectPath));
    }, 0);
    timer.unref?.();
}

/** Only the owner publishes a decision. Once master's synchronous append succeeds,
 * serve it: never reject a committed hint because of a later IPC acknowledgement. */
export function persistAutoSearchDecision(
    db: Database,
    sessionId: string,
    decision: AutoSearchHintDecision,
    startedAt: number,
): ReturnType<typeof appendAutoSearchHintDecision> | null {
    if (performance.now() - startedAt >= AUTO_SEARCH_TIMEOUT_MS) return null;
    let outcome: ReturnType<typeof appendAutoSearchHintDecision>;
    try {
        outcome = appendAutoSearchHintDecision(db, sessionId, decision);
    } catch (error) {
        assertTransformWrite();
        rememberUnpublishedAutoSearchNoHint(
            sessionId,
            decision.messageId,
            decision.decision === "no-hint" ? decision.reason : "error",
        );
        // A locked store must not refuse the turn over this bookkeeping write.
        // The message is now remembered as served without a hint, so this pass
        // serves it plain and a later pass retries the save before any search
        // could add a hint to bytes the provider has already cached.
        if (!isTransientSqliteError(error)) throw error;
        log(
            `[auto-search] decision save hit a busy store for session ${sessionId}; serving without a hint and retrying the save on a later pass: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { ok: false, kind: "storage-busy" };
    }
    if (!outcome.ok) {
        assertTransformWrite();
        rememberUnpublishedAutoSearchNoHint(
            sessionId,
            decision.messageId,
            decision.decision === "no-hint" ? decision.reason : "error",
        );
    } else if (outcome.decision.decision === "no-hint") {
        forgetUnpublishedAutoSearchNoHint(sessionId, decision.messageId);
    }
    return outcome;
}

/** Retry saving a served no-hint decision before a recovered search can change its bytes. */
export function retryUnpublishedAutoSearchNoHint(
    db: Database,
    sessionId: string,
    messageId: string,
    startedAt: number,
): boolean {
    const reason = getUnpublishedAutoSearchNoHint(sessionId, messageId);
    if (reason === undefined) return false;
    try {
        persistAutoSearchDecision(
            db,
            sessionId,
            { messageId, decision: "no-hint", reason },
            startedAt,
        );
    } catch (error) {
        assertTransformWrite();
        log(
            `[auto-search] frozen omission save still failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return true;
}

export interface AutoSearchWorkerInput {
    persistent?: boolean;
    job?: "search" | "backfill" | "messages";
    path: string;
    harness: HarnessId;
    sessionId: string;
    projectPath: string;
    query: string;
    options: Omit<
        UnifiedSearchOptions,
        | "embedQuery"
        | "isEmbeddingRuntimeEnabled"
        | "signal"
        | "readMessages"
        | "searchMessageHistory"
        | "stepTimings"
    >;
    embeddingRuntimeEnabled: boolean;
    embeddingHostBusy: boolean;
    snapshot: ReturnType<typeof getProjectEmbeddingSnapshot>;
    deadlineUnixMs?: number;
    /** The message-history lane to run, for the "messages" job. */
    messageRequest?: MessageHistorySearchRequest;
}
export type AutoSearchWorkerReply =
    | { kind: "result"; results: UnifiedSearchResult[]; timings?: AutoSearchJobTimings }
    | { kind: "messages"; outcome: MessageHistorySearchOutcome }
    /** Sent by a "messages" job as soon as its thread runs, before loading search code. */
    | { kind: "accepted" }
    | { kind: "error"; error: string }
    | { kind: "query"; id: number; text: string }
    | { kind: "batch"; id: number; texts: string[]; purpose: EmbeddingPurpose };
/** Where a search job spent its time, reported with its result. Durations and counts only. */
export interface AutoSearchJobTimings {
    steps: UnifiedSearchStepTimings;
    jobMs: number;
    /** The worker's last background refresh of a history-chunk pool. */
    lastPoolWarm: CompartmentChunkPoolWarmReport | null;
}
export type AutoSearchEmbeddingReply = {
    id: number;
    embeddingHostBusy?: boolean;
    result?: CapturedQueryEmbedding | Float32Array | null;
    passage?: {
        vectors: (Float32Array | null)[];
        modelId: string;
        generation: number;
        providerIdentity: string;
        runtimeFingerprint: string;
        dimensions: number | null;
    } | null;
    error?: string;
};

/**
 * Thrown by {@link searchAutoHint} when an earlier search of the same session
 * is still running on the worker (typically one whose deadline already
 * passed). The turn is served without a hint instead of queueing behind it.
 */
export class AutoSearchBusyError extends Error {
    constructor() {
        super("an earlier auto-search of this session is still running");
        this.name = "AutoSearchBusyError";
    }
}

/**
 * Keep every search SELECT and vector scan off the prompt thread.
 * Workers are cached by database, harness, project, job and entry URL so matching
 * searches reuse their SQLite connection and incremental decoded-vector pool.
 * When the caller's deadline passes, the caller stops waiting but the worker,
 * its connection and its decoded pool are kept: the job finishes in the
 * background and the worker serves the next turn. A search of a session whose
 * earlier search is still running rejects with {@link AutoSearchBusyError} at
 * once. Only the owner appends hint decisions; search workers return results on
 * read-only connections. All provider calls stay with the owner and share the
 * caller's abort signal.
 */
export async function searchAutoHint(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions,
    entry = new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./auto-search-worker.ts"
            : "./auto-search-worker.js",
        import.meta.url,
    ),
): Promise<UnifiedSearchResult[]> {
    const messageIndexEpoch = getMessageIndexEpoch(sessionId);
    const messageIndexWasSearchable = isMessageIndexSearchable(sessionId);
    // Automatic hints must never score remotely, even if a caller reuses the
    // explicit-search options. Keep credentials and non-cloneable clients out
    // of the worker message as well as disabling reranking there.
    const {
        rerankConfig: _rerankConfig,
        rerankClient: _rerankClient,
        rerankConnectionFile: _rerankConnectionFile,
        onRerankSkipped: _onRerankSkipped,
        captureRerankLanes: _captureRerankLanes,
        ...hintOptions
    } = options;
    const results = await executeAutoSearchWorker(
        db,
        sessionId,
        projectPath,
        query,
        { ...hintOptions, explicitSearch: false, rerank: false },
        entry,
        "search",
    );
    // The owner, not the worker's module globals, knows whether history changed.
    return messageIndexWasSearchable &&
        isMessageIndexSearchable(sessionId) &&
        getMessageIndexEpoch(sessionId) === messageIndexEpoch
        ? results
        : results.filter((result) => result.source !== "message");
}

const pendingBackfills = new WeakMap<Database, Map<string, Promise<void>>>();

interface SearchWorkerSlot {
    worker: Worker;
    busy?: Promise<void>;
    release?: () => void;
    /** Session of the job holding the lease. */
    busySessionId?: string;
    /** Resolves when the lease holder's caller stops waiting at its deadline. */
    detachedSignal?: Promise<void>;
    markDetached?: () => void;
    /** The lease holder's caller has stopped waiting; the job still runs. */
    detached?: boolean;
    disposed?: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
    dispose(): void;
}
const searchWorkers = new WeakMap<Database, Map<string, SearchWorkerSlot>>();
const liveSearchWorkers = new Set<SearchWorkerSlot>();
const MAX_IDLE_SEARCH_WORKERS = 4;
const SEARCH_WORKER_IDLE_MS = 5 * 60_000;
/**
 * How long a search may keep running after its caller's deadline before its
 * worker is disposed anyway. A search that has not answered by then is still
 * holding the worker (in a long statement, or waiting on a provider that
 * ignores cancellation), and every later turn of its session would otherwise
 * be skipped behind it.
 */
const DETACHED_SEARCH_LIMIT_MS = 30_000;
/**
 * How long a disposed pool worker may take to close its connection and exit
 * before it is terminated. It reads the close request only between pieces of
 * synchronous work. An idle worker, or one waiting for an embedding reply,
 * exits at once; a backfill write transaction waits at most its 250 ms busy
 * timeout and then writes at most 50 vector rows. A search still inside a long
 * synchronous statement (a message-history FTS query on a large session can
 * take seconds) is terminated when this passes, as every disposed worker was
 * before.
 */
const AUTO_SEARCH_WORKER_CLOSE_DEADLINE_MS = 2_000;
let workersCreated = 0;
let workersReused = 0;
let searchesSkippedBusy = 0;

export function getAutoSearchWorkerStats(): {
    created: number;
    reused: number;
    skippedBusy: number;
} {
    return { created: workersCreated, reused: workersReused, skippedBusy: searchesSkippedBusy };
}

/** Dispose every worker nobody is waiting for: idle ones, and ones still
 * finishing a search whose caller already stopped waiting. */
export function disposeIdleAutoSearchWorkers(): void {
    for (const slot of liveSearchWorkers) if (!slot.busy || slot.detached) slot.dispose();
}

async function acquireSearchWorker(
    db: Database,
    key: string,
    entry: URL,
    input: AutoSearchWorkerInput,
    signal: AbortSignal,
): Promise<{ slot: SearchWorkerSlot; fresh: boolean } | "busy" | null> {
    const pool = searchWorkers.get(db) ?? new Map<string, SearchWorkerSlot>();
    searchWorkers.set(db, pool);
    while (!signal.aborted) {
        let slot = pool.get(key);
        if (slot?.busy) {
            // Never queue a search behind one whose caller has stopped waiting,
            // or behind another search of the same session. Report busy, and
            // this turn goes without a hint.
            if (input.job === "search" && (slot.detached || slot.busySessionId === input.sessionId))
                return "busy";
            const current = slot;
            await new Promise<void>((resolve) => {
                const done = () => {
                    signal.removeEventListener("abort", done);
                    resolve();
                };
                signal.addEventListener("abort", done, { once: true });
                void current.busy?.then(done);
                if (!current.detached) void current.detachedSignal?.then(done);
                if (signal.aborted) done();
            });
            continue;
        }
        const fresh = !slot;
        if (!slot) {
            const worker = inRootAsyncContext(
                () => new Worker(entry, { workerData: { ...input, persistent: true } }),
            );
            const shutdown = createWorkerShutdown(
                worker,
                "auto-search",
                AUTO_SEARCH_WORKER_CLOSE_DEADLINE_MS,
            );
            slot = {
                worker,
                dispose() {
                    this.disposed = true;
                    clearTimeout(this.idleTimer);
                    if (pool.get(key) === this) pool.delete(key);
                    liveSearchWorkers.delete(this);
                    void shutdown.close();
                    worker.unref();
                },
            };
            workersCreated++;
            pool.set(key, slot);
            liveSearchWorkers.add(slot);
            const current = slot;
            worker.on("error", () => current.dispose());
            worker.on("exit", () => current.dispose());
        } else workersReused++;
        clearTimeout(slot.idleTimer);
        const current = slot;
        current.busySessionId = input.sessionId;
        current.detached = false;
        current.busy = new Promise<void>((resolve) => {
            current.release = resolve;
        });
        current.detachedSignal = new Promise<void>((resolve) => {
            current.markDetached = resolve;
        });
        current.worker.ref();
        return { slot: current, fresh };
    }
    return null;
}

/** Called only after the owner has decided the hint. No background result can
 * change that decision, and cleanup cancels both queued and active jobs.
 * The backfill embeds missing memory vectors only, so it is not queued at all
 * when the project's registration has embedding or memory turned off: the
 * worker would open a writable connection and do nothing. */
export function queueAutoSearchBackfill(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
): Promise<void> {
    if (isEmbeddingHostBusy()) return Promise.resolve();
    const snapshot = getProjectEmbeddingSnapshot(projectPath);
    if (!snapshot?.enabled || !snapshot.features.memoryEnabled) return Promise.resolve();
    const key = `${sessionId}\0${projectPath}`;
    const pending = pendingBackfills.get(db) ?? new Map<string, Promise<void>>();
    pendingBackfills.set(db, pending);
    const prior = pending.get(key);
    if (prior) return prior;
    const lifecycle = registerAutoSearchWork(sessionId);
    const work = new Promise<void>((resolve) => {
        const done = () => {
            lifecycle.done();
            pending.delete(key);
            resolve();
        };
        const queued = inRootAsyncContext(() =>
            setTimeout(() => {
                lifecycle.signal.removeEventListener("abort", cancel);
                if (lifecycle.signal.aborted) return done();
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10_000);
                timeout.unref?.();
                void executeAutoSearchWorker(
                    db,
                    sessionId,
                    projectPath,
                    query,
                    { signal: AbortSignal.any([controller.signal, lifecycle.signal]) },
                    new URL(
                        new URL(import.meta.url).pathname.endsWith(".ts")
                            ? "./auto-search-worker.ts"
                            : "./auto-search-worker.js",
                        import.meta.url,
                    ),
                    "backfill",
                )
                    .catch((error) => log("[auto-search] background backfill failed:", error))
                    .finally(() => {
                        clearTimeout(timeout);
                        done();
                    });
            }, 0),
        );
        const cancel = () => {
            clearTimeout(queued);
            done();
        };
        lifecycle.signal.addEventListener("abort", cancel, { once: true });
        queued.unref?.();
    });
    pending.set(key, work);
    return work;
}

async function executeAutoSearchWorker(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions,
    entry: URL,
    job: "search" | "backfill",
): Promise<UnifiedSearchResult[]> {
    if (options.signal?.aborted) return [];
    const path = getSqliteDatabasePath(db);
    if (!path) throw new Error("auto-search requires a file-backed database for off-thread search");
    const {
        embedQuery,
        isEmbeddingRuntimeEnabled,
        signal: deadlineSignal,
        readMessages: _readMessages,
        searchMessageHistory: _searchMessageHistory,
        stepTimings: _stepTimings,
        ...serializable
    } = options;
    const lifecycle = registerAutoSearchWork(sessionId);
    const signal = deadlineSignal
        ? AbortSignal.any([deadlineSignal, lifecycle.signal])
        : lifecycle.signal;
    const snapshot = getProjectEmbeddingSnapshot(projectPath);
    const input: AutoSearchWorkerInput = {
        job,
        path,
        harness: getHarness(),
        sessionId,
        projectPath,
        query,
        options: {
            ...serializable,
            autoHint: true,
            backfillMemoryEmbeddings: false,
            countRetrievals: false,
            measurementDisabled: true,
        },
        embeddingRuntimeEnabled: isEmbeddingRuntimeEnabled?.() ?? false,
        embeddingHostBusy: isEmbeddingHostBusy(),
        snapshot,
        deadlineUnixMs: autoSearchDeadlineUnixMs(deadlineSignal),
    };
    let lease: Awaited<ReturnType<typeof acquireSearchWorker>>;
    try {
        lease = await acquireSearchWorker(
            db,
            `${input.harness}\0${projectPath}\0${job}\0${entry.href}`,
            entry,
            input,
            signal,
        );
    } catch (error) {
        lifecycle.done();
        throw error;
    }
    if (!lease) {
        lifecycle.done();
        return [];
    }
    if (lease === "busy") {
        lifecycle.done();
        searchesSkippedBusy++;
        throw new AutoSearchBusyError();
    }
    const { slot, fresh } = lease;
    const worker = slot.worker;
    // Only pooled searches keep running past their caller's deadline. A backfill
    // is disposed when it is cancelled, and a test entry is never reused.
    const detachable = job === "search" && entry.href === defaultAutoSearchWorkerEntry().href;
    const startedAt = performance.now();
    let detachedAt: number | undefined;
    let ownerVectorMs: number | undefined;
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    return new Promise((resolve, reject) => {
        // `settled`: the caller has its answer. `released`: the worker is free
        // again (or disposed). They differ only while a detached job finishes.
        let settled = false;
        let released = false;
        const settle = (results: UnifiedSearchResult[], error?: Error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(results);
        };
        const release = (dispose: boolean) => {
            if (released) return;
            released = true;
            clearTimeout(abandonTimer);
            signal?.removeEventListener("abort", abort);
            lifecycle.signal.removeEventListener("abort", abort);
            lifecycle.done();
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
            if (dispose || !detachable) slot.dispose();
            else if (!slot.disposed) {
                slot.idleTimer = setTimeout(() => slot.dispose(), SEARCH_WORKER_IDLE_MS);
                slot.idleTimer.unref?.();
            }
            const free = slot.release;
            slot.busy = undefined;
            slot.release = undefined;
            slot.busySessionId = undefined;
            slot.detached = false;
            slot.detachedSignal = undefined;
            slot.markDetached = undefined;
            free?.();
            const reusable = liveSearchWorkers.delete(slot);
            if (reusable) liveSearchWorkers.add(slot);
            const idle = [...liveSearchWorkers].filter((candidate) => !candidate.busy);
            for (const prior of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_SEARCH_WORKERS)))
                prior.dispose();
            worker.unref();
        };
        const finish = (results: UnifiedSearchResult[], error?: Error) => {
            settle(results, error);
            release(Boolean(error) || signal.aborted);
        };
        const abort = () => {
            // Session cleanup, or a job that cannot outlive its caller: stop it.
            if (lifecycle.signal.aborted || !detachable) {
                finish([]);
                return;
            }
            if (settled) return;
            // The caller's deadline: stop waiting, but keep the worker, its
            // connection and its decoded pool. The job finishes in the
            // background and the worker then serves the next turn.
            detachedAt = performance.now();
            slot.detached = true;
            slot.markDetached?.();
            settle([]);
            abandonTimer = setTimeout(() => {
                log(
                    `[auto-search] session ${sessionId}: search still running ${DETACHED_SEARCH_LIMIT_MS} ms after its deadline; disposing its worker (owner vector wait ${formatMs(ownerVectorMs)})`,
                );
                release(true);
            }, DETACHED_SEARCH_LIMIT_MS);
            abandonTimer.unref?.();
        };
        signal?.addEventListener("abort", abort, { once: true });
        lifecycle.signal.addEventListener("abort", abort, { once: true });
        const onError = (error: Error) => finish([], error);
        const onExit = (code: number) =>
            finish([], new Error(`auto-search worker exited (${code})`));
        const onMessage = async (reply: AutoSearchWorkerReply) => {
            if (released) return;
            if (reply.kind === "result" || reply.kind === "error") {
                if (detachedAt !== undefined) {
                    logLateSearch(
                        sessionId,
                        performance.now() - detachedAt,
                        detachedAt - startedAt,
                        ownerVectorMs,
                        reply.kind === "result" ? reply.timings : undefined,
                        reply.kind === "error",
                    );
                    release(reply.kind === "error");
                    return;
                }
                if (reply.kind === "error") {
                    finish([], new Error(reply.error));
                    return;
                }
                // A registration can change while the worker is ranking. Never serve
                // vectors from a generation that the owner has since replaced.
                if (
                    snapshot &&
                    getProjectEmbeddingSnapshot(projectPath)?.generation !== snapshot.generation
                )
                    finish([]);
                else finish(reply.results);
                return;
            }
            // Only the "messages" job answers with these.
            if (reply.kind === "messages" || reply.kind === "accepted") return;
            const response: AutoSearchEmbeddingReply = { id: reply.id };
            // After the deadline, answer at once without a vector so the job
            // can finish; nobody uses its result.
            if (!signal.aborted) {
                const requestedAt = performance.now();
                try {
                    if (reply.kind === "query")
                        response.result =
                            (await (job === "backfill"
                                ? embedTextForProject(projectPath, reply.text, signal, "query")
                                : boundedHintEmbedding(embedQuery, reply.text, signal))) ?? null;
                    else {
                        const passage = await embedBatchForProject(
                            projectPath,
                            reply.texts,
                            signal,
                            reply.purpose,
                        );
                        const current = getProjectEmbeddingSnapshot(projectPath);
                        response.passage =
                            passage && current
                                ? {
                                      ...passage,
                                      providerIdentity: current.providerIdentity,
                                      runtimeFingerprint: current.runtimeFingerprint,
                                      dimensions:
                                          passage.vectors.find((vector) => vector !== null)
                                              ?.length ?? null,
                                  }
                                : null;
                    }
                } catch (error) {
                    response.error = error instanceof Error ? error.message : String(error);
                }
                if (reply.kind === "query") ownerVectorMs = performance.now() - requestedAt;
                // Providers that ignore abort can complete late. Their vector
                // is no longer wanted once the deadline has passed.
                if (signal.aborted) {
                    response.result = undefined;
                    response.passage = undefined;
                    response.error = undefined;
                }
            }
            response.embeddingHostBusy = isEmbeddingHostBusy();
            // Never send a continuation into a disposed worker or into a later
            // job's request. A detached job still holds the lease, so its
            // requests are still this job's.
            if (!released) {
                try {
                    worker.postMessage(response);
                } catch (error) {
                    finish([], error instanceof Error ? error : new Error(String(error)));
                }
            }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        if (signal?.aborted) abort();
        else if (!fresh) {
            try {
                worker.postMessage({ kind: "run", input });
            } catch (error) {
                finish([], error instanceof Error ? error : new Error(String(error)));
            }
        }
    });
}

function formatMs(value: number | undefined): string {
    return value === undefined ? "n/a" : `${Math.round(value)} ms`;
}

/**
 * One line per search that finished after its caller's deadline, with where
 * the time went. Durations, row counts and states only: never the query or
 * any result text.
 */
function logLateSearch(
    sessionId: string,
    lateMs: number,
    waitedMs: number,
    ownerVectorMs: number | undefined,
    timings: AutoSearchJobTimings | undefined,
    failed: boolean,
): void {
    const steps = timings?.steps;
    const warm = timings?.lastPoolWarm;
    const pool = warm
        ? `last pool refresh ${warm.outcome} in ${formatMs(warm.totalMs)} (probe ${formatMs(warm.probeMs)}, read ${formatMs(warm.readMs)}, decode ${formatMs(warm.decodeMs)}, ${warm.probedRows} rows probed, ${warm.decodedRows} decoded)`
        : "no pool refresh yet";
    log(
        `[auto-search] session ${sessionId}: deadline passed after ${formatMs(waitedMs)}; the search ${failed ? "failed" : "finished"} ${formatMs(lateMs)} later. Steps: message FTS ${formatMs(steps?.messageMs)}, vector wait ${formatMs(steps?.vectorWaitMs)} (owner embedding ${formatMs(ownerVectorMs)}), chunk lane ${formatMs(steps?.chunkMs)} (pool ${steps?.chunkPool ?? "n/a"}), other lanes ${formatMs(steps?.otherLanesMs)}, job ${formatMs(timings?.jobMs)}; ${pool}`,
    );
}

async function boundedHintEmbedding(
    embed: UnifiedSearchOptions["embedQuery"],
    text: string,
    signal: AbortSignal,
): Promise<CapturedQueryEmbedding | Float32Array | null> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(() => embed?.(text, combined) ?? null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    resolve(null);
                    controller.abort();
                }, AUTO_SEARCH_VECTOR_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function defaultAutoSearchWorkerEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./auto-search-worker.ts"
            : "./auto-search-worker.js",
        import.meta.url,
    );
}

/**
 * How long a message-search worker may take to report that its thread is
 * running. It does so before loading any search code, so this covers only
 * thread start.
 */
const MESSAGE_WORKER_ACCEPT_TIMEOUT_MS = 400;
/** How long an accepted message-search worker may take to answer. */
const MESSAGE_WORKER_RESULT_TIMEOUT_MS = 30_000;
/**
 * How long a finished or abandoned message-search worker may take to close its
 * read-only connection and exit before it is terminated. One FTS statement of
 * a large session's history can run for seconds; a worker still inside one when
 * this passes is terminated, as every message-search worker was before.
 */
const MESSAGE_SEARCH_WORKER_CLOSE_DEADLINE_MS = 2_000;

export type MessageSearchWorkerFallbackReason =
    | "no-file"
    | "start-failed"
    | "not-accepted"
    | "no-result"
    | "worker-error"
    | "exited";

const messageSearchWorkerFallbacks = new Map<MessageSearchWorkerFallbackReason, number>();

/** How often each reason sent a message search back to the calling thread. */
export function getMessageSearchWorkerFallbacks(): ReadonlyMap<
    MessageSearchWorkerFallbackReason,
    number
> {
    return messageSearchWorkerFallbacks;
}

/**
 * Run the message-history lane of a search on a worker with its own read-only
 * connection, so its FTS statements (the per-probe match counts of an explicit
 * `ctx_search` in particular) never run on the serving thread. The worker calls
 * the same `searchMessageHistory`, so results and ranking are unchanged.
 *
 * Resolves null when the store has no file a worker can open, the worker fails
 * or exits, does not report that it is running within
 * MESSAGE_WORKER_ACCEPT_TIMEOUT_MS, or does not answer within
 * MESSAGE_WORKER_RESULT_TIMEOUT_MS after that. The caller then runs the lane
 * in process as before. Each fallback is logged and counted by reason (see
 * {@link getMessageSearchWorkerFallbacks}).
 */
export function searchMessageHistoryOffThread(
    db: Database,
    request: MessageHistorySearchRequest,
    entry: URL = defaultAutoSearchWorkerEntry(),
    deadlines: { acceptMs?: number; resultMs?: number } = {},
): Promise<MessageHistorySearchOutcome | null> {
    const fallback = (reason: MessageSearchWorkerFallbackReason, detail?: unknown) => {
        messageSearchWorkerFallbacks.set(
            reason,
            (messageSearchWorkerFallbacks.get(reason) ?? 0) + 1,
        );
        log(
            `[search] message search runs in process (${reason})${
                detail === undefined
                    ? ""
                    : `: ${detail instanceof Error ? detail.message : String(detail)}`
            }`,
        );
    };
    const path = getSqliteDatabasePath(db);
    if (!path) {
        fallback("no-file");
        return Promise.resolve(null);
    }
    const input: AutoSearchWorkerInput = {
        job: "messages",
        path,
        harness: getHarness(),
        sessionId: request.sessionId,
        projectPath: "",
        query: request.query,
        options: {},
        embeddingRuntimeEnabled: false,
        embeddingHostBusy: false,
        snapshot: null,
        messageRequest: request,
    };
    return new Promise((resolve) => {
        let settled = false;
        let worker: Worker | undefined;
        let shutdown: WorkerShutdown | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (
            outcome: MessageHistorySearchOutcome | null,
            reason?: MessageSearchWorkerFallbackReason,
            detail?: unknown,
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (reason) fallback(reason, detail);
            void shutdown?.close();
            worker?.unref();
            resolve(outcome);
        };
        const arm = (reason: MessageSearchWorkerFallbackReason, ms: number) => {
            clearTimeout(deadline);
            deadline = setTimeout(() => finish(null, reason, `no reply within ${ms} ms`), ms);
            deadline.unref?.();
        };
        try {
            worker = inRootAsyncContext(() => new Worker(entry, { workerData: input }));
            shutdown = createWorkerShutdown(
                worker,
                "message-search",
                MESSAGE_SEARCH_WORKER_CLOSE_DEADLINE_MS,
            );
        } catch (error) {
            finish(null, "start-failed", error);
            return;
        }
        arm("not-accepted", deadlines.acceptMs ?? MESSAGE_WORKER_ACCEPT_TIMEOUT_MS);
        worker.on("message", (reply: AutoSearchWorkerReply) => {
            if (reply.kind === "accepted")
                arm("no-result", deadlines.resultMs ?? MESSAGE_WORKER_RESULT_TIMEOUT_MS);
            else if (reply.kind === "messages") finish(reply.outcome);
            else if (reply.kind === "error") finish(null, "worker-error", reply.error);
        });
        worker.on("error", (error) => finish(null, "worker-error", error));
        worker.on("exit", (code) => finish(null, "exited", `exit code ${code}`));
    });
}

import { inRootAsyncContext } from "../../shared/sqlite";
