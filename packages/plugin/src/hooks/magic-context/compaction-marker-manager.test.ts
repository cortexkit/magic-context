/// <reference types="bun-types" />

/**
 * Tests for `applyDeferredCompactionMarker` (plan v6 §5).
 *
 * These cover the validation + outcome surface end-to-end against a real
 * OpenCode DB harness (same pattern as compaction-marker-consistency.test.ts):
 *
 *   - applied happy path (no existing marker, validation passes)
 *   - already-current when persisted marker is at the pending ordinal
 *   - stale-skip / compartment-removed when the raw OC message is gone
 *   - stale-skip / compartment-removed when the local compartment row is gone
 *   - stale-skip / target-superseded when the compartment ordinal advanced
 *   - retryable-failure when DB access throws
 *
 * The remove→inject sequencing for the boundary-advance case is exercised
 * indirectly via the "applied" path: when there's no existing marker, we
 * verify inject succeeded. The "retryable on inject null" is covered by
 * deleting the boundary message after validation but before inject can
 * find a target.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { applyDeferredCompactionMarker } from "./compaction-marker-manager";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
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

function insertUserMessage(db: Database, id: string, sessionId: string, timeCreated: number): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify({ role: "user" }));
}

function makePending(overrides: Partial<PendingCompactionMarker> = {}): PendingCompactionMarker {
    return {
        ordinal: 10,
        endMessageId: "msg-boundary",
        publishedAt: Date.now(),
        ...overrides,
    };
}

function insertCompartment(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    ordinal: number,
    endMessageId: string,
): void {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: ordinal,
            startMessageId: `msg-${1}`,
            endMessageId,
            title: "test compartment",
            content: "test content",
        },
    ]);
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("applyDeferredCompactionMarker — outcomes", () => {
    it("returns `applied` on the happy path (no existing marker)", () => {
        const dataHome = useTempDataHome("apply-deferred-applied-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        // Seed session_meta row so the manager can write boundary state into it.
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("applied");
        if (outcome.kind === "applied") {
            expect(outcome.markerOrdinal).toBe(10);
        }
        // Persisted marker state should now hold the new boundary.
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).not.toBeNull();
        expect(persisted?.boundaryOrdinal).toBe(10);
    });

    it("returns `already-current` when persisted boundary >= pending ordinal", () => {
        const dataHome = useTempDataHome("apply-deferred-current-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");
        // Persist an existing marker AT the pending ordinal.
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-other",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-comp",
            summaryPartId: "prt-summary",
            boundaryOrdinal: 10,
        });

        const outcome = applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("already-current");
        // Persisted state untouched (no remove/re-inject)
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted?.boundaryMessageId).toBe("msg-other");
    });

    it("returns `stale-skip / compartment-removed` when raw OpenCode message is gone", () => {
        const dataHome = useTempDataHome("apply-deferred-msg-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // Intentionally do NOT insert msg-boundary — simulates revert/cleanup
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / compartment-removed` when local compartment row is gone", () => {
        const dataHome = useTempDataHome("apply-deferred-compart-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // No compartment inserted — simulates a recomp that wiped local state
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / target-superseded` when compartment ordinal advanced past pending", () => {
        const dataHome = useTempDataHome("apply-deferred-superseded-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // Compartment ends at endMessageId "msg-boundary" but at ordinal 20
        // (different from the pending blob's ordinal of 10). This simulates
        // a later partial-recomp resequencing the same boundary message id
        // to a different ordinal.
        insertCompartment(db, "ses-1", 20, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("target-superseded");
        }
    });

    it("returns `retryable-failure` when injectCompactionMarker cannot find a boundary message", () => {
        // Trigger this by giving the validator a compartment that points to a
        // raw msg with NO user role / no time_created < boundary — but with
        // the boundary message itself missing AFTER validation. Easier path:
        // insert msg-boundary so validation passes, then close+reopen OC DB
        // with WAL handles in a state that makes findBoundaryUserMessage fail.
        //
        // Concretely: the simplest reproducer is a session row in OpenCode
        // with the boundary message but no preceding user messages — the
        // marker injector needs a user message AT or BEFORE the boundary to
        // anchor the compaction part. We insert only the boundary as a
        // non-user message (assistant role) so findBoundaryUserMessage
        // returns null and inject returns null, mapping to retryable-failure.
        const dataHome = useTempDataHome("apply-deferred-retryable-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // Insert msg-boundary as an ASSISTANT message — passes validation
        // (getOpenCodeMessageById only checks existence) but the marker
        // injector requires a user-role boundary anchor, so inject returns null.
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run("msg-boundary", "ses-1", 1_000, 1_000, JSON.stringify({ role: "assistant" }));
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        // No user message exists at or before the boundary → inject returns
        // null → retryable-failure.
        expect(outcome.kind).toBe("retryable-failure");
        // Persisted state remains absent (we never wrote a marker)
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).toBeNull();
    });

    it("returns `retryable-failure` on raw OpenCode DB access errors", () => {
        // Don't create the opencode dir at all — this makes the writable
        // OpenCode DB handle fail to open, which throws inside
        // getOpenCodeMessageById and trips the outer try/catch.
        const dataHome = mkdtempSync(join(tmpdir(), "apply-deferred-db-err-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "cortexkit", "magic-context"), { recursive: true });
        // No opencode/ subdir created.

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("retryable-failure");
    });
});
