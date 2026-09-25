/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
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

function indexNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
        (index) => index.name,
    );
}

function openAtV88(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    db.exec(`
        DROP INDEX idx_message_fts_rowid_map_session_time;
        DROP TABLE message_time_backfill_state;
        ALTER TABLE message_fts_rowid_map DROP COLUMN message_time_ms;
    `);
    seedAppliedVersion(db, 88);
    return db;
}

describe("migration v89: indexed message times", () => {
    test("fresh databases carry the nullable time, lookup index, state row, and fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(92);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(columnNames(db, "message_fts_rowid_map")).toContain("message_time_ms");
            expect(indexNames(db, "message_fts_rowid_map")).toContain(
                "idx_message_fts_rowid_map_session_time",
            );
            expect(db.prepare("SELECT * FROM message_time_backfill_state").get()).toMatchObject({
                id: 1,
                cursor_session_id: "",
                cursor_ordinal: 0,
                completed: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("steps v88 -> v89 over populated map rows without changing their identities", () => {
        const db = openAtV88();
        try {
            db.prepare(
                "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid) VALUES ('ses', 7, 42)",
            ).run();

            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT session_id, message_ordinal, fts_rowid, message_time_ms FROM message_fts_rowid_map",
                    )
                    .get(),
            ).toEqual({
                session_id: "ses",
                message_ordinal: 7,
                fts_rowid: 42,
                message_time_ms: null,
            });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 89")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("replaying v89 preserves backfilled times and progress", () => {
        const db = openAtV88();
        try {
            runMigrations(db);
            db.prepare(
                "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES ('ses', 1, 3, 1234)",
            ).run();
            db.prepare(
                "UPDATE message_time_backfill_state SET cursor_session_id = 'ses', cursor_ordinal = 1",
            ).run();

            db.prepare("DELETE FROM schema_migrations WHERE version = 89").run();
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT message_time_ms FROM message_fts_rowid_map WHERE session_id = 'ses'",
                    )
                    .get(),
            ).toEqual({ message_time_ms: 1234 });
            expect(
                db
                    .prepare(
                        "SELECT cursor_session_id, cursor_ordinal FROM message_time_backfill_state",
                    )
                    .get(),
            ).toEqual({ cursor_session_id: "ses", cursor_ordinal: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
