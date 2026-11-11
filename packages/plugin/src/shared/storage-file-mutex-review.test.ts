import { expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __resetRpcIdentityTestHooks, __setRpcIdentityTestHooks } from "./rpc-utils";
import { withStorageFileMutex } from "./storage-file-mutex";
import * as permissions from "./storage-permissions";
import { listOpenFiles } from "./test-open-files";
import { createTestTempDir } from "./test-temp-dir";

const mutex = join(import.meta.dir, "storage-file-mutex.ts");

test("mutex retries ticket creation when empty-directory cleanup wins the mkdir race", () => {
    const { dir: root, cleanup } = createTestTempDir("mc-mutex-rmdir-");
    const directory = join(root, "locks");
    const write = permissions.writeStorageFileSync;
    let attempts = 0;
    const writer = spyOn(permissions, "writeStorageFileSync").mockImplementation((...args) => {
        if (attempts++ === 0) rmdirSync(directory);
        return write(...args);
    });
    try {
        expect(withStorageFileMutex(directory, () => "acquired")).toBe("acquired");
        // The successful contender also rewrites its ticket atomically once.
        expect(attempts).toBe(3);
    } finally {
        writer.mockRestore();
        cleanup();
    }
});

async function holder(root: string) {
    const script = `
import { existsSync } from 'node:fs';
import { withStorageFileMutex } from ${JSON.stringify(mutex)};
withStorageFileMutex(${JSON.stringify(join(root, "locks"))}, () => {
 console.log('HELD');
 const pause = new Int32Array(new SharedArrayBuffer(4));
 while (!existsSync(${JSON.stringify(join(root, "release"))})) Atomics.wait(pause, 0, 0, 10);
});`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
        env: {
            ...process.env,
            XDG_DATA_HOME: root,
            XDG_CONFIG_HOME: root,
            MAGIC_CONTEXT_STORAGE_DIR: root,
            MAGIC_CONTEXT_TEST_DATA_DIR: root,
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("HELD");
    reader.releaseLock();
    if (process.platform === "darwin") {
        const files = listOpenFiles(child.pid);
        // A paused child's isolation cannot be established from a missing inventory.
        if (!files.available) throw new Error(files.reason);
        const names = files.paths;
        expect(
            names.some((line) =>
                /\/(?:\.local\/share\/opencode|\.local\/share\/cortexkit\/magic-context|\.config\/(?:opencode|cortexkit))\//.test(
                    line,
                ),
            ),
        ).toBe(false);
        console.log(`REVIEW_LSOF pid=${child.pid} paths=${names.length} forbidden=0`);
    }
    return child;
}

test.skipIf(process.platform === "win32")(
    "independent mutex: paused live holder is not taken over, dead holder is reclaimed",
    async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-mutex-review-");
        const child = await holder(root);
        try {
            process.kill(child.pid, "SIGSTOP");
            const start = performance.now();
            expect(() =>
                withStorageFileMutex(
                    join(root, "locks"),
                    () => {
                        throw new Error("LIVE HOLDER WAS TAKEN OVER");
                    },
                    200,
                ),
            ).toThrow("Storage safety publication lock is unavailable");
            expect(performance.now() - start).toBeLessThan(2500);
            process.kill(child.pid, "SIGKILL");
            await child.exited;
            let reached = false;
            withStorageFileMutex(
                join(root, "locks"),
                () => {
                    reached = true;
                },
                200,
            );
            expect(reached).toBe(true);
            expect(readdirSync(join(root, "locks"))).toEqual([]);
        } finally {
            if (child.exitCode === null) {
                child.kill("SIGKILL");
                await child.exited;
            }
            cleanup();
        }
    },
    15000,
);

test.skipIf(process.platform === "win32")(
    "independent mutex: corrupt live-owner identity refuses within a bound",
    async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-mutex-review-");
        const child = await holder(root);
        try {
            const locks = join(root, "locks");
            const ticket = join(locks, readdirSync(locks)[0]!);
            expect(JSON.parse(readFileSync(ticket, "utf8")).birth).toBeString();
            writeFileSync(ticket, "inconclusive owner identity", { mode: 0o600 });
            const start = performance.now();
            let entered = false;
            expect(() =>
                withStorageFileMutex(
                    locks,
                    () => {
                        entered = true;
                    },
                    200,
                ),
            ).toThrow("Storage safety publication lock is unavailable");
            expect(entered).toBe(false);
            expect(performance.now() - start).toBeLessThan(2500);
            expect(readdirSync(locks)).toHaveLength(1);
        } finally {
            child.kill("SIGKILL");
            await child.exited;
            cleanup();
        }
    },
    15000,
);

test.skipIf(process.platform === "win32")(
    "independent mutex: denied PID probe is inconclusive and refuses within a bound",
    async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-mutex-inconclusive-review-");
        const child = await holder(root);
        try {
            __setRpcIdentityTestHooks({
                processKill: () => {
                    throw Object.assign(new Error("Denied PID probe"), { code: "EPERM" });
                },
            });
            const start = performance.now();
            let entered = false;
            expect(() =>
                withStorageFileMutex(
                    join(root, "locks"),
                    () => {
                        entered = true;
                    },
                    200,
                ),
            ).toThrow("Storage safety publication lock is unavailable");
            expect(entered).toBe(false);
            expect(performance.now() - start).toBeLessThan(2500);
            expect(readdirSync(join(root, "locks"))).toHaveLength(1);
        } finally {
            __resetRpcIdentityTestHooks();
            child.kill("SIGKILL");
            await child.exited;
            cleanup();
        }
    },
    15000,
);
