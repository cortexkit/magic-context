/// <reference types="bun-types" />

/**
 * The emergency planner infers the fixed part of the request (what no tool
 * drop can remove) as a size of the whole request minus our count of its
 * active tags. With only the provider's reading as that size, every token by
 * which the provider's count exceeds ours lands in the fixed part; issue 860
 * is a session where that made the drop skip with most of the request
 * droppable. Our own count of the last request served caps the size the fixed
 * part is inferred from.
 *
 * These tests compare the planner with a frozen copy of the 0.49.81 release
 * planner: the cap may only lower the fixed part, so the selection is the
 * release's or an extension of it in the same order, and without a count the
 * plan is the release's, byte for byte.
 */

import { describe, expect, it } from "bun:test";
import { releasePlanEmergencyDrop } from "./__fixtures__/emergency-drop-release-0.49.81";
import { type EmergencyDropTag, planEmergencyDrop } from "./emergency-drop";

type PlannerInput = Parameters<typeof planEmergencyDrop>[0];

/** Small deterministic generator so a failing case can be replayed by its seed. */
function rng(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x1_0000_0000;
    };
}

const TOOL_NAMES = [
    "bash",
    "read",
    "grep",
    "edit",
    "write",
    "glob",
    "task",
    "webfetch",
    "aft_outline",
    "ctx_reduce",
    null,
] as const;

function generatedInput(seed: number): PlannerInput {
    const r = rng(seed);
    const int = (lo: number, hi: number) => Math.floor(lo + r() * (hi - lo + 1));
    const count = int(0, 60);
    const floorTags: EmergencyDropTag[] = [];
    for (let i = 1; i <= count; i++) {
        const type = r() < 0.6 ? "tool" : r() < 0.8 ? "message" : "file";
        const status = r() < 0.85 ? "active" : r() < 0.5 ? "dropped" : "compacted";
        const t: EmergencyDropTag = {
            tagNumber: i,
            type,
            status,
            toolName: type === "tool" ? TOOL_NAMES[int(0, TOOL_NAMES.length - 1)] : null,
            byteSize: int(0, 120_000),
            inputByteSize: int(0, 4_000),
            reasoningByteSize: r() < 0.2 ? int(0, 8_000) : 0,
        };
        if (r() < 0.5) t.servedTokens = int(0, 40_000);
        if (r() < 0.5) t.reclaimableTokens = int(0, 40_000);
        if (i > count - 3 && r() < 0.5) t.sinceReading = true;
        floorTags.push(t);
    }
    const tags = floorTags.filter((t) => t.type === "tool" && r() < 0.9);
    const ceilingTokens = r() < 0.03 ? 0 : int(5_000, 300_000);
    const reading = r() < 0.03 ? 0 : int(1_000, 900_000);
    const usagePercentage = r() < 0.1 ? undefined : int(80, 900);
    const hasPriorDrop = r() < 0.3;
    const input: PlannerInput = {
        tags,
        floorTags,
        maxTag: count,
        protectedCutoff: r() < 0.3 ? null : int(0, count + 1),
        currentTotalInputTokens: reading,
        ceilingTokens,
        priorInputSample: hasPriorDrop ? int(1, 900_000) : 0,
        hasPriorDrop,
        removedThisPassTokens: r() < 0.4 ? int(0, 200_000) : undefined,
        passAlreadyPriced: r() < 0.3,
        protectedTools: r() < 0.3 ? { ctx_reduce: int(0, 3) } : undefined,
    };
    if (usagePercentage !== undefined) input.usagePercentage = usagePercentage;
    return input;
}

/** A count around the reading: often below it (the case it exists for), sometimes above. */
function countFor(input: PlannerInput, seed: number): number {
    const r = rng(seed ^ 0x5eed);
    const reading = input.currentTotalInputTokens;
    const roll = r();
    if (roll < 0.1) return reading;
    if (roll < 0.25) return Math.round(reading * (1 + r()));
    if (roll < 0.3) return Math.round(r() * 1000);
    return Math.round(reading * r());
}

describe("emergency planner with our count of the last request served", () => {
    it("without a count the plan is the release's, byte for byte (generated inputs)", () => {
        let cases = 0;
        for (let seed = 1; seed <= 5_000; seed++) {
            const input = generatedInput(seed);
            expect({ seed, plan: planEmergencyDrop(input) }).toEqual({
                seed,
                plan: releasePlanEmergencyDrop(input),
            });
            cases++;
        }
        expect(cases).toBe(5_000);
    });

    it("never fewer drops than the release: the selection is the release's or extends it in order (generated inputs)", () => {
        let cases = 0;
        let extended = 0;
        let turnedSkipIntoDrop = 0;
        for (let seed = 1; seed <= 20_000; seed++) {
            const input = generatedInput(seed);
            const release = releasePlanEmergencyDrop(input);
            const servedCountTokens = countFor(input, seed);
            const plan = planEmergencyDrop({ ...input, servedCountTokens });
            cases++;
            const prefix = plan.tagNumbers.slice(0, release.tagNumbers.length);
            if (release.shouldDrop) {
                expect({ seed, shouldDrop: plan.shouldDrop }).toEqual({ seed, shouldDrop: true });
                expect({ seed, prefix }).toEqual({ seed, prefix: release.tagNumbers });
            }
            expect({ seed, longer: plan.reclaimTokens >= release.reclaimTokens }).toEqual({
                seed,
                longer: true,
            });
            if (servedCountTokens >= input.currentTotalInputTokens) {
                expect({ seed, plan }).toEqual({ seed, plan: release });
            }
            if (plan.tagNumbers.length > release.tagNumbers.length) extended++;
            if (plan.shouldDrop && !release.shouldDrop) turnedSkipIntoDrop++;
        }
        expect(cases).toBe(20_000);
        // The generated set must exercise the change, not only the identity.
        expect(extended).toBeGreaterThan(500);
        expect(turnedSkipIntoDrop).toBeGreaterThan(200);
    });

    it("a count that is not a positive finite number is no count", () => {
        const input = generatedInput(42);
        const release = releasePlanEmergencyDrop(input);
        for (const servedCountTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(planEmergencyDrop({ ...input, servedCountTokens })).toEqual(release);
        }
    });
});

