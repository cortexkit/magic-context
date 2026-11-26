import { expect, mock, spyOn, test } from "bun:test";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { getLastIndexedOrdinal } from "../../features/magic-context/message-index";
import {
    __resetMessageIndexAsyncForTests,
    getMessageIndexQueueHeapStats,
} from "../../features/magic-context/message-index-async";
import { searchMessageHistory } from "../../features/magic-context/search";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
} from "../../features/magic-context/storage";
import {
    appendAutoSearchHintDecision,
    appendNoteNudgeAnchor,
    getAutoSearchHintDecisions,
    getNoteNudgeAnchors,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    getStrippedPlaceholderIds,
    setPersistedNoteNudgeTrigger,
    setPersistedReasoningWatermark,
    setStrippedPlaceholderIds,
} from "../../features/magic-context/storage-meta-persisted";
import { makeToolCompositeKey } from "../../features/magic-context/tagger";
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
} from "../../features/magic-context/temporal-decisions";
import * as rustModeTransform from "../../hooks/magic-context/rust-mode-transform";
import { getServedRecordForTest } from "../../hooks/magic-context/served-check";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { openTestDb } from "../../shared/test-db";
import { createCtxReduceTools } from "../../tools/ctx-reduce/tools";
import { restoreRow } from "../fold/restore";
import { seedV2ForkFromParent } from "../fork-inheritance";
import { V2StoreReader } from "../store-reader";
import { type Oc2ContextFixture, oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";

type Event = {
    type: string;
    data: { sessionID: string; to?: string; revert?: { messageID: unknown } };
};

function eventBus() {
    const queue: Array<{ event: Event; handled: () => void }> = [];
    let wake: (() => void) | undefined;
    let endRequested = false;
    let subscriptions = 0;
    return {
        get subscriptions() {
            return subscriptions;
        },
        end() {
            endRequested = true;
            wake?.();
        },
        emit(event: Event) {
            return new Promise<void>((handled) => {
                queue.push({ event, handled });
                wake?.();
            });
        },
        async *stream({ signal }: { signal: AbortSignal }) {
            subscriptions++;
            while (!signal.aborted) {
                if (endRequested) {
                    endRequested = false;
                    return;
                }
                const next = queue.shift();
                if (next) {
                    yield next.event;
                    next.handled();
                    continue;
                }
                await new Promise<void>((resolve) => {
                    wake = () => resolve();
                    signal.addEventListener("abort", wake, { once: true });
                });
                if (wake) signal.removeEventListener("abort", wake);
                wake = undefined;
            }
        },
    };
}

async function drained() {
    const deadline = performance.now() + 10000;
    while (
        getMessageIndexQueueHeapStats().queueLength > 0 ||
        getMessageIndexQueueHeapStats().activeSessionLocks > 0
    ) {
        if (performance.now() > deadline) throw new Error("message index did not drain");
        await Bun.sleep(10);
    }
}

test("OpenCode 2 revert clears the indexed suffix before indexing an appended message", async () => {
    __resetMessageIndexAsyncForTests();
    setBootQuietPeriodForTests(null);
    const events = eventBus();
    const fixture = await oc2ContextFixture(772, {
        area: "issue-772",
        temporal: false,
        instructions: false,
        eventStream: events.stream,
    });
    setBootQuietPeriodForTests(null);
    const search = (query: string) =>
        searchMessageHistory(fixture.db, {
            sessionId: fixture.session,
            query,
            probes: [query],
            limit: 5,
            collectDiagnostics: false,
            dateRange: null,
        }).results;
    const rawCount = () =>
        (
            fixture.raw
                .prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?")
                .get(fixture.session) as { count: number }
        ).count;
    try {
        const firstReverted = fixture.rows[3]!;
        fixture.edit(firstReverted.id, "revertedneedle772 text must disappear");
        await fixture.pass();
        await drained();
        const before = rawCount();
        expect(getLastIndexedOrdinal(fixture.db, fixture.session)).toBe(before);
        expect(search("revertedneedle772")).toHaveLength(1);

        fixture.revertBefore(firstReverted.id);
        expect(rawCount()).toBe(3);
        await events.emit({
            type: "session.revert.committed",
            data: { sessionID: fixture.session },
        });
        fixture.user("replacementneedle772 appended after revert", 1000);
        await fixture.pass();
        await drained();

        expect(rawCount()).toBe(4);
        expect(getLastIndexedOrdinal(fixture.db, fixture.session)).toBe(rawCount());
        expect(search("revertedneedle772")).toEqual([]);
        expect(search("replacementneedle772").map((hit) => hit.messageOrdinal)).toEqual([4]);
        expect(
            fixture.sessionLogs().filter((line) => line.includes("reconciliation stalled")),
        ).toEqual([]);
    } finally {
        await drained();
        await fixture.cleanup();
        __resetMessageIndexAsyncForTests();
        setBootQuietPeriodForTests(null);
    }
});

test("committing an OpenCode 2 revert ends the previous served comparison", async () => {
    const events = eventBus();
    const fixture = await oc2ContextFixture(988, {
        temporal: false,
        instructions: false,
        eventStream: events.stream,
    });
    try {
        await fixture.pass();
        const record = getServedRecordForTest(fixture.session);
        expect(record).toBeDefined();
        await events.emit({ type: "session.revert.started", data: { sessionID: fixture.session } });
        expect(getServedRecordForTest(fixture.session)).toEqual(record);

        fixture.revertBefore(fixture.rows[3]!.id);
        await events.emit({
            type: "session.revert.committed",
            data: { sessionID: fixture.session },
        });
        expect(getServedRecordForTest(fixture.session)).toBeUndefined();
        fixture.user("Replacement after the committed revert", 1000);
        const next = await fixture.pass();
        expect(next.logs.join("\n")).not.toContain(
            "a pass without rebuild permission changed served messages",
        );
        expect(getServedRecordForTest(fixture.session)).toBeDefined();
    } finally {
        await fixture.cleanup();
    }
});

test("a committed OpenCode 2 revert removes only state owned by absent stored messages", async () => {
    const events = eventBus();
    const fixture = await oc2ContextFixture(989, {
        temporal: false,
        instructions: false,
        eventStream: events.stream,
    });
    const { db, session, rows } = fixture;
    try {
        const kept = rows.at(-1)!.id;
        fixture.user("This user message will be removed", 1_000);
        const removed = rows.at(-1)!.id;
        fixture.respondWithTool({
            name: "read",
            input: { filePath: "fixture.txt" },
            output: "tool output",
        });
        const assistant = rows.at(-1)!.id;
        fixture.user("Last user message before the revert", 1_000);
        await fixture.pass();

        const before = getTagsBySession(db, session);
        const owners = (tags: typeof before) =>
            tags.map((tag) => tag.toolOwnerMessageId ?? contentTagOwnerMessageId(tag.messageId));
        const droppedTag = before.find((tag) => tag.toolOwnerMessageId === assistant);
        expect(droppedTag).toBeDefined();
        expect(owners(before)).toContain(removed);
        const spentThrough = Math.max(...before.map((tag) => tag.tagNumber));
        expect(getOrCreateSessionMeta(db, session).counter).toBe(spentThrough);

        setStrippedPlaceholderIds(db, session, new Set([kept, removed]));
        for (const id of [kept, removed]) {
            appendNoteNudgeAnchor(db, session, id, `Note for ${id}`);
            appendAutoSearchHintDecision(db, session, {
                messageId: id,
                decision: "no-hint",
                reason: "empty",
            });
        }
        setPersistedNoteNudgeTrigger(db, session, removed);
        freezeTemporalDecisions(
            db,
            session,
            new Map([
                [kept, ""],
                [removed, ""],
            ]),
        );
        setPersistedReasoningWatermark(db, session, spentThrough);

        await events.emit({ type: "session.revert.started", data: { sessionID: session } });
        expect(getTagsBySession(db, session)).toEqual(before);
        expect(getStrippedPlaceholderIds(db, session)).toEqual(new Set([kept, removed]));

        await events.emit({
            type: "session.revert.staged",
            data: { sessionID: session, revert: { messageID: removed } },
        });
        fixture.revertBefore(removed);
        await events.emit({
            type: "session.revert.committed",
            data: { sessionID: session, to: removed },
        });
        const after = getTagsBySession(db, session);
        expect(owners(after)).toContain(kept);
        expect(owners(after)).not.toContain(removed);
        expect(owners(after)).not.toContain(assistant);
        expect(getStrippedPlaceholderIds(db, session)).toEqual(new Set([kept]));
        expect(getNoteNudgeAnchors(db, session).map(({ messageId }) => messageId)).toEqual([kept]);
        expect(getAutoSearchHintDecisions(db, session).map(({ messageId }) => messageId)).toEqual([
            kept,
        ]);
        expect(getPersistedNoteNudge(db, session).triggerMessageId).toBeNull();
        expect(getTemporalDecisions(db, session)).toEqual(new Map([[kept, ""]]));
        expect(getPersistedReasoningWatermark(db, session)).toBe(
            Math.max(...after.map((tag) => tag.tagNumber)),
        );
        expect(getOrCreateSessionMeta(db, session).counter).toBe(spentThrough);

        fixture.user("The replacement must not inherit a spent tag", 1_000);
        const replacement = rows.at(-1)!.id;
        await fixture.pass();
        const replacementTag = getTagsBySession(db, session).find(
            (tag) => contentTagOwnerMessageId(tag.messageId) === replacement,
        );
        expect(replacementTag?.tagNumber).toBeGreaterThan(spentThrough);

        const reduce = createCtxReduceTools({ db }).ctx_reduce!;
        const pendingBefore = getPendingOps(db, session);
        const result = await reduce.execute({ drop: String(droppedTag!.tagNumber) }, {
            sessionID: session,
        } as Parameters<typeof reduce.execute>[1]);
        expect(result).toBe(
            `Error: Unknown tag(s) §${droppedTag!.tagNumber}§. Check available tags in conversation.`,
        );
        expect(getPendingOps(db, session)).toEqual(pendingBefore);
    } finally {
        await fixture.cleanup();
    }
});

function stageEvent(sessionID: string, messageID: unknown): Event {
    return { type: "session.revert.staged", data: { sessionID, revert: { messageID } } };
}

function commitEvent(sessionID: string, to: string): Event {
    return { type: "session.revert.committed", data: { sessionID, to } };
}

function seedReplay(f: Oc2ContextFixture, owners: readonly string[], session = f.session) {
    const { db } = f;
    for (const [index, id] of owners.entries()) {
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, ?, 'message', 'dropped', 10, ?)",
        ).run(session, `${id}:p0`, index + 1);
        appendNoteNudgeAnchor(db, session, id, `note:${id}`);
        appendAutoSearchHintDecision(db, session, {
            messageId: id,
            decision: "no-hint",
            reason: "empty",
        });
    }
    setStrippedPlaceholderIds(db, session, new Set(owners));
    freezeTemporalDecisions(db, session, new Map(owners.map((id) => [id, ""])));
    setPersistedNoteNudgeTrigger(db, session, owners[0]);
    setPersistedReasoningWatermark(db, session, 1);
}

