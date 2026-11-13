/// <reference types="bun-types" />
import { afterEach, expect, spyOn, test } from "bun:test";
import * as loggerModule from "../../shared/logger";
import {
    commitServedRequest,
    countServedRefusal,
    dropServedRecord,
    getServedCheckCountersForTest,
    getServedCheckWorkForTest,
    getServedRecordForTest,
    noteServedPassPermission,
    noteServedReplay,
    resetServedCheckForTest,
    SERVED_FULL_CHECK_INTERVAL,
    SERVED_RECORD_SESSION_LIMIT,
    servedShapeForTest,
} from "./served-check";

afterEach(() => resetServedCheckForTest());

const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const SONNET = { providerID: "anthropic", modelID: "claude-sonnet-4" };

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

function user(id: string, text: string): Message {
    return { info: { id, role: "user" }, parts: [{ id: `${id}-p`, type: "text", text }] };
}

function step(id: string, output: string, thinking = false): Message {
    return {
        info: { id, role: "assistant", ...OPUS },
        parts: [
            ...(thinking
                ? [
                      {
                          id: `${id}-r`,
                          type: "reasoning",
                          text: `thinking in ${id}`,
                          metadata: { anthropic: { signature: `sig-${id}` } },
                      },
                  ]
                : []),
            {
                id: `${id}-t`,
                type: "tool",
                tool: "read",
                callID: `call-${id}`,
                state: {
                    status: "completed",
                    input: { path: `${id}.ts` },
                    output,
                    metadata: { diagnostics: `lsp ${id}` },
                },
            },
        ],
    };
}

function head(): Message {
    return {
        info: { id: "m0", role: "user" },
        parts: [
            {
                id: "m0-p",
                type: "text",
                text: "<session-history>old</session-history>",
                synthetic: true,
            },
        ],
    };
}

function session(count: number, thinkingAt = -1): Message[] {
    const messages = [head(), user("u0", "start")];
    for (let index = 1; index < count; index += 1)
        messages.push(step(`s${index}`, `output ${index}`, index === thinkingAt));
    return messages;
}

