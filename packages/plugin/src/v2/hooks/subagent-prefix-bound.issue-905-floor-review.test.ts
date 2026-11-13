/// <reference types="bun-types" />
// Review witness for the emergency planner's "removed this pass" credit
// (issue 905 follow-up). The planner takes the mass that this pass's queued
// drops removed off the provider's reading of the previous request. That credit
// must only cover content the previous request carried.
//
// On a prefix-bound model the proactive thinking strip removes reasoning at the
// end of a pass (finalizeMessageRepresentation), and later passes replay that
// strip at the same point. The served-mass snapshot is taken earlier in the
// pass, while the host's fresh messages still hold the original reasoning
// text, so a queued drop that neutralizes the reasoning beside an old call is
// credited with reasoning the previous request never sent.
//
// A tool call's reasoning is attached to its drop target only when the step's
// assistant message has no text part (tag-messages.ts), which is the usual
// shape of a tool step. The session fixture gives every step a text part, so
// the second run below removes it from tool steps as the host renders them.
//
// The run is the OpenCode 2 subagent session of issue 905 (see
// __tests__/issue-905-subagent.fixture.ts), with visible thinking. Each pass's
// usage reading is exactly what the previous pass served, so the reasoning the
// previous request carried is known.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as emergencyDrop from "../../hooks/magic-context/emergency-drop";
import * as restore from "../fold/restore";
import { type Issue905Run, runIssue905Session } from "./__tests__/issue-905-subagent.fixture";

type Credit = {
    total: number;
    reasoning: number;
    /** Reasoning credit by the id of the assistant message that holds the part. */
    byMessage: Array<{ messageId: string; tokens: number }>;
};

