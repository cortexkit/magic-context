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
        (row) => row.name,
    );
}

describe("migration v81: durable last-known-good transform snapshots", () => {
    test("fresh databases include the lkg_slots table and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "lkg_slots")).toEqual([
                "session_id",
                "json_prefix",
                "input_id_seq",
                "input_content_digests",
                "input_content_signatures",
                "last_input_message_id",
                "model_key",
                "provider_key",
                "captured_at",
                "row_version",
                "capture_sequence",
            ]);
            expect(LATEST_SUPPORTED_VERSION).toBe(82);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("creates the table on upgrade and remains idempotent", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 80);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name='lkg_slots'",
                    )
                    .get(),
            ).toEqual({ name: "lkg_slots" });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 81")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
