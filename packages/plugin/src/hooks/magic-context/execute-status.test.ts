import { describe, expect, test } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { CONFIG_WARNING_CLASS, type ConfigParseFailure } from "../../shared/config-diagnostics";
import {
    formatOpenCodeDbMissingStatusLine,
    resetOpenCodeDbPathStateForTesting,
    resolveOpenCodeDbPath,
} from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { executeStatus } from "./execute-status";
import { estimateTokens } from "./read-session-formatting";

const SESSION_ID = "ses_execute_status";

describe("executeStatus", () => {
    test("attributes history tokens using rendered compartment headings", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 12, 34, "m12", "m34", "Status arc", "status body", Date.now());

        const status = executeStatus(db, SESSION_ID);
        const expected = estimateTokens("## 12-34 · Status arc\nstatus body\n");

        expect(status).toContain(`- History block: ~${expected.toLocaleString()} tokens`);
        db.close();
    });

    // The claim this test carries used to live in command-handler.test.ts,
    // reached through `/ctx-status diagnostics`. That argument is gone, but the
    // legacy renderer is still what answers a handler consumer that supplies no
    // shared status builder, so its queue section is pinned here instead.
    test("lists queued drop operations with their tag numbers", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(SESSION_ID, "msg-10", "message", "active", 300, 10);
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)",
        ).run(SESSION_ID, 10, Date.now());

        const status = executeStatus(db, SESSION_ID);

        expect(status).toContain("### Queued Operations");
        expect(status).toContain("§10§ → drop");
        expect(status).toContain("- Drops: 1");
        db.close();
    });

    test("annotates the execute threshold when a tokens config is clamped (#241)", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);

        // 190K requested on a 128K model → clamped to 90% × 128K. The status must
        // say so explicitly (configured value + cap) rather than silently showing
        // the reduced value, which is what confused users in issue #241.
        const status = executeStatus(
            db,
            SESSION_ID,
            65,
            "some/model",
            undefined,
            undefined,
            { "some/model": 190_000 },
            128_000,
        );

        expect(status).toContain("[token-mode] [clamped:");
        expect(status).toContain("> 90% of");
        db.close();
    });

    test("omits the clamp annotation when the threshold is not clamped (#241)", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);

        const status = executeStatus(
            db,
            SESSION_ID,
            65,
            "some/model",
            undefined,
            undefined,
            undefined,
            128_000,
        );

        expect(status).toContain("Execute threshold:");
        expect(status).not.toContain("[clamped:");
        db.close();
    });

    test("shows the exact nudge hygiene ratio and keeps zero values", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);

        const status = executeStatus(
            db,
            SESSION_ID,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                u: 0,
                t: 0,
                severity: 0,
                evaluable: true,
                generationInvalidated: false,
                baselineGeneration: 0,
                computedAt: 0,
            },
        );

        expect(status).toContain("### Tail Hygiene");
        expect(status).toContain("0.0% · 0 / 0 tok");
        expect(status).toContain("Reasoning is excluded from both terms");
        db.close();
    });

    test("renders 'never expires' for cacheTtl 'never'", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        db.prepare("UPDATE session_meta SET cache_ttl = 'never' WHERE session_id = ?").run(
            SESSION_ID,
        );

        const status = executeStatus(db, SESSION_ID);

        expect(status).toContain("- Cache TTL: never (session)");
        expect(status).toContain(
            "- Remaining: never (MC never assumes expiry — external cache-keep)",
        );
        expect(status).toContain("never (MC never assumes expiry");
        expect(status).not.toContain("Infinity");
        db.close();
    });

    test("puts the missing OpenCode store before parse failures and keeps configured TTL read-only", () => {
        const originalOpenCodeDb = process.env.OPENCODE_DB;
        process.env.OPENCODE_DB = ":memory:";
        resetOpenCodeDbPathStateForTesting();
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        const failure: ConfigParseFailure = {
            warningClass: CONFIG_WARNING_CLASS.FILE_PARSE,
            source: "user",
            path: "/tmp/magic-context.jsonc",
            line: 1,
            column: 1,
            message: "invalid symbol",
            recovered: true,
            warning: "/tmp/magic-context.jsonc:1:1: invalid symbol",
        };

        const status = executeStatus(
            db,
            SESSION_ID,
            undefined,
            "anthropic/claude-opus-5",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                cacheTtlConfig: { default: "5m", "anthropic/claude-opus-5": "1h" },
                cacheTtlConfigured: true,
                configParseFailures: [failure],
            },
        );

        expect(status.split("\n")[0]).toBe(
            formatOpenCodeDbMissingStatusLine(resolveOpenCodeDbPath()),
        );
        expect(status).toContain(
            "Config: PARSE FAILED (/tmp/magic-context.jsonc:1:1) — recovered values applied; fix the file",
        );
        expect(status).toContain("Cache TTL: 1h (your config)");
        expect(getOrCreateSessionMeta(db, SESSION_ID).cacheTtl).toBe("5m");
        db.close();
        if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = originalOpenCodeDb;
        resetOpenCodeDbPathStateForTesting();
    });
});
