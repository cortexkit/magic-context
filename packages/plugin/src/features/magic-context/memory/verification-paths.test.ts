import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedTestGitEnv } from "../../../shared/test-git-env";
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
            env: isolatedTestGitEnv(),
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
                        env: isolatedTestGitEnv(),
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
            ["ls-files", "-z", "--full-name"],
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
            ["ls-files", "-z", "--full-name"],
            ["ls-files", "-z", "--full-name", "--error-unmatch", "--", "file.ts"],
        ]);
    } finally {
        __resetVerificationPathsForTests();
        rmSync(dir, { recursive: true, force: true });
    }
});
