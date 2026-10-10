/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildToolArcs } from "./read-session-true-raw-tokens";

describe("buildToolArcs", () => {
    it("pairs invocations with results without serializing tool inputs or outputs", () => {
        // The compartment trigger builds arcs over the eligible tail on every pass;
        // serializing each tool input there cost seconds on large inputs.
        let reads = 0;
        const counted = (value: string) => {
            const input: Record<string, unknown> = {};
            Object.defineProperty(input, "body", {
                enumerable: true,
                get: () => {
                    reads += 1;
                    return value;
                },
            });
            return input;
        };
        const messages = [
            {
                ordinal: 1,
                id: "a1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        state: { status: "completed", input: counted("x"), output: counted("y") },
                    },
                    { type: "tool-invocation", callId: "call-2", args: counted("z") },
                ],
            },
            {
                ordinal: 2,
                id: "u2",
                role: "user",
                parts: [{ type: "tool_result", tool_call_id: "call-2", content: [counted("r")] }],
            },
        ];
        const arcs = buildToolArcs(messages as never);
        expect(arcs).toEqual([
            { callId: "call-1", invOrdinal: 1, resOrdinal: 1 },
            { callId: "call-2", invOrdinal: 1, resOrdinal: 2 },
        ]);
        expect(reads).toBe(0);
    });
});
