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

describe("migration v82: memory mapping origin", () => {
    test("fresh databases record mapping origins and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "memory_verifications")).toContain("mapping_origin");
            expect(LATEST_SUPPORTED_VERSION).toBe(82);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades existing mappings to the conservative mapper origin idempotently", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE memory_verifications (
                    memory_id INTEGER NOT NULL,
                    file_path TEXT NOT NULL,
                    verified_at INTEGER NOT NULL,
                    mapped_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (memory_id, file_path)
                );
                INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at)
                VALUES (1, '', 0, 1000);
            `);
            seedAppliedVersion(db, 81);

            runMigrations(db);
            runMigrations(db);

            expect(columnNames(db, "memory_verifications")).toContain("mapping_origin");
            expect(
                db
                    .prepare("SELECT mapping_origin FROM memory_verifications WHERE memory_id = 1")
                    .get(),
            ).toEqual({ mapping_origin: "mapper" });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 82")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
