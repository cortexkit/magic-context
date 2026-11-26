import { expect, test } from "bun:test";
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
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
} from "../../features/magic-context/temporal-decisions";
import { getServedRecordForTest } from "../../hooks/magic-context/served-check";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { createCtxReduceTools } from "../../tools/ctx-reduce/tools";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

type Event = { type: string; data: { sessionID: string } };

function eventBus() {
    const queue: Array<{ event: Event; handled: () => void }> = [];
    let wake: (() => void) | undefined;
    return {
        emit(event: Event) {
            return new Promise<void>((handled) => {
                queue.push({ event, handled });
                wake?.();
            });
        },
        async *stream({ signal }: { signal: AbortSignal }) {
            while (!signal.aborted) {
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

        fixture.revertBefore(removed);
        await events.emit({ type: "session.revert.committed", data: { sessionID: session } });
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