function replayState(
    f: Oc2ContextFixture,
    excluding?: string | ReadonlySet<string>,
    session = f.session,
) {
    const { db } = f;
    const keep = (id: string | null) =>
        id === null || (typeof excluding === "string" ? id !== excluding : !excluding?.has(id));
    return {
        tags: getTagsBySession(db, session).filter((tag) =>
            keep(
                tag.type === "tool"
                    ? tag.toolOwnerMessageId
                    : contentTagOwnerMessageId(tag.messageId),
            ),
        ),
        stripped: [...getStrippedPlaceholderIds(db, session)].filter(keep),
        anchors: getNoteNudgeAnchors(db, session).filter(({ messageId }) => keep(messageId)),
        search: getAutoSearchHintDecisions(db, session).filter(({ messageId }) => keep(messageId)),
        temporal: [...getTemporalDecisions(db, session)].filter(([id]) => keep(id)),
        trigger: getPersistedNoteNudge(db, session),
        watermark: getPersistedReasoningWatermark(db, session),
    };
}

async function revertFixture(seed: number) {
    const bus = eventBus();
    const f = await oc2ContextFixture(seed, {
        temporal: false,
        instructions: false,
        eventStream: bus.stream,
    });
    const read = () => new V2StoreReader(process.env.OPENCODE_DB!);
    const cutoff = f.rows.at(-2)!.id;
    return {
        f,
        bus,
        cutoff,
        read,
        stage: (id = cutoff) => bus.emit(stageEvent(f.session, id)),
        clear: () => bus.emit({ type: "session.revert.cleared", data: { sessionID: f.session } }),
        commit: (to = cutoff) => bus.emit(commitEvent(f.session, to)),
    };
}

