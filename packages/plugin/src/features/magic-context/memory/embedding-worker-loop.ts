import type { EmbeddingFailure } from "./embedding-failure";
import type { LocalEmbeddingNativeMemoryStats } from "./embedding-local";

/** Sent by the client to ask the worker to finish its current inference and exit. */
export type EmbeddingWorkerStopRequest = { stop: true };

/**
 * Sent by the worker while it stops. `stopping` answers the stop request as soon
 * as the worker's JavaScript runs again; `stopped` follows once the model is
 * released, just before the worker exits. `busy` says whether a request was
 * being processed when the stop arrived, and for how long it had run.
 */
export type EmbeddingWorkerStopNotice =
    | { control: "stopping"; busy: boolean; busyMs: number }
    | { control: "stopped"; busy: boolean; waitedMs: number };

/** Error text of requests the worker refuses because it is stopping. */
export const EMBEDDING_WORKER_STOPPING_ERROR = "embedding worker stopping";

export function isEmbeddingWorkerStopNotice(
    message: unknown,
): message is EmbeddingWorkerStopNotice {
    return (
        typeof message === "object" &&
        message !== null &&
        "control" in message &&
        ((message as { control?: unknown }).control === "stopping" ||
            (message as { control?: unknown }).control === "stopped")
    );
}

/** The model the worker serves: the real local provider, or a test double. */
export interface EmbeddingWorkerModel {
    initialize(): Promise<boolean>;
    embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
    getLastFailureReason(): EmbeddingFailure | null;
    /** Releases the model's runtime sessions. */
    dispose(): Promise<void>;
}

export interface EmbeddingWorkerPort {
    on(event: "message", listener: (message: unknown) => void): unknown;
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

export interface EmbeddingWorkerLoopOptions {
    /** Texts per inference call; a stop request is honoured between calls. */
    batchSize: number;
    stats?: () => LocalEmbeddingNativeMemoryStats | undefined;
    /** Ends the worker once the model is released and `stopped` is posted. */
    exit: () => void;
    now?: () => number;
}

/**
 * Serve embedding requests one at a time and stop on request without ever being
 * interrupted inside an inference.
 *
 * Under Node, terminating a worker thread while it is inside the native ONNX
 * Runtime call makes the native binding throw into a stopping JavaScript
 * environment, which aborts the whole host process. So the worker owns its own
 * shutdown: a stop request lets the inference call already running finish,
 * starts no further call (later batches of the same request and every queued or
 * later request are refused), releases the model and then ends the worker.
 */
export function serveEmbeddingWorker(
    port: EmbeddingWorkerPort,
    model: EmbeddingWorkerModel,
    options: EmbeddingWorkerLoopOptions,
): void {
    const now = options.now ?? (() => performance.now());
    // Transformers pipelines and output buffers cannot safely run concurrently.
    let queue = Promise.resolve();
    let stopping = false;
    let busySince: number | null = null;

    const refuse = (id: number) =>
        port.postMessage({ id, loaded: false, error: EMBEDDING_WORKER_STOPPING_ERROR });

    const handle = async (request: { id: number; texts?: string[] }) => {
        if (stopping) return refuse(request.id);
        busySince = now();
        try {
            const loaded = await model.initialize();
            let vectors: (Float32Array | null)[] | undefined;
            if (loaded && request.texts) {
                vectors = [];
                // Bounded batches limit temporary model allocations and give a
                // stop request a point at which no inference is running.
                for (let offset = 0; offset < request.texts.length; offset += options.batchSize) {
                    // Awaiting the previous batch only runs microtasks; a stop request
                    // sent during it waits in the message queue. One macrotask turn
                    // lets it be read before the next batch starts. A single-batch
                    // request never pays for this.
                    if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve));
                    if (stopping) throw new Error(EMBEDDING_WORKER_STOPPING_ERROR);
                    vectors.push(
                        ...(await model.embedBatch(
                            request.texts.slice(offset, offset + options.batchSize),
                        )),
                    );
                }
            }
            port.postMessage(
                {
                    id: request.id,
                    loaded,
                    vectors,
                    failure: model.getLastFailureReason(),
                    stats: options.stats?.(),
                },
                vectors?.flatMap((vector) => (vector ? [vector.buffer as ArrayBuffer] : [])) ?? [],
            );
        } catch (error) {
            port.postMessage({ id: request.id, loaded: false, error: String(error) });
        } finally {
            busySince = null;
        }
    };

    const stop = async () => {
        stopping = true;
        const requestedAt = now();
        const busy = busySince !== null;
        port.postMessage({
            control: "stopping",
            busy,
            busyMs: busySince === null ? 0 : requestedAt - busySince,
        } satisfies EmbeddingWorkerStopNotice);
        await queue;
        try {
            await model.dispose();
        } catch {
            // The worker ends next, which frees whatever the failed release kept.
        }
        port.postMessage({
            control: "stopped",
            busy,
            waitedMs: now() - requestedAt,
        } satisfies EmbeddingWorkerStopNotice);
        options.exit();
    };

    port.on("message", (message) => {
        if ((message as Partial<EmbeddingWorkerStopRequest>)?.stop === true) {
            if (!stopping) void stop();
            return;
        }
        const request = message as { id: number; texts?: string[] };
        // A request that arrives after the stop request never starts.
        if (stopping) return refuse(request.id);
        queue = queue.then(() => handle(request));
    });
}
