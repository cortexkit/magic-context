/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v77: durable candidate provenance", () => {
    test("fresh databases include both provenance columns and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "user_memories")).toContain("source_candidate_provenance");
            expect(columnNames(db, "primers")).toContain("source_candidate_provenance");
            expect(LATEST_SUPPORTED_VERSION).toBe(79);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades legacy rows without inventing provenance and remains idempotent", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE user_memories (
                    id INTEGER PRIMARY KEY,
                    source_candidate_ids TEXT DEFAULT '[]'
                );
                INSERT INTO user_memories (id, source_candidate_ids) VALUES (1, '[41]');

                CREATE TABLE primers (
                    id INTEGER PRIMARY KEY,
                    source_candidate_ids TEXT NOT NULL DEFAULT '[]'
                );
                INSERT INTO primers (id, source_candidate_ids) VALUES (1, '[73]');
            `);
            seedAppliedVersion(db, 76);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT source_candidate_ids, source_candidate_provenance FROM user_memories WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ source_candidate_ids: "[41]", source_candidate_provenance: null });
            expect(
                db
                    .prepare(
                        "SELECT source_candidate_ids, source_candidate_provenance FROM primers WHERE id = 1",
                    )
                    .get(),
            ).toEqual({ source_candidate_ids: "[73]", source_candidate_provenance: null });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 77")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("tolerates a sparse legacy database without either durable table", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 76);
            expect(() => runMigrations(db)).not.toThrow();
            expect(
                db.prepare("SELECT version FROM schema_migrations WHERE version = 77").get(),
            ).toEqual({ version: 77 });
        } finally {
            closeQuietly(db);
        }
    });
});
