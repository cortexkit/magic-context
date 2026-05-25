import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "./storage";
import {
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    getSessionsWithPendingMarker,
    type PendingCompactionMarker,
    setPendingCompactionMarkerState,
} from "./storage-meta-persisted";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
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

describe("migration v13 — pending_compaction_marker_state schema", () => {
    test("fresh database has pending_compaction_marker_state column", () => {
        useTempDataHome("v13-fresh-");
        const db = openDatabase();
        const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
            dflt_value: unknown;
        }>;
        const found = cols.find((c) => c.name === "pending_compaction_marker_state");
        expect(found).toBeDefined();
        // Plan v6 §3: column must NOT have a DEFAULT clause. Absence is SQL NULL.
        // (Bun's PRAGMA returns null for "no default"; verify it's not the empty string.)
        expect(found?.dflt_value).not.toBe("''");
    });

    test("new sessions get SQL NULL, not empty string, by default", () => {
        useTempDataHome("v13-null-default-");
        const db = openDatabase();
        db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-1')").run();
        const row = db
            .prepare(
                "SELECT pending_compaction_marker_state FROM session_meta WHERE session_id = ?",
            )
            .get("ses-1") as { pending_compaction_marker_state: string | null };
        expect(row.pending_compaction_marker_state).toBeNull();
    });

    test("getPendingCompactionMarkerState returns null when unset", () => {
        useTempDataHome("v13-get-empty-");
        const db = openDatabase();
        expect(getPendingCompactionMarkerState(db, "ses-empty")).toBeNull();
    });

    test("set / get round-trip with stable JSON shape", () => {
        useTempDataHome("v13-rw-");
        const db = openDatabase();
        const payload: PendingCompactionMarker = {
            ordinal: 1234,
            endMessageId: "msg-boundary-abc",
            publishedAt: 1_700_000_000_000,
        };
        setPendingCompactionMarkerState(db, "ses-rw", payload);
        const got = getPendingCompactionMarkerState(db, "ses-rw");
        expect(got).toEqual(payload);
    });

    test("setPendingCompactionMarkerState(null) writes SQL NULL not empty string", () => {
        useTempDataHome("v13-clear-null-");
        const db = openDatabase();
        const payload: PendingCompactionMarker = {
            ordinal: 1,
            endMessageId: "m",
            publishedAt: 1,
        };
        setPendingCompactionMarkerState(db, "ses-clear", payload);
        setPendingCompactionMarkerState(db, "ses-clear", null);
        const row = db
            .prepare(
                "SELECT pending_compaction_marker_state FROM session_meta WHERE session_id = ?",
            )
            .get("ses-clear") as { pending_compaction_marker_state: string | null };
        expect(row.pending_compaction_marker_state).toBeNull();
        expect(getPendingCompactionMarkerState(db, "ses-clear")).toBeNull();
    });

    test("getter treats stored empty string as absent (legacy / external write)", () => {
        useTempDataHome("v13-empty-treated-null-");
        const db = openDatabase();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_compaction_marker_state) VALUES ('ses-e', '')",
        ).run();
        expect(getPendingCompactionMarkerState(db, "ses-e")).toBeNull();
    });

    test("getter treats corrupt JSON as absent", () => {
        useTempDataHome("v13-corrupt-");
        const db = openDatabase();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_compaction_marker_state) VALUES ('ses-c', 'not-json')",
        ).run();
        expect(getPendingCompactionMarkerState(db, "ses-c")).toBeNull();
    });

    test("getter rejects malformed payload (missing field)", () => {
        useTempDataHome("v13-malformed-");
        const db = openDatabase();
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_compaction_marker_state) VALUES ('ses-m', '{\"ordinal\": 1}')",
        ).run();
        expect(getPendingCompactionMarkerState(db, "ses-m")).toBeNull();
    });

    test("CAS clear succeeds when blob matches", () => {
        useTempDataHome("v13-cas-ok-");
        const db = openDatabase();
        const payload: PendingCompactionMarker = {
            ordinal: 1,
            endMessageId: "m",
            publishedAt: 1,
        };
        setPendingCompactionMarkerState(db, "ses-cas", payload);
        const cleared = clearPendingCompactionMarkerStateIf(db, "ses-cas", payload);
        expect(cleared).toBe(true);
        expect(getPendingCompactionMarkerState(db, "ses-cas")).toBeNull();
    });

    test("CAS clear is no-op when expected payload doesn't match current", () => {
        useTempDataHome("v13-cas-mismatch-");
        const db = openDatabase();
        const original: PendingCompactionMarker = {
            ordinal: 1,
            endMessageId: "m1",
            publishedAt: 100,
        };
        const stale: PendingCompactionMarker = {
            ordinal: 2,
            endMessageId: "m2",
            publishedAt: 200,
        };
        setPendingCompactionMarkerState(db, "ses-mis", original);
        const cleared = clearPendingCompactionMarkerStateIf(db, "ses-mis", stale);
        expect(cleared).toBe(false);
        // Original payload still in place
        expect(getPendingCompactionMarkerState(db, "ses-mis")).toEqual(original);
    });

    test("getSessionsWithPendingMarker filters NULL and empty strings", () => {
        useTempDataHome("v13-list-");
        const db = openDatabase();
        // Session with valid pending
        setPendingCompactionMarkerState(db, "ses-with", {
            ordinal: 1,
            endMessageId: "m",
            publishedAt: 1,
        });
        // Session with NULL (default state)
        db.prepare("INSERT INTO session_meta (session_id) VALUES ('ses-null')").run();
        // Session with legacy empty string
        db.prepare(
            "INSERT INTO session_meta (session_id, pending_compaction_marker_state) VALUES ('ses-empty', '')",
        ).run();

        const sessions = getSessionsWithPendingMarker(db);
        expect(sessions).toEqual(["ses-with"]);
    });

    test("blob is canonical under stableStringify (key order doesn't break CAS)", () => {
        useTempDataHome("v13-cas-canon-");
        const db = openDatabase();
        // Write with one key order
        setPendingCompactionMarkerState(db, "ses-canon", {
            ordinal: 5,
            endMessageId: "m",
            publishedAt: 1,
        });
        // CAS with a different object literal that has the same content but
        // different key order — stableStringify normalizes both → CAS succeeds.
        const cleared = clearPendingCompactionMarkerStateIf(db, "ses-canon", {
            publishedAt: 1,
            endMessageId: "m",
            ordinal: 5,
        });
        expect(cleared).toBe(true);
    });
});
