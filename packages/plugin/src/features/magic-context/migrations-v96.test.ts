import { describe, expect, test } from "bun:test";
import { loadPersistedLkgSlot, saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import {
    checkLkgDurability,
    recordServedCapture,
} from "../../hooks/magic-context/lkg-served-marker";
import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta-session";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

function v95(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    db.exec(
        "DROP TABLE lkg_served_markers; ALTER TABLE lkg_slots DROP COLUMN served_capture_id; ALTER TABLE lkg_slots DROP COLUMN input_move_digests",
    );
    db.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)",
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 95)) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
            migration.version,
        );
    }
    return db;
}

describe("migration 96", () => {
    test("upgrades populated v95 through public APIs without certifying a legacy slot", () => {
        const db = v95();
        try {
            getOrCreateSessionMeta(db, "legacy");
            const slot = {
                jsonPrefix: '[{"text":"old served bytes"}]',
                inputIdSeq: ["u"],
                inputContentDigests: ["old-digest"],
                lastInputMessageId: "u",
                modelKey: "test/model",
                providerKey: "test",
                capturedAt: Date.now(),
                rowVersion: 41,
                captureSequence: 7,
            };
            expect(saveLkgSlotToDb(db, "legacy", slot)).toBe(true);
            const before = db.prepare("SELECT * FROM lkg_slot_chunks").all();
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(96);
            expect(LATEST_MIGRATION_VERSION).toBe(96);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: 96,
            });
            expect(db.prepare("SELECT * FROM lkg_slot_chunks").all()).toEqual(before);
            expect(loadPersistedLkgSlot(db, "legacy")).toEqual(slot);
            expect(checkLkgDurability(db, "legacy")).toEqual({
                durable: false,
                reason: "lkg_not_durable",
            });
            expect(db.prepare("SELECT * FROM lkg_served_markers").all()).toEqual([]);
            const servedCaptureId = recordServedCapture(db, "legacy", true);
            expect(servedCaptureId).toBe(1);
            expect(
                saveLkgSlotToDb(db, "legacy", {
                    ...slot,
                    servedCaptureId,
                    inputMoveDigests: ["a".repeat(64)],
                }),
            ).toBe(true);
            expect(checkLkgDurability(db, "legacy")).toEqual({ durable: true, servedCaptureId: 1 });
            expect(loadPersistedLkgSlot(db, "legacy")?.captureSequence).toBe(7);
            expect(
                SESSION_SCOPED_TABLES.some((entry) => entry.table === "lkg_served_markers"),
            ).toBe(true);
            const after = db.prepare("SELECT * FROM lkg_served_markers").all();
            runMigrations(db);
            expect(db.prepare("SELECT * FROM lkg_served_markers").all()).toEqual(after);
        } finally {
            db.close();
        }
    });

    test("fresh schema and v96 installer are idempotent", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            MIGRATIONS.find((m) => m.version === 96)!.up(db);
            expect(recordServedCapture(db, "s", true)).toBe(1);
            expect(recordServedCapture(db, "s", true)).toBe(2);
            expect(db.prepare("SELECT served_capture_id FROM lkg_served_markers").all()).toEqual([
                { served_capture_id: 2 },
            ]);
        } finally {
            db.close();
        }
    });
});
