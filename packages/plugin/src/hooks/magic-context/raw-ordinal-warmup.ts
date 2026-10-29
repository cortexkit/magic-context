/**
 * Off-thread warm-up for canonical ordinal counts.
 *
 * Counting a session's canonical ordinals needs the ids of its compaction
 * summary rows (see `countCanonicalOrdinalsIndexed` in read-session-raw.ts).
 * Finding them the first time means reading every message's JSON once, which
 * takes seconds on a large, cold OpenCode store. This module does that scan on
 * a worker thread with its own read-only connection and installs the result on
 * the serving connection. Synchronous lookups use rank checkpoints and a bounded
 * suffix. After a commit the worker updates the candidates and rebuilds ranks;
 * the serving thread never recounts the whole prefix.
 *
 * Callers on the transform path await {@link prewarmRawSessionOrdinalsForDb}
 * before their synchronous counts. Background callers (message indexing)
 * reschedule when it reports "failed". A failed worker is not retried for the
 * same session until FAILURE_BACKOFF_MS has passed.
 */
import { Worker } from "node:worker_threads";
import type { IndexWorkerMeasurements } from "../../features/magic-context/message-index-bounded";
import type {
    TagOwnerDelta,
    TagOwnerSummary,
    TagOwnerWarmupState,
} from "../../features/magic-context/storage-tags";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import type { HarnessId } from "../../shared/harness";
import { log } from "../../shared/logger";
import { type Database, getSqliteDatabasePath, releaseIndexOwner } from "../../shared/sqlite";
import { createWorkerShutdown, type WorkerShutdown } from "../../shared/worker-shutdown";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    isRawSessionSummaryWarm,
    type RawMessage,
    type RawSessionSummaryScan,
    rawOrdinalSummarySeed,
} from "./read-session-raw";

export interface RawOrdinalWarmupInput {
    path: string;
    sessionId: string;
    tagRatio?: number;
    tagRatios?: number[];
    tagState?: TagOwnerWarmupState;
    indexMessage?: RawMessage;
    previous?: RawSessionSummaryScan;
    harness?: HarnessId;
    indexCancellation?: SharedArrayBuffer;
    /** Shared cancellation checked after imports, before the worker opens its SQLite connection. */
    openCancellation?: SharedArrayBuffer;
    indexCoordination?: SharedArrayBuffer;
    indexOwner?: number;
    /** Ordinals whose message ids the worker reads exactly (see raw-exact-ordinal-read.ts). */
    exactOrdinalIds?: number[];
    ftsRowidBackfill?: boolean;
    /** Archive rendering uses explicit store paths; workers never discover a host store. */
    searchArchive?: {
        start: number;
        end: number;
        tokenBudget: number;
        archiveOnly: boolean;
        rawPath: string | null;
        rawIds?: Array<[string, number]>;
    };
}

export type RawOrdinalWarmupReply =
    | { kind: "accepted" }
    | { kind: "scan"; scan: RawSessionSummaryScan }
    | { kind: "tag-summary"; summary: TagOwnerSummary }
    | { kind: "tag-delta"; delta: TagOwnerDelta }
    | { kind: "indexed"; inserted: boolean; measurements?: IndexWorkerMeasurements }
    | { kind: "exact-ordinal-ids"; ids: Array<[number, string | null]> }
    | { kind: "search-archive"; text: string | null }
    | { kind: "fts-rowid-backfill" }
    | { kind: "error"; error: string; code?: string; errcode?: number };

/**
 * "warm": this connection has valid rank checkpoints. "failed": the
 * off-thread scan could not be completed or installed.
 */
export type RawOrdinalWarmupOutcome = "warm" | "failed";

export type RawOrdinalWarmupFailureReason =
    | "start-failed"
    | "not-accepted"
    | "no-result"
    | "worker-error"
    | "exited"
    | "stopped"
    | "superseded";

export interface RawOrdinalWarmupOptions {
    entry?: URL;
    signal?: AbortSignal;
    /** @deprecated File stores always scan off-thread; retained for old callers. */
    inThreadMaxRows?: number;
    acceptMs?: number;
    resultMs?: number;
}

/** Thread start only: the worker reports before loading any module. */
const ACCEPT_TIMEOUT_MS = 2_000;
/** A cold scan of a session of hundreds of thousands of messages on a large store. */
const RESULT_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a stopped warm-up may take to close its connections and exit before
 * it is terminated. The worker reads the close request between awaits: an index
 * chunk waits at most its 250 ms busy timeout and then writes a
 * short batch. A single summary scan cannot be interrupted; one still running
 * after this is terminated, as every stopped warm-up was before.
 */
const WARMUP_CLOSE_DEADLINE_MS = 2_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

