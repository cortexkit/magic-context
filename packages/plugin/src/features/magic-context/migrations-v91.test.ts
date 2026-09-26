/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { acquireCompartmentLease, getCompartmentLeaseBlocker } from "./compartment-lease";
import { getMemoriesByProject, insertMemory } from "./memory/storage-memory";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

/**
 * v91 adds the per-project embedding high-water mark.
 *
 * It exists because embeddings are host-computed, not trigger-maintained: a memory row
 * written by the Rust module arrives without one and nothing would ask. The mark is what
 * asks. It is a separate table rather than a column on `memories` on purpose — a column
 * would make a module-written row distinguishable from a host-written one, and the whole
 * point of the single-store work is that they are not.
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

/** A database exactly as v90 left it: every migration through v90, none of v91. */
function openAtV90(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DROP TABLE IF EXISTS memory_embedding_watermarks");
    db.prepare("DELETE FROM schema_migrations WHERE version = 91").run();
    return db;
}

describe("migration v91: module-written memory embedding watermark", () => {
    test("a fresh database carries the table and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 91")
                    .get(),
            ).toEqual({ count: 1 });
            expect(tableExists(db, "memory_embedding_watermarks")).toBe(true);
            expect(columnNames(db, "memory_embedding_watermarks")).toEqual([
                "project_path",
                "written_memory_id",
                "embedded_memory_id",
                "updated_at",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v90 -> v91 over rows written through the public APIs keeps them intact", () => {
        const db = openAtV90();
        try {
            expect(tableExists(db, "memory_embedding_watermarks")).toBe(false);
            // Populated at v90 the way a running host would: a memory through the
            // storage API, and a historian lease that records its owner pid (v90).
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "kept across the step",
            });
            const lease = acquireCompartmentLease(db, "ses-v90", "holder-v90");
            expect(lease).not.toBeNull();
            const memoryColumnsBefore = columnNames(db, "memories");

            runMigrations(db);

            expect(tableExists(db, "memory_embedding_watermarks")).toBe(true);
            // A memory row written before the migration must be indistinguishable from
            // one written after it; the mark lives outside this table for that reason.
            expect(columnNames(db, "memories")).toEqual(memoryColumnsBefore);
            expect(getMemoriesByProject(db, "git:p").map((row) => [row.id, row.content])).toEqual([
                [memory.id, "kept across the step"],
            ]);
            expect(getCompartmentLeaseBlocker(db, "ses-v90")).toMatchObject({
                holderId: "holder-v90",
                ownerPid: process.pid,
            });
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_watermarks").get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("re-running v91 preserves the marks already recorded", () => {
        const db = openAtV90();
        try {
            runMigrations(db);
            db.prepare(
                `INSERT INTO memory_embedding_watermarks
                    (project_path, written_memory_id, embedded_memory_id, updated_at)
                 VALUES ('git:p', 41, 12, 900)`,
            ).run();

            db.prepare("DELETE FROM schema_migrations WHERE version = 91").run();
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT written_memory_id, embedded_memory_id FROM memory_embedding_watermarks WHERE project_path = 'git:p'",
                    )
                    .get(),
            ).toEqual({ written_memory_id: 41, embedded_memory_id: 12 });
        } finally {
            closeQuietly(db);
        }
    });
});
