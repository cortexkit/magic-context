import { describe, expect, test } from "bun:test";
import { fork, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    type BoundaryResult,
    childChannel,
    driveBoundary,
    threadChannel,
} from "./embedding-worker-boundary.test-support";

// A stop request that reaches the worker while an inference call is running must
// be read before the next call of the same request starts. These tests send the
// stop through a real message port while the first call blocks the worker.
const fixture = new URL("./embedding-worker.fixture.ts", import.meta.url);
const workerData = { boundaryProbe: true };

function expectStoppedAfterFirstBatch(result: BoundaryResult): void {
    expect(result.exitCode).toBe(0);
    expect(result.batches).toEqual([["a", "b"]]);
    const events = result.events.filter((event) => event !== "stopped");
    expect(events).toEqual([
        "batch a,b",
        "sent stop",
        "stopping",
        "reply Error: embedding worker stopping",
    ]);
}

describe("embedding worker batch boundary", () => {
    test("Bun thread: the second batch never starts", async () => {
        const worker = new Worker(fixture, { workerData });
        expectStoppedAfterFirstBatch(await driveBoundary(threadChannel(worker)));
    });

    test("fork child: the second batch never starts", async () => {
        const child = fork(new URL("./embedding-worker-process.ts", import.meta.url), [], {
            serialization: "json",
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            windowsHide: true,
        });
        child.send({ entry: fixture.href, data: workerData });
        expectStoppedAfterFirstBatch(await driveBoundary(childChannel(child)));
    });

    test.skipIf(!Bun.which("node"))("Node thread: the second batch never starts", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-boundary-"));
        try {
            const entry = join(dir, "node-boundary.ts");
            writeFileSync(
                entry,
                `import { Worker } from "node:worker_threads";
import { driveBoundary, threadChannel } from ${JSON.stringify(new URL("./embedding-worker-boundary.test-support.ts", import.meta.url).pathname)};
const worker = new Worker(new URL("./embedding-worker.fixture.js", import.meta.url), { workerData: ${JSON.stringify(workerData)} });
console.log(JSON.stringify(await driveBoundary(threadChannel(worker))));
`,
            );
            const build = await Bun.build({
                entrypoints: [entry, fixture.pathname],
                outdir: dir,
                target: "node",
                format: "esm",
                naming: "[name].js",
            });
            expect(build.success, build.logs.join("\n")).toBe(true);
            const run = spawnSync("node", [join(dir, "node-boundary.js")], {
                encoding: "utf8",
                timeout: 20_000,
                windowsHide: true,
            });
            expect(run.status, run.stderr).toBe(0);
            expectStoppedAfterFirstBatch(JSON.parse(run.stdout.trim()) as BoundaryResult);
        } finally {
            cleanupTestTempDir(dir);
        }
    });
});
