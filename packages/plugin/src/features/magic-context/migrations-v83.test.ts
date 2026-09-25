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

function tableSql(db: Database, table: string): string {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql?: string } | undefined;
    return row?.sql ?? "";
}

describe("migration v83: indexed message FTS rowid access", () => {
    test("fresh databases have rowid-map parity and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableSql(db, "message_fts_rowid_map")).toContain(
                "PRIMARY KEY(session_id, message_ordinal)",
            );
            expect(tableSql(db, "message_fts_rowid_map_backfill_state")).toContain(
                "watermark_rowid INTEGER NOT NULL DEFAULT 0",
            );
            expect(
                db.prepare("SELECT * FROM message_fts_rowid_map_backfill_state").get(),
            ).toMatchObject({ id: 1, watermark_rowid: 0, completed: 0 });
            expect(LATEST_SUPPORTED_VERSION).toBe(92);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("v82 upgrades create empty resumable state without scanning legacy FTS rows", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE VIRTUAL TABLE message_history_fts USING fts5(
                    session_id UNINDEXED,
                    message_ordinal UNINDEXED,
                    message_id UNINDEXED,
                    role,
                    content
                );
                INSERT INTO message_history_fts
                    (session_id, message_ordinal, message_id, role, content)
                VALUES ('legacy', 1, 'm1', 'user', 'legacy bytes');
            `);
            seedAppliedVersion(db, 82);

            runMigrations(db);
            runMigrations(db);

            expect(db.prepare("SELECT COUNT(*) AS count FROM message_fts_rowid_map").get()).toEqual(
                { count: 0 },
            );
            expect(
                db.prepare("SELECT * FROM message_fts_rowid_map_backfill_state").get(),
            ).toMatchObject({ id: 1, watermark_rowid: 0, completed: 0 });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 83")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
