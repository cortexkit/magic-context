import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
    );
}
function tableExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name),
    );
}

describe("migration v55 — skill_memory embeddings + FTS", () => {
    test("fresh DB: delta_embedding column and skill_memory_fts exist, no throw", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runMigrations(db); // idempotency

            expect(columnNames(db, "skill_memory")).toContain("delta_embedding");
            expect(tableExists(db, "skill_memory_fts")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("FTS triggers keep skill_memory_fts in sync with skill_memory", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.prepare(
                `INSERT INTO skill_memory
                   (skill_id, resolved_path, tier, project_identity, intent, kind, delta, normalized_hash, hit_count, pinned, created_at)
                 VALUES (?,?,?,?,?,?,?,?,0,0,?)`,
            ).run(
                "s1",
                "/p/SKILL.md",
                "global",
                "git:abc",
                "fix a flaky auth test",
                "fix",
                "mock Date.now in auth tests",
                "h1",
                Date.now(),
            );

            const hit = db
                .prepare(
                    `SELECT m.id FROM skill_memory_fts f JOIN skill_memory m ON m.id = f.rowid
                     WHERE skill_memory_fts MATCH ?`,
                )
                .get('"auth"');
            expect(hit).toBeTruthy();
        } finally {
            closeQuietly(db);
        }
    });

    // requires `import { MIGRATIONS } from "./migrations";` (added above)
    test("v55 migration backfills FTS for rows that pre-existed v40", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            // Build a PRE-v40 schema: apply every migration BELOW v40 directly via up() (runMigrations has no
            // target-version param). skill_memory is created at v39; the FTS table + delta_embedding do NOT exist yet.
            for (const m of MIGRATIONS.filter((x) => x.version < 55).sort(
                (a, b) => a.version - b.version,
            )) {
                m.up(db);
            }
            // Insert a row under the pre-v55 schema — no FTS table yet, so no AFTER-INSERT trigger indexes it.
            db.prepare(
                `INSERT INTO skill_memory
                   (skill_id, resolved_path, tier, project_identity, intent, kind, delta, normalized_hash, hit_count, pinned, created_at)
                 VALUES (?,?,?,?,?,?,?,?,0,0,?)`,
            ).run(
                "s2",
                "/p/SKILL.md",
                "global",
                "git:abc",
                "handle oauth refresh",
                "fix",
                "rotate the token early",
                "h2",
                Date.now(),
            );
            // Apply ONLY v40's up() — its body must ALTER + create the FTS table + BACKFILL the pre-existing row.
            const v55 = MIGRATIONS.find((m) => m.version === 55);
            if (!v55) throw new Error("v40 migration not found");
            v55.up(db);
            const hit = db
                .prepare(
                    `SELECT m.id FROM skill_memory_fts f JOIN skill_memory m ON m.id = f.rowid WHERE skill_memory_fts MATCH ?`,
                )
                .get('"oauth"');
            expect(hit).toBeTruthy();
        } finally {
            closeQuietly(db);
        }
    });

    test("LATEST_SUPPORTED_VERSION equals LATEST_MIGRATION_VERSION after v55", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        expect(LATEST_SUPPORTED_VERSION).toBe(56);
    });
});
