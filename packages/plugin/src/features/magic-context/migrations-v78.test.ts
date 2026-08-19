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

describe("migration v78: migration_pending journal", () => {
    test("fresh databases include the journal table and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "migration_pending")).toEqual([
                "migration_key",
                "source_session_id",
                "target_harness",
                "pi_session_id",
                "final_path",
                "stage_path",
                "content_sha256",
                "phase",
                "created_at",
            ]);
            expect(LATEST_SUPPORTED_VERSION).toBe(79);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("replaying migrations from v77 creates the journal and is idempotent", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 77);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 78")
                    .get(),
            ).toEqual({ count: 1 });

            // The journal accepts a full row and enforces its phase values.
            db.exec(`
                INSERT INTO migration_pending (
                    migration_key, source_session_id, target_harness, pi_session_id,
                    final_path, stage_path, content_sha256, phase, created_at
                ) VALUES (
                    'key1', 'ses_src', 'pi', 'pi-uuid',
                    '/final.jsonl', '/stage.jsonl', 'sha', 'staged', 123
                );
            `);
            expect(() =>
                db.exec(
                    "INSERT INTO migration_pending (migration_key, source_session_id, target_harness, pi_session_id, final_path, stage_path, content_sha256, phase, created_at) VALUES ('key2', 's', 'pi', 'p', '/f', '/s', 'x', 'bogus', 1)",
                ),
            ).toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    test("journal never carries a bare session_id column (clearSession must not wipe it)", () => {
        // The structural clearSession contract discovers every table with a
        // `session_id` column and requires session deletion to empty it. Recovery
        // records must survive session deletion, so the journal names its session
        // columns `source_session_id` / `pi_session_id` instead.
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "migration_pending")).not.toContain("session_id");
        } finally {
            closeQuietly(db);
        }
    });
});
