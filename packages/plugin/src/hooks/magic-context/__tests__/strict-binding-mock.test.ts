import { describe, expect, it } from "bun:test";
import {
    BYTES_ERROR,
    beforeLastThinking,
    LATEST_TURN_ERROR,
    MIDDLE_ERROR,
    ORPHAN_ERROR,
    PREFIX_ERROR,
    StrictBindingMock,
    type Wire,
} from "./strict-binding-mock";

// The oracle must reject exactly what the provider rejects, or every audit
// result built on it is meaningless. These cases follow Anthropic's
// preserved-thinking rules one by one.

function user(text: string): Wire[number] {
    return { role: "user", content: [{ type: "text", text }] };
}
function step(thinking: Record<string, unknown> | null, call: string, output = "ok"): Wire {
    return [
        {
            role: "assistant",
            content: [
                ...(thinking ? [thinking as Wire[number]["content"][number]] : []),
                { type: "tool_use", id: call, name: "read", input: { path: call } },
            ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: output }] },
    ];
}

function loop(turns: number[]): { mock: StrictBindingMock; wire: Wire } {
    const mock = new StrictBindingMock();
    const wire: Wire = [];
    let call = 0;
    for (const steps of turns) {
        mock.newUserTurn();
        wire.push(user(`turn ${call}`));
        for (let i = 0; i < steps; i++) {
            const block = mock.respond(wire);
            wire.push(...step(block, `c${++call}`));
        }
    }
    return { mock, wire };
}

const thinkingIndexes = (wire: Wire) =>
    wire.flatMap((m, i) => (m.content.some((b) => b.type === "thinking") ? [i] : []));
const strip = (wire: Wire, indexes: number[]): Wire =>
    wire.map((m, i) =>
        indexes.includes(i) ? { ...m, content: m.content.filter((b) => b.type !== "thinking") } : m,
    );

describe("strict binding mock follows the documented rules", () => {
    it("accepts the unchanged transcript", () => {
        const { mock, wire } = loop([2, 3]);
        expect(mock.check(wire)).toBeNull();
    });

    it("rejects a shortened earlier tool_result even though that message has no thinking", () => {
        const { mock, wire } = loop([2, 3]);
        const edited = structuredClone(wire);
        edited[2]!.content[0]!.content = "o";
        expect(mock.check(edited)).toBe(PREFIX_ERROR);
    });

    it("rejects a changed earlier tool_use input", () => {
        const { mock, wire } = loop([2, 3]);
        const edited = structuredClone(wire);
        (edited[1]!.content[1] as { input: unknown }).input = { path: "other" };
        expect(mock.check(edited)).toBe(PREFIX_ERROR);
    });

    it("rejects removing an older unsigned arc before the current turn's thinking", () => {
        const { mock, wire } = loop([2, 3]);
        // Remove the first turn's second step (assistant + result) but keep thinking-free
        // structure otherwise: the current turn's blocks are bound to that arc.
        const edited = strip(structuredClone(wire), thinkingIndexes(wire).slice(0, 2));
        edited.splice(3, 2);
        expect(mock.check(edited)).toBe(PREFIX_ERROR);
    });

    it("accepts removing all older-turn thinking from the start while the current turn is kept", () => {
        const { mock, wire } = loop([2, 3]);
        expect(mock.check(strip(wire, thinkingIndexes(wire).slice(0, 2)))).toBeNull();
    });

    it("rejects removing older thinking from the middle", () => {
        const { mock, wire } = loop([3, 2]);
        expect(mock.check(strip(wire, [thinkingIndexes(wire)[1]!]))).toBe(MIDDLE_ERROR);
    });

    it("rejects removing thinking of the current turn", () => {
        const { mock, wire } = loop([1, 3]);
        expect(mock.check(strip(wire, [thinkingIndexes(wire).at(-1)!]))).toBe(LATEST_TURN_ERROR);
    });

    it("rejects changed thinking bytes", () => {
        const { mock, wire } = loop([1, 2]);
        const edited = structuredClone(wire);
        (edited[1]!.content[0] as { thinking: string }).thinking = "rewritten";
        expect(mock.check(edited)).toBe(BYTES_ERROR);
    });

    it("accepts an earlier edit once every older thinking block is stripped at a new user turn", () => {
        const { mock, wire } = loop([2, 2]);
        mock.newUserTurn();
        const next = strip(structuredClone(wire), thinkingIndexes(wire));
        next[2]!.content[0]!.content = "o";
        next.push(user("third turn"));
        expect(mock.check(next)).toBeNull();
    });

    it("rejects one side of a parallel tool arc removed after the last thinking block", () => {
        const { mock, wire } = loop([1, 2]);
        // The newest step calls two tools at once; its results arrive as separate tool
        // messages, which the SDK merges into one user message.
        const block = mock.respond(wire);
        const parallel: Wire = [
            ...wire,
            {
                role: "assistant",
                content: [
                    block!,
                    { type: "tool_use", id: "pa", name: "read", input: { path: "a" } },
                    { type: "tool_use", id: "pb", name: "read", input: { path: "b" } },
                ],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "pa", content: "a" }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "pb", content: "b" }] },
        ];
        expect(mock.check(parallel)).toBeNull();
        // Shortening the newest result is after every kept block: valid.
        const shortened = structuredClone(parallel);
        shortened.at(-1)!.content[0]!.content = "[dropped]";
        expect(mock.check(shortened)).toBeNull();
        // Removing it orphans its call, which binding alone would allow.
        expect(mock.check(parallel.slice(0, -1))).toBe(ORPHAN_ERROR);
        // Removing the call instead orphans the result.
        const withoutCall = structuredClone(parallel);
        withoutCall.at(-3)!.content.splice(2, 1);
        expect(mock.check(withoutCall)).toBe(ORPHAN_ERROR);
    });

    it("beforeLastThinking covers exactly the content a kept block binds", () => {
        const { wire } = loop([1, 2]);
        const tail = structuredClone(wire);
        tail.at(-1)!.content[0]!.content = "shortened";
        expect(beforeLastThinking(tail)).toBe(beforeLastThinking(wire));
        const earlier = structuredClone(wire);
        earlier[2]!.content[0]!.content = "shortened";
        expect(beforeLastThinking(earlier)).not.toBe(beforeLastThinking(wire));
    });
});