test("revert proof preserves absent plugin-owned replay state and legacy tool owner forms", async () => {
    const { f, cutoff, read, stage, commit } = await revertFixture(990);
    const store = read();
    try {
        const retained = f.rows[0]!.id;
        const notice = "plugin-only-storage-notice";
        const composite = makeToolCompositeKey(retained, "call-composite");
        const synthetic = [...HEAD_IDS, notice, composite];
        seedReplay(f, [retained, ...synthetic, cutoff]);
        for (const [index, owner] of [null, "", composite].entries()) {
            f.db
                .prepare(
                    "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, tool_owner_message_id) VALUES (?, ?, 'tool', 'dropped', 10, ?, ?)",
                )
                .run(f.session, index === 0 ? cutoff : `call-legacy-${index}`, 20 + index, owner);
        }
        expect(synthetic.map((id) => store.sequenceForId(f.session, id))).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
        const retainedState = replayState(f, cutoff);
        await stage();
        f.revertBefore(cutoff);
        await commit();
        expect(replayState(f)).toEqual(retainedState);
    } finally {
        store.close();
        await f.cleanup();
    }
});

test.each([
    ["no stage", "no staged proof"],
    ["wrong cutoff", "commit cutoff differs from staged cutoff"],
    ["cleared stage", "no staged proof"],
    ["empty view", "retained predecessor is not visible at commit"],
    ["busy at stage", "host store read failed at stage"],
    ["busy at commit", "host store read failed at commit"],
    ["late stage", "stage did not prove a bounded suffix and retained predecessor"],
])("revert proof leaves all state alone: %s", async (scenario, reason) => {
    const { f, cutoff, stage, clear, commit } = await revertFixture(991);
    const retained = f.rows[0]!.id;
    const failRead = async (operation: () => Promise<void>) => {
        const spy = spyOn(V2StoreReader.prototype, "hostIdentity").mockImplementation(() => {
            throw new Error("SQLITE_BUSY: host store unavailable");
        });
        try {
            await operation();
        } finally {
            spy.mockRestore();
        }
    };
    try {
        seedReplay(f, [retained, cutoff]);
        const before = replayState(f);
        if (scenario === "busy at stage") await failRead(() => stage());
        else if (scenario !== "no stage" && scenario !== "late stage") await stage();
        if (scenario === "cleared stage") await clear();
        f.revertBefore(cutoff);
        if (scenario === "late stage") await stage();
        if (scenario === "empty view")
            f.raw.prepare("DELETE FROM session_message WHERE session_id = ?").run(f.session);
        if (scenario === "busy at commit") await failRead(() => commit());
        else await commit(scenario === "wrong cutoff" ? retained : cutoff);
        expect(replayState(f)).toEqual(before);
        expect(
            f
                .sessionLogs()
                .filter((line) => line.includes("committed revert tag cleanup skipped:")),
        ).toEqual([expect.stringContaining(reason)]);
    } finally {
        await f.cleanup();
    }
});

