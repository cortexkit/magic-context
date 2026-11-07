import { EventEmitter } from "node:events";
import { type MessagePort, parentPort, workerData } from "node:worker_threads";

/** Dispatch each job with new per-job state and a port whose messages are matched by job id. */
export function serveWorkerJobs<T>(
    run: (data: T, port: MessagePort) => Promise<void> | void,
    autoClose = true,
): void {
    if (!parentPort) throw new Error("worker requires a parent port");
    const parent = parentPort;
    if (!workerData?.reusableWorker) {
        void Promise.resolve(run(workerData, parent)).catch(rethrow);
        return;
    }
    let active: { id: number; port: EventEmitter } | undefined;
    parent.on("message", (message: { jobId: number; start?: T; value?: unknown }) => {
        if (!("start" in message)) {
            if (active?.id === message.jobId) active.port.emit("message", message.value);
            return;
        }
        if (active) throw new Error("reusable worker received overlapping jobs");
        const id = message.jobId;
        let closed = false;
        const port = Object.assign(new EventEmitter(), {
            postMessage(value: unknown, transferList?: readonly object[]) {
                if (!closed) parent.postMessage({ jobId: id, value }, transferList as never);
            },
            close() {
                if (closed) return;
                closed = true;
                port.removeAllListeners();
                active = undefined;
                parent.postMessage({
                    jobId: id,
                    finished: true,
                    code: Number(process.exitCode) || 0,
                });
            },
        });
        active = { id, port };
        try {
            void Promise.resolve(run(message.start as T, port as unknown as MessagePort))
                .then(() => {
                    if (autoClose) port.close();
                })
                .catch(rethrow);
        } catch (error) {
            rethrow(error);
        }
    });
}

function rethrow(error: unknown): void {
    // Bun 1.3 aborts the host for a microtask throw; a timer reports a Worker error.
    setTimeout(() => {
        throw error;
    });
}
