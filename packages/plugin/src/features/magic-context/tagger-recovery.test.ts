/// <reference types="bun-types" />

/**
 * Tagger collision-recovery and counter-drift tests.
 *
 * These exercise the real bun:sqlite-backed paths that the lighter mock-based
 * tagger.test.ts cannot reach: UNIQUE-constraint collisions, monotonic counter
 * upserts, initFromDb refresh on memory drift, and the migration v6 startup
 * heal that brings session_meta.counter back up to MAX(tag_number).
 *
 * The bug these protect against is the cache-bust cascade traced in the
 * v0.15.7 incident — once session_meta.counter dropped below the tags table's
 * actual max tag_number for any reason (outer-transaction rollback in the
 * legacy tagMessages, multi-process race, non-monotonic counter upsert), the
 * tagger could never self-heal and every transform pass that allocated a new
 * tag would either fail outright or fall into the throw-error recovery path,
 * which the transform's catch block then turned into a full message[0] rebuild.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { getMaxTagNumberBySession, getTagNumberByMessageId } from "./storage-tags";
import { createTagger } from "./tagger";

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/**
 * Open a file-backed test DB. Required for tests that need a SECOND
 * `Database` connection to the same file (e.g. cross-process WAL behavior),
 * since `:memory:` databases are private to one connection.
 */
function openFileBackedTestDb(filePath: string): DatabaseType {
    const db = new Database(filePath);
    db.exec("PRAGMA journal_mode = WAL");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function getCounter(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT counter FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { counter: number } | null | undefined;
    return row?.counter ?? 0;
}

describe("tagger collision recovery", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("recovers when memory counter is behind DB max for a different message", () => {
        //#given — simulate the v0.15.6 failure mode: a previous pass committed
        // tags up to 5 in DB but session_meta.counter is stuck at 2 (e.g. from
        // an outer-transaction rollback that undid the counter upsert while
        // inner SAVEPOINTs already committed the inserts).
        const sessionId = "session-drift";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        // Fake legacy state: bump tags table to 5 directly, leave counter at 2
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "legacy-msg-5", 5);
        // Force in-memory counter to be stale
        const fresh = createTagger();
        // Don't initFromDb — simulate not realizing the drift exists yet.
        // The first assignTag call should detect via the dbMax read and skip
        // ahead to 6 instead of trying 3 and colliding.

        //#when
        const newTag = fresh.assignTag(sessionId, "msg-new", "message", 100, db);

        //#then
        expect(newTag).toBe(6);
        expect(getCounter(db, sessionId)).toBe(6);
        expect(getMaxTagNumberBySession(db, sessionId)).toBe(6);
    });

    it("rebinds when a different writer raced this messageId to its own tag", () => {
        //#given — simulate a concurrent writer that just inserted a row for
        // our messageId before we got to it.
        const sessionId = "session-race";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-prior", "message", 100, db);
        // Concurrent writer claims tag 2 for "msg-raced" while our tagger is
        // about to allocate.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-raced", 2);
        // Our process didn't observe that insert in memory yet — counter is
        // still 1 in our tagger, so it would propose 2.

        //#when — assigning the raced message should rebind to the existing
        // tag rather than throw or duplicate.
        const racedTag = tagger.assignTag(sessionId, "msg-raced", "message", 100, db);

        //#then
        expect(racedTag).toBe(2);
        expect(tagger.getTag(sessionId, "msg-raced", "message")).toBe(2);
    });

    it("monotonic counter upsert never moves backward under concurrent writes", () => {
        //#given — two taggers that write counter values out of order.
        const sessionId = "session-monotonic";
        const taggerA = createTagger();
        const taggerB = createTagger();

        //#when — A allocates tag 5, then B (with a stale view) tries to
        // upsert the counter back to 3.
        taggerA.assignTag(sessionId, "msg-a-1", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-2", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-3", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-4", "message", 100, db);
        taggerA.assignTag(sessionId, "msg-a-5", "message", 100, db);
        expect(getCounter(db, sessionId)).toBe(5);
        // Force B to do a stale write: directly call the upsert SQL with a
        // smaller value, simulating B's in-memory counter being 3.
        db.prepare(
            "INSERT INTO session_meta (session_id, counter) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)",
        ).run(sessionId, 3);

        //#then — counter must still be 5, not 3.
        expect(getCounter(db, sessionId)).toBe(5);
        // And B's next allocation through assignTag picks up the live max.
        const nextFromB = taggerB.assignTag(sessionId, "msg-b-new", "message", 100, db);
        expect(nextFromB).toBe(6);
    });

    it("initFromDb refreshes from DB even when session is already known in memory", () => {
        //#given — tagger has already loaded counter 2 from DB.
        const sessionId = "session-refresh";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        expect(tagger.getCounter(sessionId)).toBe(2);

        // Another writer commits tags 3-5 (different messageIds) in DB.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-3", 3);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-4", 4);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-other-5", 5);

        //#when — initFromDb should refresh, not early-return based on
        // in-memory state.
        tagger.initFromDb(sessionId, db);

        //#then — counter is now at the live DB max, and assignments reflect
        // the new rows.
        expect(tagger.getCounter(sessionId)).toBe(5);
        expect(tagger.getTag(sessionId, "msg-other-3", "message")).toBe(3);
        expect(tagger.getTag(sessionId, "msg-other-5", "message")).toBe(5);
        // Next allocation goes to 6.
        const next = tagger.assignTag(sessionId, "msg-fresh", "message", 100, db);
        expect(next).toBe(6);
    });

    it("does not infinite-loop or wedge if collisions persist (capped retries)", () => {
        //#given — pathological case: pre-fill many tag numbers so the tagger
        // has to walk past several before finding a free slot.
        const sessionId = "session-walk";
        for (let n = 1; n <= 4; n++) {
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
            ).run(sessionId, `legacy-${n}`, n);
        }
        // counter still 0 — first attempt would propose 1 and collide.
        const tagger = createTagger();

        //#when
        const tag = tagger.assignTag(sessionId, "msg-new", "message", 100, db);

        //#then — retry loop walked past 1-4, allocated 5 cleanly.
        expect(tag).toBe(5);
    });
});

