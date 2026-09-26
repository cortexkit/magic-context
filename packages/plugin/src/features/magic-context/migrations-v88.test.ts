/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

/**
 * Issue 492 finding 1. v88 adds the two coordinate columns the store-projection
 * rebase needs. The step-through arms upgrade a database that stopped at v87 and
 * already holds rows, because `ALTER TABLE ADD COLUMN` does not backfill a
 * DEFAULT into existing rows unless the column is NOT NULL.
 */

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

/** Build a v87-shaped database: the current schema minus the three v88 columns. */
function openAtV87(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    db.exec("ALTER TABLE session_meta DROP COLUMN coordinate_generation");
    db.exec("ALTER TABLE session_meta DROP COLUMN coordinate_rebase_notice");
    db.exec("ALTER TABLE compartments DROP COLUMN rebase_status");
    db.exec("ALTER TABLE recomp_compartments DROP COLUMN rebase_status");
    seedAppliedVersion(db, 87);
    return db;
}

function seedPopulatedSession(db: Database, sessionId: string): void {
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, counter, prior_boundary_ordinal) VALUES (?, 'opencode', 3, 4)",
    ).run(sessionId);
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, legacy, created_at, harness)
         VALUES (?, 1, 1, 4, 'msg_start', 'msg_end', 'first', 'body', 50, 0, 1000, 'opencode')`,
    ).run(sessionId);
    db.prepare(
        `INSERT INTO recomp_compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, pass_number, created_at, harness)
         VALUES (?, 1, 1, 4, 'msg_start', 'msg_end', 'staged', 'body', 50, 1, 1000, 'opencode')`,
    ).run(sessionId);
}

describe("migration v88: store projection coordinates", () => {
    test("a fresh database already carries the columns and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 88")
                    .get(),
            ).toEqual({ count: 1 });
            expect(columnNames(db, "session_meta")).toContain("coordinate_generation");
            expect(columnNames(db, "session_meta")).toContain("coordinate_rebase_notice");
            expect(columnNames(db, "compartments")).toContain("rebase_status");
            expect(columnNames(db, "recomp_compartments")).toContain("rebase_status");
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v87 -> v88 on populated tables adds the columns without moving a row", () => {
        const db = openAtV87();
        try {
            seedPopulatedSession(db, "ses-populated");
            expect(columnNames(db, "session_meta")).not.toContain("coordinate_generation");
            expect(columnNames(db, "compartments")).not.toContain("rebase_status");

            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("coordinate_generation");
            expect(columnNames(db, "compartments")).toContain("rebase_status");
            expect(columnNames(db, "recomp_compartments")).toContain("rebase_status");
            expect(
                db
                    .prepare(
                        "SELECT start_message, end_message, rebase_status FROM compartments WHERE session_id = ?",
                    )
                    .all("ses-populated"),
            ).toEqual([{ start_message: 1, end_message: 4, rebase_status: "ok" }]);
            expect(
                db
                    .prepare(
                        "SELECT start_message, end_message, rebase_status FROM recomp_compartments WHERE session_id = ?",
                    )
                    .all("ses-populated"),
            ).toEqual([{ start_message: 1, end_message: 4, rebase_status: "ok" }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("an existing session's coordinate generation is NULL, not a guessed projection", () => {
        const db = openAtV87();
        try {
            seedPopulatedSession(db, "ses-existing");

            runMigrations(db);

            // NULL is the whole point: "never recorded" must stay distinguishable
            // from "recorded as v1", because only the first one may rebase.
            expect(
                db
                    .prepare(
                        "SELECT coordinate_generation AS generation, coordinate_rebase_notice AS notice FROM session_meta WHERE session_id = ?",
                    )
                    .get("ses-existing"),
            ).toEqual({ generation: null, notice: null });
        } finally {
            closeQuietly(db);
        }
    });

    test("re-running v88 against an already-migrated database changes nothing", () => {
        const db = openAtV87();
        try {
            seedPopulatedSession(db, "ses-idempotent");
            runMigrations(db);
            db.prepare(
                "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ?",
            ).run("ses-idempotent");
            db.prepare(
                "UPDATE session_meta SET coordinate_generation = 'v2' WHERE session_id = ?",
            ).run("ses-idempotent");

            db.prepare("DELETE FROM schema_migrations WHERE version = 88").run();
            runMigrations(db);

            expect(
                db
                    .prepare("SELECT rebase_status FROM compartments WHERE session_id = ?")
                    .get("ses-idempotent"),
            ).toEqual({ rebase_status: "unresolved" });
            expect(
                db
                    .prepare(
                        "SELECT coordinate_generation AS generation FROM session_meta WHERE session_id = ?",
                    )
                    .get("ses-idempotent"),
            ).toEqual({ generation: "v2" });
        } finally {
            closeQuietly(db);
        }
    });
});
