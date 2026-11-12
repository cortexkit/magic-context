/// <reference types="bun-types" />
// Characterization of GitHub issue 905: an OpenCode 2 subagent on a
// prefix-bound thinking model (claude-mythos-5-2) that works on one task
// message as a single turn of many tool steps, with the reporter's limits
// (`limit.context` 302,222, `execute_threshold_tokens` 250,000,
// `protected_tokens` 16,000). The session runs through the real OpenCode 2
// context hook (see __tests__/issue-905-subagent.fixture.ts); usage readings are
// the size of what each request served. These tests pin today's behaviour, so
// a change to any of it shows up here.
import { beforeAll, describe, expect, test } from "bun:test";
import {
    hasMeasuredDecisionCalibration,
    resolveDecisionCalibration,
} from "../../hooks/magic-context/decision-calibration";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { decideSignedThinkingHold } from "../../hooks/magic-context/signed-thinking-hold";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { servesThinkingBlock } from "../../hooks/magic-context/transform-postprocess-phase";
import {
    ISSUE_905_CONTEXT,
    ISSUE_905_MODEL,
    type Issue905Pass,
    type Issue905Run,
    runIssue905Session,
} from "./__tests__/issue-905-subagent.fixture";

// 250,000 / 302,222 and ten points above it, as the transform logs them.
const THRESHOLD = 82.72064905930078;
const CAP = 92.72064905930078;

let visible: Issue905Run;
let omitted: Issue905Run;
let largeConversation: Issue905Run;
let withOutputLimit: Issue905Run;

beforeAll(async () => {
    // Visible thinking: a third of the steps think heavily (above the hold's
    // 1,500 tokens); the agent reduces every read two steps after it, except
    // every ninth, and every grep output.
    visible = await runIssue905Session({ seed: 905, steps: 136 });
    // The same agent with the thinking text omitted (only the signature is
    // stored, as with Anthropic's `display: "omitted"`); the host still
    // records each step's reasoning-token count.
    omitted = await runIssue905Session({ seed: 9051, steps: 70, thinking: "omitted" });
    // A conversation that no lane can shrink (a 100,000-token task message)
    // keeps the session near the threshold after each rebuild.
    largeConversation = await runIssue905Session({
        seed: 9052,
        steps: 60,
        thinking: "omitted",
        taskTokens: 100_000,
        activeReads: 14,
    });
    // The same model declared with an output limit as well.
    withOutputLimit = await runIssue905Session({
        seed: 9053,
        steps: 6,
        heavyShare: 1,
        limit: { context: ISSUE_905_CONTEXT, output: 32_000 },
    });
}, 600_000);

const strips = (run: Issue905Run) =>
    run.passes.filter((pass) => (pass.proactiveStripFroze ?? 0) > 0);
const previous = (run: Issue905Run, pass: Issue905Pass) => run.passes[pass.step - 2]!;