describe("getTagNumberByMessageId helper", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("returns the tag for a known messageId", () => {
        const sessionId = "s1";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-target", "message", 100, db);

        const tag = getTagNumberByMessageId(db, sessionId, "msg-target");
        expect(tag).toBe(1);
    });

    it("returns null for an unknown messageId", () => {
        expect(getTagNumberByMessageId(db, "s1", "msg-missing")).toBeNull();
    });

    it("scopes to the correct session", () => {
        const tagger = createTagger();
        tagger.assignTag("s1", "msg-shared", "message", 100, db);
        // Different session, same messageId — must not leak.
        expect(getTagNumberByMessageId(db, "s2", "msg-shared")).toBeNull();
    });
});

describe("migration v6 — counter heal", () => {
    it("heals divergent counters where MAX(tag_number) > session_meta.counter", () => {
        //#given — fresh DB, mark migrations v1-v5 as already applied (so v1
        // already created `notes`, allowing v7 to ALTER it later), then
        // build divergent state, then run migrations to apply v6 and v7.
        const db = new Database(":memory:");
        initializeDatabase(db);
        // v1 creates `notes`; we have to actually run that part for v7 to
        // succeed. Easiest path: run migrations once normally, then
        // delete v6's record so the heal logic is forced to run again on
        // the already-divergent state we'll build below.
        runMigrations(db);
        // Build a session with counter=2, max(tag_number)=5
        db.prepare(
            "INSERT INTO session_meta (session_id, counter, last_response_time, cache_ttl) VALUES (?, ?, 0, '5m')",
        ).run("s-divergent", 2);
        for (let n = 1; n <= 5; n++) {
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
            ).run("s-divergent", `msg-${n}`, n);
        }
        // And a session that's already in sync — must NOT be touched.
        db.prepare(
            "INSERT INTO session_meta (session_id, counter, last_response_time, cache_ttl) VALUES (?, ?, 0, '5m')",
        ).run("s-clean", 3);
        for (let n = 1; n <= 3; n++) {
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
            ).run("s-clean", `clean-${n}`, n);
        }
        // Run the v6 heal SQL directly. We can't trigger it via runMigrations
        // again because getCurrentVersion uses MAX(version), and v7 is
        // already applied — runMigrations would consider everything done.
        // What we're testing is that the SQL itself heals divergent state
        // correctly; the wiring (invocation on the v5→v6 schema upgrade) is
        // covered by runMigrations() running it once on fresh-DB setup.
        db.prepare(
            `UPDATE session_meta
             SET counter = (
                 SELECT MAX(tag_number)
                 FROM tags
                 WHERE tags.session_id = session_meta.session_id
             )
             WHERE EXISTS (
                 SELECT 1
                 FROM tags
                 WHERE tags.session_id = session_meta.session_id
                   AND tags.tag_number > session_meta.counter
             )`,
        ).run();

        //#then — divergent session is healed, clean session is unchanged.
        expect(getCounter(db, "s-divergent")).toBe(5);
        expect(getCounter(db, "s-clean")).toBe(3);
    });

    it("is idempotent on a fresh DB with no divergent sessions", () => {
        //#given — fresh DB, migrations applied.
        const db = openTestDb();

        //#when — running migrations again is a no-op.
        runMigrations(db);

        //#then — schema_migrations only has each version once.
        const v6Count = db
            .prepare("SELECT COUNT(*) as c FROM schema_migrations WHERE version = 6")
            .get() as { c: number };
        expect(v6Count.c).toBe(1);
    });
});

