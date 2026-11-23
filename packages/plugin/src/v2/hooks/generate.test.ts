import { expect, spyOn, test } from "bun:test";
import * as logger from "../../shared/logger";
import { generateReplayAnchor, V2GenerateReplay } from "./generate";
import type { SessionContext } from "./types";

const draft = (): SessionContext => ({
    sessionID: "s",
    model: { providerID: "p", id: "m" },
    agent: "a",
    system: [{ text: "host" }],
    messages: [{ id: "u", role: "user", content: [{ type: "text", text: "question" }] }],
    tools: {},
    options: {},
});

test("generate reuses exact served bytes and pristine live tail without changing replay state", () => {
    const replay = new V2GenerateReplay();
    const served = draft();
    const anchor = generateReplayAnchor(served.messages);
    served.system = [{ text: "managed system" }];
    served.tools = { ctx_reduce: { description: "managed description", input: {} } };
    served.messages.unshift({
        id: "m0",
        role: "user",
        content: [{ type: "text", text: "<session-history>summary</session-history>" }],
    });
    served.messages[1]!.content.push({ type: "text", text: "[dropped]" });
    replay.capture(served, anchor);
    const input = draft();
    input.messages.push(
        { id: "a", role: "assistant", content: [{ type: "text", text: "live" }] },
        { role: "user", content: [{ type: "text", text: "btw" }] },
    );
    const next = structuredClone(input);
    expect(replay.apply(input)).toBe(true);
    expect(input.messages).toEqual([...served.messages, ...next.messages.slice(1)]);
    expect(input.system).toEqual(served.system);
    expect(input.tools).toEqual(served.tools);
    const bytes = JSON.stringify(input);
    input.messages[0]!.content[0]!.text = "caller mutation";
    expect(replay.apply(next)).toBe(true);
    expect(JSON.stringify(next)).toBe(bytes);
    expect(served.messages[0]!.content[0]!.text).toBe("<session-history>summary</session-history>");
});

test("generate leaves host request unchanged without a compatible anchored prefix", () => {
    const replay = new V2GenerateReplay();
    const input = draft();
    const bytes = JSON.stringify(input);
    expect(replay.apply(input)).toBe(false);
    replay.capture(input, generateReplayAnchor([{ ...input.messages[0]!, id: "missing" }]));
    expect(replay.apply(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(bytes);
    replay.capture(input, generateReplayAnchor(input.messages));
    input.model.id = "other";
    expect(replay.apply(input)).toBe(false);
    input.model.id = "m";
    replay.forget("s");
    expect(replay.apply(input)).toBe(false);
});

test("generate captures the final request with id-less tool tails without duplicating them", () => {
    const replay = new V2GenerateReplay();
    const first = draft();
    replay.capture(first, generateReplayAnchor(first.messages));
    const raw = draft();
    raw.messages.push(
        { id: "a", role: "assistant", content: [{ type: "tool-call", id: "call-1" }] },
        { role: "tool", content: [{ type: "tool-result", id: "call-1", result: "raw one" }] },
        { role: "tool", content: [{ type: "tool-result", id: "call-2", result: "raw two" }] },
    );
    const anchor = generateReplayAnchor(raw.messages);
    expect(anchor?.id).toBe("a");
    expect(anchor?.tail).toEqual(raw.messages.slice(2));
    const served = structuredClone(raw);
    served.system = [{ text: "final system" }];
    served.tools = { tool: { description: "final description", input: {} } };
    served.messages[0]!.content[0]!.text = "<session-history>final summary</session-history>";
    served.messages[2]!.content[0]!.result = "§1§ managed one";
    served.messages[3]!.content[0]!.result = "[dropped]";
    served.messages.push({
        role: "tool",
        content: [{ type: "tool-result", id: "mc", result: "managed synthetic" }],
    });
    replay.capture(served, anchor);
    const input = structuredClone(raw);
    const live = [
        { id: "final", role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "btw" }] },
    ];
    input.messages.push(...live);
    const next = structuredClone(input);
    expect(replay.apply(input)).toBe(true);
    expect(JSON.stringify(input.messages)).toBe(JSON.stringify([...served.messages, ...live]));
    expect(input.system).toEqual(served.system);
    expect(input.tools).toEqual(served.tools);
    input.messages[2]!.content[0]!.result = "caller mutation";
    anchor!.tail[0]!.content[0]!.result = "anchor mutation";
    expect(replay.apply(next)).toBe(true);
    expect(next.messages).toEqual([...served.messages, ...live]);
});

