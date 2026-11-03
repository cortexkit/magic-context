import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
});
