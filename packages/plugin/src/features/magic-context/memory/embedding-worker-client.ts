import { type ChildProcess, fork } from "node:child_process";
import { Worker } from "node:worker_threads";
import { flushLogger, log } from "../../../shared/logger";
import { inRootAsyncContext } from "../../../shared/sqlite";
import type { EmbeddingFailure } from "./embedding-failure";
import type { LocalEmbeddingNativeMemoryStats } from "./embedding-local";
import {
    type EmbeddingWorkerStopRequest,
    isEmbeddingWorkerStopNotice,
} from "./embedding-worker-loop";
import { prepareNativeOnnxTelemetry } from "./onnx-telemetry";

export type EmbeddingWorkerReply = {
    id: number;
    loaded: boolean;
    vectors?: (Float32Array | null)[];
    failure?: EmbeddingFailure | null;
    error?: string;
    stats?: LocalEmbeddingNativeMemoryStats;
};

// JSON IPC works in both Node and Bun; base64 preserves all float32 bits, including NaN and -0.
export type EmbeddingWorkerWireReply = Omit<EmbeddingWorkerReply, "vectors"> & {
    vectors?: (string | null)[];
};

let warnedWindowsTelemetry = false;

/**
 * How long a stopping worker may take to finish its current inference and exit
 * before it is terminated anyway. One inference call covers at most two texts
 * and takes well under a second for the supported local models, so the bound
 * is only reached by a stuck worker (for example a stalled model download). It
 * matches the five-second cap Pi's session_shutdown handler already puts on
 * each of its drains; stock Pi itself awaits that handler without a limit.
 */
export const EMBEDDING_WORKER_STOP_GRACE_MS = 5_000;

/**
 * After a forced stop, how long to wait for the worker to actually exit before
 * giving up on it. A child process on POSIX is then sent SIGKILL once and given
 * `EMBEDDING_WORKER_SIGKILL_WAIT_MS` more.
 */
export const EMBEDDING_WORKER_FORCED_EXIT_WAIT_MS = 2_000;
const EMBEDDING_WORKER_SIGKILL_WAIT_MS = 200;

/** The longest a stop can take before it settles, whatever the worker does. */
export const EMBEDDING_WORKER_STOP_MAX_MS =
    EMBEDDING_WORKER_STOP_GRACE_MS +
    EMBEDDING_WORKER_FORCED_EXIT_WAIT_MS +
    EMBEDDING_WORKER_SIGKILL_WAIT_MS;

type EmbeddingWorkerHandle = ChildProcess | Worker;

type EmbeddingWorkerState = {
    /**
     * Requests sent to the worker that it has not answered yet, with their send
     * time. A caller that gave up has left `pending`, but the worker still runs
     * its request, so this, not `pending`, says whether the worker is busy.
     */
    dispatched: Map<number, number>;
    /** The worker's answer to a stop request, with the time it arrived here. */
    stopNotice: { busy: boolean; busyMs: number; receivedAt: number } | null;
    exited: boolean;
    exit: Promise<void>;
};

export type EmbeddingWorkerClientOptions = {
    stopGraceMs?: number;
    forcedExitWaitMs?: number;
    log?: (message: string) => void;
};

/** Send time of the oldest request the worker has not answered, or null when it is idle. */
function busySince(state: EmbeddingWorkerState): number | null {
    // A loop, not Math.min(...values): spreading a very long queue into one call
    // can exceed the engine's argument limit and throw before the stop is sent.
    let oldest: number | null = null;
    for (const sentAt of state.dispatched.values()) {
        if (oldest === null || sentAt < oldest) oldest = sentAt;
    }
    return oldest;
}