test("generate rejects a changed or missing id-less anchor tail without consuming live messages", () => {
    const replay = new V2GenerateReplay();
    const served = draft();
    const anchor = generateReplayAnchor([
        ...served.messages,
        { role: "tool", content: [{ type: "tool-result", id: "call", result: "raw" }] },
    ]);
    replay.capture(served, anchor);
    for (const tail of [
        [],
        [{ role: "tool", content: [{ type: "tool-result", id: "call", result: "changed" }] }],
        [{ role: "user", content: [{ type: "text", text: "btw" }] }],
    ]) {
        const input = draft();
        input.messages.push(...tail);
        const before = JSON.stringify(input);
        expect(replay.apply(input)).toBe(false);
        expect(JSON.stringify(input)).toBe(before);
    }
});

test("generate leaves an earlier host edit intact even when the anchor and tail match", () => {
    const replay = new V2GenerateReplay();
    const raw = draft();
    raw.messages.push(
        { id: "a", role: "assistant", content: [{ type: "tool-call", id: "call" }] },
        { role: "tool", content: [{ type: "tool-result", id: "call", result: "raw" }] },
    );
    const served = structuredClone(raw);
    served.messages[0]!.content[0]!.text = "managed question";
    replay.capture(served, generateReplayAnchor(raw.messages));

    const input = structuredClone(raw);
    input.messages[0]!.content[0]!.text = "redacted";
    input.messages.push({ role: "user", content: [{ type: "text", text: "btw" }] });
    const bytes = JSON.stringify(input);
    const applied = replay.apply(input);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(applied).toBe(false);
});

test("generate logs each capture and apply skip once", () => {
    const logging = spyOn(logger, "sessionLog").mockImplementation(() => {});
    logging.mockClear();
    try {
        const replay = new V2GenerateReplay();
        const input = draft();
        expect(replay.apply(input)).toBe(false);
        replay.capture(input, generateReplayAnchor([{ ...input.messages[0]!, id: "missing" }]));
        expect(replay.apply(input)).toBe(false);
        replay.capture(input, generateReplayAnchor(input.messages));
        input.model.id = "other";
        expect(replay.apply(input)).toBe(false);
        input.model.id = "m";
        input.agent = "other";
        expect(replay.apply(input)).toBe(false);
        input.agent = "a";
        replay.capture(
            input,
            generateReplayAnchor([...input.messages, { role: "tool", content: [] }]),
        );
        expect(replay.apply(input)).toBe(false);
        const idless = [{ role: "tool", content: [] }];
        expect(generateReplayAnchor(idless)).toBeUndefined();
        replay.capture(input, generateReplayAnchor(idless));
        expect(replay.apply(input)).toBe(false);
        expect(logging.mock.calls.map((call) => call.slice(0, 2))).toEqual([
            ["s", "generate replay apply skipped: no-prefix"],
            ["s", "generate replay apply skipped: anchor-not-found"],
            ["s", "generate replay apply skipped: model-mismatch"],
            ["s", "generate replay apply skipped: agent-mismatch"],
            ["s", "generate replay apply skipped: anchor-tail-mismatch"],
            ["s", "generate replay capture skipped: no-anchor"],
            ["s", "generate replay apply skipped: no-prefix"],
        ]);
    } finally {
        logging.mockRestore();
    }
});

const sized = (sessionID: string, chars: number, label = "served"): SessionContext => ({
    ...draft(),
    sessionID,
    system: [{ text: `${label} system` }],
    messages: [
        {
            id: `${sessionID}-u`,
            role: "user",
            content: [{ type: "text", text: "x".repeat(chars) }],
        },
        { id: `${sessionID}-a`, role: "assistant", content: [{ type: "text", text: label }] },
    ],
});

/** The host's request for a side question: its raw history plus the new question. */
const sideQuestion = (sessionID: string, chars = 100): SessionContext => {
    const input = sized(sessionID, chars, "raw");
    input.messages.push({ role: "user", content: [{ type: "text", text: "btw" }] });
    return input;
};

const capture = (replay: V2GenerateReplay, served: SessionContext) => {
    const anchor = generateReplayAnchor(served.messages);
    replay.capture(served, anchor);
};

