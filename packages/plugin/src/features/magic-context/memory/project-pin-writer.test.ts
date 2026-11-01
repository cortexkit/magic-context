import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../../../shared/storage-permissions";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { persistPinRequest } from "./project-pin-persistence";
import type { PinWriteRequest } from "./project-pin-worker";
import {
    __resetProjectPinWriterDiagnosticsForTests,
    __setProjectPinWriterForTests,
    PinWorker,
    ProjectPinWriter,
} from "./project-pin-writer";

const temp = createTestTempDir("mc-project-pin-writer-");
const writers: ProjectPinWriter[] = [];
afterEach(async () => {
    for (const writer of writers.splice(0)) await writer.shutdown(100);
    await __setProjectPinWriterForTests();
    __resetProjectPinWriterDiagnosticsForTests();
});

function controlled(capacity = 256) {
    const calls: PinWriteRequest[] = [];
    const completions: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const messages: string[] = [];
    const writer = new ProjectPinWriter(
        (request) => {
            calls.push(request);
            return new Promise<void>((resolve, reject) => completions.push({ resolve, reject }));
        },
        capacity,
        (message) => messages.push(message),
    );
    writers.push(writer);
    return { writer, calls, completions, messages };
}

async function turn() {
    // The pump and completion handlers each use microtasks, not wall-clock sleeps.
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function publish(writer: ProjectPinWriter, name: string, identity = "pj-FIRST") {
    const destination = join(temp.dir, name, "pin.json");
    writer.publish(destination, { directory: `/${name}`, identity, gitCommonDir: "/repo.git" });
    return destination;
}

test("queued worktree cleanup preserves a changed sidecar and never publishes a borrowed pin", async () => {
    const destination = join(temp.dir, "cleanup", "pin.json");
    const record = { directory: "/worktree", identity: "git:abcdef123" };
    const bytes = JSON.stringify(record);
    writeStorageFileAtomicSync(destination, bytes);
    const writer = new ProjectPinWriter(async (request) => persistPinRequest(request));
    writers.push(writer);
    writer.removeIfUnchanged(destination, record, bytes);
    writeStorageFileAtomicSync(destination, JSON.stringify({ ...record, identity: "pj-NEW" }));
    expect(await writer.flush(1_000)).toBe(true);
    expect(JSON.parse(readFileSync(destination, "utf8")).identity).toBe("pj-NEW");
    expect(writer.lookup(destination)).toBeUndefined();
    writeStorageFileAtomicSync(destination, bytes);
    writer.removeIfUnchanged(destination, record, bytes);
    expect(await writer.flush(1_000)).toBe(true);
    expect(existsSync(destination)).toBe(false);
});

test("publishes before writing and coalesces a folder without replacing its first pin", async () => {
    const { writer, calls, completions } = controlled();
    const destination = publish(writer, "coalesced");
    for (let i = 0; i < 20; i++) publish(writer, "coalesced", "pj-LATER");
    expect(writer.lookup(destination)?.identity).toBe("pj-FIRST");
    expect(writer.records(join(temp.dir, "coalesced"))).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await turn();
    expect(calls).toHaveLength(1);
    expect(calls[0].record.identity).toBe("pj-FIRST");
    completions[0].resolve();
    expect(await writer.flush(100)).toBe(true);
    writer.lookup(destination);
    await turn();
    expect(calls).toHaveLength(1);
});

test("overflow remains visible and retries on the next folder lookup", async () => {
    const { writer, calls, completions, messages } = controlled(2);
    publish(writer, "active");
    await turn();
    publish(writer, "queued-a");
    publish(writer, "queued-b");
    const overflow = publish(writer, "overflow");
    publish(writer, "overflow-other");
    expect(writer.lookup(overflow)?.identity).toBe("pj-FIRST");
    expect(messages).toHaveLength(1);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
        completions[i].resolve();
        await turn();
    }
    expect(calls).toHaveLength(3);
    expect(await writer.flush(100)).toBe(true);
    writer.lookup(overflow);
    await turn();
    expect(calls).toHaveLength(4);
    expect(calls[3].destination).toBe(overflow);
    completions[3].resolve();
    expect(await writer.flush(100)).toBe(true);
});