const inFlight = new Map<string, SharedScan>();
const connectionIds = new WeakMap<Database, number>();
let nextConnectionId = 0;
const failedAt = new Map<string, number>();
const activeWorkers = new Map<Worker, (reason: RawOrdinalWarmupFailureReason) => void>();
const failures = new Map<RawOrdinalWarmupFailureReason, number>();
let exitHookRegistered = false;

/** How often each reason left a session without an off-thread scan, in this process. */
export function getRawOrdinalWarmupFailures(): ReadonlyMap<RawOrdinalWarmupFailureReason, number> {
    return failures;
}

/** Stop every running warm-up worker; their callers see "failed". */
export function stopRawSessionOrdinalWarmups(): void {
    for (const stop of [...activeWorkers.values()]) stop("stopped");
}

/** @internal */
export function resetRawSessionOrdinalWarmupsForTest(): void {
    stopRawSessionOrdinalWarmups();
    inFlight.clear();
    failedAt.clear();
    failures.clear();
}

function defaultEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./raw-ordinal-warmup-worker.ts"
            : "./raw-ordinal-warmup-worker.js",
        import.meta.url,
    );
}

function ensureExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", stopRawSessionOrdinalWarmups, { once: true });
    registerExitAbort(controller);
}

export function runSessionWarmupWorker(
    input: RawOrdinalWarmupInput,
    options: RawOrdinalWarmupOptions,
): Promise<WorkerResult> {
    ensureExitHook();
    return new Promise((resolve) => {
        const openCancellation = new Int32Array(
            new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        );
        let worker: Worker | undefined;
        let shutdown: WorkerShutdown | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (
            result:
                | { scan: RawSessionSummaryScan }
                | { summary: TagOwnerSummary }
                | { delta: TagOwnerDelta }
                | { inserted: boolean; measurements?: IndexWorkerMeasurements }
                | { exactOrdinalIds: Array<[number, string | null]> }
                | { searchArchive: string | null }
                | { ftsRowidBackfill: true }
                | {
                      failure: RawOrdinalWarmupFailureReason;
                      detail: string;
                      code?: string;
                      errcode?: number;
                  },
        ) => {
            if (settled) return;
            settled = true;
            // Worker termination is asynchronous; publish cancellation before requesting it.
            Atomics.store(openCancellation, 0, 1);
            clearTimeout(deadline);
            options.signal?.removeEventListener("abort", abort);
            if (worker) {
                activeWorkers.delete(worker);
                const stopped = shutdown?.close() ?? worker.terminate();
                worker.unref();
                void stopped.finally(() => {
                    releaseIndexOwner(input);
                    resolve(result);
                });
                return;
            }
            releaseIndexOwner(input);
            resolve(result);
        };
        const arm = (failure: RawOrdinalWarmupFailureReason, ms: number) => {
            clearTimeout(deadline);
            deadline = setTimeout(
                () => finish({ failure, detail: `no reply within ${ms} ms` }),
                ms,
            );
            deadline.unref?.();
        };
        const abort = () => finish({ failure: "stopped", detail: "stopped" });
        if (options.signal?.aborted) {
            abort();
            return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
            worker = inRootAsyncContext(
                () =>
                    new Worker(options.entry ?? defaultEntry(), {
                        workerData: { ...input, openCancellation: openCancellation.buffer },
                    }),
            );
            shutdown = createWorkerShutdown(worker, "raw-ordinal-warmup", WARMUP_CLOSE_DEADLINE_MS);
        } catch (error) {
            finish({ failure: "start-failed", detail: String(error) });
            return;
        }
        // Never keep the host process alive for a warm-up.
        worker.unref();
        activeWorkers.set(worker, (failure) => finish({ failure, detail: "stopped" }));
        arm("not-accepted", options.acceptMs ?? ACCEPT_TIMEOUT_MS);
        worker.on("message", (reply: RawOrdinalWarmupReply) => {
            if (reply.kind === "accepted") arm("no-result", options.resultMs ?? RESULT_TIMEOUT_MS);
            else if (reply.kind === "scan") finish({ scan: reply.scan });
            else if (reply.kind === "tag-summary") finish({ summary: reply.summary });
            else if (reply.kind === "tag-delta") finish({ delta: reply.delta });
            else if (reply.kind === "indexed")
                finish({ inserted: reply.inserted, measurements: reply.measurements });
            else if (reply.kind === "exact-ordinal-ids") finish({ exactOrdinalIds: reply.ids });
            else if (reply.kind === "search-archive") finish({ searchArchive: reply.text });
            else if (reply.kind === "fts-rowid-backfill") finish({ ftsRowidBackfill: true });
            else
                finish({
                    failure: "worker-error",
                    detail: reply.error,
                    code: reply.code,
                    errcode: reply.errcode,
                });
        });
        worker.on("error", (error) => finish({ failure: "worker-error", detail: String(error) }));
        worker.on("exit", (code) => finish({ failure: "exited", detail: `exit code ${code}` }));
    });
}

