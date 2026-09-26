/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionHandler } from "../../features/magic-context/compaction";
import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import {
    closeDatabase,
    getDatabasePath,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createEventHandler } from "./event-handler";
import {
    clearHostCompactionGapState,
    type HostCompactionGapOutcome,
    hostCompactionGapBudgetTokens,
    markHostCompactionTagsKept,
    restoreHostCompactionGap,
    settleHostCompactionTags,
} from "./host-compaction-gap";
import { findHostCompactionWindow } from "./inject-compartments";
import { readHostMessageRangeFromDb, readHostMessagesByIdFromDb } from "./read-session-raw";
import { cleanupRemovedMessageState } from "./removed-message-cleanup";
import { type MessageLike, tagMessages } from "./tag-messages";

/**
 * Second adversarial gate on the rows restored after a native OpenCode 1 `/compact`.
 * Each test states the cache property it expects. The ones marked `it.failing` are
 * findings: the property does not hold on the code under review, so the suite stays
 * green while they fail. Once the property holds, bun reports them as failures;
 * turn them back into plain `it` then.
 *
 * Store: u1 a1 | u2 a2 u3 a3 | u4 a4 | req sum | u5, Magic Context boundary a1,
 * retained tail from u4, so u2..a3 are restored.
 */

const SESSION = "ses-gap-gate2";

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
            { type: "text", text: `reply ${turn} ${"x".repeat(400)}` },
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
    const dir = mkdtempSync(join(tmpdir(), "gap-gate2-"));
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

function hostWindow(): MessageLike[] {
    const byId = readHostMessagesByIdFromDb(store, SESSION, ["req", "sum", "u4", "a4", "u5"]);
    return ["req", "sum", "u4", "a4", "u5"].map((id) => byId.get(id) as unknown as MessageLike);
}

/** One pass: restore, clean rows that left the range, then tag as the transform does. */
function servePass(
    tagger: ReturnType<typeof createTagger>,
    options: { refreshAllowed?: boolean; budgetTokens?: number } = {},
): { bytes: string; outcome: HostCompactionGapOutcome } {
    const db = openDatabase() as NonNullable<ReturnType<typeof openDatabase>>;
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
        budgetTokens: options.budgetTokens ?? 1_000_000,
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
    return { bytes: JSON.stringify(messages), outcome };
}

function eventHandler(tagger: ReturnType<typeof createTagger>) {
    return createEventHandler({
        contextUsageMap: new Map(),
        compactionHandler: createCompactionHandler(),
        config: { cache_ttl: "5m" },
        tagger,
        db: openDatabase() as NonNullable<ReturnType<typeof openDatabase>>,
        hostCompactionGapRestore: true,
    });
}

async function removeA2ThroughHost(tagger: ReturnType<typeof createTagger>): Promise<void> {
    store.prepare("DELETE FROM part WHERE message_id = 'a2'").run();
    store.prepare("DELETE FROM message WHERE id = 'a2'").run();
    await eventHandler(tagger)({
        event: { type: "message.removed", properties: { sessionID: SESSION, messageID: "a2" } },
    });
}

async function editU3ThroughHost(tagger: ReturnType<typeof createTagger>): Promise<void> {
    const part = {
        id: "p-u3-0",
        sessionID: SESSION,
        messageID: "u3",
        type: "text",
        text: "EDITED",
    };
    store
        .prepare("UPDATE part SET data = ? WHERE id = 'p-u3-0'")
        .run(JSON.stringify({ type: "text", text: "EDITED" }));
    await eventHandler(tagger)({
        event: { type: "message.part.updated", properties: { part } },
    });
}

describe("a store change after a restart, before the new process's first pass", () => {
    it.failing("a served row the host removes then: the first (defer) pass replays the served bytes", async () => {
        const first = servePass(createTagger());
        expect(first.bytes).toContain("reply 2");
        // The process restarts; the host removes a served row before any pass runs.
        clearHostCompactionGapState();
        const tagger = createTagger();
        await removeA2ThroughHost(tagger);
        const next = servePass(tagger);
        console.log(`GATE2 restart+remove source=${(next.outcome as { source?: string }).source}`);
        expect(next.bytes).toBe(first.bytes);
    });

    it("a served row the host edits then: the first (defer) pass replays the served bytes", async () => {
        const first = servePass(createTagger());
        clearHostCompactionGapState();
        const tagger = createTagger();
        await editU3ThroughHost(tagger);
        const next = servePass(tagger);
        // The restore reads the store on this defer pass (source "store") and hands
        // the edited text to tagging; the served bytes still match because tagging
        // re-serves the text it recorded for the already-tagged part. A removal has
        // no such second line of defence (see the test above).
        expect(next.outcome).toMatchObject({ source: "store" });
        expect(next.bytes).toBe(first.bytes);
    });

    it("control: the same edit while the process that served the row is alive replays", async () => {
        const tagger = createTagger();
        const first = servePass(tagger);
        await editU3ThroughHost(tagger);
        expect(servePass(tagger).bytes).toBe(first.bytes);
        clearHostCompactionGapState();
        expect(servePass(createTagger()).bytes).toBe(first.bytes);
    });
});

