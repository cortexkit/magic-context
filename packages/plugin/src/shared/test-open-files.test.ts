import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { closeSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOpenFiles, parseLsofPaths } from "./test-open-files";
import { cleanupTestTempDir, createTestTempDirFromPath } from "./test-temp-dir";

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "open-file inventory sees a file only while its descriptor is open",
    () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-open-files-"));
        const path = join(realpathSync(root), "file with spaces.db");
        let descriptor: number | undefined;
        try {
            descriptor = openSync(path, "w");
            const open = listOpenFiles();
            if (!open.available) throw new Error(open.reason);
            expect(open.paths).toContain(path);
            if (process.platform === "linux")
                expect(open.entries).toContainEqual({ descriptor, path });
            closeSync(descriptor);
            descriptor = undefined;
            const closed = listOpenFiles();
            if (!closed.available) throw new Error(closed.reason);
            expect(closed.paths).not.toContain(path);
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
            cleanupTestTempDir(root);
        }
    },
);

test.skipIf(process.platform !== "linux")("Linux inventory never spawns lsof", () => {
    const execute = spyOn(childProcess, "execFileSync").mockImplementation(() => {
        throw new Error("subprocess forbidden during inventory");
    });
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-open-files-path-"));
    const path = join(realpathSync(root), "marker");
    const descriptor = openSync(path, "w");
    try {
        const result = listOpenFiles();
        if (!result.available) throw new Error(result.reason);
        expect(result.paths).toContain(path);
        expect(execute).not.toHaveBeenCalled();
    } finally {
        execute.mockRestore();
        closeSync(descriptor);
        cleanupTestTempDir(root);
    }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "inventory can observe a child process's open file",
    async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-open-files-child-"));
        const path = join(realpathSync(root), "child marker");
        const child = Bun.spawn(
            [
                process.execPath,
                "--eval",
                `
            import { openSync } from 'node:fs';
            const descriptor = openSync(${JSON.stringify(path)}, 'w');
            console.log('ready');
            setInterval(() => {}, 1000);
        `,
            ],
            { stdout: "pipe", stderr: "pipe", windowsHide: true },
        );
        try {
            const reader = child.stdout.getReader();
            const ready = await reader.read();
            reader.releaseLock();
            expect(new TextDecoder().decode(ready.value)).toContain("ready");
            const inventory = listOpenFiles(child.pid);
            if (!inventory.available) throw new Error(inventory.reason);
            expect(inventory.paths).toContain(path);
        } finally {
            child.kill();
            await child.exited;
            cleanupTestTempDir(root);
        }
    },
);

test.skipIf(process.platform !== "linux")("Linux inventory skips vanished descriptors", () => {
    const readlink = fs.readlinkSync;
    let raced = false;
    const link = spyOn(fs, "readlinkSync").mockImplementation(((path: fs.PathLike) => {
        if (!raced && String(path).startsWith("/proc/self/fd/")) {
            raced = true;
            throw Object.assign(new Error("closed during inventory"), { code: "ENOENT" });
        }
        return readlink(path);
    }) as typeof fs.readlinkSync);
    try {
        expect(listOpenFiles().available).toBe(true);
        expect(raced).toBe(true);
    } finally {
        link.mockRestore();
    }
});

test.skipIf(process.platform !== "linux")(
    "Linux inventory reports listing failures as unavailable",
    () => {
        const listing = spyOn(fs, "readdirSync").mockImplementation(() => {
            throw new Error("inventory denied");
        });
        try {
            expect(listOpenFiles()).toEqual({ available: false, reason: "inventory denied" });
        } finally {
            listing.mockRestore();
        }
    },
);

test.skipIf(process.platform !== "linux")(
    "child exit during inventory is unavailable, not empty",
    () => {
        const read = fs.readFileSync;
        let reads = 0;
        const stat = spyOn(fs, "readFileSync").mockImplementation(((
            path: fs.PathOrFileDescriptor,
        ) => {
            if (String(path) !== "/proc/123456/stat") return read(path);
            return `123456 (test process) ${reads++ === 0 ? "S" : "Z"} ${"0 ".repeat(18)}100`;
        }) as typeof fs.readFileSync);
        const listing = spyOn(fs, "readdirSync").mockReturnValue([]);
        try {
            expect(listOpenFiles(123456)).toEqual({
                available: false,
                reason: "Process 123456 has exited",
            });
        } finally {
            stat.mockRestore();
            listing.mockRestore();
        }
    },
);

test("macOS name parser ignores warnings and preserves paths with spaces", () => {
    expect(
        parseLsofPaths(
            [
                "lsof: WARNING: can't stat() overlay file system /container/one",
                "      Output information may be incomplete.",
                "p123",
                "n/private/var/test directory/context.db",
                "n/private/var/test directory/context.db-wal",
                "lsof: WARNING: can't stat() overlay file system /container/two",
                "",
            ].join("\n"),
        ),
    ).toEqual([
        "/private/var/test directory/context.db",
        "/private/var/test directory/context.db-wal",
    ]);
});

test("macOS name parser keeps paths beyond the old 1 MiB subprocess limit", () => {
    const paths = Array.from(
        { length: 24_000 },
        (_, index) => `/private/var/test directory/fixture-${index}.db`,
    );
    const output = `p123\n${paths.map((path) => `n${path}\n`).join("")}`;
    expect(Buffer.byteLength(output)).toBeGreaterThan(1024 * 1024);
    expect(parseLsofPaths(output)).toEqual(paths);
});

test("macOS inventory requests name fields with a 64 MiB buffer", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const execute = spyOn(childProcess, "execFileSync").mockReturnValue("p123\nn/test file.db\n");
    try {
        // Exercise command construction on every host without needing a macOS subprocess.
        Object.defineProperty(process, "platform", { value: "darwin" });
        expect(listOpenFiles(123)).toEqual({
            available: true,
            paths: ["/test file.db"],
            entries: [{ path: "/test file.db" }],
        });
        expect(execute).toHaveBeenCalledWith("lsof", ["-p", "123", "-Fn"], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: 10_000,
            windowsHide: true,
        });
    } finally {
        Object.defineProperty(process, "platform", platform);
        execute.mockRestore();
    }
});
