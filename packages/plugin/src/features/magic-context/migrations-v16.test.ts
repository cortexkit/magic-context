import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

describe("migration v16 — context-limit cache regression sentinels", () => {
    test("fresh database has defaulted sentinel columns", () => {
        useTempDataHome("v16-fresh-");
        const db = openDatabase();
        const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
            dflt_value: unknown;
        }>;

        expect(cols.find((c) => c.name === "observed_safe_input_tokens")?.dflt_value).toBe("0");
        expect(cols.find((c) => c.name === "cache_alert_sent")?.dflt_value).toBe("0");

        db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-v16')").run();
        const row = db
            .prepare(
                "SELECT observed_safe_input_tokens, cache_alert_sent FROM session_meta WHERE session_id = ?",
            )
            .get("ses-v16") as {
            observed_safe_input_tokens: number;
            cache_alert_sent: number;
        };
        expect(row.observed_safe_input_tokens).toBe(0);
        expect(row.cache_alert_sent).toBe(0);
    });

    test("migration is idempotent", () => {
        useTempDataHome("v16-idempotent-");
        openDatabase();

        // Re-opening runs initializeDatabase/ensureColumn and runMigrations again.
        closeDatabase();
        const reopened = openDatabase();
        const cols = reopened.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
        }>;

        expect(cols.filter((c) => c.name === "observed_safe_input_tokens")).toHaveLength(1);
        expect(cols.filter((c) => c.name === "cache_alert_sent")).toHaveLength(1);
    });
});
