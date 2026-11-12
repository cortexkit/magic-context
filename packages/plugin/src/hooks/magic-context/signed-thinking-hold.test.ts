import { describe, expect, it } from "bun:test";
import { escalationBands } from "../../shared/escalation-bands";
import { forceBandConfirmed } from "./routine-cleanup-decision";
import {
    decideSignedThinkingHold,
    recordedReasoningTokens,
    stepReasoningTokens,
} from "./signed-thinking-hold";

// One character per token keeps the text-estimate cases readable.
const charTokens = (text: string) => text.length;

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

function user(id: string, synthetic = false): Message {
    return {
        info: { id, role: "user" },
        parts: [{ type: "text", text: id, ...(synthetic ? { synthetic: true } : {}) }],
    };
}

function step(id: string, reasoningTokens: number, text = "short thought"): Message {
    return {
        info: {
            id,
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: reasoningTokens },
        },
        parts: [
            { type: "reasoning", text, metadata: { anthropic: { signature: `sig-${id}` } } },
            { type: "tool", callID: `call-${id}`, tool: "read", state: { status: "completed" } },
        ],
    };
}

/** A turn of `count` light steps, with a heavy step `heavyBack` steps from the newest. */
function turn(count: number, heavy: Array<{ back: number; tokens: number }>): Message[] {
    const messages: Message[] = [user("old-user"), step("old-heavy", 9_000), user("task")];
    for (let index = 0; index < count; index++) {
        const back = count - index;
        const tokens = heavy.find((entry) => entry.back === back)?.tokens ?? 200;
        messages.push(step(`step-${index}`, tokens));
    }
    return messages;
}

/** The force-band predicate the OpenCode transform passes for a reading. */
const forceBand = (threshold: number, usage: number, fromEstimate = false) =>
    forceBandConfirmed({
        percentage: usage,
        fromEstimate,
        forceMaterializationPercentage: escalationBands(threshold).forceMaterializationPercentage,
        compactionOff: false,
    });

const decide = (messages: Message[], usagePercentage: number) =>
    decideSignedThinkingHold({
        messages,
        usagePercentage,
        executeThresholdPercentage: 65,
        forceBandPressure: forceBand(65, usagePercentage),
        estimateTextTokens: charTokens,
    });