test.each([
    false,
    true,
])("revert proof uses only the latest stage (clear between stages: %s)", async (clearBetween) => {
    const { f, cutoff, stage, clear, commit } = await revertFixture(992);
    try {
        const earlier = f.rows[1]!.id;
        seedReplay(f, [f.rows[0]!.id, earlier, cutoff]);
        const retainedState = replayState(f, cutoff);
        await stage(earlier);
        if (clearBetween) await clear();
        await stage();
        f.revertBefore(cutoff);
        await commit();
        expect(replayState(f)).toEqual(retainedState);
    } finally {
        await f.cleanup();
    }
});

test.each([
    "converted history",
    "host checkpoint",
    "child in another project",
])("revert proof keeps earlier state after %s", async (scenario) => {
    const { f, cutoff, read, stage, commit } = await revertFixture(993);
    const store = read();
    try {
        const earlier = f.rows[0]!.id;
        const owners = [earlier];
        let target = cutoff;
        if (scenario === "converted history") {
            const legacy = "msg-retained-only-in-v1";
            f.raw.exec(
                "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
            );
            f.raw
                .prepare("INSERT INTO message VALUES (?, ?, ?)")
                .run(
                    legacy,
                    f.session,
                    JSON.stringify({ role: "user", id: legacy, sessionID: f.session }),
                );
            getOrCreateSessionMeta(f.db, f.session);
            f.db
                .prepare(
                    "UPDATE session_meta SET coordinate_generation = 'v2' WHERE session_id = ?",
                )
                .run(f.session);
            expect(store.sequenceForId(f.session, legacy)).toBeUndefined();
            owners.push(legacy);
        } else if (scenario === "host checkpoint") {
            const checkpoint = f.providerFold();
            expect(store.sequenceForId(f.session, checkpoint)).toBeDefined();
            const earlierRow = store.messageById(f.session, earlier)!;
            expect(
                restoreRow(earlierRow, { providerID: "openai", id: "gpt-4.1" }).map(({ id }) => id),
            ).toContain(earlier);
            owners.push(checkpoint);
            f.user("Unrelated turn after the host checkpoint", 1_000);
            target = f.rows.at(-1)!.id;
        } else {
            f.raw
                .prepare("INSERT INTO session_v2(id, directory) VALUES (?, ?)")
                .run("parent", "/other/project");
            f.raw
                .prepare("UPDATE session_v2 SET parent_id = ?, directory = ? WHERE id = ?")
                .run("parent", "/other/project", f.session);
            expect(store.isSubagent(f.session)).toBe(true);
        }
        expect(store.sequenceForId(f.session, earlier)).toBeDefined();
        seedReplay(f, [...owners, target]);
        const retainedState = replayState(f, target);
        await stage(target);
        f.revertBefore(target);
        await commit(target);
        expect(replayState(f)).toEqual(retainedState);
    } finally {
        store.close();
        await f.cleanup();
    }
});