describe("issue 905, OpenCode 2 subagent, visible signed thinking", () => {
    test("the token threshold is 82.72% of the declared limit and the hold cap is ten points above it", () => {
        const thresholds = new Set(visible.passes.map((pass) => pass.threshold));
        expect([...thresholds]).toEqual([THRESHOLD]);
        const caps = new Set(
            visible.logs
                .filter((line) => line.includes("signed thinking hold: "))
                .map((line) => Number(/cap=([\d.]+)%/.exec(line)?.[1])),
        );
        expect([...caps]).toEqual([CAP]);
    });

    test("the hold line is logged when its step distance changes, not once per held pass", () => {
        const held = visible.passes.filter((pass) => pass.thinkingHold === true);
        const heldWithoutLine = held.filter((pass) => pass.holdLine === null);
        expect(held.length).toBeGreaterThan(20);
        expect(heldWithoutLine.length).toBeGreaterThan(0);
        // Every line that is logged names a new heavyStepsBack for the turn.
        expect(visible.passes.filter((pass) => pass.holdLine !== null).length).toBeLessThan(
            visible.passes.length,
        );
    });

    test("a held pass in the force band rebuilds nothing: no queued drop lands, the emergency drop finds no candidate, no thinking is stripped", () => {
        const heldInForceBand = visible.passes.filter(
            (pass) =>
                pass.thinkingHold === true &&
                (pass.mcPercentage ?? 0) >= 85 &&
                (pass.mcPercentage ?? 0) < CAP,
        );
        expect(heldInForceBand.length).toBeGreaterThanOrEqual(5);
        for (const pass of heldInForceBand) {
            // The force band lifts the hold's gate for the rewrite permission...
            expect(pass.rewriteAllowed).toBe(true);
            expect(pass.ride).toBe("force+subagentExecute");
            // ...but every edit before the turn's kept thinking stays protected.
            expect(pass.pendingQueuedBefore).toBeGreaterThan(0);
            expect(pass.pendingQueuedAfter).toBe(pass.pendingQueuedBefore);
            expect(pass.emergency).toContain("emergency tiered drop skipped: no-candidates");
            expect(pass.proactiveStripFroze).toBeNull();
            expect(pass.served.thinkingBlocks).toBeGreaterThanOrEqual(15);
        }
    });

    test("the first unheld pass lands every queued drop and strips the thinking of every assistant since the last strip", () => {
        const stripped = strips(visible);
        expect(stripped.length).toBeGreaterThanOrEqual(3);
        for (const pass of stripped) {
            expect(pass.thinkingHold).toBe(false);
            // Unheld in this run means above the cap.
            expect(pass.mcPercentage ?? 0).toBeGreaterThanOrEqual(CAP);
            // Every block the previous request served, plus the newest step's.
            expect(pass.proactiveStripFroze).toBe(
                previous(visible, pass).served.thinkingBlocks + 1,
            );
            expect(pass.served.thinkingBlocks).toBe(0);
            expect(pass.pendingQueuedAfter).toBeLessThan(pass.pendingQueuedBefore);
        }
    });

    test("no pass releases the signed prefix for a head change, and the reasoning-clearing lane never runs", () => {
        const permissions = visible.logs.filter((line) => line.includes("rewrite permission: "));
        expect(permissions.length).toBe(visible.passes.length);
        for (const line of permissions) {
            expect(line).toContain("signed_prefix_release=false");
            expect(line).toContain("recovery_has_head=false");
        }
        expect(visible.logs.some((line) => line.includes("reasoning removal: froze"))).toBe(false);
        expect(visible.logs.some((line) => line.includes("reasoning cleanup: "))).toBe(false);
        for (const pass of visible.passes)
            if (pass.removedReasoningParts !== null) expect(pass.removedReasoningParts).toBe(0);
    });

    test("after every strip the session falls below the threshold: it saws instead of sitting in the force band", () => {
        for (const pass of strips(visible)) {
            const next = visible.passes[pass.step];
            if (next) expect(next.mcPercentage ?? 100).toBeLessThan(THRESHOLD);
        }
        let run = 0;
        let longest = 0;
        for (const pass of visible.passes) {
            run = (pass.mcPercentage ?? 0) >= 85 ? run + 1 : 0;
            longest = Math.max(longest, run);
        }
        expect(longest).toBeLessThanOrEqual(5);
    });

    test("the emergency planner's floor counts the thinking and the drops the same pass removes", () => {
        const planned = strips(visible).filter((pass) => pass.emergencyFloor !== null);
        expect(planned.length).toBeGreaterThan(0);
        for (const pass of planned) {
            const before = previous(visible, pass).served;
            // The floor is the previous reading minus what is still an active
            // tag after this pass's drops, so it holds the system allowance, the
            // thinking the pass strips and the outputs it drops.
            expect(pass.emergencyFloor!).toBeGreaterThan(before.overhead + before.thinking);
            // It is far above what the pass actually serves.
            expect(pass.emergencyFloor!).toBeGreaterThan(2 * pass.served.total);
        }
    });
});

describe("issue 905, OpenCode 2 subagent, thinking text omitted", () => {
    test("the hold never engages: OpenCode 2 messages carry no recorded reasoning count, so an omitted-text step counts 1,000 tokens", () => {
        const holds = omitted.logs.filter((line) => line.includes("signed thinking hold: "));
        expect(holds.length).toBeGreaterThan(0);
        for (const line of holds)
            expect(line).toContain(
                "held=false reason=no_recent_heavy_reasoning heavyStepsBack=none heavyStepTokens=0",
            );
        // The host did record heavy steps on the stored rows.
        expect(omitted.rows.some((row) => row.thinkingTokens > 1500)).toBe(true);
    });

    test("every execute pass strips all unfrozen thinking and lands the queued drops", () => {
        const executes = omitted.passes.filter(
            (pass) => pass.decision === "execute" && pass.rewriteAllowed === true,
        );
        expect(executes.length).toBeGreaterThanOrEqual(2);
        for (const pass of executes) {
            expect(pass.proactiveStripFroze).toBe(
                previous(omitted, pass).served.thinkingBlocks + 1,
            );
            expect(pass.served.thinkingBlocks).toBe(0);
            expect(pass.pendingQueuedAfter).toBeLessThan(pass.pendingQueuedBefore);
        }
    });
});