test("generate replay keeps at most maxSessions sessions and evicts the least recently used", () => {
    const replay = new V2GenerateReplay({
        maxSessions: 3,
        sessionMaxBytes: 1024 * 1024,
        totalMaxBytes: 1024 * 1024,
    });
    for (let index = 0; index < 10; index++) capture(replay, sized(`s${index}`, 100));
    expect(replay.stats().sessions.map((entry) => entry.sessionId)).toEqual(["s7", "s8", "s9"]);
    // Replaying s7 makes it the most recently used, so the next capture evicts s8.
    expect(replay.apply(sideQuestion("s7"))).toBe(true);
    capture(replay, sized("s10", 100));
    expect(replay.stats().sessions.map((entry) => entry.sessionId)).toEqual(["s9", "s7", "s10"]);
    for (const evicted of ["s0", "s6", "s8"]) {
        const input = sideQuestion(evicted);
        const before = JSON.stringify(input);
        expect(replay.apply(input)).toBe(false);
        expect(JSON.stringify(input)).toBe(before);
    }
});

test("generate replay keeps the summed byte estimate under its total cap", () => {
    const probe = new V2GenerateReplay();
    capture(probe, sized("probe", 20_000));
    const one = probe.stats().totalBytes;
    // The estimator charges each of the 20,000 ASCII characters at two bytes.
    expect(one).toBeGreaterThan(40_000);
    expect(one).toBeLessThan(42_000);
    const totalMaxBytes = Math.floor(one * 2.5);
    const replay = new V2GenerateReplay({
        maxSessions: 16,
        sessionMaxBytes: totalMaxBytes,
        totalMaxBytes,
    });
    for (let index = 0; index < 12; index++) {
        capture(replay, sized(`s${index}`, 20_000));
        const stats = replay.stats();
        expect(stats.totalBytes).toBeLessThanOrEqual(totalMaxBytes);
        expect(stats.totalBytes).toBe(stats.sessions.reduce((sum, entry) => sum + entry.bytes, 0));
    }
    expect(replay.stats().sessions.map((entry) => entry.sessionId)).toEqual(["s10", "s11"]);
    // Recapturing a kept session replaces its charge rather than adding to it.
    const kept = replay.stats().totalBytes;
    capture(replay, sized("s11", 20_000));
    expect(replay.stats().totalBytes).toBe(kept);
    replay.forget("s10");
    replay.forget("s11");
    expect(replay.stats()).toEqual({ totalBytes: 0, sessions: [] });
});

test("generate replay after eviction leaves the host request as built, then replays the next capture exactly", () => {
    const replay = new V2GenerateReplay({
        maxSessions: 1,
        sessionMaxBytes: 1024 * 1024,
        totalMaxBytes: 1024 * 1024,
    });
    capture(replay, sized("a", 100, "first served"));
    capture(replay, sized("b", 100));
    // Evicted: the host's own request goes out unchanged, as after a restart.
    const cold = sideQuestion("a");
    const raw = JSON.stringify(cold);
    expect(replay.apply(cold)).toBe(false);
    expect(JSON.stringify(cold)).toBe(raw);
    // The session's next main request captures again; a replay then serves that
    // request's bytes, never the evicted one's.
    const served = sized("a", 100, "second served");
    capture(replay, served);
    const warm = sideQuestion("a");
    expect(replay.apply(warm)).toBe(true);
    expect(JSON.stringify(warm.messages)).toBe(
        JSON.stringify([...served.messages, ...sideQuestion("a").messages.slice(2)]),
    );
    expect(JSON.stringify(warm.system)).toBe(JSON.stringify(served.system));
    expect(JSON.stringify(warm)).not.toContain("first served");
});

test("generate replay drops a session's older request when its new request is over the per-session cap", () => {
    const replay = new V2GenerateReplay({
        maxSessions: 16,
        sessionMaxBytes: 10_000,
        totalMaxBytes: 1024 * 1024,
    });
    capture(replay, sized("s", 100, "older served"));
    expect(replay.stats().sessions).toHaveLength(1);
    capture(replay, sized("s", 10_000, "too large"));
    expect(replay.stats()).toEqual({ totalBytes: 0, sessions: [] });
    const input = sideQuestion("s");
    const before = JSON.stringify(input);
    expect(replay.apply(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
});

test("generate replay hands back host class instances by reference, as the host requires", () => {
    class Asset {
        constructor(readonly bytes: Uint8Array) {}
    }
    const asset = new Asset(new Uint8Array(4096));
    const replay = new V2GenerateReplay();
    const served = sized("s", 10);
    served.messages[0]!.content.push({ type: "media", media: asset });
    capture(replay, served);
    expect(replay.stats().totalBytes).toBeGreaterThan(4096);
    const input = sideQuestion("s", 10);
    input.messages[0]!.content.push({ type: "media", media: new Asset(new Uint8Array(4096)) });
    expect(replay.apply(input)).toBe(true);
    expect(input.messages[0]!.content[1]!.media).toBe(asset);
    expect(input.messages[0]).not.toBe(served.messages[0]);
});