test("revert proof keeps the tag of a staged suffix row that still exists after commit", async () => {
    const { f, cutoff, stage, commit } = await revertFixture(994);
    try {
        const removed = f.rows.at(-1)!.id;
        seedReplay(f, [f.rows[0]!.id, cutoff, removed]);
        const retainedState = replayState(f, removed);
        await stage();
        f.raw
            .prepare("DELETE FROM session_message WHERE session_id = ? AND id = ?")
            .run(f.session, removed);
        await commit();
        expect(replayState(f)).toEqual(retainedState);
    } finally {
        await f.cleanup();
    }
});

test("revert proof keeps a fork's inherited history tags and replay state", async () => {
    const { f, cutoff, read, stage, commit } = await revertFixture(995);
    const store = read();
    try {
        const parent = "parent-with-summaries";
        const row = f.rows[0]!;
        const copiedId = `${f.session}_${row.seq}`;
        f.raw.prepare("UPDATE session_message SET id = ? WHERE id = ?").run(copiedId, row.id);
        row.id = copiedId;
        const parentMessage = "parent-assistant";
        const installed = f.raw
            .prepare(
                "INSERT INTO session_v2(id,directory) SELECT ?,directory FROM session_v2 WHERE id=?",
            )
            .run(parent, f.session);
        expect(installed.changes).toBe(1);
        f.raw
            .prepare("UPDATE session_v2 SET fork_session_id=?,fork_boundary=? WHERE id=?")
            .run(parent, JSON.stringify({ type: "through", messageID: parentMessage }), f.session);
        f.raw
            .prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) SELECT ?,?,type,seq,time_created,time_updated,data FROM session_message WHERE id=?",
            )
            .run(parentMessage, parent, row.id);
        appendCompartments(f.db, parent, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: parentMessage,
                endMessageId: parentMessage,
                title: "Parent summary",
                content: "Inherited history",
            },
        ]);
        f.db
            .prepare(
                "INSERT INTO tags (session_id,message_id,type,status,byte_size,tag_number) VALUES (?,?,'message','dropped',10,10)",
            )
            .run(parent, `${parentMessage}:p0`);
        setStrippedPlaceholderIds(f.db, parent, new Set([parentMessage]));
        freezeTemporalDecisions(f.db, parent, new Map([[parentMessage, ""]]));
        expect(seedV2ForkFromParent({ db: f.db, store, sessionId: f.session }).kind).toBe("seeded");
        expect(getCompartments(f.db, f.session).map(({ endMessageId }) => endMessageId)).toEqual([
            row.id,
        ]);
        expect(store.sequenceForId(f.session, parentMessage)).toBeUndefined();
        expect(store.sequenceForId(f.session, row.id)).toBe(row.seq);
        expect(getTagsBySession(f.db, f.session)).toEqual([
            expect.objectContaining({ messageId: `${row.id}:p0`, status: "dropped" }),
        ]);
        expect(replayState(f).stripped).toEqual([row.id]);
        expect(replayState(f).temporal).toEqual([[row.id, ""]]);
        appendNoteNudgeAnchor(f.db, f.session, row.id, "fork note");
        appendAutoSearchHintDecision(f.db, f.session, {
            messageId: row.id,
            decision: "no-hint",
            reason: "empty",
        });
        const inherited = replayState(f);
        f.db
            .prepare(
                "INSERT INTO tags (session_id,message_id,type,status,byte_size,tag_number) VALUES (?,?,'message','dropped',10,11)",
            )
            .run(f.session, `${cutoff}:p0`);
        await stage();
        f.revertBefore(cutoff);
        await commit();
        expect(replayState(f)).toEqual(inherited);
        expect(getCompartments(f.db, f.session)).toHaveLength(1);
    } finally {
        store.close();
        await f.cleanup();
    }
});

