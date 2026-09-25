/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { loadPersistedLkgSlot, saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import {
    loadPersistedOrdinalCheckpoints,
    savePersistedOrdinalCheckpoints,
} from "../../hooks/magic-context/ordinal-checkpoint-persist";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getMemoriesByProject, insertMemory } from "./memory/storage-memory";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";

/**
 * v92 adds the Rust adapter's persisted ordinal-walk checkpoints: one row per session
 * holding the sparse page checkpoints a restarted process starts its id-to-ordinal map
 * from, instead of re-reading every stored row of the session.
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

/** A database exactly as v91 left it: every migration through v91, none of v92. */
function openAtV91(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DROP TABLE IF EXISTS rust_ordinal_checkpoints");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 92").run();
    return db;
}

const CHECKPOINTS = [
    { anchor: { timeCreated: 500, id: "msg-500" }, storedCount: 500, canonicalCount: 499 },
    { anchor: { timeCreated: 1000, id: "msg-1000" }, storedCount: 1000, canonicalCount: 998 },
];

describe("migration v92: persisted Rust ordinal checkpoints", () => {
    test("a fresh database carries the table and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(92);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 92")
                    .get(),
            ).toEqual({ count: 1 });
            expect(columnNames(db, "rust_ordinal_checkpoints")).toEqual([
                "session_id",
                "checkpoints_json",
                "updated_at",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v91 -> v92 over rows written through the public APIs keeps them intact", () => {
        const db = openAtV91();
        try {
            expect(tableExists(db, "rust_ordinal_checkpoints")).toBe(false);
            // Populated at v91 the way a running host would: a project memory and a
            // persisted LKG replay slot for the session whose checkpoints come next.
            const memory = insertMemory(db, {
                projectPath: "git:p",
                category: "ARCHITECTURE",
                content: "kept across the step",
            });
            expect(
                saveLkgSlotToDb(db, "ses-v91", {
                    jsonPrefix: "[]",
                    inputIdSeq: ["msg-1"],
                    inputContentDigests: ["digest-1"],
                    lastInputMessageId: "msg-1",
                    modelKey: null,
                    providerKey: null,
                    capturedAt: 10,
                }),
            ).toBe(true);
            // Before v92 a checkpoint write fails soft rather than throwing into a pass.
            expect(savePersistedOrdinalCheckpoints(db, "ses-v91", CHECKPOINTS)).toBe(false);
            expect(loadPersistedOrdinalCheckpoints(db, "ses-v91")).toEqual([]);

            runMigrations(db);

            expect(tableExists(db, "rust_ordinal_checkpoints")).toBe(true);
            expect(getMemoriesByProject(db, "git:p").map((row) => [row.id, row.content])).toEqual([
                [memory.id, "kept across the step"],
            ]);
            expect(loadPersistedLkgSlot(db, "ses-v91")?.lastInputMessageId).toBe("msg-1");
            expect(savePersistedOrdinalCheckpoints(db, "ses-v91", CHECKPOINTS, 77)).toBe(true);
            expect(loadPersistedOrdinalCheckpoints(db, "ses-v91")).toEqual(CHECKPOINTS);

            // Session deletion and the orphan sweep delete from every table in
            // SESSION_SCOPED_TABLES, which now includes the ordinal checkpoints.
            deleteSessionScopedRows(db, ["ses-v91"], undefined, {
                rustModuleCleanupAcknowledged: true,
            });
            expect(loadPersistedOrdinalCheckpoints(db, "ses-v91")).toEqual([]);
            expect(loadPersistedLkgSlot(db, "ses-v91")).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("re-running v92 preserves checkpoints already recorded", () => {
        const db = openAtV91();
        try {
            runMigrations(db);
            savePersistedOrdinalCheckpoints(db, "ses-rerun", CHECKPOINTS, 5);

            db.prepare("DELETE FROM schema_migrations WHERE version = 92").run();
            runMigrations(db);

            expect(loadPersistedOrdinalCheckpoints(db, "ses-rerun")).toEqual(CHECKPOINTS);
        } finally {
            closeQuietly(db);
        }
    });
});
