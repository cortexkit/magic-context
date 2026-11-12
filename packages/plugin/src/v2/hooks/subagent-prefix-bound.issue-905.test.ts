/// <reference types="bun-types" />
// Characterization of GitHub issue 905: an OpenCode 2 subagent on a
// prefix-bound thinking model (claude-mythos-5-2, where any edit in front of a
// signed thinking block invalidates that block) that works on one task
// message as a single turn of many tool steps, with the reporter's limits
// (`limit.context` 302,222, `execute_threshold_tokens` 250,000,
// `protected_tokens` 16,000). The session runs through the real OpenCode 2
// context hook (see __tests__/issue-905-subagent.fixture.ts); usage readings are
// the size of what each request served. These tests pin the session's
// behaviour, so a change to any of it shows up here. The signed-thinking hold
// ends where force-band pressure begins (85% here), so a held stretch never
// keeps the force band from landing the queued drops.
//
// At the default 65% threshold the hold's cap (75%) lies below the force band,
// so for a pass judged on one reading nothing changes. A pass that starts with
// no provider reading (the first after a restart, or any pass on a provider
// that reports no usage) is judged again on the reading it is sized at; there
// the cap and the force band now end holds that used to stay on at any sized
// reading (see subagent-prefix-bound.issue-905-review.test.ts).

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    hasMeasuredDecisionCalibration,
    resolveDecisionCalibration,
} from "../../hooks/magic-context/decision-calibration";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { forceBandConfirmed } from "../../hooks/magic-context/routine-cleanup-decision";
import { decideSignedThinkingHold } from "../../hooks/magic-context/signed-thinking-hold";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { servesThinkingBlock } from "../../hooks/magic-context/transform-postprocess-phase";
import {
    ISSUE_905_CONTEXT,
    ISSUE_905_EXECUTE_TOKENS,
    ISSUE_905_MODEL,
    type Issue905Pass,
    type Issue905Run,
    runIssue905Session,
} from "./__tests__/issue-905-subagent.fixture";

// 250,000 / 302,222 and ten points above it, as the transform logs them.
const THRESHOLD = 82.72064905930078;
const CAP = 92.72064905930078;
// max(85%, threshold + 2): where force-band pressure begins.
const FORCE_BAND = 85;

let visible: Issue905Run;
let omitted: Issue905Run;
let largeConversation: Issue905Run;
let withOutputLimit: Issue905Run;
let defaultThreshold: Issue905Run;
let localCount: Issue905Run;