describe("issue 905, a conversation no lane can shrink", () => {
    test("back-to-back execute passes each freeze only the assistants added since the previous strip", () => {
        const consecutive = strips(largeConversation).filter(
            (pass) => (previous(largeConversation, pass).proactiveStripFroze ?? 0) > 0,
        );
        expect(consecutive.length).toBeGreaterThan(0);
        for (const pass of consecutive) expect(pass.proactiveStripFroze).toBe(1);
        // The frozen assistants stay in the request with their thinking removed.
        const merged = largeConversation.passes
            .map((pass) => pass.mergedReasoningParts ?? 0)
            .filter((count) => count > 0);
        expect(merged.at(-1)!).toBeGreaterThan(merged[0]!);
    });
});

test("issue 905: a declared output limit shrinks the usable window, clamps the token threshold to 90% and moves the hold cap to 100%", () => {
    const threshold = withOutputLimit.passes.find((pass) => pass.threshold !== null)?.threshold;
    expect(threshold).toBe(90);
    const cap = withOutputLimit.logs
        .filter((line) => line.includes("signed thinking hold: "))
        .map((line) => Number(/cap=([\d.]+)%/.exec(line)?.[1]));
    expect(new Set(cap)).toEqual(new Set([100]));
    expect(
        withOutputLimit.logs.some((line) =>
            line.includes("execute_threshold_tokens clamped: 250000 → 243199.8"),
        ),
    ).toBe(true);
});

test("issue 905: Magic Context counts nothing for an OpenCode 2 thinking block whose text is omitted", () => {
    const opencode2 = {
        type: "reasoning",
        text: "",
        providerMetadata: { anthropic: { signature: "sig" } },
    };
    const opencode1 = {
        type: "reasoning",
        text: "",
        metadata: { anthropic: { signature: "sig" } },
    };
    const assistant = (part: unknown): MessageLike =>
        ({
            info: { id: "a1", role: "assistant", sessionID: "s" },
            parts: [part, { type: "text", text: "done" }],
        }) as unknown as MessageLike;
    const estimate = (part: unknown) =>
        estimateFinalWireInputTokens({
            messages: [assistant(part)],
            systemPromptTokens: 1,
            providerID: "anthropic",
            modelID: ISSUE_905_MODEL,
            agentName: undefined,
        }).messageTokens.conversation;
    // OpenCode 1 keeps the signature under `metadata` and gets an opaque charge;
    // OpenCode 2 keeps it under `providerMetadata` and is charged only its text.
    expect(estimate(opencode1)).toBeGreaterThan(estimate(opencode2) + 900);
    expect(estimate(opencode2)).toBe(estimate({ type: "text", text: "" }));
    // The served-thinking check treats that block as never reaching the provider.
    expect(servesThinkingBlock([assistant(opencode2)], "anthropic", ISSUE_905_MODEL)).toBe(false);
});

test("issue 905: claude-mythos-5-2 has no measured calibration of its own, so no estimate of its requests is refusal grade", () => {
    const mythos = resolveDecisionCalibration("anthropic", ISSUE_905_MODEL);
    expect(mythos.seeded).toBe(true);
    expect(mythos.source).not.toBe("seed");
    expect(hasMeasuredDecisionCalibration(mythos)).toBe(false);
    expect(
        hasMeasuredDecisionCalibration(resolveDecisionCalibration("anthropic", "claude-fable-5-1")),
    ).toBe(true);
});

test("issue 905: an omitted-text step is heavy for the hold on OpenCode 1, which carries the recorded reasoning count, and light on OpenCode 2, which does not", () => {
    const user = { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] };
    const decide = (assistant: unknown) =>
        decideSignedThinkingHold({
            messages: [user, assistant],
            usagePercentage: 88,
            executeThresholdPercentage: THRESHOLD,
            estimateTextTokens: (text) => text.length / 4,
        });
    // OpenCode 1: the host's message keeps `info.tokens.reasoning`.
    const opencode1 = decide({
        info: { id: "a1", role: "assistant", tokens: { reasoning: 5_000 } },
        parts: [{ type: "reasoning", text: "", metadata: { anthropic: { signature: "sig" } } }],
    });
    // OpenCode 2: the adapted message has no token record (see adaptPayload).
    const opencode2 = decide({
        info: { id: "a1", role: "assistant" },
        parts: [
            { type: "reasoning", text: "", providerMetadata: { anthropic: { signature: "sig" } } },
        ],
    });
    expect(opencode1).toMatchObject({ held: true, heavyStepTokens: 5_000, capPercentage: CAP });
    expect(opencode2).toMatchObject({ held: false, reason: "no_recent_heavy_reasoning" });
});
