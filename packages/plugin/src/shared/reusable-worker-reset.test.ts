import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as timers from "node:timers";
import { fileURLToPath } from "node:url";
import { resetReusableWorkersForTests, reuseWorker } from "./reusable-worker";
import { withTestTempDir } from "./test-temp-dir";

test("a temporary caller clock cannot replace the pool's idle timer", async () => {
    const clock = spyOn(globalThis, "setTimeout").mockReturnValue(
        0 as unknown as ReturnType<typeof setTimeout>,
    );
    try {
        const worker = reuseWorker(new URL("./reusable-worker.fixture.ts", import.meta.url), {
            workerData: { path: "caller-clock" },
        });
        const message = once(worker, "message");
        const exit = once(worker, "exit");
        await message;
        await exit;
        expect(clock).not.toHaveBeenCalled();
    } finally {
        clock.mockRestore();
        await resetReusableWorkersForTests();
    }
});

test("reset clears idle timers and waits for active and queued leases to exit", async () => {
    const entry = new URL("./reusable-worker.fixture.ts", import.meta.url);
    const schedules = spyOn(timers, "setTimeout");
    const cancellations = spyOn(timers, "clearTimeout");
    const idleMs = 12_345;
    async function runIdle() {
        const worker = reuseWorker(entry, { workerData: { path: "reset-idle" } }, idleMs);
        const message = once(worker, "message");
        const exit = once(worker, "exit");
        const [reply] = await message;
        await exit;
        return reply.threadId as number;
    }
    try {
        const previousThread = await runIdle();
        const timerIndex = schedules.mock.calls.findIndex(([, delay]) => delay === idleMs);
        expect(timerIndex).toBeGreaterThanOrEqual(0);
        const idleTimer = schedules.mock.results[timerIndex]?.value;
        const active = reuseWorker(entry, { workerData: { path: "reset-active", hang: true } });
        const queued = reuseWorker(entry, {
            workerData: { path: "reset-active", value: "queued" },
        });
        const replies: unknown[] = [];
        queued.on("message", (message) => replies.push(message));
        const activeExit = once(active, "exit");
        const queuedExit = once(queued, "exit");
        await Promise.resolve();
        await Promise.all([resetReusableWorkersForTests(), activeExit, queuedExit]);
        expect(cancellations).toHaveBeenCalledWith(idleTimer);
        expect(replies).toEqual([]);
        expect(await runIdle()).not.toBe(previousThread);
    } finally {
        schedules.mockRestore();
        cancellations.mockRestore();
        await resetReusableWorkersForTests();
    }
});

test("the shared preload stops pooled workers between test cases", () => {
    withTestTempDir("reusable-worker-boundaries-", (dir) => {
        writeFileSync(
            join(dir, "boundaries.test.ts"),
            `import { expect, test } from "bun:test";
import { once } from "node:events";
import { reuseWorker } from ${JSON.stringify(new URL("./reusable-worker.ts", import.meta.url).href)};
const entry = new URL(${JSON.stringify(new URL("./reusable-worker.fixture.ts", import.meta.url).href)});
let previousThread;
async function run() {
    const worker = reuseWorker(entry, { workerData: { path: "test-boundaries" } });
    const message = once(worker, "message");
    const exit = once(worker, "exit");
    const [reply] = await message;
    await exit;
    return reply.threadId;
}
test("finishes with an idle pooled worker", async () => {
    previousThread = await run();
    expect(previousThread).toBeGreaterThan(0);
});
test("cannot inherit the previous test's pooled worker", async () => {
    expect(await run()).not.toBe(previousThread);
});`,
        );
        const child = spawnSync(
            process.execPath,
            [
                "test",
                "--preload",
                fileURLToPath(new URL("../../test-preload.ts", import.meta.url)),
                join(dir, "boundaries.test.ts"),
            ],
            { cwd: dir, encoding: "utf8", timeout: 5_000, windowsHide: true },
        );
        const output = child.stdout + child.stderr;
        expect(output).toContain("2 pass");
        expect(output).toContain("0 fail");
        expect(child.status).toBe(0);
    });
}, 10_000);