beforeAll(async () => {
    // Visible thinking: a third of the steps think heavily (above the hold's
    // 1,500 tokens); the agent reduces every read two steps after it, except
    // every ninth, and every grep output.
    visible = await runIssue905Session({ seed: 905, steps: 136 });
    // The same agent with the thinking text omitted (only the signature is
    // stored, as with Anthropic's `display: "omitted"`); the host still
    // records each step's reasoning-token count.
    omitted = await runIssue905Session({ seed: 9051, steps: 70, thinking: "omitted" });
    // A 100,000-token task message, which no automatic reduction can shrink,
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
    // The same agent at the default 65% execute threshold: hold cap 75%, force
    // band from 85%.
    defaultThreshold = await runIssue905Session({
        seed: 9054,
        steps: 80,
        configOverrides: { execute_threshold_tokens: undefined },
    });
    // A provider that reports no input usage: every pass reads a local count of
    // the request it serves.
    localCount = await runIssue905Session({ seed: 9055, steps: 80, reportUsage: false });
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

    test("a pass in the force band is never held: it lands the queued drops and strips the turn's kept thinking once", () => {
        const inForceBand = visible.passes.filter((pass) => (pass.mcPercentage ?? 0) >= FORCE_BAND);
        // Below the cap, with heavy reasoning in the turn's recent steps: passes
        // the hold's other conditions would have held.
        expect(
            inForceBand.filter((pass) => (pass.mcPercentage ?? 0) < CAP).length,
        ).toBeGreaterThanOrEqual(5);
        for (const pass of inForceBand) {
            expect(pass.thinkingHold).toBe(false);
            expect(pass.rewriteAllowed).toBe(true);
            expect(pass.ride).toBe("force+subagentExecute");
            expect(pass.pendingQueuedBefore).toBeGreaterThan(0);
            expect(pass.pendingQueuedAfter).toBeLessThan(pass.pendingQueuedBefore);
            // Every block the previous request served, plus the newest step's,
            // stripped by this one pass.
            expect(pass.proactiveStripFroze).toBe(
                previous(visible, pass).served.thinkingBlocks + 1,
            );
            expect(pass.served.thinkingBlocks).toBe(0);
        }
        // The hold names the force band as the reason it ended.
        expect(
            visible.logs.filter((line) =>
                line.includes("signed thinking hold: held=false reason=force_band"),
            ).length,
        ).toBeGreaterThanOrEqual(5);
    });

    test("between the threshold and the force band the hold still holds and nothing lands", () => {
        const heldBelowForceBand = visible.passes.filter(
            (pass) =>
                pass.thinkingHold === true &&
                (pass.mcPercentage ?? 0) >= THRESHOLD &&
                (pass.mcPercentage ?? 0) < FORCE_BAND,
        );
        expect(heldBelowForceBand.length).toBeGreaterThanOrEqual(3);
        for (const pass of heldBelowForceBand) {
            expect(pass.rewriteAllowed).toBe(false);
            expect(pass.pendingQueuedAfter).toBe(pass.pendingQueuedBefore);
            expect(pass.proactiveStripFroze).toBeNull();
            expect(pass.served.thinkingBlocks).toBeGreaterThan(0);
        }
    });

    test("the first unheld pass lands every queued drop and strips the thinking of every assistant since the last strip", () => {
        const stripped = strips(visible);
        expect(stripped.length).toBeGreaterThanOrEqual(3);
        for (const pass of stripped) {
            expect(pass.thinkingHold).toBe(false);
            // Unheld in this run means in the force band.
            expect(pass.mcPercentage ?? 0).toBeGreaterThanOrEqual(FORCE_BAND);
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

    test("the emergency planner's floor leaves out what the same pass dropped and keeps the thinking it still serves", () => {
        const planned = strips(visible).filter((pass) => pass.emergencyFloor !== null);
        expect(planned.length).toBeGreaterThan(0);
        // No pass skips the planner as if tool drops could never reach the ceiling.
        expect(visible.logs.some((line) => line.includes("already exceeds ceiling"))).toBe(false);
        for (const pass of planned) {
            const before = previous(visible, pass).served;
            // The floor is the request this pass serves minus its active tags.
            // Every tool output, tool input and text part the previous request
            // served was either dropped by this pass's queued drops (and taken
            // off the reading) or is still an active tag, so none of it is fixed.
            expect(pass.emergencyFloor!).toBeLessThanOrEqual(
                before.overhead +
                    before.thinking +
                    before.hiddenThinking +
                    before.placeholders +
                    before.other,
            );
            // The thinking is still on the request when the planner runs (the
            // strip comes at the end of the pass) and no tool drop removes it,
            // so it stays in the floor.
            expect(pass.emergencyFloor!).toBeGreaterThan(before.thinking);
            expect(pass.emergencyFloor!).toBeLessThan(ISSUE_905_EXECUTE_TOKENS);
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

describe("issue 905, a conversation no automatic reduction can shrink", () => {
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

test("issue 905: an OpenCode 2 thinking block whose text is omitted is counted and served; OpenCode 1's is counted and not served", () => {
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
    // Both hosts' signature-only blocks get the same opaque charge: OpenCode 1
    // keeps the signature under `metadata`, OpenCode 2 under `providerMetadata`.
    expect(estimate(opencode2)).toBe(estimate(opencode1));
    expect(estimate(opencode2)).toBeGreaterThan(estimate({ type: "text", text: "" }) + 900);
    // OpenCode 2's encoder sends that block as a thinking block with empty
    // text; OpenCode 1's Anthropic adapter drops an empty reasoning part.
    expect(servesThinkingBlock([assistant(opencode2)], "anthropic", ISSUE_905_MODEL)).toBe(true);
    expect(servesThinkingBlock([assistant(opencode1)], "anthropic", ISSUE_905_MODEL)).toBe(false);
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
            // Above the threshold and below the force band, where the hold applies.
            usagePercentage: 84,
            executeThresholdPercentage: THRESHOLD,
            forceBandPressure: forceBandConfirmed({
                percentage: 84,
                fromEstimate: false,
                forceMaterializationPercentage: FORCE_BAND,
                compactionOff: false,
            }),
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

/**
 * The decisions and served bytes of every pass of the default-threshold run,
 * recorded with the code from before the force band ended the hold. The run's
 * provider reports its usage, so every hold is judged on the reading the pass
 * starts with; at 65% the hold's cap (75%) lies below the force band (85%), so
 * ending the hold there changes nothing for it: the same digest proves it. A
 * provider that reports no usage does change (see the review test file).
 */
const DEFAULT_THRESHOLD_DIGEST = "a40ff2cf6771e026884a8fcdd85a3d52c27928eb29352ed5e47ef24f9e1d5efb";

describe("issue 905, the default 65% threshold", () => {
    test("with a provider that reports usage nothing changes: every pass decides and serves exactly what it did before", () => {
        const passes = defaultThreshold.passes;
        expect(new Set(passes.map((pass) => pass.threshold))).toEqual(new Set([65]));
        const usage = (pass: Issue905Pass) => pass.mcPercentage ?? 0;
        // The run covers the hold's whole range and the passes above its cap.
        expect(
            passes.filter(
                (pass) => pass.thinkingHold === true && usage(pass) >= 65 && usage(pass) < 75,
            ).length,
        ).toBeGreaterThanOrEqual(3);
        expect(
            passes.filter(
                (pass) =>
                    pass.thinkingHold === false &&
                    usage(pass) >= 75 &&
                    (pass.proactiveStripFroze ?? 0) > 0,
            ).length,
        ).toBeGreaterThanOrEqual(2);
        expect(defaultThreshold.logs.some((line) => line.includes("reason=force_band"))).toBe(
            false,
        );
        const digest = createHash("sha256")
            .update(
                passes
                    .map((pass) =>
                        [
                            pass.decision,
                            pass.thinkingHold,
                            pass.rewriteAllowed,
                            pass.ride,
                            pass.pendingQueuedAfter,
                            pass.proactiveStripFroze,
                            pass.servedDigest,
                        ].join("|"),
                    )
                    .join("\n"),
            )
            .digest("hex");
        expect(digest).toBe(DEFAULT_THRESHOLD_DIGEST);
    });
});

describe("issue 905, a provider that reports no usage", () => {
    // The reading a priced pass took from its own local count, when it took one.
    const localReading = (pass: Issue905Pass): number | null => {
        const line = pass.logs.find((entry) =>
            entry.includes("unknown provider usage; using wire estimate for priced pass"),
        );
        const match = line ? / percentage=([\d.]+) /.exec(line) : null;
        return match ? Number(match[1]) : null;
    };

    // A local count is force-band pressure only from 95%, but the hold's cap
    // (92.72% here) applies to the sized reading too and ends it first.
    test("between 85% of a local count and the hold's cap the hold stays on and nothing lands", () => {
        const between = localCount.passes.filter((pass) => {
            const reading = localReading(pass);
            return reading !== null && reading >= FORCE_BAND && reading < CAP;
        });
        expect(between.length).toBeGreaterThanOrEqual(2);
        for (const pass of between) {
            expect(pass.thinkingHold).toBe(true);
            expect(pass.rewriteAllowed).toBe(false);
            expect(pass.pendingQueuedBefore).toBeGreaterThan(0);
            expect(pass.pendingQueuedAfter).toBe(pass.pendingQueuedBefore);
            expect(pass.proactiveStripFroze).toBeNull();
            expect(pass.served.thinkingBlocks).toBeGreaterThan(0);
        }
    });

    test("from the hold's cap of a local count the hold ends: the pass lands the queued drops and strips the kept thinking once", () => {
        const atCap = localCount.passes.filter((pass) => (localReading(pass) ?? 0) >= CAP);
        expect(atCap.length).toBeGreaterThanOrEqual(2);
        for (const pass of atCap) {
            expect(pass.thinkingHold).toBe(false);
            expect(pass.logs.some((line) => line.includes("held=false reason=above_cap"))).toBe(
                true,
            );
            expect(pass.pendingQueuedAfter).toBeLessThan(pass.pendingQueuedBefore);
            expect(pass.proactiveStripFroze).toBe(
                previous(localCount, pass).served.thinkingBlocks + 1,
            );
            expect(pass.served.thinkingBlocks).toBe(0);
        }
    });
});
