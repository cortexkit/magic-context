import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    FORK_MIGRATIONS,
    LATEST_FORK_MIGRATION_VERSION,
    runForkMigrations,
} from "./fork-migrations";
import { FORK_MIGRATION_VERSION_FLOOR, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db"; // ESM import (not require) — matches codebase pattern

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

describe("migration v10000 (fork lane) — skill_memory table", () => {
    test("creates skill_memory table with correct columns on fresh DB, idempotently", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runForkMigrations(db);
            runMigrations(db);
            runForkMigrations(db); // idempotency check

            expect(tableExists(db, "skill_memory")).toBe(true);

            const cols = columnNames(db, "skill_memory");
            expect(cols).toContain("id");
            expect(cols).toContain("skill_id");
            expect(cols).toContain("resolved_path");
            expect(cols).toContain("tier");
            expect(cols).toContain("skill_source");
            expect(cols).toContain("project_identity");
            expect(cols).toContain("intent");
            expect(cols).toContain("intent_embedding");
            expect(cols).toContain("embedding_model_version");
            expect(cols).toContain("kind");
            expect(cols).toContain("delta");
            expect(cols).toContain("tags");
            expect(cols).toContain("hit_count");
            expect(cols).toContain("pinned");
            expect(cols).toContain("normalized_hash");
            expect(cols).toContain("created_at");
            expect(cols).toContain("last_used_at");

            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: LATEST_FORK_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("skill_memory CHECK constraints reject invalid tier and kind values", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runForkMigrations(db);

            const insert = db.prepare(`
                INSERT INTO skill_memory
                  (skill_id, resolved_path, tier, project_identity, intent, kind, delta, normalized_hash, hit_count, pinned, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
            `);

            // Valid row
            expect(() =>
                insert.run(
                    "test-skill",
                    "/path/SKILL.md",
                    "project",
                    "git:abc123",
                    "test intent",
                    "gotcha",
                    "test delta",
                    "hash1",
                    Date.now(),
                ),
            ).not.toThrow();

            // Invalid tier
            expect(() =>
                insert.run(
                    "test-skill",
                    "/path/SKILL.md",
                    "invalid-tier",
                    "git:abc123",
                    "test intent",
                    "gotcha",
                    "test delta",
                    "hash2",
                    Date.now(),
                ),
            ).toThrow();

            // Invalid kind
            expect(() =>
                insert.run(
                    "test-skill",
                    "/path/SKILL.md",
                    "project",
                    "git:abc123",
                    "test intent",
                    "general",
                    "test delta",
                    "hash3",
                    Date.now(),
                ),
            ).toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    test("this migration lives in the fork lane, outside the schema fence", () => {
        // Was a mirror of schema-version-fence.test.ts, asserting
        // LATEST_SUPPORTED_VERSION === the newest migration. That contract belongs to
        // the UPSTREAM lane only: fork rows are fence-invisible by design, so the
        // fence stays at upstream's ceiling and never tracks a fork version.
        expect(FORK_MIGRATIONS.some((m) => m.version === 10_000)).toBe(true);
        expect(LATEST_SUPPORTED_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
    });
});
