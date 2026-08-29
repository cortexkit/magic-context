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

function columnNames(db: Database): string[] {
    return (db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v76: retina condition compilation", () => {
    test("fresh databases include all nullable compilation columns and align the fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db)).toEqual(
                expect.arrayContaining([
                    "compiled_provider",
                    "compiled_config",
                    "compiled_at",
                    "compile_status",
                ]),
            );
            expect(LATEST_SUPPORTED_VERSION).toBe(82);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO notes (type, status, content, created_at, updated_at, compile_status) VALUES ('smart', 'pending', 'invalid', 1, 1, 'invalid')",
                    )
                    .run(),
            ).toThrow("CHECK constraint failed");
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades existing notes without marking them attempted and remains idempotent", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE notes (
                    id INTEGER PRIMARY KEY,
                    content TEXT NOT NULL
                );
                INSERT INTO notes (id, content) VALUES (1, 'legacy note');
            `);
            seedAppliedVersion(db, 75);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT compiled_provider, compiled_config, compiled_at, compile_status FROM notes WHERE id = 1",
                    )
                    .get(),
            ).toEqual({
                compiled_provider: null,
                compiled_config: null,
                compiled_at: null,
                compile_status: null,
            });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 76")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