test("revert proof survives a location's reader seeing a different host database", async () => {
    const { f, cutoff, stage, commit } = await revertFixture(996);
    const sourcePath = process.env.OPENCODE_DB!;
    const otherPath = `${sourcePath}.other`;
    const other = openTestDb(otherPath);
    try {
        const kept = f.rows[0]!.id;
        seedReplay(f, [kept, cutoff]);
        const before = replayState(f);
        other.exec(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY); CREATE TABLE session_message (id TEXT, session_id TEXT, seq INTEGER)",
        );
        other.prepare("INSERT INTO session_v2 VALUES (?)").run(f.session);
        await stage();
        f.revertBefore(cutoff);
        process.env.OPENCODE_DB = otherPath;
        await commit();
        expect(replayState(f)).toEqual(before);
        expect(f.sessionLogs().some((line) => line.includes("host database changed"))).toBe(true);
    } finally {
        process.env.OPENCODE_DB = sourcePath;
        other.close();
        await f.cleanup();
    }
});

test.each([
    "first row",
    "over the row limit",
])("revert proof refuses an unprovable suffix: %s", async (scenario) => {
    const { f, cutoff, stage, commit } = await revertFixture(997);
    try {
        const first = f.rows[0]!.id;
        const target = scenario === "first row" ? first : cutoff;
        if (scenario === "over the row limit") {
            f.raw
                .prepare(`WITH RECURSIVE extra(n) AS (VALUES(101) UNION ALL SELECT n+1 FROM extra WHERE n<10100)
                INSERT INTO session_message (id,session_id,type,seq,time_created,data)
                SELECT 'after-cutoff-'||n,?,'user',n,0,'{}' FROM extra`)
                .run(f.session);
        }
        seedReplay(f, [first, cutoff]);
        const before = replayState(f);
        await stage(target);
        f.revertBefore(target);
        await commit(target);
        expect(replayState(f)).toEqual(before);
        expect(
            f
                .sessionLogs()
                .filter((line) => line.includes("committed revert tag cleanup skipped:")),
        ).toEqual([
            expect.stringContaining(
                "stage did not prove a bounded suffix and retained predecessor",
            ),
        ]);
    } finally {
        await f.cleanup();
    }
});

function addStoredSession(f: Oc2ContextFixture, session: string, ids: readonly string[]): void {
    f.raw
        .prepare(
            "INSERT INTO session_v2(id, directory) SELECT ?, directory FROM session_v2 WHERE id = ?",
        )
        .run(session, f.session);
    const insert = f.raw.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, 'user', ?, 0, '{}')",
    );
    for (const [seq, id] of ids.entries()) insert.run(id, session, seq);
}

