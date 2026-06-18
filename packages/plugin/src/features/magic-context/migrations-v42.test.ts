import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
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

describe("migration v42 — skill_memory table", () => {
    test("creates skill_memory table with correct columns on fresh DB, idempotently", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            runMigrations(db); // idempotency check

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
            ).toEqual({ version: LATEST_MIGRATION_VERSION });
        } finally {
            closeQuietly(db);
        }
    });

    test("skill_memory CHECK constraints reject invalid tier and kind values", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

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

    test("LATEST_SUPPORTED_VERSION equals LATEST_MIGRATION_VERSION after v42", () => {
        // This test will fail until storage-db.ts is bumped to 39.
        // Belt-and-braces: mirrors schema-version-fence.test.ts but is co-located with the migration.
        // If this feels redundant, keep it with this comment — co-location aids discoverability.
        // NOTE: use ESM import at the top of the file (not require()) to match codebase pattern.
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
    });
});
