import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveTurnOneFactAnchor } from "../../src/features/magic-context/memory/turn-one-publication";
import { parseTurnTwoEnvelope } from "../../src/features/magic-context/memory/turn-two-envelope";
import { rankTurnTwoNeighbours } from "../../src/features/magic-context/memory/turn-two-retrieval";
import { splitFactAnchorPrefix } from "../../src/hooks/magic-context/compartment-parser";
import {
    buildCompartmentAgentPrompt,
    HISTORIAN_FACT_ANCHOR_INSTRUCTION,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import { renderHistorianSystemPrompt } from "../../src/hooks/magic-context/historian-prompt-render";
import {
    readSessionChunk,
    withRawMessageProvider,
} from "../../src/hooks/magic-context/read-session-chunk";
import {
    TWO_PASS_SYSTEM,
    TWO_PASS_TURN_ONE,
    TWO_PASS_TURN_TWO,
} from "../../src/hooks/magic-context/two-pass-prompts/prompts.generated";
import { type RawExport, withRawInput } from "./input";
import { mockCases } from "./mock";
import { request, requestHash, turnOne, turnTwo } from "./prompts";

test("one-pass request bytes match the pre-change golden", () => {
    const user = buildCompartmentAgentPrompt({
        seedExamples: "",
        sessionReferences: "",
        projectMemory: "",
        inputSource: "Messages 1-1:\n\n[1] user: Always serialize DeepSeek requests.",
        memoryEnabled: true,
    });
    expect(
        requestHash(
            request([
                { role: "system", content: historianSystemPrompt(false) },
                { role: "user", content: user },
            ]),
        ),
    ).toBe("bf7a456af52247caa45256d46935e776143d9a95bda10483545c6139308acfdb");
    const messages = [1, 2, 3].map((ordinal) => ({
        id: `m${ordinal}`,
        ordinal,
        role: ordinal === 3 ? "user" : "assistant",
        parts: [{ type: "text", text: ordinal === 3 ? "Keep all words." : `Statement ${ordinal}` }],
    }));
    const text = withRawMessageProvider(
        "one-pass-byte-test",
        { readMessages: () => messages, getMessageCount: () => 3 },
        () => readSessionChunk("one-pass-byte-test", 10000).text,
    );
    expect(text).toBe("[1-2] A: Statement 1 / Statement 2\n[3] U: Keep all words.");
    const mixed = buildCompartmentAgentPrompt({
        seedExamples: "",
        sessionReferences: "",
        projectMemory: "",
        inputSource: `Messages 1-3:\n\n${text}`,
        memoryEnabled: true,
    });
    expect(
        requestHash(
            request([
                { role: "system", content: historianSystemPrompt(false) },
                { role: "user", content: mixed },
            ]),
        ),
    ).toBe("d56167cdd33a2279f0126416bb6f5919f8ad5188c68b31de9b52976366018b35");
});

test("dedicated source files render without changing user-authored text", () => {
    const source = (name: string) =>
        readFileSync(
            new URL(`../../src/hooks/magic-context/two-pass-prompts/${name}.md`, import.meta.url),
            "utf8",
        );
    expect(TWO_PASS_SYSTEM).toBe(renderHistorianSystemPrompt(source("system"), "combined"));
    expect(historianSystemPrompt(true)).toBe(TWO_PASS_SYSTEM);
    expect(HISTORIAN_FACT_ANCHOR_INSTRUCTION).toBe(source("turn-one"));
    expect(TWO_PASS_TURN_ONE).toBe(source("turn-one"));
    expect(TWO_PASS_TURN_TWO).toBe(source("turn-two"));
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(hash(source("system"))).toBe(
        "c7a0e4290bae4524f386bb0857ee79160fcce32bd39e30fee7eb919962ccaa0a",
    );
    expect(hash(source("turn-one"))).toBe(
        "3b57ca8b5a9a59f4e8a9af8cf432706c770ae5783b4d5facf951a99bc37b17fc",
    );
    expect(hash(source("turn-two"))).toBe(
        "7d84dda119f55f26702fca5d9392aaeac66bbf3b804ec7901fdc045ed9f21ca7",
    );
});

test("two-pass input keeps commit hashes in their sentence and the search prefix", () => {
    const sentence =
        "Committed the probe. Green run: daemon from a1b2c3d; red runs: daemon from b2c3d4e, then c3d4e5f.";
    const messages = [
        {
            id: "commit-message",
            ordinal: 1,
            role: "assistant",
            parts: [{ type: "text", text: sentence }],
        },
    ];
    const render = (singleMessageLines: boolean) =>
        withRawMessageProvider(
            "commit-input-test",
            { readMessages: () => messages, getMessageCount: () => 1 },
            () => readSessionChunk("commit-input-test", 10000, 1, 2, { singleMessageLines }).text,
        );
    const prefix = "[1] A: commits: a1b2c3d, b2c3d4e, c3d4e5f ";
    expect(render(false)).toBe(
        `${prefix}Committed the probe. Green run: daemon from; red runs: daemon from, then.`,
    );
    expect(render(true)).toBe(`${prefix}${sentence}`);
});

test("whole-chunk and fourth-range anchors are unknown; three precise ranges resolve", () => {
    const compartments = [{ startMessage: 1, endMessage: 6 }];
    const blocks = [1, 2, 3, 4, 5, 6].map((n) => ({ startOrdinal: n, endOrdinal: n }));
    const parsed = (ranges: string) =>
        splitFactAnchorPrefix(`[at_compartment=1 messages=${ranges}] The rule.`);
    expect(resolveTurnOneFactAnchor(parsed("1-6").anchor, compartments, blocks)).toBeNull();
    expect(parsed("1,2,3,4")).toEqual({ content: "The rule." });
    expect(
        resolveTurnOneFactAnchor(parsed("1-2,4,5").anchor, compartments, blocks)?.blockIndexes,
    ).toEqual([0, 1, 3, 4]);
    expect(resolveTurnOneFactAnchor(parsed("1-6,4").anchor, compartments, blocks)).toBeNull();
    expect(resolveTurnOneFactAnchor(parsed("1-2,9").anchor, compartments, blocks)).toBeNull();
    expect(parsed("1,9007199254740992").anchor).toBeUndefined();
});

function rawFixture() {
    const fixture = mockCases([0])[0];
    const lines = [1, 2, 3, 4].map((ordinal) => ({ ordinal, messageId: `m${ordinal}` }));
    const raw: RawExport = {
        case: fixture.id,
        messages: lines.map((line) => ({
            ...line,
            sessionId: "parent",
            timeCreated: line.ordinal,
            message: { role: line.ordinal === 4 ? "user" : "assistant" },
            parts: [
                {
                    id: `p${line.ordinal}`,
                    timeCreated: line.ordinal,
                    data:
                        line.ordinal === 2
                            ? {
                                  type: "tool",
                                  tool: "bash",
                                  state: {
                                      status: "completed",
                                      input: { command: "bun run build" },
                                      title: "Build plugin",
                                      output: "ok",
                                  },
                              }
                            : {
                                  type: "text",
                                  text:
                                      line.ordinal === 4
                                          ? `Okay ${"longword".repeat(2000)} finalword`
                                          : `Statement ${line.ordinal}`,
                              },
                },
            ],
        })),
    };
    return withRawInput({ ...fixture, lines }, raw);
}

test("two-pass raw input has one line per message, TC summaries and uncut user text", () => {
    const result = rawFixture();
    expect(result.blocks.map((block) => [block.startOrdinal, block.endOrdinal])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
    ]);
    const prompt = turnOne(result).messages[1].content;
    expect(prompt).toContain("[1] A: Statement 1\n[2] A: TC:");
    expect(prompt).toContain("[3] A: Statement 3\n[4] U: Okay");
    expect(prompt).toContain(`${"longword".repeat(2000)} finalword`);
});

