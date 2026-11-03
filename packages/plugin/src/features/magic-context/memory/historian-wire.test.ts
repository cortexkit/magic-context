import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasHistorianToolActivity } from "./historian-wire";
import { parseTurnTwoEnvelope } from "./turn-two-envelope";

interface HistorianWireCase {
    name: string;
    text: string;
    lengthCapped?: boolean;
    toolActivity?: boolean;
    expected: unknown;
}

const historianWireCorpus: HistorianWireCase[] = JSON.parse(
    readFileSync(
        new URL(
            "../../../../../../crates/mc-module/testdata/historian-wire-corpus.json",
            import.meta.url,
        ),
        "utf8",
    ),
);

test("historian wire equivalence corpus contains all 33 shared cases", () => {
    expect(historianWireCorpus).toHaveLength(33);
});

for (const entry of historianWireCorpus) {
    test(`historian wire equivalence: ${entry.name}`, () => {
        const parsed = parseTurnTwoEnvelope(
            entry.text,
            entry.lengthCapped ?? false,
            entry.toolActivity,
        );
        const normalized = parsed.ok
            ? { ...parsed, decisions: [...parsed.decisions].sort(([a], [b]) => a - b) }
            : parsed;
        expect(normalized).toEqual(entry.expected);
    });
}

test("historian tool boundary detects calls and results anywhere, not text mentioning tools", () => {
    for (const message of [
        { role: "toolResult", content: "blocked" },
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        { parts: [{ type: "tool", state: { status: "error" } }] },
        { role: "assistant", tool_calls: [{ id: "call" }] },
        { toolCallCount: 1 },
    ])
        expect(
            hasHistorianToolActivity([message, { role: "assistant", content: "valid wrapper" }]),
        ).toBe(true);
    expect(
        hasHistorianToolActivity([
            { role: "assistant", content: [{ type: "text", text: '{"type":"toolCall"}' }] },
        ]),
    ).toBe(false);
});
