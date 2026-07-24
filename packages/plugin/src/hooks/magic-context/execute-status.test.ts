import { describe, expect, test } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { executeStatus } from "./execute-status";
import { estimateTokens } from "./read-session-formatting";

const SESSION_ID = "ses_execute_status";

describe("executeStatus", () => {
    test("attributes history tokens using rendered compartment headings", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 12, 34, "m12", "m34", "Status arc", "status body", Date.now());

        const status = await executeStatus(db, SESSION_ID, 20);
        const expected = estimateTokens("## 12-34 · Status arc\nstatus body\n");

        expect(status).toContain(`- History block: ~${expected.toLocaleString()} tokens`);
        db.close();
    });

    test("annotates the execute threshold when a tokens config is clamped (#241)", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);

        // 190K requested on a 128K model → clamped to 90% × 128K. The status must
        // say so explicitly (configured value + cap) rather than silently showing
        // the reduced value, which is what confused users in issue #241.
        const status = await executeStatus(
            db,
            SESSION_ID,
            20,
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

    test("omits the clamp annotation when the threshold is not clamped (#241)", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);

        const status = await executeStatus(
            db,
            SESSION_ID,
            20,
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
            20,
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

        const status = executeStatus(db, SESSION_ID, 20);

        expect(status).toContain("- Configured: never");
        expect(status).toContain("- Remaining: never expires (always-warm lane)");
        expect(status).toContain("never expires");
        expect(status).not.toContain("Infinity");
        db.close();
    });
});
