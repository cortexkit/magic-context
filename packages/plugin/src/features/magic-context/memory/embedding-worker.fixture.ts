import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { serveEmbeddingWorker } from "./embedding-worker-loop";

const nativeEnv = workerData.probeAddon
    ? createRequire(import.meta.url)(workerData.probeAddon).readNativeEnv()
    : undefined;

/** Blocks this thread without using the CPU, like a native call the worker cannot leave. */
function blockFor(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serves requests through the production worker loop with a stand-in model, so
// the client's transport and stop protocol run against the real worker logic.
// `boundaryProbe` switches to production batching (two texts per call): each
// call reports its texts to the parent and then blocks for 150 ms.
// `exitDelayMs` delays the exit after the worker has posted `stopped`.
const boundaryProbe = workerData.boundaryProbe === true;
const exitDelayMs = typeof workerData.exitDelayMs === "number" ? workerData.exitDelayMs : 0;
if (parentPort) {
    const port = parentPort;
    serveEmbeddingWorker(
        port,
        {
            initialize: async () => true,
            getLastFailureReason: () => null,
            dispose: async () => {},
            embedBatch: async (texts) => {
                if (boundaryProbe) {
                    port.postMessage({ probe: "batch", texts });
                    blockFor(150);
                    return texts.map((text) => new Float32Array([text.length]));
                }
                if (texts[0] === "crash") process.exit(7);
                if (texts[0]?.startsWith("hang")) return new Promise(() => {});
                const start = performance.now();
                while (performance.now() - start < 350) {
                    // A synchronous CPU-bound batch stands in for the native inference call:
                    // it makes accidental host-thread execution observable, and the worker
                    // cannot read a stop request until it returns.
                }
                return texts.map((text) =>
                    text === "pid"
                        ? new Float32Array([process.pid])
                        : text === "native-env"
                          ? new Float32Array([nativeEnv === "1" ? 1 : 0])
                          : text === "special-floats"
                            ? new Float32Array([-0, NaN, Infinity, -Infinity])
                            : new Float32Array([text.length, 0.125, -0.25]),
                );
            },
        },
        {
            // Otherwise one inference call per request, as the fixture always modelled it.
            batchSize: boundaryProbe ? 2 : Number.POSITIVE_INFINITY,
            exit: () => {
                if (exitDelayMs > 0) setTimeout(() => process.exit(0), exitDelayMs);
                else process.exit(0);
            },
        },
    );
}