/**
 * Prepare exact message numbers, excluding finished compaction summaries, without
 * scanning the session on the host thread. The worker records prefix counts
 * every 256 stored messages so later lookups need only a bounded suffix read.
 *
 * Already warm: extends those checkpoints and returns. Cold file stores always
 * use the worker, including sessions opened long after process startup. Memory
 * stores use the direct path because another connection cannot see them.
 * Tail deletion from a revert truncates to the last surviving checkpoint.
 * Concurrent requests on the same database handle share one worker; separate
 * handles keep separate caches because session ids can repeat across stores.
 * Explicit cache resets during a scan allow an immediate retry. Worker failures
 * back off to avoid repeatedly spawning a worker that cannot run.
 */
export function prewarmRawSessionOrdinalsForDb(
    db: Database,
    sessionId: string,
    options: RawOrdinalWarmupOptions = {},
): Promise<RawOrdinalWarmupOutcome> {
    if (isRawSessionSummaryWarm(db, sessionId)) return Promise.resolve("warm");
    if (
        !db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE name = 'message' AND type IN ('table', 'view')",
            )
            .get()
    )
        return Promise.resolve("warm");
    const path = getSqliteDatabasePath(db);
    if (!path) {
        countRawSessionMessageOrdinalsFromDb(db, sessionId);
        return Promise.resolve("warm");
    }
    let connectionId = connectionIds.get(db);
    if (connectionId === undefined) {
        connectionId = ++nextConnectionId;
        connectionIds.set(db, connectionId);
    }
    const key = `${path}\0${sessionId}\0${connectionId}`;
    let shared = inFlight.get(key);
    if (!shared) {
        const failed = failedAt.get(key);
        if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS)
            return Promise.resolve("failed");
        const epoch = getRawSessionSummaryEpoch(sessionId);
        const started = performance.now();
        // A worker failure is recorded once, however many connections await it.
        const result = runSessionWarmupWorker(
            { path, sessionId, previous: rawOrdinalSummarySeed(db, sessionId) },
            options,
        )
            .then((outcome) => {
                if ("failure" in outcome)
                    recordFailure(key, sessionId, outcome.failure, outcome.detail);
                return outcome;
            })
            .finally(() => {
                if (inFlight.get(key) === scan) inFlight.delete(key);
            });
        const scan: SharedScan = { epoch, started, result };
        inFlight.set(key, scan);
        shared = scan;
    }
    const awaited = shared;
    // Concurrent preparation shares the worker result on this serving handle.
    return awaited.result.then((result): RawOrdinalWarmupOutcome => {
        if (!("scan" in result)) return "failed";
        try {
            if (installRawSessionSummaryScan(db, sessionId, result.scan, awaited.epoch, true)) {
                failedAt.delete(key);
                log(
                    `[magic-context] canonical ordinals of ${sessionId} warmed off-thread (${result.scan.sessionRows} messages, ${Math.round(performance.now() - awaited.started)} ms)`,
                );
                return "warm";
            }
        } catch {
            // The connection was closed or replaced while the worker ran.
        }
        recordFailure(
            key,
            sessionId,
            "superseded",
            `session removed during scan: epoch=${awaited.epoch}/${getRawSessionSummaryEpoch(sessionId)}`,
        );
        return "failed";
    });
}

type WorkerResult =
    | { scan: RawSessionSummaryScan }
    | { summary: TagOwnerSummary }
    | { delta: TagOwnerDelta }
    | { inserted: boolean; measurements?: IndexWorkerMeasurements }
    | { exactOrdinalIds: Array<[number, string | null]> }
    | { searchArchive: string | null }
    | { ftsRowidBackfill: true }
    | { failure: RawOrdinalWarmupFailureReason; detail: string; code?: string; errcode?: number };

/** One worker scan of a store and session, shared by every connection that asks meanwhile. */
interface SharedScan {
    /** The session's summary epoch when the scan started; a later epoch makes it stale. */
    epoch: number;
    started: number;
    result: Promise<WorkerResult>;
}

function recordFailure(
    key: string,
    sessionId: string,
    failure: RawOrdinalWarmupFailureReason,
    detail: string,
): void {
    failures.set(failure, (failures.get(failure) ?? 0) + 1);
    // A superseded scan is not a broken worker: the next call may try again.
    if (failure !== "superseded") failedAt.set(key, Date.now());
    log(
        `[magic-context] WARN canonical ordinal warm-up failed for ${sessionId} (${failure}: ${detail}); counts remain bounded and callers must defer or retry`,
    );
}

import { inRootAsyncContext } from "../../shared/sqlite";