/** Fresh objects with the same content, as a host builds them on every pass. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function serve(sessionId: string, messages: unknown[], model = OPUS) {
    return commitServedRequest({ sessionId, host: "opencode", messages, ...model });
}

function captureLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(loggerModule, "sessionLog").mockImplementation((_id, message) => {
        lines.push(String(message));
    });
    return { lines, restore: () => spy.mockRestore() };
}

const permission = (permitted: boolean) => ({
    permitted,
    rides: permitted ? "ride=hardFold" : "ride=none",
    signedThinkingHold: false,
    firstRender: false,
    hostCheckpointHead: false,
    emergency: false,
    schedulerDecision: "defer",
});

test("a session this process has not served is unknown, never equal", () => {
    const result = serve("s", session(4));
    expect(result?.class).toBe("unknown");
    expect(getServedCheckCountersForTest("s")?.unknown).toBe(1);
    expect(getServedRecordForTest("s")?.count).toBe(5);
});

test("a request that only appends to the record is append only and logs nothing", () => {
    const base = session(6);
    serve("s", base);
    const logs = captureLogs();
    try {
        const result = serve("s", fresh([...base, user("u9", "more"), step("s9", "nine")]));
        expect(result?.class).toBe("append_only");
        expect(result?.events).toEqual([]);
        expect(logs.lines).toEqual([]);
    } finally {
        logs.restore();
    }
});

test("a change at index 0 without rebuild permission is named with its counts", () => {
    const base = session(6);
    serve("s", base);
    const next = fresh(base);
    next[0]!.parts[0]!.text = "<session-history>re-rendered</session-history>";
    noteServedPassPermission("s", permission(false));
    const logs = captureLogs();
    try {
        const result = serve("s", next);
        expect(result?.class).toBe("changed");
        expect(result?.firstIndex).toBe(0);
        expect(result?.seenBy).toBe("shape");
        expect(result?.events).toContain("unpermitted_change");
        expect(
            logs.lines.some((line) =>
                line.startsWith(
                    "served check: a pass without rebuild permission changed served messages first_index=0 recorded=7 after_first=7 served=7 class=changed seen_by=shape kind=pass permitted=false decision=defer ride=none",
                ),
            ),
        ).toBe(true);
    } finally {
        logs.restore();
    }
});

test("a change with rebuild permission and no kept thinking behind it is only counted", () => {
    const base = session(6);
    serve("s", base);
    const next = fresh(base);
    next[3]!.parts[0]!.state = { status: "completed", input: {}, output: "[dropped §3§]" };
    noteServedPassPermission("s", permission(true));
    const logs = captureLogs();
    try {
        const result = serve("s", next);
        expect(result?.class).toBe("changed");
        expect(result?.firstIndex).toBe(3);
        expect(result?.events).toEqual([]);
        expect(logs.lines).toEqual([]);
        expect(getServedCheckCountersForTest("s")?.changed).toBe(1);
    } finally {
        logs.restore();
    }
});

test("a change in the tail without permission names the tail index", () => {
    const base = session(8);
    serve("s", base);
    const next = fresh(base);
    (next[7]!.parts[0]!.state as { output: string }).output = "[dropped §9§]";
    const result = serve("s", next);
    expect(result?.class).toBe("changed");
    expect(result?.firstIndex).toBe(7);
    expect(result?.recorded).toBe(9);
    expect(result?.events).toContain("unpermitted_change");
});

test("a request with fewer messages than the record is shorter", () => {
    const base = session(8);
    serve("s", base);
    const result = serve("s", fresh(base.slice(0, 5)));
    expect(result?.class).toBe("shorter");
    expect(result?.firstIndex).toBe(5);
    expect(getServedCheckWorkForTest().full).toBe(true);
});

test("a model change re-records without an event", () => {
    const base = session(5);
    serve("s", base);
    const next = fresh(base);
    next[0]!.parts[0]!.text = "rendered for the new model";
    const result = serve("s", next, SONNET);
    expect(result?.class).toBe("model_change");
    expect(result?.events).toEqual([]);
    expect(getServedCheckCountersForTest("s")?.modelChanged).toBe(1);
});

test("a change in front of kept signed thinking on a prefix-bound model says whether it was stripped", () => {
    const base = session(8, 6);
    serve("s", base);
    expect(getServedRecordForTest("s")?.keptThinkingIndex).toBe(7);

    const kept = fresh(base);
    (kept[3]!.parts[0]!.state as { output: string }).output = "[dropped §4§]";
    noteServedPassPermission("s", permission(true));
    const unstripped = serve("s", kept);
    expect(unstripped?.events).toEqual(["thinking_prefix_change"]);

    serve("other", base);
    const stripped = fresh(base);
    (stripped[3]!.parts[0]!.state as { output: string }).output = "[dropped §4§]";
    stripped[7]!.parts.shift();
    noteServedPassPermission("other", permission(true));
    const logs = captureLogs();
    try {
        // Stripped with the change on a pass that may rebuild: normal, only counted.
        expect(serve("other", stripped)?.events).toEqual([]);
        expect(logs.lines).toEqual([]);
    } finally {
        logs.restore();
    }
});

test("a replay that differs from the record is a mixed replay, and the next pass runs the full check", () => {
    const base = session(6);
    serve("s", base);
    const replay = fresh(base);
    (replay[2]!.parts[0]!.state as { output: string }).output = "[dropped §2§]";
    noteServedReplay("s");
    const result = serve("s", replay);
    expect(result?.kind).toBe("replay");
    expect(result?.events).toEqual(["mixed_replay"]);
    expect(getServedCheckWorkForTest().full).toBe(true);

    serve("s", fresh([...replay, user("u7", "after")]));
    expect(getServedCheckWorkForTest().full).toBe(true);
    serve("s", fresh([...replay, user("u7", "after"), user("u8", "later")]));
    expect(getServedCheckWorkForTest().full).toBe(false);
});

test("a same-length edit tier 1 cannot see is found by the sampled full check", () => {
    const base = session(6);
    serve("s", base);
    const same = fresh(base);
    (same[3]!.parts[0]!.state as { output: string }).output = "OUTPUT 3";
    expect(servedShapeForTest(same[3])).toBe(servedShapeForTest(base[3]));
    // Until the sample, the edit is not seen: it carries the recorded digest.
    for (let pass = 1; pass < SERVED_FULL_CHECK_INTERVAL; pass += 1)
        expect(serve("s", fresh(same))?.class).toBe("append_only");
    const logs = captureLogs();
    try {
        const sampled = serve("s", fresh(same));
        expect(getServedCheckWorkForTest().full).toBe(true);
        expect(sampled?.class).toBe("changed");
        expect(sampled?.seenBy).toBe("full");
        expect(sampled?.events).toContain("same_shape_change");
        expect(
            logs.lines.some((line) =>
                line.startsWith(
                    "served check: content changed with the same shape first_index=3 seen_by=full",
                ),
            ),
        ).toBe(true);
    } finally {
        logs.restore();
    }
});

test("the shape sees a drop placeholder, a stripped reasoning part and a moved message, but not tool-state metadata", () => {
    const original = step("x", "full output", true);
    const shape = servedShapeForTest(original);
    const placeholder = fresh(original);
    (placeholder.parts[1]!.state as { output: string }).output = "[dropped §1§]";
    expect(servedShapeForTest(placeholder)).not.toBe(shape);
    const stripped = fresh(original);
    stripped.parts.shift();
    expect(servedShapeForTest(stripped)).not.toBe(shape);
    const renamed = fresh(original);
    renamed.info.id = "y";
    expect(servedShapeForTest(renamed)).not.toBe(shape);
    const metadata = fresh(original);
    (metadata.parts[1]!.state as { metadata: unknown }).metadata = { diagnostics: "other" };
    expect(servedShapeForTest(metadata)).toBe(shape);
});

test("a refused turn leaves the record and is counted", () => {
    serve("s", session(4));
    countServedRefusal("s");
    expect(getServedCheckCountersForTest("s")?.refused).toBe(1);
    expect(getServedRecordForTest("s")?.count).toBe(5);
});

test("dropping a session's record makes its next request unknown and logs that it was not compared", () => {
    serve("s", session(4));
    const logs = captureLogs();
    try {
        dropServedRecord("s", "host_edit");
        expect(logs.lines.some((line) => line.startsWith("served check counts: "))).toBe(true);
        expect(logs.lines).toContain(
            "served check: record dropped reason=host_edit; the next request is not compared",
        );
    } finally {
        logs.restore();
    }
    expect(getServedRecordForTest("s")).toBeUndefined();
    expect(serve("s", session(5))?.class).toBe("unknown");
});

test("the record map is bounded", () => {
    for (let index = 0; index <= SERVED_RECORD_SESSION_LIMIT; index += 1)
        serve(`bounded-${index}`, [user("u", "x")]);
    expect(getServedRecordForTest("bounded-0")).toBeUndefined();
    expect(getServedRecordForTest(`bounded-${SERVED_RECORD_SESSION_LIMIT}`)).toBeDefined();
});

test("the check never touches the messages it reads", () => {
    const base = session(6, 4);
    serve("s", base);
    const next = fresh(base);
    next[1]!.parts[0]!.text = "edited";
    const before = JSON.stringify(next);
    const frozen = next.map((message) => Object.freeze(message));
    serve("s", frozen);
    expect(JSON.stringify(next)).toBe(before);
});

for (const count of [1_000, 10_000]) {
    test(`cost at ${count} messages: an appending pass digests only a handful of messages; an early change digests all`, () => {
        const base = session(count, count - 10);
        serve("cost", base);
        expect(getServedCheckWorkForTest()).toMatchObject({ digested: count + 1, full: true });
        const appended = fresh([...base, user("n1", "new"), step("n2", "new step")]);
        expect(serve("cost", appended)?.class).toBe("append_only");
        // The head (two messages), the last recorded message, the recorded and
        // the current first kept thinking (the same message), and the two new
        // messages.
        expect(getServedCheckWorkForTest()).toMatchObject({
            fingerprinted: count + 3,
            digested: 6,
            full: false,
        });
        const early = fresh(appended);
        early[1]!.parts[0]!.text = "changed start";
        expect(serve("cost", early)?.firstIndex).toBe(1);
        expect(getServedCheckWorkForTest()).toMatchObject({
            fingerprinted: count + 3,
            digested: count + 3,
            full: true,
        });
    });
}

/** Serves two requests and returns weak references to them only. */
function serveAndForget(): WeakRef<object>[] {
    const base = session(50, 40);
    serve("gc", base);
    const next = fresh([...base, user("n", "new")]);
    serve("gc", next);
    return [new WeakRef(base), new WeakRef(next), new WeakRef(next[3] as object)];
}

test("the record keeps no message: a committed request is collectable", async () => {
    const refs = serveAndForget();
    for (let round = 0; round < 4; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        Bun.gc(true);
    }
    expect(getServedRecordForTest("gc")?.count).toBe(52);
    expect(refs.map((ref) => ref.deref() === undefined)).toEqual([true, true, true]);
});