describe("a fallback after the rows were restored", () => {
    it.failing("a too-large verdict on a busting pass stays off the wire on the defer passes after a restart with a store change", async () => {
        const tagger = createTagger();
        const db = openDatabase() as NonNullable<ReturnType<typeof openDatabase>>;
        getOrCreateSessionMeta(db, SESSION);
        markHostCompactionTagsKept(db, SESSION);
        const first = servePass(tagger);
        expect(first.outcome.status).toBe("restored");
        expect(settleHostCompactionTags(db, SESSION, first.outcome)).toBe("kept");
        const tokens = (first.outcome as { tokens: number }).tokens;
        const restoredTags = getTagsBySession(db, SESSION).filter((tag) =>
            ["u2", "a2", "u3", "a3"].some((id) => tag.messageId.startsWith(id)),
        );
        expect(restoredTags.length).toBeGreaterThan(0);

        // A busting pass whose verdict is now "too large" (same budget on every pass
        // after this): the rows leave the wire on a pass that busts anyway.
        const busting = servePass(tagger, { refreshAllowed: true, budgetTokens: tokens - 1 });
        expect(busting.outcome.status).toBe("fallback");
        const fallbackBytes = busting.bytes;
        const stillActive = getTagsBySession(db, SESSION).filter(
            (tag) =>
                ["u2", "a2", "u3", "a3"].some((id) => tag.messageId.startsWith(id)) &&
                tag.status === "active",
        );
        console.log(
            `GATE2 fallback-after-restore: ${stillActive.length} tags of rows now off the wire stay active`,
        );
        expect(servePass(tagger, { budgetTokens: tokens - 1 }).bytes).toBe(fallbackBytes);

        // Restart, and the host removes a row of the (unserved) range: the range now
        // fits the budget.
        clearHostCompactionGapState();
        const restarted = createTagger();
        await removeA2ThroughHost(restarted);
        const deferAfterRestart = servePass(restarted, { budgetTokens: tokens - 1 });
        console.log(
            `GATE2 fallback-after-restore restart status=${deferAfterRestart.outcome.status}`,
        );
        expect(deferAfterRestart.bytes).toBe(fallbackBytes);
    });
});

describe("the JSON root shared with the tokenizer calibration", () => {
    it.failing("a calibration adoption does not lose a gap record written by another connection between its read and its write", () => {
        const db = openDatabase() as NonNullable<ReturnType<typeof openDatabase>>;
        getOrCreateSessionMeta(db, SESSION);
        const path = getDatabasePath(db) as string;
        // A second process's connection: records the served range while the first
        // process is between reading the root and writing it back.
        const other = new Database(path);
        other.exec("PRAGMA busy_timeout = 2000");
        let interleaved = false;
        const racing = new Proxy(db, {
            get(target, property) {
                if (property === "prepare") {
                    return (sql: string) => {
                        if (
                            !interleaved &&
                            sql.startsWith("UPDATE session_meta SET deferred_execute_state")
                        ) {
                            interleaved = true;
                            markHostCompactionTagsKept(other, SESSION);
                        }
                        return target.prepare(sql);
                    };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        sessionDecisionCalibration(racing as typeof db, SESSION, {
            bustPermitted: true,
            modelKey: "anthropic/claude-sonnet-4-5",
        });
        other.close();
        expect(interleaved).toBe(true);
        const root = JSON.parse(
            (
                db
                    .prepare(
                        "SELECT deferred_execute_state AS s FROM session_meta WHERE session_id = ?",
                    )
                    .get(SESSION) as { s: string }
            ).s,
        ) as Record<string, unknown>;
        console.log(`GATE2 shared-root keys after the race: ${JSON.stringify(Object.keys(root))}`);
        expect(Object.keys(root).sort()).toEqual([
            "magicContextHostCompactionGap",
            "magicContextTokenizerCalibration",
        ]);
    });

    it("measures the per-pass calibration read with the largest recorded range", () => {
        const db = openDatabase() as NonNullable<ReturnType<typeof openDatabase>>;
        getOrCreateSessionMeta(db, SESSION);
        // The most a served range may carry: a 1M-token model at a 65% execute
        // threshold. Worst case, every served row was edited, so all of its bytes
        // are recorded.
        const budget = hostCompactionGapBudgetTokens(1_000_000, 65);
        const rows = 2_000;
        const perRowChars = Math.floor((budget * 4) / rows);
        const preserved: Record<string, unknown> = {};
        const rowIds: string[] = [];
        for (let index = 0; index < rows; index++) {
            const id = `msg_${String(index).padStart(6, "0")}`;
            rowIds.push(id);
            preserved[id] = {
                info: { id, role: "assistant", sessionID: SESSION },
                parts: [{ id: `prt_${index}`, type: "text", text: "y".repeat(perRowChars) }],
            };
        }
        const root = {
            magicContextHostCompactionGap: {
                range: {
                    compactionMessageId: "req",
                    tailStartId: "u4",
                    lowerId: "a1",
                    rowIds,
                    digest: "0",
                    tokens: budget,
                    served: true,
                    preserved,
                    removed: [],
                },
            },
        };
        const json = JSON.stringify(root);
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            json,
            SESSION,
        );
        sessionDecisionCalibration(db, SESSION, { bustPermitted: true, modelKey: "anthropic/x" });
        const runs = 20;
        const started = performance.now();
        for (let index = 0; index < runs; index++) sessionDecisionCalibration(db, SESSION);
        const perPass = (performance.now() - started) / runs;
        const emptyStarted = performance.now();
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify({ magicContextTokenizerCalibration: {} }),
            SESSION,
        );
        for (let index = 0; index < runs; index++) sessionDecisionCalibration(db, SESSION);
        const perPassEmpty = (performance.now() - emptyStarted) / runs;
        console.log(
            `GATE2 cost budget=${budget} tokens root=${(json.length / 1_048_576).toFixed(1)} MiB per-pass calibration read=${perPass.toFixed(2)} ms (empty root ${perPassEmpty.toFixed(3)} ms)`,
        );
        expect(perPass).toBeGreaterThan(0);
    });
});
