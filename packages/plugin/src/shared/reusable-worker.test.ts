import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { reuseWorker } from "./reusable-worker";
import { withTestTempDir } from "./test-temp-dir";

const entry = new URL("./reusable-worker.fixture.ts", import.meta.url);
let key = 0;
function start(path: string, input: Record<string, unknown> = {}, idleMs = 60_000) {
    return reuseWorker(entry, { workerData: { path, ...input } }, idleMs);
}
async function result(worker: Worker) {
    const reply = once(worker, "message");
    const exit = once(worker, "exit");
    const [message] = await reply;
    await exit;
    return message as { threadId: number; value?: string };
}

describe("reusable job workers", () => {
    test("reuses a thread but gives each job fresh input and port state", async () => {
        const path = `reuse-${++key}`;
        const first = await result(start(path, { value: "first" }));
        const second = await result(start(path, { value: "second" }));
        expect(second.threadId).toBe(first.threadId);
        expect(second.value).toBe("second");
    });

    test("replaces a crashed worker and fails its job", async () => {
        const path = `crash-${++key}`;
        const first = await result(start(path));
        const crashed = start(path, { crash: true });
        const error = new Promise<Error>((resolve) => crashed.once("error", resolve));
        const exit = new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
        expect((await error).message).toContain("injected worker crash");
        await exit;
        const next = await result(start(path));
        expect(next.threadId).not.toBe(first.threadId);
    });

    test("terminates a hung job and replaces its thread", async () => {
        const path = `hang-${++key}`;
        const first = await result(start(path));
        const hung = start(path, { hang: true });
        // Allow dispatch, then terminate the worker to exercise the hard-stop behavior.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await hung.terminate();
        const next = await result(start(path));
        expect(next.threadId).not.toBe(first.threadId);
    });

    test("shuts the thread down after its idle lifetime", async () => {
        const path = `idle-${++key}`;
        const first = await result(start(path, {}, 20));
        await new Promise((resolve) => setTimeout(resolve, 80));
        const next = await result(start(path, {}, 20));
        expect(next.threadId).not.toBe(first.threadId);
    });

    test("rejects late replies from a released job", async () => {
        const path = `late-${++key}`;
        const prior = start(path, { late: true });
        const oldReplies: unknown[] = [];
        prior.on("message", (reply) => oldReplies.push(reply));
        const first = await result(prior);
        const next = start(path, { hang: true });
        const replies: unknown[] = [];
        next.on("message", (reply) => replies.push(reply));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(oldReplies).toHaveLength(1);
        expect(replies).toEqual([]);
        await next.terminate();
        expect(first.threadId).toBeGreaterThan(0);
    });

    test("queues concurrent jobs without sharing job input", async () => {
        const path = `queue-${++key}`;
        const [a, b] = await Promise.all([
            result(start(path, { value: "a" })),
            result(start(path, { value: "b" })),
        ]);
        expect(a.threadId).toBe(b.threadId);
        expect([a.value, b.value]).toEqual(["a", "b"]);
    });

    test("a crash does not fail a queued job that never entered the thread", async () => {
        const path = `queued-crash-${++key}`;
        const crashed = start(path, { crash: true });
        crashed.on("error", () => {});
        const next = await result(start(path, { value: "unstarted" }));
        expect(next.value).toBe("unstarted");
    });

    test("keeps different database paths in separate threads", async () => {
        const a = await result(start(`db-a-${++key}`));
        const b = await result(start(`db-b-${++key}`));
        expect(a.threadId).not.toBe(b.threadId);
    });

    test("copies a job's input before dispatch", async () => {
        const data = { path: `copy-${++key}`, value: "submitted" };
        const job = reuseWorker(entry, { workerData: data });
        data.value = "changed after submission";
        expect((await result(job)).value).toBe("submitted");
    });

    test("a nonzero job exit fails the lease and replaces the thread", async () => {
        const path = `exit-code-${++key}`;
        const first = await result(start(path));
        const failed = start(path, { exitCode: true });
        expect((await once(failed, "exit"))[0]).toBe(1);
        expect((await result(start(path))).threadId).not.toBe(first.threadId);
    });

    test("process shutdown releases queued jobs without starting a replacement worker", async () => {
        const path = `shutdown-${++key}`;
        await result(start(path));
        const active = start(path, { hang: true });
        const queued = start(path, { value: "must not run during shutdown" });
        const replies: unknown[] = [];
        queued.on("message", (message) => replies.push(message));
        const activeExit = once(active, "exit");
        const queuedExit = once(queued, "exit");
        await Promise.resolve();

        // Invoke only the registry's callback: emitting process exit would also
        // tear down Bun's test runner before it could check the queued lease.
        const abortAll = process.listeners("exit").find((listener) => listener.name === "abortAll");
        expect(abortAll).toBeDefined();
        abortAll!();

        await activeExit;
        await queuedExit;
        expect(replies).toEqual([]);
    });

    test("a file ending with queued jobs cannot interrupt the next parallel file", () => {
        withTestTempDir("reusable-worker-files-", (dir) => {
            writeFileSync(
                join(dir, "01-owner.test.ts"),
                `import { test } from "bun:test";
import { reuseWorker } from ${JSON.stringify(new URL("./reusable-worker.ts", import.meta.url).href)};
test("owner finishes with queued work", async () => {
    const entry = new URL(${JSON.stringify(entry.href)});
    const active = reuseWorker(entry, { workerData: { path: "file-exit", hang: true } });
    const queued = reuseWorker(entry, { workerData: { path: "file-exit", value: "queued" } });
    active.on("error", () => {});
    queued.on("error", () => console.log("queued failure reached client"));
    queued.on("exit", (code) => console.log("queued exit:", code));
    await Promise.resolve();
});`,
            );
            // Top-level await lets the old file's native Worker exit handler run
            // while the next file is importing.
            writeFileSync(
                join(dir, "02-next.test.ts"),
                `import { describe, expect, test } from "bun:test";
await new Promise(resolve => setTimeout(resolve, 50));
describe("next file", () => {
    test("still registers", () => expect(1).toBe(1));
});`,
            );
            const child = spawnSync(process.execPath, ["test", "--parallel=1", dir], {
                cwd: dir,
                encoding: "utf8",
                timeout: 5_000,
                windowsHide: true,
            });
            const output = child.stdout + child.stderr;
            expect(output).toContain("2 pass");
            expect(output).toContain("0 fail");
            expect(output).not.toContain("Unhandled error");
            expect(output).toContain("queued failure reached client");
            expect(output).toContain("queued exit: 1");
            expect(child.status).toBe(0);
        });
    }, 10_000);
});
