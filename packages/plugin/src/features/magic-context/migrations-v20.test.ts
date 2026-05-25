import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";

describe("migration v20", () => {
    test("creates subagent_invocations idempotently", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-v20-"));
        process.env.XDG_DATA_HOME = dir;
        try {
            const db = openDatabase();
            const table = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_invocations'",
                )
                .get();
            expect(table).toBeTruthy();
            closeDatabase();
            openDatabase();
        } finally {
            closeDatabase();
            process.env.XDG_DATA_HOME = undefined;
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });
});