let credits: Credit[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
let snapshotSpy: ReturnType<typeof spyOn> | undefined;
let partOwners = new Map<unknown, string>();
let withStepText: { run: Issue905Run; credits: Credit[] };
let toolStepsWithoutText: { run: Issue905Run; credits: Credit[] };

beforeAll(async () => {
    const original = emergencyDrop.emergencyServedMassRemovedSince;
    spy = spyOn(emergencyDrop, "emergencyServedMassRemovedSince").mockImplementation(
        (snapshot, targets, calibration, measuredNow) => {
            const total = original(snapshot, targets, calibration, measuredNow);
            // The same measurement without the reasoning entries: what is left is
            // the credit for reasoning the pass's drops neutralized.
            const toolsOnly = original(
                { tags: snapshot.tags, reasoning: new Map() },
                targets,
                calibration,
                measuredNow,
            );
            const byMessage: Credit["byMessage"] = [];
            for (const [part, before] of snapshot.reasoning) {
                const tokens = original(
                    { tags: new Map(), reasoning: new Map([[part, before]]) },
                    targets,
                    calibration,
                    measuredNow,
                );
                if (tokens > 0) byMessage.push({ messageId: partOwners.get(part) ?? "?", tokens });
            }
            credits.push({ total, reasoning: total - toolsOnly, byMessage });
            return total;
        },
    );
    const originalSnapshot = emergencyDrop.snapshotEmergencyServedMass;
    snapshotSpy = spyOn(emergencyDrop, "snapshotEmergencyServedMass").mockImplementation(
        (tags, targets, calibration, messages) => {
            partOwners = new Map();
            for (const message of messages)
                for (const part of message.parts)
                    partOwners.set(part, String(message.info.id ?? "?"));
            return originalSnapshot(tags, targets, calibration, messages);
        },
    );
    credits = [];
    withStepText = { run: await runIssue905Session({ seed: 905, steps: 136 }), credits };

    const originalRestore = restore.restoreRow;
    const restoreSpy = spyOn(restore, "restoreRow").mockImplementation((...args) => {
        const rendered = originalRestore(...args);
        for (const message of rendered) {
            if (message.role !== "assistant") continue;
            const content = message.content as Array<Record<string, unknown>>;
            if (!content.some((part) => part.type === "tool-call")) continue;
            message.content = content.filter((part) => part.type !== "text") as never;
        }
        return rendered;
    });
    try {
        credits = [];
        toolStepsWithoutText = {
            run: await runIssue905Session({ seed: 905, steps: 136 }),
            credits,
        };
    } finally {
        restoreSpy.mockRestore();
    }
}, 900_000);

afterAll(() => {
    spy?.mockRestore();
    snapshotSpy?.mockRestore();
});

function overCredited(run: Issue905Run, runCredits: Credit[]): string[] {
    const planned = run.passes.filter((pass) => pass.emergency !== null);
    // One credit per planner run, in pass order.
    expect(runCredits.length).toBe(planned.length);
    expect(planned.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const [index, pass] of planned.entries()) {
        const before = run.passes[pass.step - 2];
        if (!before) continue;
        const credit = runCredits[index]!;
        // Every reasoning token the previous request carried, visible or not.
        const carried = before.served.thinking + before.served.hiddenThinking;
        if (process.env.MC_905_REVIEW_DEBUG)
            console.log(
                `debug step ${pass.step}: credit ${Math.round(credit.total)} reasoning ${Math.round(credit.reasoning)} carried ${carried} blocks ${before.served.thinkingBlocks} :: ${pass.emergency}`,
            );
        // Calibration may drift from the fixture's static ratios; allow 10%.
        if (credit.reasoning > carried * 1.1 + 64)
            found.push(
                `step ${pass.step}: reasoning credit ${Math.round(credit.reasoning)} of total ${Math.round(credit.total)}, previous request carried ${carried} reasoning tokens (${pass.emergency})`,
            );
    }
    if (found.length > 0) console.log(found.join("\n"));
    return found;
}

describe("issue 905 review: removed-this-pass credit for reasoning", () => {
    test("control: steps with a text part attach no reasoning to their drops, so none is credited", () => {
        expect(overCredited(withStepText.run, withStepText.credits)).toEqual([]);
        expect(withStepText.credits.every((credit) => credit.reasoning === 0)).toBe(true);
    });

    test("tool steps without text: the credit never counts reasoning the previous request did not send", () => {
        expect(overCredited(toolStepsWithoutText.run, toolStepsWithoutText.credits)).toEqual([]);
    });

    test("tool steps without text: the planner's fixed floor never falls below the system prompt and tool definitions", () => {
        // The fixture's provider counts 27,000 tokens of system prompt and tool
        // definitions on every request; no tool drop can remove them, so a floor
        // below that has subtracted something twice.
        const floors = toolStepsWithoutText.run.passes
            .filter((pass) => pass.emergencyFloor !== null)
            .map((pass) => ({ step: pass.step, floor: Math.round(pass.emergencyFloor!) }));
        expect(floors.length).toBeGreaterThan(0);
        const below = floors.filter(({ floor }) => floor < 27_000);
        if (below.length > 0) console.log(JSON.stringify(below));
        expect(below).toEqual([]);
    });

    test("tool steps without text: no reasoning an earlier pass's thinking strip already took off the request is credited as removed again", () => {
        const { run, credits: runCredits } = toolStepsWithoutText;
        const planned = run.passes.filter((pass) => pass.emergency !== null);
        expect(runCredits.length).toBe(planned.length);
        const recredited: string[] = [];
        for (const [index, pass] of planned.entries()) {
            // Assistants whose thinking an earlier pass stripped: no request
            // after that pass carried it, the previous one included.
            const stripped = new Set(
                run.passes
                    .filter((earlier) => earlier.step < pass.step)
                    .flatMap((earlier) => earlier.proactiveStripIds),
            );
            const again = runCredits[index]!.byMessage.filter((entry) =>
                stripped.has(entry.messageId),
            );
            if (again.length > 0)
                recredited.push(
                    `step ${pass.step}: ${again.length} stripped block(s) credited again, ${Math.round(again.reduce((sum, entry) => sum + entry.tokens, 0))} tokens (${pass.emergency})`,
                );
        }
        if (recredited.length > 0) console.log(recredited.join("\n"));
        expect(recredited).toEqual([]);
    });
});
