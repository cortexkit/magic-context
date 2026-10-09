import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** A no-prompt OMP initialization probe, using the real built Pi worker. */
export default function ompWorkerLoaderProbe(): void {
    const root = process.env.MC_OMP_PROBE_ROOT;
    const entry = process.env.MC_OMP_WORKER_ENTRY;
    if (!root || !entry) throw new Error("isolated OMP worker probe paths required");
    console.log("OMP extension factory invoked");
    const worker = new Worker(pathToFileURL(entry), {
        workerData: {
            path: `${root}/context.db`,
            harness: "omp",
            sessionId: "omp-loader-probe",
            projectPath: "git:omp-loader-probe",
            query: "historian cache wiring",
            options: {
                sources: ["memory"],
                embeddingEnabled: false,
                countRetrievals: false,
                measurementDisabled: true,
            },
            embeddingRuntimeEnabled: false,
            embeddingHostBusy: false,
            snapshot: null,
            deadlineUnixMs: Date.now() + 3000,
        },
    });
    const timer = setTimeout(() => {
        void worker.terminate();
        process.exit(2);
    }, 10000);
    worker.on("message", (reply: { kind?: string; results?: { content: string }[] }) => {
        if (
            reply.kind !== "result" ||
            reply.results?.[0]?.content !== "historian cache wiring details"
        )
            throw new Error(JSON.stringify(reply));
        writeFileSync(
            `${root}/omp-loader-evidence.json`,
            JSON.stringify({
                runtime: process.version,
                bun: process.versions.bun,
                harness: "omp",
                checks: 1,
                reply,
            }),
        );
        console.log("OMP bundled worker load/search passed (1 check)");
        clearTimeout(timer);
        void worker.terminate().then(() => process.exit(0));
    });
    worker.on("error", (error) => {
        console.error(error);
        clearTimeout(timer);
        process.exit(1);
    });
}