test("failed writes retain the pin and retry only after a later decision", async () => {
    const { writer, calls, completions } = controlled();
    const destination = publish(writer, "failed");
    await turn();
    completions[0].reject(new Error("injected write failure"));
    expect(await writer.flush(100)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(writer.lookup(destination)?.identity).toBe("pj-FIRST");
    await turn();
    expect(calls).toHaveLength(1);
    publish(writer, "failed", "pj-LATER");
    await turn();
    expect(calls).toHaveLength(2);
    completions[1].resolve();
    expect(await writer.flush(100)).toBe(true);
});

test("shutdown is bounded when a writer is stuck and stops admitting new work", async () => {
    const { writer, calls, completions } = controlled();
    publish(writer, "stuck");
    await turn();
    publish(writer, "abandoned");
    expect(await writer.shutdown(20)).toBe(false);
    const visible = publish(writer, "after-close");
    expect(writer.lookup(visible)?.identity).toBe("pj-FIRST");
    completions[0].resolve();
    await turn();
    expect(calls).toHaveLength(1);
});

function fakeWorker(handle: (request: PinWriteRequest, worker: EventEmitter) => void): Worker {
    class FakeWorker extends EventEmitter {
        postMessage(request: PinWriteRequest) {
            handle(request, this);
        }

        unref() {}

        terminate() {
            return Promise.resolve(1);
        }
    }
    return new FakeWorker() as unknown as Worker;
}

test("worker crash after one write falls back in process without restarting it", async () => {
    let spawnAttempts = 0;
    let workerWrites = 0;
    const logs: string[] = [];
    const pinWorker = new PinWorker(
        new URL("./project-pin-worker.ts", import.meta.url),
        () => {
            spawnAttempts++;
            return fakeWorker((request, worker) => {
                workerWrites++;
                if (workerWrites === 1) {
                    setStoragePrivatePermissionEnforcement(request.privateStorage);
                    writeStorageFileAtomicSync(request.destination, JSON.stringify(request.record));
                    queueMicrotask(() => worker.emit("message", { ok: true }));
                } else {
                    queueMicrotask(() => worker.emit("exit", 1));
                }
            });
        },
        (message) => logs.push(message),
    );
    const writer = new ProjectPinWriter(pinWorker.write, 256, (message) => logs.push(message));
    writers.push(writer);

    const first = publish(writer, "worker-before-crash");
    expect(await writer.flush(1_000)).toBe(true);
    const second = publish(writer, "worker-after-crash");
    expect(await writer.flush(1_000)).toBe(true);

    expect(spawnAttempts).toBe(1);
    expect(workerWrites).toBe(2);
    expect(JSON.parse(readFileSync(first, "utf8")).identity).toBe("pj-FIRST");
    expect(JSON.parse(readFileSync(second, "utf8")).identity).toBe("pj-FIRST");
    expect(
        logs.filter((line) => line.includes("pin worker unavailable; writing pins in process")),
    ).toHaveLength(1);
});

test("50 lookups and later decisions do not flood failed pin logs or respawn the worker", async () => {
    let spawnAttempts = 0;
    let writeAttempts = 0;
    let failCurrentWrite: (() => void) | undefined;
    const logs: string[] = [];
    const pinWorker = new PinWorker(
        new URL("./project-pin-worker.ts", import.meta.url),
        () => {
            spawnAttempts++;
            return fakeWorker((_request, worker) => {
                writeAttempts++;
                failCurrentWrite = () =>
                    worker.emit("message", { ok: false, error: "injected filesystem failure" });
            });
        },
        (message) => logs.push(message),
    );
    const writer = new ProjectPinWriter(pinWorker.write, 256, (message) => logs.push(message));
    writers.push(writer);
    const destination = publish(writer, "repeated-failure");
    await turn();

    for (let i = 0; i < 50; i++) writer.lookup(destination);
    const firstDrain = writer.flush(1_000);
    failCurrentWrite?.();
    expect(await firstDrain).toBe(true);
    expect(writeAttempts).toBe(1);

    for (let i = 0; i < 50; i++) writer.lookup(destination);
    await turn();
    expect(writeAttempts).toBe(1);
    expect(spawnAttempts).toBe(1);

    for (let i = 0; i < 2; i++) {
        writer.publish(destination, {
            directory: "/repeated-failure",
            identity: "pj-NEW",
            gitCommonDir: "/repo.git",
        });
        await turn();
        const drain = writer.flush(1_000);
        failCurrentWrite?.();
        expect(await drain).toBe(true);
    }

    expect(writeAttempts).toBe(3);
    expect(spawnAttempts).toBe(1);
    expect(logs.filter((line) => line.includes("project pin persistence failed"))).toHaveLength(1);
    expect(writer.lookup(destination)?.identity).toBe("pj-FIRST");
});
