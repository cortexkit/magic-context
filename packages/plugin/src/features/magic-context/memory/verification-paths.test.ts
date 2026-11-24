import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetVerificationPathsForTests,
    __setVerificationPathsTestHooks,
    normalizeVerificationFiles,
} from "./verification-paths";

test("normalizing fifty exact tracked files uses one repository lookup and one tracked inventory", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "verification-paths-bulk-"));
    const git = (...args: string[]) =>
        execFileSync("git", args, {
            cwd: dir,
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
        });
    const files = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
    try {
        git("init", "-q");
        for (const file of files) writeFileSync(join(dir, file), "tracked\n");
        git("add", ".");
        const calls: string[][] = [];
        __setVerificationPathsTestHooks({
            execFile: async (binary, args, options) => {
                calls.push([...args]);
                return {
                    stdout: execFileSync(binary, args, {
                        cwd: options.cwd,
                        encoding: "utf8",
                        timeout: 10000,
                        windowsHide: true,
                    }),
                    stderr: "",
                };
            },
        });
        const result = await normalizeVerificationFiles({ cwd: dir, files: [...files, files[0]] });
        expect(result.files).toEqual([...files].sort());
        expect(result.warnings).toEqual([]);
        expect(calls).toEqual([
            ["rev-parse", "--show-toplevel"],
            ["ls-files", "--recurse-submodules", "-z", "--full-name"],
        ]);
    } finally {
        __resetVerificationPathsForTests();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an optional inventory failure falls back to the original path lookup and blank inputs need no inventory", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "verification-paths-fallback-"));
    writeFileSync(join(dir, "file.ts"), "tracked\n");
    const calls: string[][] = [];
    __setVerificationPathsTestHooks({
        execFile: async (_binary, args) => {
            calls.push([...args]);
            if (args[0] === "rev-parse") return { stdout: dir, stderr: "" };
            if (args.includes("--error-unmatch")) return { stdout: "file.ts\0", stderr: "" };
            throw Object.assign(new Error("inventory exceeded deadline"), { killed: true });
        },
    });
    try {
        expect((await normalizeVerificationFiles({ cwd: dir, files: ["", "."] })).files).toEqual(
            [],
        );
        expect(calls).toEqual([["rev-parse", "--show-toplevel"]]);
        calls.length = 0;
        expect((await normalizeVerificationFiles({ cwd: dir, files: ["file.ts"] })).files).toEqual([
            "file.ts",
        ]);
        expect(calls).toEqual([
            ["rev-parse", "--show-toplevel"],
            ["ls-files", "--recurse-submodules", "-z", "--full-name"],
            ["ls-files", "-z", "--full-name", "--error-unmatch", "--", "file.ts"],
        ]);
    } finally {
        __resetVerificationPathsForTests();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a file inside a git submodule is a tracked verification path", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "verification-paths-submodule-"));
    const sub = join(dir, "sub");
    const parent = join(dir, "parent");
    const git = (cwd: string, ...args: string[]) =>
        execFileSync(
            "git",
            [
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "protocol.file.allow=always",
                ...args,
            ],
            { cwd, encoding: "utf8", timeout: 10000, windowsHide: true },
        );
    try {
        mkdirSync(join(sub, "src"), { recursive: true });
        writeFileSync(join(sub, "src", "thing.ts"), "export const thing = 1;\n");
        git(sub, "init", "-q");
        git(sub, "add", ".");
        git(sub, "commit", "-q", "-m", "sub");
        mkdirSync(parent);
        writeFileSync(join(parent, "root.ts"), "root\n");
        git(parent, "init", "-q");
        git(parent, "add", ".");
        git(parent, "commit", "-q", "-m", "root");
        git(parent, "submodule", "add", "-q", sub, "app");

        // The parent repo lists only the gitlink `app`, so this path used to be
        // dropped as "not a tracked git file" and the memory went unmapped (#973).
        const result = await normalizeVerificationFiles({
            cwd: parent,
            files: ["app/src/thing.ts", "root.ts"],
        });
        expect(result.files).toEqual(["app/src/thing.ts", "root.ts"]);
        expect(result.warnings).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