/** Resolves true when `exit` settles within `ms`, false otherwise. */
async function exitsWithin(exit: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            exit.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function describeRunning(since: number | null, at: number): string {
    return since === null ? "no" : `yes (for ${Math.max(0, Math.round(at - since))}ms)`;
}

/** Whether a worker that has not exited in time is still running an inference. */
function describeStuckWorker(state: EmbeddingWorkerState, stopSince: number | null): string {
    const notice = state.stopNotice;
    const at = performance.now();
    if (notice) return describeRunning(notice.busy ? notice.receivedAt - notice.busyMs : null, at);
    // Without an answer the worker's thread has not returned to JavaScript since
    // the stop request: it is still inside one call, usually the native inference.
    return `${describeRunning(stopSince, at)}, no answer to the stop request`;
}

/** One model owner; a dead or unresponsive worker rejects every outstanding request. */
export class EmbeddingWorkerClient {
    private worker: EmbeddingWorkerHandle | null = null;
    private startPromise: Promise<EmbeddingWorkerHandle> | null = null;
    private readonly states = new WeakMap<EmbeddingWorkerHandle, EmbeddingWorkerState>();
    /** Workers still finishing their inference after a stop request. */
    private readonly stopping = new Set<Promise<void>>();
    private nextId = 1;
    private readonly pending = new Map<
        number,
        {
            resolve: (reply: EmbeddingWorkerReply) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private disposed = false;
    private activeRequests = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly data: Record<string, unknown>,
        private readonly entry = new URL(
            new URL(import.meta.url).pathname.endsWith(".ts")
                ? "./embedding-worker.ts"
                : "./embedding-worker.js",
            import.meta.url,
        ),
        private readonly timeoutMs = 5 * 60_000,
        private readonly prepareTelemetry = prepareNativeOnnxTelemetry,
        private readonly idleMs = 10 * 60_000,
        private readonly options: EmbeddingWorkerClientOptions = {},
    ) {}

    private start(): Promise<EmbeddingWorkerHandle> {
        if (this.startPromise) return this.startPromise;
        this.startPromise = inRootAsyncContext(() => this.startOwner()).finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async startOwner(): Promise<EmbeddingWorkerHandle> {
        if (this.disposed) throw new Error("embedding worker disposed");
        if (this.worker) return this.worker;
        // Compiled Bun 1.4.2 disk-worker probes fail on external sharp imports; the Bun-CLI child loads them.
        // Ordinary Bun and main-thread Node can set ORT_DISABLE_TELEMETRY in native memory first.
        const compiledBun =
            process.versions.bun &&
            (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
                ?.isStandaloneExecutable;
        const inProcess = !compiledBun && (await this.prepareTelemetry());
        if (this.disposed) throw new Error("embedding worker disposed");
        const worker = inProcess
            ? new Worker(this.entry, { workerData: this.data })
            : fork(
                  new URL(
                      new URL(import.meta.url).pathname.endsWith(".ts")
                          ? "./embedding-worker-process.ts"
                          : "./embedding-worker-process.js",
                      import.meta.url,
                  ),
                  [],
                  {
                      env: {
                          ...process.env,
                          ORT_DISABLE_TELEMETRY: "1",
                          // Set BUN_BE_BUN so a compiled Bun executable runs the worker script, not the host app.
                          ...(process.versions.bun ? { BUN_BE_BUN: "1" } : {}),
                      },
                      execArgv: [],
                      serialization: "json",
                      ...{ windowsHide: true },
                      stdio: ["ignore", "inherit", "inherit", "ipc"],
                  },
              );
        if (process.platform === "win32" && this.data.runtimePreference !== "wasm") {
            // Windows uses Event Tracing for Windows (ETW); this environment opt-out only applies to POSIX uploads.
            if (!warnedWindowsTelemetry) {
                warnedWindowsTelemetry = true;
                const warning =
                    "[magic-context] ORT_DISABLE_TELEMETRY=1 prevents ONNX uploads on POSIX. Windows native ONNX uses OS-controlled ETW diagnostics instead and exposes no JavaScript telemetry-disable API; Windows diagnostic settings and trace collectors govern collection.";
                log(warning);
            }
        }
        this.worker = worker;
        let markExited!: () => void;
        const state: EmbeddingWorkerState = {
            dispatched: new Map(),
            stopNotice: null,
            exited: false,
            exit: new Promise((resolve) => {
                markExited = resolve;
            }),
        };
        this.states.set(worker, state);
        worker.once("exit", () => {
            state.exited = true;
            markExited();
        });
        worker.unref();
        if (!(worker instanceof Worker)) worker.channel?.unref?.();
        worker.on("message", (wire: EmbeddingWorkerWireReply | EmbeddingWorkerReply) => {
            if (isEmbeddingWorkerStopNotice(wire)) {
                if (wire.control === "stopping")
                    state.stopNotice = {
                        busy: wire.busy,
                        busyMs: wire.busyMs,
                        receivedAt: performance.now(),
                    };
                return;
            }
            const reply: EmbeddingWorkerReply =
                worker instanceof Worker
                    ? (wire as EmbeddingWorkerReply)
                    : {
                          ...wire,
                          vectors: (wire as EmbeddingWorkerWireReply).vectors?.map((vector) =>
                              vector === null
                                  ? null
                                  : new Float32Array(
                                        Uint8Array.from(Buffer.from(vector, "base64")).buffer,
                                    ),
                          ),
                      };
            state.dispatched.delete(reply.id);
            if (this.worker !== worker) return;
            const request = this.pending.get(reply.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(reply.id);
            if (reply.error) request.reject(new Error(reply.error));
            else request.resolve(reply);
            if (this.pending.size === 0) {
                worker.unref();
                if (!(worker instanceof Worker)) worker.channel?.unref?.();
            }
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.clearIdleTimer();
            this.worker = null;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            this.pending.clear();
            log("[magic-context] embedding worker exited unexpectedly:", error);
            if (worker instanceof Worker) void worker.terminate();
            else worker.kill();
        };
        worker.on("error", fail);
        worker.on("exit", (code, signal) =>
            fail(new Error(`embedding worker exited (${signal ?? code})`)),
        );
        if (!(worker instanceof Worker)) worker.send({ entry: this.entry.href, data: this.data });
        return worker;
    }

    isRunning(): boolean {
        return this.worker !== null;
    }

    async request(texts?: string[], signal?: AbortSignal): Promise<EmbeddingWorkerReply> {
        if (signal?.aborted) return Promise.reject(new Error("embedding request aborted"));
        // Count the request and cancel idle shutdown before awaiting worker startup.
        this.activeRequests++;
        this.clearIdleTimer();
        try {
            return await this.requestOnWorker(texts, signal);
        } finally {
            this.activeRequests--;
            this.armIdleTimer();
        }
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private armIdleTimer(): void {
        if (this.disposed || this.activeRequests !== 0 || !this.worker) return;
        this.clearIdleTimer();
        this.idleTimer = inRootAsyncContext(() =>
            setTimeout(() => {
                this.idleTimer = null;
                // stop clears the worker before awaiting termination, so new requests can restart it.
                void this.stop(new Error("embedding worker idle"));
            }, this.idleMs),
        );
        this.idleTimer.unref();
    }

    private async requestOnWorker(
        texts?: string[],
        signal?: AbortSignal,
    ): Promise<EmbeddingWorkerReply> {
        const worker = await this.start();
        if (this.disposed) throw new Error("embedding worker disposed");
        if (signal?.aborted) throw new Error("embedding request aborted");
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            // Loading may download a model; inference must still have a finite deadline.
            const timer = setTimeout(() => {
                void this.stop(new Error("embedding worker request timed out"));
            }, this.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                signal?.removeEventListener("abort", abort);
                reject(new Error("embedding request aborted"));
                if (this.pending.size === 0) {
                    worker.unref();
                    if (!(worker instanceof Worker)) worker.channel?.unref?.();
                }
            };
            signal?.addEventListener("abort", abort, { once: true });
            const cleanup = () => signal?.removeEventListener("abort", abort);
            this.pending.set(id, {
                timer,
                resolve: (reply) => {
                    cleanup();
                    resolve(reply);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            });
            worker.ref();
            if (!(worker instanceof Worker)) worker.channel?.ref?.();
            this.states.get(worker)?.dispatched.set(id, performance.now());
            try {
                if (worker instanceof Worker) worker.postMessage({ id, texts });
                else
                    worker.send({ id, texts }, (error) => {
                        if (error && this.worker === worker) void this.stop(error);
                    });
            } catch (error) {
                void this.stop(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private async stop(error: Error): Promise<void> {
        this.clearIdleTimer();
        const worker = this.worker;
        this.worker = null;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        if (!worker) return;
        const stopped = this.stopWorker(worker, error.message);
        this.stopping.add(stopped);
        try {
            await stopped;
        } finally {
            this.stopping.delete(stopped);
        }
    }

    /**
     * Ask the worker to stop and wait until it has exited. The worker finishes
     * the inference call it is running first: terminating a Node worker thread
     * inside the native ONNX Runtime call aborts the whole host process. Only a
     * worker that has not exited within the grace bound is terminated, and the
     * stop always settles within `EMBEDDING_WORKER_STOP_MAX_MS` (plus log writes).
     */
    private async stopWorker(worker: EmbeddingWorkerHandle, reason: string): Promise<void> {
        const state = this.states.get(worker);
        if (!state || state.exited) return;
        const writeLog = this.options.log ?? log;
        const graceMs = this.options.stopGraceMs ?? EMBEDDING_WORKER_STOP_GRACE_MS;
        const forcedExitWaitMs =
            this.options.forcedExitWaitMs ?? EMBEDDING_WORKER_FORCED_EXIT_WAIT_MS;
        const owner =
            worker instanceof Worker
                ? `pid ${process.pid}`
                : `pid ${process.pid}, worker pid ${worker.pid ?? "unknown"}`;
        const startedAt = performance.now();
        // Unanswered requests include those whose callers gave up: the worker still runs them.
        const stopSince = busySince(state);
        // Keep the host's event loop alive while the worker finishes, on purpose:
        // a process that exits by itself while the worker is inside a native call
        // aborts just as a forced stop does.
        worker.ref();
        if (!(worker instanceof Worker)) worker.channel?.ref?.();
        const request: EmbeddingWorkerStopRequest = { stop: true };
        try {
            if (worker instanceof Worker) worker.postMessage(request);
            else if (worker.connected) worker.send(request, () => {});
        } catch {
            // A worker that cannot be asked is terminated when the bound expires.
        }
        // Only the worker's real exit counts; its `stopped` message can precede
        // the thread's teardown.
        if (await exitsWithin(state.exit, graceMs)) {
            writeLog(
                `[magic-context] embedding worker stopped (${reason}; ${owner}; inference running: ${describeRunning(stopSince, startedAt)}; stop took ${Math.round(performance.now() - startedAt)}ms)`,
            );
            // Write the line at once: a buffered line arms the logger's flush
            // timer, which would keep an otherwise finished process alive.
            flushLogger();
            return;
        }
        writeLog(
            `[magic-context] embedding worker did not stop within ${graceMs}ms; terminating it (${reason}; ${owner}; inference running: ${describeStuckWorker(state, stopSince)})`,
        );
        // Write the line now: if the termination brings the process down, a
        // buffered line would be lost with it.
        flushLogger();
        try {
            if (worker instanceof Worker) void worker.terminate().catch(() => {});
            else worker.kill();
        } catch {
            // Whether the worker is gone is decided by its exit event below.
        }
        if (await exitsWithin(state.exit, forcedExitWaitMs)) return;
        let killed = false;
        if (!(worker instanceof Worker) && process.platform !== "win32") {
            try {
                killed = worker.kill("SIGKILL");
            } catch {
                // Reported below as not exited.
            }
            if (await exitsWithin(state.exit, EMBEDDING_WORKER_SIGKILL_WAIT_MS)) return;
        }
        writeLog(
            `[magic-context] embedding worker has not exited ${forcedExitWaitMs}ms after it was terminated${killed ? " and sent SIGKILL" : ""}; no longer waiting for it (${reason}; ${owner})`,
        );
        flushLogger();
        // Let the host exit even though this worker never confirmed its end.
        worker.unref();
        if (!(worker instanceof Worker)) worker.channel?.unref?.();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.startPromise?.catch(() => {});
        await this.stop(new Error("embedding worker disposed"));
        // An idle or timed-out worker stopped earlier may still be finishing its inference.
        await Promise.all([...this.stopping]);
    }
}