describe("decideSignedThinkingHold", () => {
    it("holds with a 1,600-token step 3 steps back at 70%", () => {
        const decision = decide(turn(10, [{ back: 3, tokens: 1_600 }]), 70);
        expect(decision).toMatchObject({
            held: true,
            reason: "heavy_reasoning",
            heavyStepsBack: 3,
            heavyStepTokens: 1_600,
        });
    });

    it("does not hold at 76%: the cap always ends the hold", () => {
        const decision = decide(turn(10, [{ back: 3, tokens: 1_600 }]), 76);
        expect(decision.held).toBe(false);
        expect(decision.reason).toBe("above_cap");
        expect(decision.heavyStepsBack).toBe(3);
    });

    it("the cap is exclusive: held at 74.9%, not held at exactly 75%", () => {
        const messages = turn(10, [{ back: 3, tokens: 1_600 }]);
        expect(decide(messages, 74.9).held).toBe(true);
        expect(decide(messages, 75).held).toBe(false);
    });

    it("the cap follows the session's execute threshold", () => {
        const messages = turn(10, [{ back: 3, tokens: 1_600 }]);
        const at = (threshold: number, usage: number, fromEstimate = false) =>
            decideSignedThinkingHold({
                messages,
                usagePercentage: usage,
                executeThresholdPercentage: threshold,
                forceBandPressure: forceBand(threshold, usage, fromEstimate),
                estimateTextTokens: charTokens,
            });
        expect(at(50, 55).held).toBe(true);
        expect(at(50, 61).held).toBe(false);
        expect(at(80, 84.9).held).toBe(true);
    });

    it("never holds in the force band, which ends the hold before the cap when the threshold is above 75%", () => {
        const messages = turn(10, [{ back: 3, tokens: 1_600 }]);
        const at = (threshold: number, usage: number, fromEstimate = false) =>
            decideSignedThinkingHold({
                messages,
                usagePercentage: usage,
                executeThresholdPercentage: threshold,
                forceBandPressure: forceBand(threshold, usage, fromEstimate),
                estimateTextTokens: charTokens,
            });
        // Threshold 80%: cap 90%, force band from 85%.
        expect(at(80, 85)).toMatchObject({ held: false, reason: "force_band", capPercentage: 90 });
        // A reading only a local count raised is force-band pressure only at
        // 95%, so the hold runs until then and the cap ends it first.
        expect(at(80, 89.9, true).held).toBe(true);
        expect(at(80, 90, true).reason).toBe("above_cap");
        // Threshold 88%: cap 98%, force band from 90%; a local count from 95%.
        expect(at(88, 89.9).held).toBe(true);
        expect(at(88, 90).reason).toBe("force_band");
        expect(at(88, 94.9, true).held).toBe(true);
        expect(at(88, 95, true).reason).toBe("force_band");
    });

    it("at the default threshold the force band never ends a hold the cap has not already ended", () => {
        const messages = turn(10, [{ back: 3, tokens: 1_600 }]);
        for (const fromEstimate of [false, true])
            for (let tenths = 0; tenths <= 1_200; tenths++) {
                const usage = tenths / 10;
                const decision = decideSignedThinkingHold({
                    messages,
                    usagePercentage: usage,
                    executeThresholdPercentage: 65,
                    forceBandPressure: forceBand(65, usage, fromEstimate),
                    estimateTextTokens: charTokens,
                });
                expect(decision.reason).toBe(usage < 75 ? "heavy_reasoning" : "above_cap");
            }
    });

    it("does not hold when the heavy step is 16 steps back", () => {
        const decision = decide(turn(20, [{ back: 16, tokens: 1_600 }]), 70);
        expect(decision.held).toBe(false);
        expect(decision.reason).toBe("no_recent_heavy_reasoning");
        expect(decision.heavyStepsBack).toBeNull();
    });

    it("holds when the heavy step is exactly 15 steps back", () => {
        const decision = decide(turn(20, [{ back: 15, tokens: 1_600 }]), 70);
        expect(decision.held).toBe(true);
        expect(decision.heavyStepsBack).toBe(15);
    });

    it("a second heavy step extends the hold", () => {
        // The first heavy step has left the window; the second, newer one keeps
        // the pass held and is the one reported.
        const messages = turn(20, [
            { back: 17, tokens: 1_600 },
            { back: 9, tokens: 2_400 },
        ]);
        const decision = decide(messages, 70);
        expect(decision.held).toBe(true);
        expect(decision.heavyStepsBack).toBe(9);
        expect(decision.heavyStepTokens).toBe(2_400);
        // Without the second heavy step the same turn is not held.
        expect(decide(turn(20, [{ back: 17, tokens: 1_600 }]), 70).held).toBe(false);
    });

    it("does not hold with no heavy step at 66%", () => {
        const decision = decide(turn(10, []), 66);
        expect(decision.held).toBe(false);
        expect(decision.reason).toBe("no_recent_heavy_reasoning");
    });

    it("1,500 tokens is not heavy; 1,501 is", () => {
        expect(decide(turn(5, [{ back: 2, tokens: 1_500 }]), 70).held).toBe(false);
        expect(decide(turn(5, [{ back: 2, tokens: 1_501 }]), 70).held).toBe(true);
    });

    it("synthetic continuations stay inside the turn", () => {
        const messages = turn(4, [{ back: 4, tokens: 1_600 }]);
        // Todo continuations and background notices between the steps.
        messages.splice(5, 0, user("todo-continuation", true));
        messages.push(user("background-notice", true), step("after-notice", 100));
        const decision = decide(messages, 70);
        expect(decision.held).toBe(true);
        expect(decision.heavyStepsBack).toBe(5);
        // A real user message ends the turn: the heavy step no longer counts.
        messages.push(user("real-user"), step("next-turn", 100));
        expect(decide(messages, 70).held).toBe(false);
    });

    it("steps of an earlier turn never count", () => {
        // `old-heavy` (9,000 tokens) precedes the turn's real user message.
        expect(decide(turn(2, []), 70).held).toBe(false);
    });

    it("an assistant with no parts yet takes no slot in the window", () => {
        const messages = turn(15, [{ back: 15, tokens: 1_600 }]);
        messages.push({ info: { id: "pending", role: "assistant" }, parts: [] });
        expect(decide(messages, 70).heavyStepsBack).toBe(15);
    });

    it("estimates from stored thinking text when the host recorded no count", () => {
        const heavyText = step("text-heavy", 0, "x".repeat(3_000));
        const lightText = step("text-light", 0, "x".repeat(300));
        expect(stepReasoningTokens(heavyText, charTokens)).toBe(3_000);
        expect(stepReasoningTokens(lightText, charTokens)).toBe(300);
        expect(decide([user("task"), heavyText], 70).held).toBe(true);
        expect(decide([user("task"), lightText], 70).held).toBe(false);
    });

    it("a recorded count wins over the text estimate", () => {
        const recordedLight = step("recorded", 300, "x".repeat(5_000));
        expect(stepReasoningTokens(recordedLight, charTokens)).toBe(300);
        expect(decide([user("task"), recordedLight], 70).held).toBe(false);
    });

    it("reads Pi's usage.reasoning and Oh My Pi's usage.reasoningTokens", () => {
        const pi = {
            role: "assistant",
            usage: { input: 1, output: 2, reasoning: 1_700 },
            content: [{ type: "thinking", thinking: "short", thinkingSignature: "sig" }],
        };
        const omp = {
            role: "assistant",
            usage: { input: 1, output: 2, reasoningTokens: 1_800 },
            content: [{ type: "thinking", thinking: "short", thinkingSignature: "sig" }],
        };
        const piUser = { role: "user", content: [{ type: "text", text: "task" }] };
        expect(recordedReasoningTokens(pi)).toBe(1_700);
        expect(recordedReasoningTokens(omp)).toBe(1_800);
        expect(decide([piUser, pi] as never, 70).heavyStepTokens).toBe(1_700);
        expect(decide([piUser, omp] as never, 70).heavyStepTokens).toBe(1_800);
        // Pi tool results do not end the turn.
        const toolResult = {
            role: "toolResult",
            toolCallId: "call",
            content: [{ type: "text", text: "out" }],
        };
        const light = {
            role: "assistant",
            content: [{ type: "thinking", thinking: "short", thinkingSignature: "sig" }],
        };
        expect(decide([piUser, pi, toolResult, light] as never, 70).heavyStepsBack).toBe(2);
    });

    it("is a pure function of its input", () => {
        const messages = turn(12, [{ back: 6, tokens: 1_900 }]);
        const snapshot = JSON.stringify(messages);
        const first = decide(messages, 70);
        const second = decide(structuredClone(messages), 70);
        expect(second).toEqual(first);
        expect(JSON.stringify(messages)).toBe(snapshot);
    });
});
