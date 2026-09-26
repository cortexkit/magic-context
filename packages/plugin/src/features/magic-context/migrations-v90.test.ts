/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

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

function openAtV89(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    db.exec("ALTER TABLE compartment_state_lease DROP COLUMN owner_pid");
    seedAppliedVersion(db, 89);
    return db;
}

describe("migration v90: compartment lease owner pid", () => {
    test("a fresh database carries owner_pid and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(columnNames(db, "compartment_state_lease")).toContain("owner_pid");
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 90")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v89 to v90 preserves an opaque legacy lease", () => {
        const db = openAtV89();
        try {
            db.prepare(
                `INSERT INTO compartment_state_lease
                    (session_id, holder_id, acquired_at, expires_at)
                 VALUES (?, ?, ?, ?)`,
            ).run("ses-legacy", "legacy-holder", 1_000, 2_000);

            runMigrations(db);

            expect(
                db
                    .prepare(
                        `SELECT holder_id AS holderId, owner_pid AS ownerPid,
                                acquired_at AS acquiredAt, expires_at AS expiresAt
                           FROM compartment_state_lease WHERE session_id = ?`,
                    )
                    .get("ses-legacy"),
            ).toEqual({
                holderId: "legacy-holder",
                ownerPid: null,
                acquiredAt: 1_000,
                expiresAt: 2_000,
            });
        } finally {
            closeQuietly(db);
        }
    });
});
