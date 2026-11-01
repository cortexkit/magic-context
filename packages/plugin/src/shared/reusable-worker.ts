import { EventEmitter } from "node:events";
import * as timers from "node:timers";
import {
    MessageChannel,
    receiveMessageOnPort,
    Worker,
    type WorkerOptions,
} from "node:worker_threads";
import { registerExitAbort, unregisterExitAbort } from "./exit-abort-registry";
import { inRootAsyncContext } from "./sqlite";

const pools = new Map<string, Slot>();
const liveSlots = new Set<Slot>();
let nextId = 0;
const IDLE_MS = 60_000;
const sharedCloneWorks = (() => {
    const source = new SharedArrayBuffer(1);
    const clone = structuredClone(source);
    new Uint8Array(source)[0] = 1;
    return new Uint8Array(clone)[0] === 1;
})();
let cloneChannel: MessageChannel | undefined;

function cloneJobValue<T>(value: T, transferList?: readonly object[]): T {
    if (sharedCloneWorks) return structuredClone(value, { transfer: transferList as never });
    // Bun 1.3's structuredClone snapshots shared buffers, but native message
    // transport preserves them. One reusable channel keeps cancellation and
    // writer coordination shared without allocating ports for every job.
    if (!cloneChannel) {
        cloneChannel = inRootAsyncContext(() => new MessageChannel());
        cloneChannel.port1.unref();
        cloneChannel.port2.unref();
    }
    cloneChannel.port1.postMessage(value, transferList as never);
    const packet = receiveMessageOnPort(cloneChannel.port2);
    if (!packet) throw new Error("worker input clone did not arrive synchronously");
    return packet.message as T;
}

interface Slot {
    worker: Worker;
    controller: AbortController;
    queue: Lease[];
    active?: Lease;
    idle?: ReturnType<typeof timers.setTimeout>;
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
        else this.outbox.push(cloneJobValue({ value, transferList }, transferList));
    }
    start() {
        if (this.referenced) this.slot.worker.ref();
        else this.slot.worker.unref();
        this.emit("online");
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
    const data = cloneJobValue(options.workerData);
    const slot = acquireSlot(entry, options, idleMs);
    const lease = new Lease(slot, data);
    enqueue(slot, lease);
    return lease as unknown as Worker;
}

/** End test-owned pools before another test can replace their timers or databases. */
export async function resetReusableWorkersForTests(): Promise<void> {
    while (liveSlots.size) {
        const slots = [...liveSlots];
        pools.clear();
        await Promise.all(
            slots.map(
                (slot) =>
                    new Promise<void>((resolve) => {
                        timers.clearTimeout(slot.idle);
                        slot.idle = undefined;
                        slot.worker.once("exit", () => resolve());
                        slot.controller.abort();
                    }),
            ),
        );
    }
    cloneChannel?.port1.close();
    cloneChannel?.port2.close();
    cloneChannel = undefined;
}

function enqueue(slot: Slot, lease: Lease): void {
    timers.clearTimeout(slot.idle);
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
        const controller = new AbortController();
        slot = { worker, controller, queue: [], advance: () => {} };
        pools.set(key, slot);
        liveSlots.add(slot);
        const owned = slot;
        const advance = () => {
            if (controller.signal.aborted || owned.active) return;
            timers.clearTimeout(owned.idle);
            const lease = owned.queue.shift();
            owned.active = lease;
            if (!lease) {
                worker.unref();
                // A caller's temporary clock must not own a shared pool's lifetime.
                owned.idle = timers.setTimeout(() => {
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
            liveSlots.delete(owned);
            timers.clearTimeout(owned.idle);
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
