import { parentPort, threadId } from "node:worker_threads";
import { serveWorkerJobs } from "./reusable-worker-entry";

serveWorkerJobs<{
    crash?: boolean;
    hang?: boolean;
    late?: boolean;
    exitCode?: boolean;
    value?: string;
    shared?: SharedArrayBuffer;
}>(async (input, port) => {
    if (input.crash) throw new Error("injected worker crash");
    if (input.hang) return await new Promise<void>(() => {});
    if (input.exitCode) process.exitCode = 1;
    if (input.shared) {
        const state = new Int32Array(input.shared);
        port.postMessage({ threadId, shared: Atomics.load(state, 0) });
        await new Promise<void>((resolve) =>
            port.once("message", () => {
                port.postMessage({ threadId, shared: Atomics.add(state, 0, 1) });
                resolve();
            }),
        );
        port.close();
        return;
    }
    if (input.late)
        setTimeout(() => {
            port.postMessage({ value: "stale" });
            // Bypass the job port to verify the owner ignores a mismatched job id.
            parentPort?.postMessage({ jobId: -1, value: { value: "stale" } });
        }, 20);
    port.postMessage({ threadId, value: input.value });
    port.close();
});
