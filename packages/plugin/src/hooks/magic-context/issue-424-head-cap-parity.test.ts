import { expect, test } from "bun:test";

import fixtureSet from "../../../test-fixtures/runtime/issue-424-head-cap.json";
import { applyHeadCap } from "./protected-tail-boundary";
import type { RawMessage } from "./read-session-raw";
import {
    buildToolArcs,
    buildTrueRawTokenIndexFromTokenCountsForTest,
    completedToolArcCrossesBoundary,
} from "./read-session-true-raw-tokens";

function fixtureMessages(
    tokens: readonly number[],
    fixtureArcs: ReadonlyArray<{
        invOrdinal: number;
        resOrdinal: number | null;
        result_shape?: string;
    }>,
): RawMessage[] {
    const messages = tokens.map((_, index) => ({
        id: `fixture-${index + 1}`,
        ordinal: index + 1,
        role: "assistant",
        parts: [] as unknown[],
    }));
    for (const [index, arc] of fixtureArcs.entries()) {
        const callID = `fixture-call-${index}`;
        messages[arc.invOrdinal - 1]?.parts.push({
            type: "tool",
            callID,
            state: { input: { fixture: true } },
        });
        if (arc.resOrdinal === null) continue;
        const state =
            arc.result_shape === "error"
                ? { status: "error", error: "fixture error" }
                : { status: "completed", output: arc.result_shape === "empty" ? "" : "fixture" };
        messages[arc.resOrdinal - 1]?.parts.push({ type: "tool", callID, state });
    }
    return messages;
}

test("issue 424 head cap matches shared Rust differential cases", () => {
    for (const fixture of fixtureSet.cases) {
        const arcs = buildToolArcs(fixtureMessages(fixture.tokens, fixture.arcs));
        const result = applyHeadCap({
            index: buildTrueRawTokenIndexFromTokenCountsForTest(fixture.label, fixture.tokens),
            arcs,
            offset: fixture.offset,
            lastCompartmentEndOrdinal: fixture.offset - 1,
            protectedTailStart: fixture.protected_tail_start,
            capTokens: fixture.cap_tokens,
            recentOpenArcCutoff: fixture.recent_open_arc_cutoff,
        });
        expect(result.eligibleEndOrdinal, fixture.label).toBe(fixture.expected_end);
        expect(result.oversizeAtomicUnit, fixture.label).toBe(fixture.expected_oversize);
        for (const arc of arcs) {
            if (arc.resOrdinal !== null)
                expect(
                    completedToolArcCrossesBoundary(
                        arc.invOrdinal,
                        arc.resOrdinal,
                        result.eligibleEndOrdinal,
                    ),
                    fixture.label,
                ).toBe(false);
        }
    }
});
