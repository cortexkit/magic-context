/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { setPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { checkCompactionMarkerConsistency } from "./compaction-marker-manager";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    // Match the getDataDir() layout the plugin expects. opencode.db lives
    // under opencode/, while magic-context's own DB now lives at the shared
    // cortexkit path. Create both parent directories so the OpenCode-side DB
    // file write succeeds and openDatabase() finds a clean target.
    mkdirSync(join(dir, "opencode"), { recursive: true });
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function insertMessage(db: Database, id: string): void {
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        id,
        "ses-1",
        "{}",
    );
}

function insertPart(db: Database, id: string): void {
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run(
        id,
        "msg-x",
        "ses-1",
        "{}",
    );
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("checkCompactionMarkerConsistency", () => {
    it("is a no-op when there is no persisted state", () => {
        const dataHome = useTempDataHome("consistency-empty-");
        const opencodeDb = createOpenCodeDb(dataHome);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // Should not throw on the happy path even when there are no markers.
        expect(() => checkCompactionMarkerConsistency(db)).not.toThrow();
    });

    it("clears persisted state when any referenced row is missing", () => {
        const dataHome = useTempDataHome("consistency-orphan-");
        const opencodeDb = createOpenCodeDb(dataHome);

        // Insert only 2 of the 4 referenced rows, simulating a half-written marker
        insertMessage(opencodeDb, "msg-boundary");
        insertPart(opencodeDb, "prt-compaction");
        // msg-summary and prt-summary-text are intentionally MISSING
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
        });

        checkCompactionMarkerConsistency(db);

        // Persisted state should now be cleared
        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        expect(row?.compaction_marker_state ?? "").toBe("");
    });

    it("preserves persisted state when all referenced rows are present", () => {
        const dataHome = useTempDataHome("consistency-healthy-");
        const opencodeDb = createOpenCodeDb(dataHome);

        // All 4 referenced rows exist
        insertMessage(opencodeDb, "msg-boundary");
        insertMessage(opencodeDb, "msg-summary");
        insertPart(opencodeDb, "prt-compaction");
        insertPart(opencodeDb, "prt-summary-text");
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
        });

        checkCompactionMarkerConsistency(db);

        // Persisted state should still be intact
        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        const parsed = JSON.parse(row?.compaction_marker_state ?? "{}");
        expect(parsed.boundaryMessageId).toBe("msg-boundary");
        expect(parsed.boundaryOrdinal).toBe(42);
    });

    it("reconciles multiple sessions in one pass", () => {
        const dataHome = useTempDataHome("consistency-multi-");
        const opencodeDb = createOpenCodeDb(dataHome);

        // Session 1: healthy, keep
        insertMessage(opencodeDb, "msg-boundary-1");
        insertMessage(opencodeDb, "msg-summary-1");
        insertPart(opencodeDb, "prt-compaction-1");
        insertPart(opencodeDb, "prt-summary-text-1");
        // Session 2: orphaned, clear
        // (no rows inserted for ses-2)
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary-1",
            summaryMessageId: "msg-summary-1",
            compactionPartId: "prt-compaction-1",
            summaryPartId: "prt-summary-text-1",
            boundaryOrdinal: 10,
        });
        setPersistedCompactionMarkerState(db, "ses-2", {
            boundaryMessageId: "msg-boundary-2",
            summaryMessageId: "msg-summary-2",
            compactionPartId: "prt-compaction-2",
            summaryPartId: "prt-summary-text-2",
            boundaryOrdinal: 20,
        });

        checkCompactionMarkerConsistency(db);

        const row1 = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        const row2 = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-2") as { compaction_marker_state?: string } | null;

        // ses-1 healthy → preserved
        const parsed1 = JSON.parse(row1?.compaction_marker_state ?? "{}");
        expect(parsed1.boundaryMessageId).toBe("msg-boundary-1");
        // ses-2 orphaned → cleared
        expect(row2?.compaction_marker_state ?? "").toBe("");
    });

    it("is idempotent — running twice produces the same result", () => {
        const dataHome = useTempDataHome("consistency-idempotent-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertMessage(opencodeDb, "msg-boundary");
        // Missing rows → marker is orphaned
        closeQuietly(opencodeDb);

        const db = openDatabase();
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-compaction",
            summaryPartId: "prt-summary-text",
            boundaryOrdinal: 42,
        });

        checkCompactionMarkerConsistency(db);
        checkCompactionMarkerConsistency(db); // second pass — no-op

        const row = db
            .prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id = ?")
            .get("ses-1") as { compaction_marker_state?: string } | null;
        expect(row?.compaction_marker_state ?? "").toBe("");
    });
});
