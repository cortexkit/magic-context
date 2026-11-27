import { parentPort, threadId } from "node:worker_threads";
import { serveWorkerJobs } from "./reusable-worker-entry";

let replyToReleasedJob: (() => void) | undefined;

serveWorkerJobs<{
    crash?: boolean;
    hang?: boolean;
    acknowledgeHang?: boolean;
    late?: boolean;
    deliverLate?: boolean;
    exitCode?: boolean;
    value?: string;
    shared?: SharedArrayBuffer;
}>(async (input, port) => {
    if (input.crash) throw new Error("injected worker crash");
    if (input.hang) {
        if (input.acknowledgeHang) port.postMessage({ threadId, hanging: true });
        return await new Promise<void>(() => {});
    }
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
        replyToReleasedJob = () => {
            port.postMessage({ value: "stale" });
            // Bypass the job port to verify the owner ignores a mismatched job id.
            parentPort?.postMessage({ jobId: -1, value: { value: "stale" } });
        };
    if (input.deliverLate) {
        if (!replyToReleasedJob) throw new Error("fixture did not reuse the prior thread");
        replyToReleasedJob();
        replyToReleasedJob = undefined;
    }
    port.postMessage({ threadId, value: input.value });
    port.close();
});
