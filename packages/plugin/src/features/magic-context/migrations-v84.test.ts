/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getPersistedEpochFloor, persistEpochFloorSnapshot } from "./storage-meta-persisted";
import { updateSessionMeta } from "./storage-meta-session";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

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

describe("migration v84: effective protected-token floor", () => {
    test("fresh databases include the floor column and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("protected_tokens_effective");
            expect(columnNames(db, "session_meta")).toContain("protected_tokens_pre_snapshot");
            expect(LATEST_SUPPORTED_VERSION).toBe(92);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                SESSION_SCOPED_TABLES.filter(({ table }) => table === "session_meta"),
            ).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("v83 upgrades preserve populated session metadata and round-trip the floor", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec("ALTER TABLE session_meta DROP COLUMN protected_tokens_effective");
            db.exec("ALTER TABLE session_meta DROP COLUMN protected_tokens_pre_snapshot");
            seedAppliedVersion(db, 83);
            updateSessionMeta(db, "ses-v83", { counter: 7 });

            expect(columnNames(db, "session_meta")).not.toContain("protected_tokens_effective");
            expect(columnNames(db, "session_meta")).not.toContain("protected_tokens_pre_snapshot");
            runMigrations(db);
            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("protected_tokens_effective");
            expect(columnNames(db, "session_meta")).toContain("protected_tokens_pre_snapshot");
            expect(
                db
                    .prepare(
                        `SELECT counter, protected_tokens_effective, protected_tokens_pre_snapshot
                         FROM session_meta WHERE session_id = ?`,
                    )
                    .get("ses-v83"),
            ).toEqual({
                counter: 7,
                protected_tokens_effective: null,
                protected_tokens_pre_snapshot: null,
            });

            persistEpochFloorSnapshot(db, "ses-v83", 24_000);
            expect(getPersistedEpochFloor(db, "ses-v83")).toBe(24_000);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 84")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("v84 tolerates the column already added by the former lazy healer", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            seedAppliedVersion(db, 83);
            persistEpochFloorSnapshot(db, "ses-healed", 32_000);

            runMigrations(db);

            expect(getPersistedEpochFloor(db, "ses-healed")).toBe(32_000);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 84")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});
