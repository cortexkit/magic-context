import { expect, test } from "bun:test";
import { getLastIndexedOrdinal } from "../../features/magic-context/message-index";
import {
    __resetMessageIndexAsyncForTests,
    getMessageIndexQueueHeapStats,
} from "../../features/magic-context/message-index-async";
import { searchMessageHistory } from "../../features/magic-context/search";
import { getServedRecordForTest } from "../../hooks/magic-context/served-check";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
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