function deleteStoredSuffix(f: Oc2ContextFixture, session: string, cutoff: string): void {
    f.raw
        .prepare(`DELETE FROM session_message WHERE session_id = ? AND seq >= (
        SELECT seq FROM session_message WHERE session_id = ? AND id = ?
    )`)
        .run(session, session, cutoff);
}

function cleanupSkips(f: Oc2ContextFixture, session = f.session): string[] {
    return f
        .sessionLogs()
        .filter((line) => line.includes(`${session} committed revert tag cleanup skipped:`));
}

test("committed revert matches tag owners exactly across prefix and suffix collisions", async () => {
    const { f, bus } = await revertFixture(998);
    const session = "owner-collision-session";
    const cutoff = "x1";
    const owners = ["x", "x10", "x1-", "px1", "1", cutoff];
    try {
        addStoredSession(f, session, owners);
        seedReplay(f, owners, session);
        const insert =
            f.db.prepare(`INSERT INTO tags (session_id,message_id,type,status,byte_size,tag_number,tool_owner_message_id)
            VALUES (?,?,?,'dropped',10,?,?)`);
        for (const [index, owner] of owners.entries()) {
            insert.run(session, `${owner}:file0`, "file", 100 + index, null);
            insert.run(session, `call-of-${owner}`, "tool", 200 + index, owner);
        }
        insert.run(session, `${cutoff}:p0:p1`, "message", 300, null);
        insert.run(session, `${cutoff}:mc-text-v1:0a:0b:o0`, "message", 301, null);
        const retained = replayState(f, cutoff, session);
        expect(retained.tags).toHaveLength(16);
        await bus.emit(stageEvent(session, cutoff));
        deleteStoredSuffix(f, session, cutoff);
        await bus.emit(commitEvent(session, cutoff));
        expect(replayState(f, undefined, session)).toEqual(retained);
    } finally {
        await f.cleanup();
    }
});

test("interleaved committed reverts keep a separate proof per session", async () => {
    const { f, bus, cutoff, stage, commit } = await revertFixture(999);
    const other = "interleaved-session";
    try {
        const kept = f.rows[0]!.id;
        addStoredSession(f, other, ["other-prefix", "other-cutoff"]);
        seedReplay(f, [kept, cutoff]);
        seedReplay(f, ["other-prefix", "other-cutoff"], other);
        const before = replayState(f);
        const after = replayState(f, cutoff);
        const otherAfter = replayState(f, "other-cutoff", other);
        await stage();
        await bus.emit(stageEvent(other, "other-cutoff"));
        deleteStoredSuffix(f, other, "other-cutoff");
        await bus.emit(commitEvent(other, "other-cutoff"));
        expect(replayState(f, undefined, other)).toEqual(otherAfter);
        expect(replayState(f)).toEqual(before);
        f.revertBefore(cutoff);
        await commit();
        expect(replayState(f)).toEqual(after);
        expect(replayState(f, undefined, other)).toEqual(otherAfter);
    } finally {
        await f.cleanup();
    }
});

test("ending the host event stream discards staged revert proofs", async () => {
    const { f, bus, cutoff, stage, commit } = await revertFixture(1000);
    try {
        const earlier = f.rows.at(-3)!.id;
        seedReplay(f, [f.rows[0]!.id, earlier, cutoff]);
        const before = replayState(f);
        const afterProvenRevert = replayState(f, earlier);
        await stage();
        expect(bus.subscriptions).toBe(1);
        bus.end();
        f.revertBefore(cutoff);
        await commit();
        expect(bus.subscriptions).toBe(2);
        expect(replayState(f)).toEqual(before);
        expect(cleanupSkips(f)).toEqual([expect.stringContaining("no staged proof")]);

        await stage(earlier);
        f.revertBefore(earlier);
        await commit(earlier);
        expect(replayState(f)).toEqual(afterProvenRevert);
    } finally {
        await f.cleanup();
    }
});

test("committed revert requires the retained predecessor at its staged sequence", async () => {
    const { f, cutoff, stage, commit } = await revertFixture(1001);
    try {
        const predecessor = f.rows.at(-3)!;
        seedReplay(f, [f.rows[0]!.id, predecessor.id, cutoff]);
        const before = replayState(f);
        await stage();
        f.revertBefore(cutoff);
        f.raw
            .prepare("UPDATE session_message SET seq = ? WHERE session_id = ? AND id = ?")
            .run(-1, f.session, predecessor.id);
        await commit();
        expect(replayState(f)).toEqual(before);
        expect(cleanupSkips(f)).toEqual([
            expect.stringContaining("retained predecessor is not visible at commit"),
        ]);
    } finally {
        await f.cleanup();
    }
});

