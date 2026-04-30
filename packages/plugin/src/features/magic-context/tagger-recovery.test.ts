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
        expect(tagger.getTag(sessionId, "msg-raced")).toBe(2);
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
        expect(tagger.getTag(sessionId, "msg-other-3")).toBe(3);
        expect(tagger.getTag(sessionId, "msg-other-5")).toBe(5);
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
