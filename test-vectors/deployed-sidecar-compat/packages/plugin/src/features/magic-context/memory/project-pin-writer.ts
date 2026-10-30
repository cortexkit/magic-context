import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { log } from "../../../shared/logger";
import {
    setStoragePrivatePermissionEnforcement,
    shouldEnforcePrivateStoragePermissions,
    writeStorageFileAtomicSync,
} from "../../../shared/storage-permissions";
import type { ProjectIdentityRecord } from "./project-identity-cache";
import type { PinWriteRequest } from "./project-pin-worker";

type WritePin = (request: PinWriteRequest) => Promise<void>;
interface Pin extends PinWriteRequest {
    persisted: boolean;
    awaitingDecision: boolean;
}

const failedPinDestinations = new Set<string>();
let workerUnavailableReported = false;

class WorkerUnavailableError extends Error {
    constructor(cause: unknown) {
        super(`Pin worker unavailable: ${cause}`);
    }
}

/** One active atomic write, with at most 256 distinct destinations waiting. */
export class ProjectPinWriter {
    private readonly pins = new Map<string, Pin>();
    private readonly queued = new Map<string, Pin>();
    private active: Pin | undefined;
    private closing = false;
    private saturated = false;
    private pumpScheduled = false;
    private readonly changed = new Set<() => void>();

    constructor(
        private readonly write: WritePin,
        private readonly capacity = 256,
        private readonly report: (message: string) => void = log,
    ) {}

    publish(destination: string, record: ProjectIdentityRecord): void {
        // Keep the original record if later resolutions propose a different identity
        // for this destination, even while its first write is still pending.
        const existing = this.pins.get(destination);
        const pin = existing ?? {
            destination,
            record: { ...record },
            privateStorage: shouldEnforcePrivateStoragePermissions(),
            persisted: false,
            awaitingDecision: false,
        };
        // A fresh publish follows a new identity decision; lookups during the same
        // decision or later context passes must not retry a failed disk write.
        pin.awaitingDecision = false;
        this.pins.set(destination, pin);
        this.schedule(pin);
    }

    lookup(destination: string): ProjectIdentityRecord | undefined {
        const pin = this.pins.get(destination);
        if (!pin) return undefined;
        this.schedule(pin);
        return { ...pin.record };
    }

    records(sidecarDirectory: string): ProjectIdentityRecord[] {
        return [...this.pins.values()]
            .filter((pin) => dirname(pin.destination) === sidecarDirectory)
            .map((pin) => ({ ...pin.record }));
    }

    private schedule(pin: Pin): void {
        if (pin.persisted || pin.awaitingDecision || this.closing || this.active === pin) return;
        if (this.queued.has(pin.destination) || this.queued.size < this.capacity) {
            this.queued.set(pin.destination, pin);
            if (!this.pumpScheduled) {
                this.pumpScheduled = true;
                queueMicrotask(() => {
                    this.pumpScheduled = false;
                    this.pump();
                });
            }
        } else if (!this.saturated) {
            this.saturated = true;
            this.report(
                "[magic-context] project pin writer saturated; retaining pins in memory until a later decision",
            );
        }
    }

    private pump(): void {
        if (this.active) return;
        const pin = this.queued.values().next().value;
        if (!pin) return;
        this.queued.delete(pin.destination);
        this.saturated = false;
        this.active = pin;
        void Promise.resolve()
            .then(() => this.write(pin))
            .then(
                () => {
                    pin.persisted = true;
                },
                (error) => {
                    pin.awaitingDecision = true;
                    if (!failedPinDestinations.has(pin.destination)) {
                        failedPinDestinations.add(pin.destination);
                        this.report(
                            `[magic-context] project pin persistence failed; retaining process pin: ${error}`,
                        );
                    }
                },
            )
            .finally(() => {
                this.active = undefined;
                this.pump();
                for (const notify of this.changed) notify();
            });
    }

    async flush(boundMs = 250): Promise<boolean> {
        this.pump();
        if (!this.active && !this.queued.size) return true;
        return new Promise<boolean>((resolve) => {
            const finish = (drained: boolean) => {
                clearTimeout(timer);
                this.changed.delete(check);
                resolve(drained);
            };
            const check = () => {
                if (!this.active && !this.queued.size) finish(true);
            };
            const timer = setTimeout(() => finish(false), boundMs);
            this.changed.add(check);
        });
    }

