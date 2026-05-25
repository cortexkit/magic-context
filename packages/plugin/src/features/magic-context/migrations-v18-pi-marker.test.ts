import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";
import {
    clearPendingPiCompactionMarkerStateIf,
    getPendingPiCompactionMarkerState,
    getSessionsWithPendingPiMarker,
    type PendingPiCompactionMarker,
    setPendingPiCompactionMarkerState,
} from "./storage-meta-persisted";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

function payload(overrides: Partial<PendingPiCompactionMarker> = {}): PendingPiCompactionMarker {
    return {
        firstKeptEntryId: "entry-3",
        endMessageId: "msg-2",
        ordinal: 2,
        tokensBefore: 123,
        summary: "Magic Context compacted: slice",
        publishedAt: 1_700_000_000_000,
        ...overrides,
    };
}

describe("migration v18 — pending_pi_compaction_marker_state schema", () => {
    test("fresh database has nullable pending_pi_compaction_marker_state column", () => {
        useTempDataHome("v18-pi-fresh-");
        const db = openDatabase();
        const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
            dflt_value: unknown;
        }>;
        const found = cols.find((c) => c.name === "pending_pi_compaction_marker_state");
        expect(found).toBeDefined();
        expect(found?.dflt_value).not.toBe("''");
    });

    test("new sessions get SQL NULL, not empty string, by default", () => {
        useTempDataHome("v18-pi-null-");
        const db = openDatabase();
        db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-1')").run();
        const row = db
            .prepare(
                "SELECT pending_pi_compaction_marker_state FROM session_meta WHERE session_id = ?",
            )
            .get("ses-1") as { pending_pi_compaction_marker_state: string | null };
        expect(row.pending_pi_compaction_marker_state).toBeNull();
    });

    test("set / get round-trip with full Pi marker payload", () => {
        useTempDataHome("v18-pi-rw-");
        const db = openDatabase();
        const value = payload();
        setPendingPiCompactionMarkerState(db, "ses-rw", value);
        expect(getPendingPiCompactionMarkerState(db, "ses-rw")).toEqual(value);
    });

    test("set null writes SQL NULL and getter treats empty/corrupt/malformed as absent", () => {
        useTempDataHome("v18-pi-absent-");
        const db = openDatabase();
        setPendingPiCompactionMarkerState(db, "ses-clear", payload());
        setPendingPiCompactionMarkerState(db, "ses-clear", null);
        expect(getPendingPiCompactionMarkerState(db, "ses-clear")).toBeNull();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_pi_compaction_marker_state) VALUES ('ses-empty', '')",
        ).run();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_pi_compaction_marker_state) VALUES ('ses-corrupt', 'not-json')",
        ).run();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_pi_compaction_marker_state) VALUES ('ses-bad', '{\"ordinal\": 2}')",
        ).run();
        expect(getPendingPiCompactionMarkerState(db, "ses-empty")).toBeNull();
        expect(getPendingPiCompactionMarkerState(db, "ses-corrupt")).toBeNull();
        expect(getPendingPiCompactionMarkerState(db, "ses-bad")).toBeNull();
        expect(getSessionsWithPendingPiMarker(db)).toEqual([]);
    });

    test("CAS clear and pending-session list use the canonical blob", () => {
        useTempDataHome("v18-pi-cas-");
        const db = openDatabase();
        const original = payload();
        setPendingPiCompactionMarkerState(db, "ses-with", original);
        db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-null')").run();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_pi_compaction_marker_state) VALUES ('ses-empty', '')",
        ).run();
        expect(getSessionsWithPendingPiMarker(db)).toEqual(["ses-with"]);
        expect(clearPendingPiCompactionMarkerStateIf(db, "ses-with", payload({ ordinal: 3 }))).toBe(
            false,
        );
        expect(getPendingPiCompactionMarkerState(db, "ses-with")).toEqual(original);
        expect(clearPendingPiCompactionMarkerStateIf(db, "ses-with", { ...original })).toBe(true);
        expect(getPendingPiCompactionMarkerState(db, "ses-with")).toBeNull();
    });
});
