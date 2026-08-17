import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { FORK_MIGRATIONS, runForkMigrations } from "./fork-migrations";
import { FORK_MIGRATION_VERSION_FLOOR, MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function migratedDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    runForkMigrations(db);
    return db;
}

function insertGlobal(
    db: Database,
    skillId: string,
    projectIdentity: string,
    hash: string,
    opts: { hit?: number; recall?: number; lastUsed?: number | null; createdAt?: number } = {},
): void {
    db.prepare(
        `INSERT INTO skill_memory (skill_id, resolved_path, tier, project_identity, intent, kind, delta, hit_count, recall_count, pinned, normalized_hash, created_at, last_used_at)
         VALUES (?, '/p', 'global', ?, 'i', 'fix', 'd-' || ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
        skillId,
        projectIdentity,
        hash,
        opts.hit ?? 0,
        opts.recall ?? 0,
        hash,
        opts.createdAt ?? Date.now(),
        opts.lastUsed ?? null,
    );
}

describe("migration v10002 (fork lane) — origin_project + source_type + global '*' unification", () => {
    test("this migration lives in the fork lane, outside the schema fence", () => {
        expect(FORK_MIGRATIONS.some((m) => m.version === 10_002)).toBe(true);
        expect(LATEST_SUPPORTED_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
    });

    test("fresh DB has origin_project + source_type columns", () => {
        const db = migratedDb();
        try {
            const cols = (
                db.prepare("PRAGMA table_info(skill_memory)").all() as Array<{ name: string }>
            ).map((r) => r.name);
            expect(cols).toContain("origin_project");
            expect(cols).toContain("source_type");
        } finally {
            closeQuietly(db);
        }
    });

    test("singleton global note rewritten to '*' with origin_project preserved", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            insertGlobal(db, "council", "git:repoA", "h1");

            const forkMigration = FORK_MIGRATIONS.find((m) => m.version === 10_002);
            expect(forkMigration).toBeDefined();
            forkMigration?.up(db);

            const row = db
                .prepare(
                    "SELECT project_identity, origin_project FROM skill_memory WHERE normalized_hash='h1'",
                )
                .get() as { project_identity: string; origin_project: string };
            expect(row.project_identity).toBe("*");
            expect(row.origin_project).toBe("git:repoA");
        } finally {
            closeQuietly(db);
        }
    });

    test("collision-merge: same lesson in 2 repos → one '*' row, summed counters, MAX(last_used_at)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            insertGlobal(db, "council", "git:repoA", "dup", {
                hit: 2,
                recall: 3,
                lastUsed: 1000,
                createdAt: 500,
            });
            insertGlobal(db, "council", "git:repoB", "dup", {
                hit: 5,
                recall: 1,
                lastUsed: 9000,
                createdAt: 800,
            });

            FORK_MIGRATIONS.find((m) => m.version === 10_002)?.up(db);

            const rows = db
                .prepare(
                    "SELECT project_identity, hit_count, recall_count, last_used_at, created_at FROM skill_memory WHERE normalized_hash='dup'",
                )
                .all() as Array<{
                project_identity: string;
                hit_count: number;
                recall_count: number;
                last_used_at: number;
                created_at: number;
            }>;
            expect(rows.length).toBe(1);
            expect(rows[0].project_identity).toBe("*");
            expect(rows[0].hit_count).toBe(7);
            expect(rows[0].recall_count).toBe(4);
            expect(rows[0].last_used_at).toBe(9000);
            expect(rows[0].created_at).toBe(500);
        } finally {
            closeQuietly(db);
        }
    });

    test("idempotent: re-running v10002 up() does not double-process '*' rows", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            insertGlobal(db, "council", "git:repoA", "h1", { hit: 1 });

            const forkMigration = FORK_MIGRATIONS.find((m) => m.version === 10_002);
            forkMigration?.up(db);
            forkMigration?.up(db);

            const rows = db
                .prepare("SELECT hit_count FROM skill_memory WHERE normalized_hash='h1'")
                .all() as Array<{ hit_count: number }>;
            expect(rows.length).toBe(1);
            expect(rows[0].hit_count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("FTS index consistent after collision-merge (no orphans)", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            insertGlobal(db, "council", "git:repoA", "dup");
            insertGlobal(db, "council", "git:repoB", "dup");

            FORK_MIGRATIONS.find((m) => m.version === 10_002)?.up(db);

            const ftsCount = db.prepare("SELECT COUNT(*) AS n FROM skill_memory_fts").get() as {
                n: number;
            };
            const rowCount = db.prepare("SELECT COUNT(*) AS n FROM skill_memory").get() as {
                n: number;
            };
            // Prove the merge actually happened (2 dup rows → 1) so the parity
            // assertion below isn't trivially true on a no-op merge.
            expect(rowCount.n).toBe(1);
            expect(ftsCount.n).toBe(rowCount.n);
        } finally {
            closeQuietly(db);
        }
    });

    test("project-tier rows untouched", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            for (const m of MIGRATIONS.filter((m) => m.version <= 40)) m.up(db);
            db.prepare(
                `INSERT INTO skill_memory (skill_id, resolved_path, tier, project_identity, intent, kind, delta, normalized_hash, created_at) VALUES ('s', '/p', 'project', 'git:repoA', 'i', 'fix', 'd', 'ph', 1)`,
            ).run();

            FORK_MIGRATIONS.find((m) => m.version === 10_002)?.up(db);

            const row = db
                .prepare("SELECT project_identity FROM skill_memory WHERE normalized_hash='ph'")
                .get() as { project_identity: string };
            expect(row.project_identity).toBe("git:repoA");
        } finally {
            closeQuietly(db);
        }
    });
});