    async shutdown(boundMs = 250): Promise<boolean> {
        this.closing = true;
        const drained = await this.flush(boundMs);
        this.queued.clear();
        return drained;
    }
}

export class PinWorker {
    private worker: Worker | undefined;
    private pending: { resolve: () => void; reject: (error: unknown) => void } | undefined;
    private unavailable = false;

    constructor(
        private readonly workerUrl = new URL(
            import.meta.url.endsWith(".ts") ? "./project-pin-worker.ts" : "./project-pin-worker.js",
            import.meta.url,
        ),
        private readonly createWorker: (url: URL) => Worker = (url) => new Worker(url),
        private readonly report: (message: string) => void = log,
    ) {}

    write: WritePin = async (request) => {
        if (!this.unavailable) {
            try {
                await this.writeWithWorker(request);
                return;
            } catch (error) {
                if (!(error instanceof WorkerUnavailableError)) throw error;
            }
        }
        this.writeInProcess(request);
    };

    private writeWithWorker(request: PinWriteRequest): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                if (!this.worker) {
                    const worker = this.createWorker(this.workerUrl);
                    this.worker = worker;
                    worker.on("message", (message: { ok: boolean; error?: string }) => {
                        if (this.worker !== worker) return;
                        const pending = this.pending;
                        this.pending = undefined;
                        if (message.ok) pending?.resolve();
                        else pending?.reject(new Error(message.error ?? "Pin write failed"));
                    });
                    worker.on("error", (error) => this.failed(worker, error));
                    worker.on("exit", (code) =>
                        this.failed(worker, new Error(`Pin worker exited (${code})`)),
                    );
                    worker.unref();
                }
                this.pending = { resolve, reject };
                this.worker.postMessage(request);
            } catch (error) {
                if (this.worker) this.failed(this.worker, error);
                else this.unavailable = true;
                reject(new WorkerUnavailableError(error));
            }
        });
    }

    private writeInProcess(request: PinWriteRequest): void {
        if (!workerUnavailableReported) {
            workerUnavailableReported = true;
            this.report("[magic-context] pin worker unavailable; writing pins in process");
        }
        setStoragePrivatePermissionEnforcement(request.privateStorage);
        writeStorageFileAtomicSync(request.destination, JSON.stringify(request.record));
    }

    private failed(worker: Worker, error: unknown): void {
        if (this.worker !== worker) return;
        this.worker = undefined;
        this.unavailable = true;
        this.pending?.reject(new WorkerUnavailableError(error));
        this.pending = undefined;
        void worker.terminate();
    }

    close(): void {
        if (this.worker) this.failed(this.worker, new Error("Pin writer closed"));
    }
}

let writer: ProjectPinWriter | undefined;
let worker: PinWorker | undefined;
let exitRegistered = false;

export function projectPinWriter(): ProjectPinWriter {
    if (!writer) {
        worker = new PinWorker();
        writer = new ProjectPinWriter(worker.write);
        if (!exitRegistered) {
            exitRegistered = true;
            process.once("beforeExit", () => {
                // flush()'s timer keeps the event loop alive for up to 250 ms while
                // queued pin writes finish. The worker itself is unreferenced.
                void writer?.shutdown(250).finally(() => worker?.close());
            });
            process.once("exit", () => worker?.close());
        }
    }
    return writer;
}

export function flushProjectPinWrites(boundMs = 250): Promise<boolean> {
    return writer?.flush(boundMs) ?? Promise.resolve(true);
}

/** Drain before a test removes its directories; replacement lets tests block or reject writes without disk I/O. */
export async function __setProjectPinWriterForTests(replacement?: ProjectPinWriter): Promise<void> {
    await writer?.shutdown(1_000);
    worker?.close();
    worker = undefined;
    writer = replacement;
}

/** Reset process-wide diagnostics between tests that share this module instance. */
export function __resetProjectPinWriterDiagnosticsForTests(): void {
    failedPinDestinations.clear();
    workerUnavailableReported = false;
}
