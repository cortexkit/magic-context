import { Worker } from "node:worker_threads";
import {
    embedBatchForProject,
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import type { EmbeddingPurpose } from "../../features/magic-context/memory/embedding-provider";
import type {
    CapturedQueryEmbedding,
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintDecision,
    appendAutoSearchHintDecision,
} from "../../features/magic-context/storage-meta-persisted";
import { registerAutoSearchWork } from "../../shared/auto-search-lifecycle";
import { isEmbeddingHostBusy } from "../../shared/embedding-activity";
import { getHarness, type HarnessId } from "../../shared/harness";
import { log } from "../../shared/logger";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import { AUTO_SEARCH_TIMEOUT_MS, autoSearchDeadlineUnixMs } from "./auto-search-deadline";

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
    return appendAutoSearchHintDecision(db, sessionId, decision);
}

export interface AutoSearchWorkerInput {
    job?: "search" | "backfill";
    path: string;
    harness: HarnessId;
    sessionId: string;
    projectPath: string;
    query: string;
    options: Omit<
        UnifiedSearchOptions,
        "embedQuery" | "isEmbeddingRuntimeEnabled" | "signal" | "readMessages"
    >;
    embeddingRuntimeEnabled: boolean;
    embeddingHostBusy: boolean;
    snapshot: ReturnType<typeof getProjectEmbeddingSnapshot>;
    deadlineUnixMs?: number;
}
export type AutoSearchWorkerReply =
    | { kind: "result"; results: UnifiedSearchResult[] }
    | { kind: "error"; error: string }
    | { kind: "query"; id: number; text: string }
    | { kind: "batch"; id: number; texts: string[]; purpose: EmbeddingPurpose };
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
 * Keep every search SELECT and vector scan off the prompt thread.
 * Termination is deliberately not awaited: a blocked SQLite worker must not hold
 * the served turn hostage. It owns its connection and cannot persist hint decisions.
 * All provider calls stay with the owner and share the caller's abort signal.
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
    return executeAutoSearchWorker(db, sessionId, projectPath, query, options, entry, "search");
}

const pendingBackfills = new WeakMap<Database, Map<string, Promise<void>>>();

/** Called only after the owner has decided the hint. No background result can
 * change that decision, and cleanup cancels both queued and active jobs. */
export function queueAutoSearchBackfill(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
): Promise<void> {
    if (isEmbeddingHostBusy()) return Promise.resolve();
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
        const queued = setTimeout(() => {
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
        }, 0);
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
            backfillMemoryEmbeddings: false,
            countRetrievals: false,
            measurementDisabled: true,
        },
        embeddingRuntimeEnabled: isEmbeddingRuntimeEnabled?.() ?? false,
        embeddingHostBusy: isEmbeddingHostBusy(),
        snapshot,
        deadlineUnixMs: autoSearchDeadlineUnixMs(deadlineSignal),
    };
    return new Promise((resolve, reject) => {
        const worker = new Worker(entry, { workerData: input });
        let settled = false;
        const finish = (results: UnifiedSearchResult[], error?: Error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            lifecycle.signal.removeEventListener("abort", abort);
            lifecycle.done();
            void worker.terminate();
            worker.unref();
            if (error) reject(error);
            else resolve(results);
        };
        const abort = () => finish([]);
        signal?.addEventListener("abort", abort, { once: true });
        lifecycle.signal.addEventListener("abort", abort, { once: true });
        worker.on("error", (error) => finish([], error));
        worker.on("exit", (code) => finish([], new Error(`auto-search worker exited (${code})`)));
        worker.on("message", async (reply: AutoSearchWorkerReply) => {
            if (settled) return;
            if (reply.kind === "result") {
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
            if (reply.kind === "error") {
                finish([], new Error(reply.error));
                return;
            }
            const response: AutoSearchEmbeddingReply = { id: reply.id };
            try {
                if (reply.kind === "query")
                    response.result =
                        (await (job === "backfill"
                            ? embedTextForProject(projectPath, reply.text, signal, "query")
                            : embedQuery?.(reply.text, signal))) ?? null;
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
                                      passage.vectors.find((vector) => vector !== null)?.length ??
                                      null,
                              }
                            : null;
                }
            } catch (error) {
                response.error = error instanceof Error ? error.message : String(error);
            }
            response.embeddingHostBusy = isEmbeddingHostBusy();
            // Providers that ignore abort can complete late. Never send their
            // continuation into a dead worker or a subsequent turn's request.
            if (!settled && !signal?.aborted) worker.postMessage(response);
        });
        if (signal?.aborted) abort();
    });
}
