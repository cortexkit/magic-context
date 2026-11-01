import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, type Worker } from "node:worker_threads";
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
            const outcomes = join(dir, "outcomes.jsonl");
            writeFileSync(outcomes, "");
            writeFileSync(
                join(dir, "01-owner.test.ts"),
                `import { test } from "bun:test";
import { appendFileSync } from "node:fs";
import { reuseWorker } from ${JSON.stringify(new URL("./reusable-worker.ts", import.meta.url).href)};
test("owner finishes with queued work", async () => {
    const entry = new URL(${JSON.stringify(entry.href)});
    const active = reuseWorker(entry, { workerData: { path: "file-exit", hang: true } });
    active.on("error", () => {});
    for (let id = 0; id < 3; id++) {
        const queued = reuseWorker(entry, { workerData: { path: "file-exit", value: "queued" } });
        let replied = false;
        let failed = false;
        queued.on("message", () => { replied = true; });
        queued.on("error", () => { failed = true; });
        queued.on("exit", code => appendFileSync(${JSON.stringify(outcomes)}, JSON.stringify({
            id, outcome: code === 0 && replied && !failed ? "completed" : "failed",
        }) + "\\n"));
    }
    await Promise.resolve();
});`,
            );
            writeFileSync(
                join(dir, "02-next.test.ts"),
                `import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
await new Promise(resolve => setTimeout(resolve, 50));
describe("next file", () => {
    test("still registers after every queued client settles once", () => {
        const outcomes = readFileSync(${JSON.stringify(outcomes)}, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
        expect(outcomes).toHaveLength(3);
        for (let id = 0; id < 3; id++) {
            const client = outcomes.filter(outcome => outcome.id === id);
            expect(client).toHaveLength(1);
            expect(["completed", "failed"]).toContain(client[0].outcome);
        }
    });
});`,
            );
            // The real preload owns file teardown. Bun may discard a bare file's
            // callbacks without notifying its workers' clients during VM teardown.
            const child = spawnSync(
                process.execPath,
                [
                    "test",
                    "--parallel=1",
                    "--preload",
                    fileURLToPath(new URL("../../test-preload.ts", import.meta.url)),
                    dir,
                ],
                { cwd: dir, encoding: "utf8", timeout: 5_000, windowsHide: true },
            );
            const output = child.stdout + child.stderr;
            expect(output).toContain("2 pass");
            expect(output).toContain("0 fail");
            expect(output).not.toContain("Unhandled error");
            expect(child.status).toBe(0);
            const settled = readFileSync(outcomes, "utf8").trim().split("\n").filter(Boolean);
            expect(settled).toHaveLength(3);
        });
    }, 10_000);

    test("replacement construction failure settles every queued client exactly once", async () => {
        const path = `replacement-failure-${++key}`;
        const { port1, port2 } = new MessageChannel();
        try {
            const crashed = reuseWorker(entry, {
                workerData: { path, crash: true },
                transferList: [port1],
            });
            crashed.on("error", () => {});
            const clients = [start(path), start(path)].map((worker) => {
                const errors: unknown[] = [];
                const exits: number[] = [];
                worker.on("error", (error) => errors.push(error));
                const done = new Promise<void>((resolve) =>
                    worker.on("exit", (code) => {
                        exits.push(code);
                        resolve();
                    }),
                );
                return { errors, exits, done };
            });
            await Promise.all(clients.map((client) => client.done));
            await new Promise((resolve) => setImmediate(resolve));
            for (const client of clients) {
                expect(client.errors).toHaveLength(1);
                expect(client.exits).toEqual([1]);
            }
        } finally {
            port2.close();
        }
    });
});
