import { EventEmitter } from "node:events";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { registerExitAbort, unregisterExitAbort } from "./exit-abort-registry";
import { inRootAsyncContext } from "./sqlite";

const pools = new Map<string, Slot>();
let nextId = 0;
const IDLE_MS = 60_000;

interface Slot {
    worker: Worker;
    queue: Lease[];
    active?: Lease;
    idle?: ReturnType<typeof setTimeout>;
    advance(): void;
}

class Lease extends EventEmitter {
    readonly id = ++nextId;
    ended = false;
    referenced = true;
    readonly outbox: Array<{ value: unknown; transferList?: readonly object[] }> = [];
    constructor(
        public slot: Slot,
        readonly data: unknown,
    ) {
        super();
    }
    postMessage(value: unknown, transferList?: readonly object[]) {
        if (this.ended) return;
        if (this.slot.active === this)
            this.slot.worker.postMessage({ jobId: this.id, value }, transferList as never);
        else
            this.outbox.push(
                structuredClone({ value, transferList }, { transfer: transferList as never }),
            );
    }
    start() {
        if (this.referenced) this.slot.worker.ref();
        else this.slot.worker.unref();
        this.slot.worker.postMessage({ jobId: this.id, start: this.data });
        for (const { value, transferList } of this.outbox.splice(0))
            this.postMessage(value, transferList);
    }
    ref() {
        this.referenced = true;
        if (this.slot.active === this) this.slot.worker.ref();
        return this;
    }
    unref() {
        this.referenced = false;
        if (this.slot.active === this) this.slot.worker.unref();
        return this;
    }
    async terminate(): Promise<number> {
        if (this.ended) return 0;
        if (this.slot.active === this) return await this.slot.worker.terminate();
        this.ended = true;
        this.slot.queue.splice(this.slot.queue.indexOf(this), 1);
        this.emit("exit", 0);
        return 0;
    }
}

/** A job-local Worker interface; only the idle thread, never job state, is reused. */
export function reuseWorker(entry: URL | string, options: WorkerOptions, idleMs = IDLE_MS): Worker {
    // Native Worker construction copies its input immediately, even if the job
    // cannot start yet. Do not let a queued job observe later caller mutations.
    const data = structuredClone(options.workerData);
    const slot = acquireSlot(entry, options, idleMs);
    const lease = new Lease(slot, data);
    enqueue(slot, lease);
    return lease as unknown as Worker;
}

function enqueue(slot: Slot, lease: Lease): void {
    clearTimeout(slot.idle);
    lease.slot = slot;
    slot.queue.push(lease);
    // Let callers attach their listeners before a queued job starts.
    queueMicrotask(() => slot.advance());
}

function acquireSlot(entry: URL | string, options: WorkerOptions, idleMs: number): Slot {
    const data = options.workerData;
    const key = JSON.stringify([
        String(entry),
        data?.path ?? data?.dbPath,
        data?.harness,
        data?.job,
    ]);
    let slot = pools.get(key);
    if (!slot) {
        const worker = inRootAsyncContext(
            () => new Worker(entry, { ...options, workerData: { reusableWorker: true } }),
        );
        slot = { worker, queue: [], advance: () => {} };
        pools.set(key, slot);
        const owned = slot;
        const advance = () => {
            if (owned.active) return;
            clearTimeout(owned.idle);
            const lease = owned.queue.shift();
            owned.active = lease;
            if (!lease) {
                worker.unref();
                owned.idle = setTimeout(() => {
                    if (pools.get(key) === owned) pools.delete(key);
                    void worker.terminate();
                }, idleMs);
                owned.idle.unref();
                return;
            }
            lease.start();
        };
        owned.advance = advance;
        worker.on(
            "message",
            (message: { jobId: number; value?: unknown; finished?: boolean; code?: number }) => {
                const lease = owned.active;
                if (!lease || message.jobId !== lease.id) return;
                if (!message.finished) {
                    lease.emit("message", message.value);
                    return;
                }
                lease.ended = true;
                owned.active = undefined;
                if (message.code) {
                    if (pools.get(key) === owned) pools.delete(key);
                    lease.emit("exit", message.code);
                    void worker.terminate();
                    return;
                }
                lease.emit("exit", 0);
                advance();
            },
        );
        worker.on("error", (error) => {
            if (pools.get(key) === owned) pools.delete(key);
            owned.active?.emit("error", error);
        });
        worker.on("exit", (code) => {
            clearTimeout(owned.idle);
            if (pools.get(key) === owned) pools.delete(key);
            const active = owned.active;
            owned.active = undefined;
            if (active && !active.ended) {
                active.ended = true;
                active.emit("exit", code);
            }
            // Only the active job hit the failed thread. Move unstarted jobs to
            // its replacement without retrying any work that may have run.
            // During process shutdown, release queued leases instead of
            // spawning threads into a torn-down host.
            for (const lease of owned.queue.splice(0)) {
                if (controller.signal.aborted) {
                    lease.ended = true;
                    lease.emit("exit", code);
                } else {
                    try {
                        enqueue(acquireSlot(entry, options, idleMs), lease);
                    } catch (error) {
                        // Bun can destroy a test file's worker communication
                        // channel without firing process exit. Report a failed
                        // replacement through its lease rather than throwing
                        // from this exit callback between files.
                        lease.ended = true;
                        lease.emit("error", error);
                        lease.emit("exit", 1);
                    }
                }
            }
        });
        const controller = new AbortController();
        controller.signal.addEventListener(
            "abort",
            () => {
                void worker.terminate();
            },
            { once: true },
        );
        registerExitAbort(controller);
        worker.once("exit", () => unregisterExitAbort(controller));
    }
    return slot;
}
