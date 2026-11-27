import { parentPort, workerData } from "node:worker_threads";
import { setHarness } from "../../../shared/harness";
import { flushLogger, log } from "../../../shared/logger";
import { setStoragePrivatePermissionEnforcement } from "../../../shared/storage-permissions";
import {
    getLocalEmbeddingNativeMemoryStats,
    LocalEmbeddingProvider,
    resolveLocalEmbeddingWorkerRuntime,
} from "./embedding-local";
import { serveEmbeddingWorker } from "./embedding-worker-loop";

setHarness(workerData.harness);
setStoragePrivatePermissionEnforcement(workerData.enforcePrivateStoragePermissions !== false);

// On Bun before 1.4, shutting down native ONNX in a worker can panic the entire process.
// Use WASM to avoid that native-addon cleanup even if the user requested native.
const unsafeNative =
    workerData.runtimePreference === "native" &&
    resolveLocalEmbeddingWorkerRuntime("native") === "wasm";
if (unsafeNative)
    log(
        "[magic-context] native embedding worker teardown is unsafe on this Bun version; using WASM. Upgrade the host to Bun >=1.4.0 for native inference.",
    );
const provider = new LocalEmbeddingProvider(
    workerData.model,
    workerData.maxInputTokens,
    workerData.dtype,
    unsafeNative ? "wasm" : workerData.runtimePreference,
);
if (parentPort)
    serveEmbeddingWorker(parentPort, provider, {
        // At most two texts per inference call bound temporary model allocations.
        batchSize: 2,
        stats: getLocalEmbeddingNativeMemoryStats,
        exit: () => {
            flushLogger();
            // The model is released and no inference is running, so ending the
            // thread here cannot interrupt a native call; waiting for the event
            // loop to drain could instead wait on unrelated timers.
            process.exit(0);
        },
    });
