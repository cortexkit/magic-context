/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionHandler } from "../../features/magic-context/compaction";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createEventHandler } from "./event-handler";
import { clearHostCompactionGapState, restoreHostCompactionGap } from "./host-compaction-gap";
import { findHostCompactionWindow } from "./inject-compartments";
import { readHostMessageRangeFromDb, readHostMessagesByIdFromDb } from "./read-session-raw";
import { cleanupRemovedMessageState } from "./removed-message-cleanup";
import { type MessageLike, tagMessages } from "./tag-messages";

/**
 * The restored range through the real tagging path: a row the host deletes while
 * it is served must be re-served with the same §N§ tags, in the same process and
 * after a restart, until a pass already known to bust takes it out of the range.
 */

const SESSION = "ses-gap-tagging";

/** OpenCode 1's store: u1 a1 | u2 a2 u3 a3 | u4 a4 | req sum | u5, boundary a1. */
function createStore(): Database {
    const store = new Database(":memory:");
    store.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    let clock = 0;
    const add = (id: string, info: Record<string, unknown>, parts: Record<string, unknown>[]) => {
        clock += 10;
        store
            .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
            .run(id, SESSION, clock, clock, JSON.stringify(info));
        parts.forEach((part, index) => {
            store
                .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
                .run(`p-${id}-${index}`, id, SESSION, clock, clock, JSON.stringify(part));
        });
    };
    for (const turn of [1, 2, 3, 4]) {
        add(`u${turn}`, { role: "user" }, [{ type: "text", text: `turn ${turn}` }]);
        add(`a${turn}`, { role: "assistant", parentID: `u${turn}`, finish: "stop" }, [
            { type: "text", text: `reply ${turn}` },
        ]);
    }
    add("req", { role: "user" }, [{ type: "compaction", auto: false, tail_start_id: "u4" }]);
    add(
        "sum",
        {
            role: "assistant",
            parentID: "req",
            summary: true,
            finish: "stop",
            time: { completed: 1 },
        },
        [{ type: "text", text: "host summary" }],
    );
    add("u5", { role: "user" }, [{ type: "text", text: "turn 5" }]);
    return store;
}

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let store: Database;

beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "gap-tagging-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    clearHostCompactionGapState();
    store = createStore();
});

afterEach(() => {
    clearHostCompactionGapState();
    closeQuietly(store);
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What OpenCode 1 loads after the compaction: [req, sum, retained tail, newer rows]. */
function hostWindow(): MessageLike[] {
    const byId = readHostMessagesByIdFromDb(store, SESSION, ["req", "sum", "u4", "a4", "u5"]);
    return ["req", "sum", "u4", "a4", "u5"].map((id) => byId.get(id) as unknown as MessageLike);
}

/** One pass: restore, then tag exactly as the transform does. Returns the served bytes. */
function servePass(
    tagger: ReturnType<typeof createTagger>,
    options: { refreshAllowed?: boolean } = {},
) {
    const db = openDatabase();
    getOrCreateSessionMeta(db, SESSION);
    const messages = hostWindow();
    const window = findHostCompactionWindow(messages, () => null);
    if (!window) throw new Error("no compaction pair");
    const outcome = restoreHostCompactionGap({
        db,
        sessionId: SESSION,
        messages,
        window,
        lower: { afterId: "a1" },
        refreshAllowed: options.refreshAllowed ?? false,
        budgetTokens: 1_000_000,
        readRange: (afterId, beforeId, maxRows) =>
            readHostMessageRangeFromDb(store, SESSION, afterId, beforeId, maxRows),
        readById: (ids) => readHostMessagesByIdFromDb(store, SESSION, ids),
        compareOrder: () => -1,
    });
    for (const messageId of outcome.rowsLeftRange) {
        cleanupRemovedMessageState(db, SESSION, messageId);
    }
    if (outcome.rowsLeftRange.length > 0) tagger.cleanup(SESSION);
    tagger.initFromDb(SESSION, db, 0);
    tagMessages(SESSION, messages, tagger, db).batch.finalize();
    return { bytes: JSON.stringify(messages), outcome, messages };
}

async function removeThroughHost(tagger: ReturnType<typeof createTagger>, restoreOn: boolean) {
    store.prepare("DELETE FROM part WHERE message_id = 'a2'").run();
    store.prepare("DELETE FROM message WHERE id = 'a2'").run();
    const handler = createEventHandler({
        contextUsageMap: new Map(),
        compactionHandler: createCompactionHandler(),
        config: { cache_ttl: "5m" },
        tagger,
        db: openDatabase(),
        hostCompactionGapRestore: restoreOn,
    });
    await handler({
        event: { type: "message.removed", properties: { sessionID: SESSION, messageID: "a2" } },
    });
}

const tagsOf = (messageId: string) =>
    getTagsBySession(openDatabase(), SESSION).filter((tag) => tag.messageId.startsWith(messageId));

describe("a served row the host removes, through the real tagging path", () => {
    it("keeps the served bytes, tags included, on the next pass and after a restart", async () => {
        const tagger = createTagger();
        const first = servePass(tagger);
        expect(first.bytes).toContain("reply 2");
        expect(first.bytes).toMatch(/§\d+§ reply 2/);
        const tagsBefore = tagsOf("a2").map((tag) => tag.tagNumber);
        expect(tagsBefore.length).toBeGreaterThan(0);

        await removeThroughHost(tagger, true);
        expect(tagsOf("a2").map((tag) => tag.tagNumber)).toEqual(tagsBefore);
        expect(servePass(tagger).bytes).toBe(first.bytes);

        // A new process: nothing in memory, a new tagger.
        clearHostCompactionGapState();
        expect(servePass(createTagger()).bytes).toBe(first.bytes);

        // A pass already known to bust takes the row out, and its tags go with it.
        const busting = servePass(createTagger(), { refreshAllowed: true });
        expect(busting.outcome.rowsLeftRange).toEqual(["a2"]);
        expect(busting.bytes).not.toContain("reply 2");
        expect(tagsOf("a2")).toEqual([]);
    });

    it("changes the served bytes when the removal cleans the row's tags at once", async () => {
        // The failure the hold prevents: the row's tags are deleted on removal, so the
        // replayed row is tagged again with new numbers.
        const tagger = createTagger();
        const first = servePass(tagger);
        await removeThroughHost(tagger, false);
        expect(tagsOf("a2")).toEqual([]);
        expect(servePass(tagger).bytes).not.toBe(first.bytes);
    });
});
