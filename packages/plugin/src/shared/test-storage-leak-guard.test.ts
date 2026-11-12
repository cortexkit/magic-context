import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTestStorageLeaks } from "./test-storage-leak-guard";
import { createTestTempDir, installTestTempDirCleanup } from "./test-temp-dir";

installTestTempDirCleanup(afterAll);

describe("test storage leak guard", () => {
    test("does not exempt an archive-named directory outside the repository archive", () => {
        const { dir } = createTestTempDir("storage-leak-guard-");
        const archive = join(dir, "crates_old");
        mkdirSync(archive);
        const leaked = join(archive, "context.db");
        writeFileSync(leaked, "generated database");
        expect(findTestStorageLeaks(dir)).toEqual([leaked]);
    });
    test("rejects generated databases and undefined directories, even beside the capture", () => {
        const { dir } = createTestTempDir("storage-leak-guard-");
        const captureDirectory = join(dir, "crates/mc-module/testdata/parity_retrieval");
        mkdirSync(captureDirectory, { recursive: true });
        const leaked = join(captureDirectory, "context.db");
        writeFileSync(leaked, "generated database");
        const undefinedDirectory = join(dir, "undefined");
        mkdirSync(undefinedDirectory);
        expect(findTestStorageLeaks(dir).sort()).toEqual([leaked, undefinedDirectory].sort());
    });
    test("skips a folder another test file removed mid-scan, and still finds leaks elsewhere", () => {
        const { dir } = createTestTempDir("storage-leak-guard-");
        const vanishing = join(dir, "target/scratch/small-trial-x");
        mkdirSync(vanishing, { recursive: true });
        const leaked = join(dir, "context.db");
        writeFileSync(leaked, "generated database");
        const gone = (path: string) => {
            if (path === vanishing) {
                throw Object.assign(new Error("ENOENT: no such file or directory"), {
                    code: "ENOENT",
                });
            }
            return readdirSync(path, { withFileTypes: true });
        };
        expect(findTestStorageLeaks(dir, gone)).toEqual([leaked]);
    });
    test("a missing top-level folder still fails the scan", () => {
        const { dir } = createTestTempDir("storage-leak-guard-");
        expect(() => findTestStorageLeaks(join(dir, "missing"))).toThrow("ENOENT");
    });
});
