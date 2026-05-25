import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";

describe("migration v21", () => {
    test("adds work metric columns idempotently", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-v21-"));
        process.env.XDG_DATA_HOME = dir;
        try {
            const db = openDatabase();
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name: string;
            }>;
            expect(cols.some((c) => c.name === "new_work_tokens")).toBe(true);
            expect(cols.some((c) => c.name === "total_input_tokens")).toBe(true);
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
