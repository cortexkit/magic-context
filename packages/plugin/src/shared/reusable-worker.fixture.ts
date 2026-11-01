import { parentPort, threadId } from "node:worker_threads";
import { serveWorkerJobs } from "./reusable-worker-entry";

serveWorkerJobs<{
    crash?: boolean;
    hang?: boolean;
    late?: boolean;
    exitCode?: boolean;
    value?: string;
}>(async (input, port) => {
    if (input.crash) throw new Error("injected worker crash");
    if (input.hang) return await new Promise<void>(() => {});
    if (input.exitCode) process.exitCode = 1;
    if (input.late)
        setTimeout(() => {
            port.postMessage({ value: "stale" });
            // Bypass the job port to verify the owner ignores a mismatched job id.
            parentPort?.postMessage({ jobId: -1, value: { value: "stale" } });
        }, 20);
    port.postMessage({ threadId, value: input.value });
    port.close();
});