describe("initFromDb signature cache", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    /**
     * Cache hit on a pure-read pass: nothing has changed since the last
     * full reload, so initFromDb must NOT touch the assignments table.
     * We prove that by replacing the assignments-loading SQL prepare with
     * a spy that throws — if the cache is hit, the spy is never reached.
     */
    it("cache hit: skips full reload when data_version + total_changes are unchanged", () => {
        const sessionId = "s-cache-hit";
        const tagger = createTagger();

        // Allocate two tags to populate DB and signature.
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        // Force a full-reload signature record by calling initFromDb after
        // writes. assignTag's own writes bumped total_changes, so the next
        // initFromDb must run a full reload and record the post-write
        // signature.
        tagger.initFromDb(sessionId, db);
        // Capture the in-memory assignment count after the load.
        const beforeSize = tagger.getAssignments(sessionId).size;
        expect(beforeSize).toBe(2);

        //#when — second call with no DB writes between them. Must NOT
        // re-load. We prove this by verifying that explicitly clearing
        // the in-memory map mid-test (simulating a stale read) is NOT
        // restored by a subsequent cache-hit initFromDb.
        // (The cache hit returns early without rebuilding the map.)
        // First call already cached. Now: tamper with the in-memory map
        // to prove the cache IS being trusted.
        const sessionAssignmentsRef = tagger.getAssignments(sessionId) as Map<string, number>;
        sessionAssignmentsRef.delete("msg-1");
        expect(tagger.getAssignments(sessionId).size).toBe(1);

        // Second initFromDb — should be a cache hit and NOT rebuild.
        tagger.initFromDb(sessionId, db);

        //#then — the tampered map is unchanged because the reload was
        // skipped. (After ANY DB write, the cache would be invalidated
        // and a real reload would restore msg-1.)
        expect(tagger.getAssignments(sessionId).size).toBe(1);
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
    });

    it("cache miss: same-connection direct INSERT bumps total_changes and forces reload", () => {
        // This is the v0.15.7 critical case: a write committed via the
        // same Database object (e.g. by another subsystem on the same
        // connection, or by direct test code) must NOT be missed by the
        // cache. PRAGMA data_version does NOT bump for same-connection
        // commits, so we rely entirely on total_changes() here.
        const sessionId = "s-direct-insert";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.initFromDb(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(1);

        //#when — same-connection direct INSERT (the existing
        // "initFromDb refreshes from DB even when session is already
        // known in memory" test pattern).
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "msg-direct-2", 2);

        tagger.initFromDb(sessionId, db);

        //#then — full reload picked up the new row.
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getTag(sessionId, "msg-direct-2", "message")).toBe(2);
    });

    it("cache miss: a second Database connection bumps data_version and forces reload", () => {
        // Different mechanism: a SECOND open Database object commits a
        // row to the same file. PRAGMA data_version bumps for OTHER-
        // connection commits but NOT for our own. This proves the
        // data_version probe is wired correctly. Requires WAL + a real
        // file-backed DB because :memory: databases are private to one
        // connection.
        const tmpDir = mkdtempSync(join(tmpdir(), "magic-context-tagger-"));
        try {
            const dbPath = join(tmpDir, "ctx.db");
            const dbA = openFileBackedTestDb(dbPath);
            const dbB = new Database(dbPath);
            try {
                const sessionId = "s-second-conn";
                const tagger = createTagger();

                // Establish baseline through dbA.
                tagger.assignTag(sessionId, "msg-1", "message", 100, dbA);
                tagger.initFromDb(sessionId, dbA);
                expect(tagger.getCounter(sessionId)).toBe(1);

                //#when — second connection commits a row.
                dbB.prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
                ).run(sessionId, "msg-from-dbB", 2);

                // Tagger sees dbA only. initFromDb(sessionId, dbA) should
                // detect the data_version bump (dbA's pragma reflects
                // dbB's commit because they're separate connections to
                // the same DB file) and reload.
                tagger.initFromDb(sessionId, dbA);

                //#then — full reload picked up dbB's commit.
                expect(tagger.getCounter(sessionId)).toBe(2);
                expect(tagger.getTag(sessionId, "msg-from-dbB", "message")).toBe(2);
            } finally {
                dbB.close();
                dbA.close();
            }
        } finally {
            try {
                rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
    });

    it("per-session signature: session A reload does not falsely satisfy session B's cache check", () => {
        // The critical correctness test for per-session (vs global)
        // signature. Sketch from Oracle review:
        //   1. Both A and B have stale caches.
        //   2. A writes a tag — total_changes bumps for our connection.
        //   3. A reloads — A's signature now holds the new total_changes.
        //   4. B's next initFromDb compares its OWN signature (recorded
        //      before the bump) against the current value — they differ,
        //      so B reloads correctly.
        // If we used a global signature pair, step 4 could falsely
        // cache-hit because A's reload would have updated the global
        // signature to match.
        const tagger = createTagger();
        const sessionA = "s-A";
        const sessionB = "s-B";

        // Both sessions have their initial caches recorded.
        tagger.assignTag(sessionA, "a-msg-1", "message", 100, db);
        tagger.assignTag(sessionB, "b-msg-1", "message", 100, db);
        tagger.initFromDb(sessionA, db);
        tagger.initFromDb(sessionB, db);
        expect(tagger.getCounter(sessionA)).toBe(1);
        expect(tagger.getCounter(sessionB)).toBe(1);

        // Concurrent writer (different connection, simulated via direct
        // SQL on this connection — same effect: total_changes bumps).
        // Writes to BOTH sessions.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionA, "a-direct-2", 2);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionB, "b-direct-2", 2);

        //#when — A reloads first, then B reloads.
        tagger.initFromDb(sessionA, db);
        // After A's reload, the global-signature design would have
        // updated the shared signature to match the post-write values.
        // B's signature was recorded BEFORE the writes, so it's stale.
        // With per-session signatures, B's check still sees a mismatch
        // and reloads correctly. With a global signature, B would have
        // been incorrectly told "cache fresh" because A just refreshed it.
        tagger.initFromDb(sessionB, db);

        //#then — both sessions picked up their respective new rows.
        expect(tagger.getCounter(sessionA)).toBe(2);
        expect(tagger.getTag(sessionA, "a-direct-2", "message")).toBe(2);
        expect(tagger.getCounter(sessionB)).toBe(2);
        expect(tagger.getTag(sessionB, "b-direct-2", "message")).toBe(2);
    });

    it("outer-transaction rollback: cache MUST miss on next pass even though assignTag bumped total_changes inside the rolled-back outer txn", () => {
        // Oracle's reasoning for choosing option A (do NOT update signature
        // from assignTag): if assignTag's write happens inside a SAVEPOINT
        // that a caller-managed outer transaction later rolls back, the
        // SAVEPOINT's commits are undone and the row no longer exists in
        // the DB. If assignTag had updated the signature, the next pass
        // would falsely cache-hit against in-memory state that no longer
        // matches the DB.
        //
        // With option A (signature only updated from successful initFromDb
        // full reloads), the first initFromDb call in the next pass sees
        // the rolled-back state correctly: total_changes still bumped
        // (rollback doesn't decrement it), so the cache misses and we
        // reload, picking up the rolled-back state.
        const sessionId = "s-rollback";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-pre", "message", 100, db);
        tagger.initFromDb(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(1);

        //#when — assignTag inside a caller-managed outer transaction
        // that rolls back.
        try {
            db.transaction(() => {
                tagger.assignTag(sessionId, "msg-rollback", "message", 100, db);
                // Simulate caller deciding to abort the outer operation.
                throw new Error("simulated outer rollback");
            })();
        } catch (e) {
            expect((e as Error).message).toBe("simulated outer rollback");
        }

        // The DB row for msg-rollback is gone. But assignTag updated
        // the in-memory map and counter before the rollback, so the
        // in-memory state is now stale.
        const inMemoryAfterRollback = tagger.getTag(sessionId, "msg-rollback", "message");
        expect(inMemoryAfterRollback).toBeDefined();
        // DB shows the row is gone.
        expect(getMaxTagNumberBySession(db, sessionId)).toBe(1);

        //#when — next pass calls initFromDb. Cache MUST miss (because
        // total_changes bumped from the rolled-back work) and reload to
        // restore consistency between in-memory assignments and DB.
        tagger.initFromDb(sessionId, db);

        //#then — assignments map now matches DB (rollback erased
        // msg-rollback's tag row, full reload removed it from the map).
        // This is the property the cache must guarantee.
        //
        // Note: the in-memory counter stays at 2 by design — assignTag is
        // monotonic (preserves the highest seen value through the
        // Math.max in initFromDb's reconciliation step) even when the
        // underlying tag row was rolled back. That's intentional: it
        // ensures the next allocation picks an unused number rather than
        // immediately re-colliding with whoever ends up at tag 2 next.
        // The cache correctness property is about the assignments map,
        // not the counter.
        expect(tagger.getTag(sessionId, "msg-rollback", "message")).toBeUndefined();
    });

    it("resetCounter invalidates signature so next initFromDb forces full reload", () => {
        // resetCounter is called by /ctx-recomp full rebuild, which also
        // wipes the tags table for the session via separate code paths.
        // Here we simulate that whole workflow: reset counter, delete
        // tag rows, then re-populate. The test verifies that initFromDb
        // doesn't cache-hit against pre-reset state.
        const sessionId = "s-reset";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.assignTag(sessionId, "msg-2", "message", 100, db);
        tagger.initFromDb(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getAssignments(sessionId).size).toBe(2);

        //#when — full /ctx-recomp-style reset: drop tag rows, reset
        // counter, repopulate.
        db.prepare("DELETE FROM tags WHERE session_id = ?").run(sessionId);
        tagger.resetCounter(sessionId, db);
        expect(tagger.getCounter(sessionId)).toBe(0);
        // Recomp inserts the rebuilt tags.
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-1", 1);
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, 'message', 0, ?)",
        ).run(sessionId, "rebuilt-msg-2", 2);

        // initFromDb must not cache-hit against the pre-reset signature.
        // The deletion + insertion above also bumps total_changes, but the
        // explicit signature invalidation in resetCounter() is what
        // guarantees correctness even if those counters were somehow
        // unchanged (e.g. equal-volume swap on a different connection).
        tagger.initFromDb(sessionId, db);

        //#then — full reload picked up the rebuilt rows.
        expect(tagger.getCounter(sessionId)).toBe(2);
        expect(tagger.getTag(sessionId, "rebuilt-msg-1", "message")).toBe(1);
        expect(tagger.getTag(sessionId, "rebuilt-msg-2", "message")).toBe(2);
        // Old assignments are gone.
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBeUndefined();
        expect(tagger.getTag(sessionId, "msg-2", "message")).toBeUndefined();
    });

    it("cleanup invalidates signature so a re-loaded session does a full reload", () => {
        const sessionId = "s-cleanup";
        const tagger = createTagger();
        tagger.assignTag(sessionId, "msg-1", "message", 100, db);
        tagger.initFromDb(sessionId, db);

        //#when — session is cleaned up (e.g. session.deleted lifecycle),
        // then later something tries to load it again.
        tagger.cleanup(sessionId);
        expect(tagger.getCounter(sessionId)).toBe(0);
        expect(tagger.getAssignments(sessionId).size).toBe(0);

        // Subsequent initFromDb must do a full reload to repopulate
        // memory from disk, NOT cache-hit against the pre-cleanup
        // signature.
        tagger.initFromDb(sessionId, db);

        //#then — counter and assignments restored from DB.
        expect(tagger.getCounter(sessionId)).toBe(1);
        expect(tagger.getTag(sessionId, "msg-1", "message")).toBe(1);
    });
});