test("each multi-range citation is published as its own source block", async () => {
    const c = rawFixture();
    const xml =
        '<compartment start="1" end="4" title="Rule" importance="60" episode_type="decision"><p1>Statement</p1><p2>Statement</p2><p3>Statement</p3><p4>Statement</p4></compartment><facts><CONSTRAINTS>\n* [at_compartment=1 messages=1-2,3] Statement 1\n</CONSTRAINTS></facts><unprocessed_from>5</unprocessed_from>';
    const second = await turnTwo(
        c,
        turnOne(c),
        JSON.stringify({ result: { step: "turn_one", xml } }),
    );
    expect(second.facts[0].blocks.map((block) => [block.startOrdinal, block.endOrdinal])).toEqual([
        [1, 2],
        [3, 3],
    ]);
});

test("check is a required string audit field, not a decision gate", () => {
    const parse = (decision: unknown) =>
        parseTurnTwoEnvelope(
            JSON.stringify({
                result: {
                    step: "turn_two",
                    decisions: [decision, { fact_id: 2, check: "", action: "abstain" }],
                },
            }),
            false,
        );
    for (const check of [undefined, 4, null]) {
        const result = parse({ fact_id: 1, action: "new", check });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.decisions.get(1)).toBe("malformed");
        expect(result.decisions.get(2)).toEqual({
            factId: 2,
            ordinal: 1,
            action: "abstain",
            check: "",
        });
        expect(result.schemaValid).toBe(false);
    }
    const result = parse({ fact_id: 1, action: "new", check: "Fails every audit question." });
    if (!result.ok) throw new Error("parse failed");
    expect(result.decisions.get(1)).toEqual({
        factId: 1,
        ordinal: 0,
        action: "new",
        check: "Fails every audit question.",
    });
    expect(result.schemaValid).toBe(true);
});

test("neighbours are ranked, capped at three and not padded with keyword hits", () => {
    const neighbour = (id: number, content: string) => ({
        id,
        revision: 1,
        category: "CONSTRAINTS",
        content,
    });
    const matches = rankTurnTwoNeighbours("SQLite cache limit is 64 KiB", [
        neighbour(1, "SQLite transactions cannot nest"),
        neighbour(2, "Cache eviction measured"),
        ...[3, 4, 5, 6].map((id) => neighbour(id, "SQLite cache limit is 64 KiB")),
    ]);
    expect(matches.map((n) => n.id)).toEqual([3, 4, 5]);
    expect(
        rankTurnTwoNeighbours("SQLite cache limit is 64 KiB", [
            neighbour(1, "SQLite transactions cannot nest"),
        ]),
    ).toEqual([]);
});