for (const suffix of [10_000, 10_001]) {
    test(`committed revert ${suffix === 10_000 ? "accepts" : "refuses"} a suffix of exactly ${suffix} rows`, async () => {
        const { f, bus } = await revertFixture(1002);
        const session = "suffix-limit-session";
        const cutoff = "limit-row-1";
        const last = `limit-row-${suffix}`;
        try {
            addStoredSession(f, session, ["limit-row-0"]);
            // Row 0 is the retained predecessor, not part of the suffix limit.
            f.raw
                .prepare(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
                INSERT INTO session_message (id,session_id,type,seq,time_created,data)
                SELECT 'limit-row-' || n,?,'user',n,0,'{}' FROM rows`)
                .run(suffix, session);
            seedReplay(f, ["limit-row-0", cutoff, last], session);
            const before = replayState(f, undefined, session);
            const retained = replayState(f, new Set([cutoff, last]), session);
            await bus.emit(stageEvent(session, cutoff));
            deleteStoredSuffix(f, session, cutoff);
            await bus.emit(commitEvent(session, cutoff));
            expect(replayState(f, undefined, session)).toEqual(
                suffix === 10_000 ? retained : before,
            );
            expect(cleanupSkips(f, session)).toEqual(
                suffix === 10_000
                    ? []
                    : [expect.stringContaining("stage did not prove a bounded suffix")],
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("a malformed restage discards the earlier valid revert proof", async () => {
    const { f, bus, cutoff, stage, commit } = await revertFixture(1003);
    try {
        seedReplay(f, [f.rows[0]!.id, cutoff]);
        const before = replayState(f);
        await stage();
        await bus.emit(stageEvent(f.session, 42));
        f.revertBefore(cutoff);
        await commit();
        expect(replayState(f)).toEqual(before);
        expect(cleanupSkips(f)).toEqual([expect.stringContaining("no staged proof")]);
    } finally {
        await f.cleanup();
    }
});

test("a committed revert logs one skip when the staged rows are all still stored", async () => {
    const { f, cutoff, stage, commit } = await revertFixture(1004);
    try {
        seedReplay(f, [f.rows[0]!.id, cutoff]);
        const before = replayState(f);
        await stage();
        await commit();
        expect(replayState(f)).toEqual(before);
        expect(cleanupSkips(f)).toEqual([expect.stringContaining("all staged rows still exist")]);
    } finally {
        await f.cleanup();
    }
});

test("pruning a committed OpenCode 2 revert invalidates the Rust wire for that session", async () => {
    const bus = eventBus();
    const run = mock(async () => {});
    const invalidateWireState = mock((_sessionID: string) => {});
    const createAdapter = rustModeTransform.createRustModeTransform;
    const rust = spyOn(rustModeTransform, "createRustModeTransform").mockImplementation(
        (deps, options) => ({
            ...createAdapter(deps, options),
            run,
            invalidateWireState,
        }),
    );
    let f: Oc2ContextFixture | undefined;
    try {
        f = await oc2ContextFixture(1005, {
            temporal: false,
            instructions: false,
            configOverrides: { transform_mode: "rust", subc: { connection_file: "/dev/null" } },
            eventStream: bus.stream,
        });
        await f.pass();
        expect(run).toHaveBeenCalledTimes(1);
        const cutoff = f.rows.at(-2)!.id;
        seedReplay(f, [f.rows[0]!.id, cutoff]);
        const retained = replayState(f, cutoff);
        await bus.emit(stageEvent(f.session, cutoff));
        expect(invalidateWireState).not.toHaveBeenCalled();
        f.revertBefore(cutoff);
        await bus.emit(commitEvent(f.session, cutoff));
        expect(replayState(f)).toEqual(retained);
        expect(invalidateWireState.mock.calls).toEqual([[f.session]]);
    } finally {
        rust.mockRestore();
        await f?.cleanup();
    }
});