describe("issue 860: the reporter's numbers at the planner", () => {
    // The reporter's log: a reading of 368,415 (818.7% of a 45,000-token usable
    // window, so the reduction point is 29,250) and a skip with "fixed floor
    // ≈122607 already exceeds ceiling 29250", which puts our count of the
    // active tags at 368,415 − 122,607 = 245,808. Counted directly, the fixed
    // part (system prompt, tool definitions, history head) was about 20,600,
    // so our count of the whole request was about 266,400.
    const ACTIVE_TAG_TOKENS = 245_808;
    const READING = 368_415;
    const OUR_COUNT = 266_400;
    const CEILING = 29_250;

    function reporterInput(): PlannerInput {
        // 42 bash results and 4 reads carry the tool mass; the rest is
        // conversation text. Each result's reclaim is its served size.
        const floorTags: EmergencyDropTag[] = [];
        let tagNumber = 0;
        const add = (t: Omit<EmergencyDropTag, "tagNumber" | "status">) =>
            floorTags.push({ ...t, tagNumber: ++tagNumber, status: "active" });
        const text = 4_000;
        add({
            type: "message",
            toolName: null,
            byteSize: 0,
            inputByteSize: 0,
            reasoningByteSize: 0,
            servedTokens: text,
        });
        const toolMass = ACTIVE_TAG_TOKENS - text;
        const perTool = toolMass / 46;
        for (let i = 0; i < 46; i++) {
            add({
                type: "tool",
                toolName: i % 12 === 5 ? "read" : "bash",
                byteSize: 0,
                inputByteSize: 0,
                reasoningByteSize: 0,
                servedTokens: perTool,
                reclaimableTokens: perTool,
            });
        }
        return {
            tags: floorTags.filter((t) => t.type === "tool"),
            floorTags,
            maxTag: tagNumber,
            protectedCutoff: tagNumber - 2,
            usagePercentage: 818.7,
            currentTotalInputTokens: READING,
            ceilingTokens: CEILING,
            priorInputSample: 0,
            hasPriorDrop: false,
        };
    }

    it("the release skips: its fixed part is the reading minus the tags", () => {
        const plan = releasePlanEmergencyDrop(reporterInput());
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toContain(
            `fixed floor ≈${READING - ACTIVE_TAG_TOKENS} already exceeds ceiling ${CEILING}`,
        );
    });

    it("with our count the fixed part is near 20,600 and a batch is planned", () => {
        const input = reporterInput();
        const plan = planEmergencyDrop({ ...input, servedCountTokens: OUR_COUNT });
        const fixed = OUR_COUNT - ACTIVE_TAG_TOKENS;
        expect(fixed).toBe(20_592);
        expect(plan.shouldDrop).toBe(true);
        expect(plan.reason).toMatch(/floor≈(20591\.9|20592[,.])/);
        expect(plan.reason).toContain(`floor from our count ≈${OUR_COUNT} of the last request`);
        // The target is fixed + 30% of the room to the reduction point; the
        // reading's size stays what the planner works against, so the gap is
        // reading − target and nearly every bash result goes, oldest first.
        const target = fixed + 0.3 * (CEILING - fixed);
        expect(plan.reclaimTokens).toBe(Math.round(READING - target));
        const bash = input.tags.filter((t) => t.toolName === "bash").map((t) => t.tagNumber);
        const reads = input.tags.filter((t) => t.toolName === "read").map((t) => t.tagNumber);
        // At 818.7% the window yields, so every bash result (tier 3) is taken
        // before any read (tier 1).
        expect(plan.tagNumbers.slice(0, bash.length)).toEqual(bash);
        expect(plan.tagNumbers.length).toBeGreaterThan(bash.length);
        expect(plan.tagNumbers.slice(bash.length)).toEqual(
            reads.slice(0, plan.tagNumbers.length - bash.length),
        );
    });

    it("a count above the reading changes nothing", () => {
        const input = reporterInput();
        expect(planEmergencyDrop({ ...input, servedCountTokens: READING + 50_000 })).toEqual(
            releasePlanEmergencyDrop(input),
        );
    });
});
