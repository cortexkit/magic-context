/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getMemoriesByProject, insertMemory } from "./memory/storage-memory";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { MARKER_LANE_VERSION, MARKER_TABLE } from "./single-store-marker";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "./storage-db";

/**
 * v93 adds the per-project single-store marker table.
 *
 * The table is created empty and nothing in this release writes to it. It exists so
 * every installed build can see a marker before any build writes one.
 */

function tableExists(db: Database, table: string): boolean {
    return (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !=
        null
    );
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function tableSql(db: Database, table: string): string {
    const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string } | null;
    return (row?.sql ?? "").split(/\s+/).join(" ");
}

/** A database exactly as the lane below v93 left it. */
function openBeforeV93(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DROP TABLE IF EXISTS single_store_projects");
    db.prepare("DELETE FROM schema_migrations WHERE version = 93").run();
    return db;
}

describe("migration v93: per-project single-store marker table", () => {
    test("the marker lane constant names the migration that creates the table", () => {
        const creating = MIGRATIONS.filter((migration) => {
            const db = new Database(":memory:");
            try {
                migration.up(db);
                return tableExists(db, MARKER_TABLE);
            } catch {
                return false;
            } finally {
                closeQuietly(db);
            }
        }).map((migration) => migration.version);
        expect(creating).toEqual([MARKER_LANE_VERSION]);
        expect(MARKER_LANE_VERSION).toBeLessThanOrEqual(LATEST_MIGRATION_VERSION);
    });

    test("a fresh database carries the table, empty, and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(getPersistedSchemaVersion(db)).toBe(93);
            expect(columnNames(db, MARKER_TABLE)).toEqual([
                "project_path",
                "context_store_uuid",
                "marked_at",
                "marked_by_version",
            ]);
            expect(db.prepare(`SELECT COUNT(*) AS count FROM ${MARKER_TABLE}`).get()).toEqual({
                count: 0,
            });
            // No index and no trigger: the table is one keyed fact per project.
            expect(
                db
                    .prepare(
                        "SELECT type, name FROM sqlite_master WHERE tbl_name = ? AND type != 'table' AND sql IS NOT NULL",
                    )
                    .all(MARKER_TABLE),
            ).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("the fresh schema and the migration declare the same table", () => {
        const fresh = new Database(":memory:");
        const migrated = openBeforeV93();
        try {
            initializeDatabase(fresh);
            runMigrations(migrated);
            expect(tableSql(migrated, MARKER_TABLE)).toBe(tableSql(fresh, MARKER_TABLE));
        } finally {
            closeQuietly(fresh);
            closeQuietly(migrated);
        }
    });

    test("stepping to v93 over populated tables keeps the rows intact and adds no marker", () => {
        const db = openBeforeV93();
        try {
            expect(tableExists(db, MARKER_TABLE)).toBe(false);
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "kept across the step",
            });
            db.prepare(
                `INSERT INTO authority_managed(project_path, context_store_uuid, marked_at)
                 VALUES ('git:p', 'uuid-p', 1)`,
            ).run();
            db.prepare(
                `INSERT INTO memory_embedding_watermarks
                    (project_path, written_memory_id, embedded_memory_id, updated_at)
                 VALUES ('git:p', 7, 3, 9)`,
            ).run();
            const memoryColumnsBefore = columnNames(db, "memories");

            runMigrations(db);

            expect(tableExists(db, MARKER_TABLE)).toBe(true);
            expect(getPersistedSchemaVersion(db)).toBe(93);
            expect(columnNames(db, "memories")).toEqual(memoryColumnsBefore);
            expect(getMemoriesByProject(db, "git:p").map((row) => [row.id, row.content])).toEqual([
                [memory.id, "kept across the step"],
            ]);
            expect(db.prepare("SELECT project_path FROM authority_managed").all()).toEqual([
                { project_path: "git:p" },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT written_memory_id, embedded_memory_id FROM memory_embedding_watermarks",
                    )
                    .get(),
            ).toEqual({ written_memory_id: 7, embedded_memory_id: 3 });
            // An authority-managed project is not a single-store project: the step
            // never derives a marker from any existing row.
            expect(db.prepare(`SELECT COUNT(*) AS count FROM ${MARKER_TABLE}`).get()).toEqual({
                count: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v91 -> v92 -> v93 over populated tables applies both, in order", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            db.exec("DROP TABLE IF EXISTS rust_ordinal_checkpoints");
            db.exec("DROP TABLE IF EXISTS single_store_projects");
            db.prepare("DELETE FROM schema_migrations WHERE version >= 92").run();
            expect(getPersistedSchemaVersion(db)).toBe(91);

            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "kept across both steps",
            });
            db.prepare(
                `INSERT INTO memory_embedding_watermarks
                    (project_path, written_memory_id, embedded_memory_id, updated_at)
                 VALUES ('git:p', 7, 3, 9)`,
            ).run();
            db.prepare(
                `INSERT INTO authority_managed(project_path, context_store_uuid, marked_at)
                 VALUES ('git:p', 'uuid-p', 1)`,
            ).run();

            runMigrations(db);

            const applied = (
                db
                    .prepare(
                        "SELECT version FROM schema_migrations WHERE version >= 91 ORDER BY applied_at, version",
                    )
                    .all() as Array<{ version: number }>
            ).map((row) => row.version);
            expect(applied.slice(-2)).toEqual([92, 93]);
            expect(tableExists(db, "rust_ordinal_checkpoints")).toBe(true);
            expect(tableExists(db, MARKER_TABLE)).toBe(true);
            expect(getMemoriesByProject(db, "git:p").map((row) => [row.id, row.content])).toEqual([
                [memory.id, "kept across both steps"],
            ]);
            expect(
                db.prepare("SELECT written_memory_id FROM memory_embedding_watermarks").get(),
            ).toEqual({ written_memory_id: 7 });
            expect(db.prepare(`SELECT COUNT(*) AS count FROM ${MARKER_TABLE}`).get()).toEqual({
                count: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("re-running v93 preserves marker rows already recorded", () => {
        const db = openBeforeV93();
        try {
            runMigrations(db);
            db.prepare(
                `INSERT INTO ${MARKER_TABLE}
                    (project_path, context_store_uuid, marked_at, marked_by_version)
                 VALUES ('git:p', 'uuid-p', 5, 'fixture')`,
            ).run();
            db.prepare("DELETE FROM schema_migrations WHERE version = 93").run();
            runMigrations(db);
            expect(
                db.prepare(`SELECT project_path, marked_by_version FROM ${MARKER_TABLE}`).all(),
            ).toEqual([{ project_path: "git:p", marked_by_version: "fixture" }]);
        } finally {
            closeQuietly(db);
        }
    });
});
