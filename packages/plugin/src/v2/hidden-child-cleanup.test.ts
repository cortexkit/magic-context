import { expect, test } from "bun:test";
import { Database } from "../shared/sqlite";
import { cleanupLegacyHiddenChildren } from "./hidden-child-cleanup";

function store() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_migrations_meta VALUES (?, ?)").run(
        "opencode2_hidden_children:old",
        JSON.stringify({
            version: 1,
            active: { historian: { id: "active" } },
            retired_children: [{ id: "retired" }, { id: "missing" }],
        }),
    );
    db.prepare("INSERT INTO schema_migrations_meta VALUES (?, ?)").run(
        "opencode2XhiddenYchildren:unrelated",
        JSON.stringify({ active: { historian: { id: "unrelated" } } }),
    );
    return db;
}
const pending = (db: Database) =>
    db
        .prepare(
            "SELECT value FROM schema_migrations_meta WHERE key GLOB 'opencode2_hidden_children:*'",
        )
        .all();

test("legacy cleanup removes active and retired children idempotently and records completion once", async () => {
    const db = store();
    const removed: string[] = [];
    const logs: string[] = [];
    const removalLogs: string[] = [];
    const remove = async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID);
        if (sessionID === "missing") throw new Error("Session not found");
    };
    const note = (message: string) => {
        if (message.endsWith(" removed")) removalLogs.push(message);
        else logs.push(message);
    };
    try {
        await cleanupLegacyHiddenChildren(db, remove, note);
        expect(removed).toEqual(["active", "retired", "missing"]);
        expect(pending(db)).toEqual([]);
        expect(
            db
                .prepare(
                    "SELECT value FROM schema_migrations_meta WHERE key = 'opencode2_hidden_children_cleanup_complete'",
                )
                .get(),
        ).toEqual({ value: "true" });
        // Completion is a fence, not merely the absence of rows on a second scan.
        db.prepare("INSERT INTO schema_migrations_meta VALUES (?, ?)").run(
            "opencode2_hidden_children:after-completion",
            JSON.stringify({ active: { historian: { id: "late" } } }),
        );
        await cleanupLegacyHiddenChildren(db, remove, note);
        expect(removed).toHaveLength(3);
        expect(pending(db)).toHaveLength(1);
        expect(
            db
                .prepare(
                    "SELECT 1 AS retained FROM schema_migrations_meta WHERE key = 'opencode2XhiddenYchildren:unrelated'",
                )
                .get(),
        ).toEqual({ retained: 1 });
        expect(logs).toEqual([]);
        expect(removalLogs).toEqual([
            "[magic-context] legacy hidden child active removed",
            "[magic-context] legacy hidden child retired removed",
        ]);
    } finally {
        db.close();
    }
});

test("legacy cleanup is bounded per boot and resumes remaining children", async () => {
    const db = store();
    const removed: string[] = [];
    const remove = async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID);
    };
    try {
        await cleanupLegacyHiddenChildren(db, remove, () => {}, { limit: 1 });
        expect(removed).toEqual(["active"]);
        expect(pending(db)).toHaveLength(1);
        await cleanupLegacyHiddenChildren(db, remove, () => {});
        expect(removed).toEqual(["active", "retired", "missing"]);
        expect(pending(db)).toEqual([]);
    } finally {
        db.close();
    }
});

test("legacy cleanup retains timed out children for another boot", async () => {
    const db = store();
    const logs: string[] = [];
    try {
        await cleanupLegacyHiddenChildren(
            db,
            async () => new Promise(() => {}),
            (message) => logs.push(message),
            { limit: 1, timeoutMs: 5 },
        );
        expect(pending(db)).toHaveLength(1);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("timed out");
        await cleanupLegacyHiddenChildren(
            db,
            async () => {},
            () => {},
        );
        expect(pending(db)).toEqual([]);
    } finally {
        db.close();
    }
});

test("legacy cleanup respects a total boot budget even when many removals stall", async () => {
    const db = store();
    const removed: string[] = [];
    let now = 0;
    try {
        await cleanupLegacyHiddenChildren(
            db,
            async ({ sessionID }) => {
                removed.push(sessionID);
                now = 100;
                await new Promise<void>(() => {});
            },
            () => {},
            { budgetMs: 100, now: () => now },
        );
        expect(removed).toEqual(["active"]);
        expect(pending(db)).toHaveLength(1);
    } finally {
        db.close();
    }
});
