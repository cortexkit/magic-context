import type { MessagePort, Worker } from "node:worker_threads";

/**
 * Stopping a worker thread that still has a SQLite connection open.
 *
 * On Bun 1.4.4, `worker.terminate()` closes the worker's open `bun:sqlite`
 * connections while it tears the thread down, and for that whole teardown
 * (measured from a few ms up to about 460 ms) every other connection to the same
 * file gets SQLITE_BUSY when it asks for the writer lock. Reads keep working. A
 * caller that terminates a worker and then writes at once, such as
 * `clearSession()` cancelling a session's auto-search backfill, then fails its
 * own write. Bun 1.4.3 and earlier did not do this, and a worker that closes
 * its connection itself never causes it on any version.
 *
 * So an owner asks the worker to stop: it posts {@link WORKER_CLOSE_MESSAGE},
 * the worker closes its connections and exits (see {@link exitOnWorkerClose}),
 * and `terminate()` runs only if the worker has not exited by a deadline. The
 * deadline is chosen per worker from the longest synchronous SQLite work it may
 * be in the middle of, because a worker handles the message only between
 * statements. Bun 1.3 queues parent messages until a worker's entry module has
 * finished evaluating, so a close posted while the worker is still loading is
 * handled as soon as it has loaded.
 */
export const WORKER_CLOSE_MESSAGE = { kind: "close" } as const;

export function isWorkerCloseMessage(message: unknown): boolean {
    return (
        typeof message === "object" &&
        message !== null &&
        (message as { kind?: unknown }).kind === WORKER_CLOSE_MESSAGE.kind
    );
}

/**
 * Worker side: when the owner asks this worker to stop, close its connections
 * and end the thread. `process.exit()` in a worker thread ends only that
 * thread, on Node and on Bun. Other `message` listeners in the worker see the
 * same message and must ignore its kind.
 *
 * On Bun 1.3.14 a worker whose parent port still has a `message` listener does
 * not exit after `port.close()`, so this listener must never outlive the port.
 * A worker that installs it closes its port only through the returned
 * `closePort`, which removes the listener first (on the next timer turn). The port's own `close()`
 * cannot be wrapped instead: on Bun 1.3.14 it is a read-only, non-configurable
 * property. `worker-shutdown-fence.test.ts` rejects any direct port close in a
 * file that calls this function.
 */
export function exitOnWorkerClose(
    port: WorkerClosePort | null,
    closeConnections: () => void,
    exitThread = true,
): { closePort(): void } {
    const listener = (message: unknown) => {
        if (!isWorkerCloseMessage(message)) return;
        try {
            closeConnections();
        } finally {
            // Exit even if a close threw: the thread is ending and a connection
            // that could not close is released by the thread's teardown instead.
            if (exitThread) process.exit(0);
            // A reusable job with no asynchronous work left releases only its
            // job port, after closing the connection and removing this listener.
            closePort();
        }
    };
    if (!port) return { closePort() {} };
    const owner = port;
    owner.on("message", listener);
    let closed = false;
    function closePort() {
        if (closed) return;
        closed = true;
        // Close on a later timer turn, not synchronously: on Bun 1.3.14 a
        // port closed while an entry module with a top-level await is still
        // evaluating does not end the thread. Every current caller closes
        // its port at the end of the module body or later, so the timer runs
        // after evaluation has finished.
        setTimeout(() => {
            owner.off("message", listener);
            owner.close();
        });
    }
    return { closePort };
}

/** The parts of a worker's parent port that {@link exitOnWorkerClose} uses. */
export type WorkerClosePort = Pick<MessagePort, "on" | "off" | "close">;

export interface WorkerShutdown {
    /**
     * Ask the worker to close its connections and exit; terminate it if it has
     * not exited after the deadline. Calling it again returns the same promise.
     * Resolves once the worker has exited.
     */
    close(): Promise<void>;
}

const outcomes = new Map<string, { graceful: number; forced: number }>();

/** How each site's workers ended after a close, by themselves or terminated. A snapshot. */
export function getWorkerShutdownStats(): ReadonlyMap<
    string,
    { readonly graceful: number; readonly forced: number }
> {
    return new Map([...outcomes].map(([site, counts]) => [site, { ...counts }]));
}

/**
 * Owner side. Call right after creating the worker, so its exit is observed
 * even when it exits before anyone asks it to close.
 *
 * @param site names the worker in {@link getWorkerShutdownStats}.
 * @param deadlineMs how long the worker may take to close and exit before it
 *   is terminated.
 */
export function createWorkerShutdown(
    worker: Worker,
    site: string,
    deadlineMs: number,
): WorkerShutdown {
    let exited = false;
    let forced = false;
    let closing: Promise<void> | undefined;
    const exit = new Promise<void>((resolve) => {
        worker.once("exit", () => {
            exited = true;
            resolve();
        });
    });
    const record = () => {
        const counts = outcomes.get(site) ?? { graceful: 0, forced: 0 };
        if (forced) counts.forced += 1;
        else counts.graceful += 1;
        outcomes.set(site, counts);
    };
    const terminate = () => {
        forced = true;
        void worker.terminate().catch(() => {});
    };
    return {
        close() {
            if (closing) return closing;
            if (exited) {
                closing = Promise.resolve();
                return closing;
            }
            try {
                worker.postMessage(WORKER_CLOSE_MESSAGE);
            } catch {
                terminate();
            }
            const fallback = setTimeout(() => {
                if (!exited) terminate();
            }, deadlineMs);
            // A host that is exiting must not wait for this timer.
            fallback.unref?.();
            closing = exit.then(() => {
                clearTimeout(fallback);
                record();
            });
            return closing;
        },
    };
}
