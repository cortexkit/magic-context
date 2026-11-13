/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import {
    type EmergencyDropTag,
    emergencyServedMassRemovedSince,
    estimateEmergencyDropReclaimTokens,
    planEmergencyDrop,
    resolveToolTier,
    snapshotEmergencyServedMass,
    TARGET_FRACTION,
    tagsSinceReading,
} from "./emergency-drop";
import { estimateTokens } from "./read-session-formatting";
import { neutralizeDroppedReasoningPart } from "./sentinel";
import type { MessageLike, TagTarget } from "./tag-messages";

// Most tests exercise selection/latch logic where the floor set equals the
// candidate set; planWithFloor keeps them on the old single-set shape. The
// floorTags/tags split itself is covered by the dedicated regression test.
function planWithFloor(
    input: Omit<Parameters<typeof planEmergencyDrop>[0], "floorTags"> & {
        floorTags?: readonly EmergencyDropTag[];
    },
) {
    return planEmergencyDrop({ ...input, floorTags: input.floorTags ?? input.tags });
}

function tag(
    tagNumber: number,
    toolName: string | null,
    byteSize: number,
    opts: Partial<EmergencyDropTag> = {},
): EmergencyDropTag {
    return {
        tagNumber,
        type: "tool",
        status: "active",
        toolName,
        byteSize,
        inputByteSize: 0,
        reasoningByteSize: 0,
        ...opts,
    };
}

describe("resolveToolTier", () => {
    it("classifies T1 navigation/structure tools", () => {
        for (const name of ["read", "todowrite", "task", "aft_outline", "aft_zoom"]) {
            expect(resolveToolTier(name)).toBe(1);
        }
    });

    it("classifies T2 edit/search tools", () => {
        for (const name of ["edit", "write", "apply_patch", "grep", "glob", "aft_search"]) {
            expect(resolveToolTier(name)).toBe(2);
        }
    });

    it("classifies everything else as T3 (drop-first default)", () => {
        for (const name of ["bash", "ctx_reduce", "aft_inspect", "webfetch", "unknown_tool"]) {
            expect(resolveToolTier(name)).toBe(3);
        }
    });

    it("normalizes mcp_ prefix and case so prefixed names still tier correctly", () => {
        expect(resolveToolTier("mcp_read")).toBe(1);
        expect(resolveToolTier("MCP_Edit")).toBe(2);
        expect(resolveToolTier("Bash")).toBe(3);
    });

    it("treats null tool name as T3", () => {
        expect(resolveToolTier(null)).toBe(3);
    });
});

describe("planEmergencyDrop — guards", () => {
    const base = {
        maxTag: 10,
        protectedCutoff: null,
        hasPriorDrop: false,
        priorInputSample: 0,
    };

    it("skips when the ceiling is unknown/invalid", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 100_000,
            ceilingTokens: 0,
        });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toBe("unknown-ceiling");
    });

    it("no-ops when already at/under target (reclaim <= min)", () => {
        const plan = planWithFloor({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 1_000,
            ceilingTokens: 100_000,
        });
        expect(plan.shouldDrop).toBe(false);
    });
});

describe("planEmergencyDrop — floorTags/tags split", () => {
    it("reclaims to the true target when substantial non-tool tail exists (audit repro)", () => {
        // Audit repro: 170k total, 130k ceiling, live tail = 60k active
        // non-tool (conversation/reasoning) + 80k droppable tool; true fixed
        // overhead = 30k. Correct: floor=30k → target=60k → reclaim=110k →
        // ALL tool tags must go. The old tool-only floor computed floor=90k →
        // target=102k → reclaim=68k and left tool output behind.
        const TOKENS_PER_BYTE = 0.25; // mirror of emergency-drop internal ratio
        const toTokens = (bytes: number) => Math.round(bytes * TOKENS_PER_BYTE);

        // 80k tokens of droppable tool output across 8 tags (10k tokens each).
        const toolTags = Array.from({ length: 8 }, (_, i) =>
            tag(i + 1, "bash", 10_000 / TOKENS_PER_BYTE),
        );
        // 60k tokens of active message/file tail — floor accounting only.
        const messageTags = Array.from({ length: 6 }, (_, i) =>
            tag(i + 101, null, 10_000 / TOKENS_PER_BYTE, { type: "message" }),
        );
        expect(toolTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(80_000);
        expect(messageTags.reduce((s, t) => s + toTokens(t.byteSize), 0)).toBe(60_000);

        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 200,
            protectedCutoff: null,
            currentTotalInputTokens: 170_000,
            ceilingTokens: 130_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });

        expect(plan.shouldDrop).toBe(true);
        // floor = 170k − 140k = 30k; target = 30k + 0.3·100k = 60k; reclaim 110k.
        expect(plan.reclaimTokens).toBe(110_000);
        // Reclaim need (110k) exceeds the whole droppable pile (80k) → every
        // tool tag is selected; non-tool tags are never selected.
        expect(plan.tagNumbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("never selects non-tool tags even when they dominate the floor set", () => {
        const toolTags = [tag(1, "bash", 40_000)];
        const messageTags = [
            tag(50, null, 400_000, { type: "message" }),
            tag(51, null, 400_000, { type: "file" }),
        ];
        const plan = planEmergencyDrop({
            tags: toolTags,
            floorTags: [...toolTags, ...messageTags],
            maxTag: 60,
            protectedCutoff: null,
            currentTotalInputTokens: 300_000,
            ceilingTokens: 200_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1]);
    });
});

describe("planEmergencyDrop — target math", () => {
    it("turns a converted 1.09M provider sample into a non-empty emergency batch", () => {
        const toolTags = Array.from({ length: 3 }, (_, index) =>
            tag(index + 1, "read", 1, {
                servedTokens: 315_000,
                reclaimableTokens: 315_000,
            }),
        );
        const base = {
            tags: toolTags,
            floorTags: toolTags,
            maxTag: 3,
            protectedCutoff: null,
            ceilingTokens: 681_574,
            priorInputSample: 0,
            hasPriorDrop: false,
            usagePercentage: 104,
        };

        const underestimated = planEmergencyDrop({
            ...base,
            currentTotalInputTokens: 56_180,
        });
        const providerSized = planEmergencyDrop({
            ...base,
            currentTotalInputTokens: 1_091_002,
        });

        expect(underestimated.tagNumbers).toHaveLength(0);
        expect(underestimated.reason).toContain("reclaim<=min");
        expect(providerSized.shouldDrop).toBe(true);
        expect(providerSized.tagNumbers).toHaveLength(3);
        expect(providerSized.reclaimTokens).toBeGreaterThan(700_000);
    });

    it("computes target = fixedFloor + 0.30 × (ceiling − fixedFloor)", () => {
        // 10 tags × 4000 bytes × 0.25 = 10000 tail tokens; usage 30000 →
        // fixedFloor = 30000 - 10000 = 20000. ceiling 160000 →
        // workingSpan 140000, target = 20000 + 0.30×140000 = 62000,
        // reclaim = 30000 - 62000 < 0 → no-op (under target).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 30_000,
            ceilingTokens: 160_000,
        });
        expect(TARGET_FRACTION).toBe(0.3);
        expect(plan.shouldDrop).toBe(false); // already under the 62k target
    });

    it("reclaims down toward target, dropping oldest T3 first", () => {
        // 20 tags × 2000 bytes × 0.25 = 10000 tail tokens; usage 10000,
        // fixedFloor ≈ 0, ceiling 6000 → target 1800 → reclaim ≈ 8200.
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 2000));
        const plan = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: 19,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 6_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // oldest first
        expect(plan.tagNumbers[0]).toBe(1);
        // never drops the protected tail (19, 20)
        expect(plan.tagNumbers).not.toContain(19);
        expect(plan.tagNumbers).not.toContain(20);
    });

    it("latches the whole force-pressure episode across fresh usage samples", () => {
        // 20 T3 tags × 20000 bytes (≈5000 tokens each). currentTotal 100k, ceiling
        // 60k. First pass drops down to target and latches the usage sample.
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 20_000));
        const first = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 100_000,
            ceilingTokens: 60_000,
            hasPriorDrop: false,
            priorInputSample: 0,
        });
        expect(first.shouldDrop).toBe(true);
        // Second ≥85% pass BEFORE the provider re-measures: same stale
        // currentTotalInputTokens, sample latched. Must NO-OP — not re-derive
        // and drop the rest of the tail (which would bust the cache again).
        const second = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 100_000, // unchanged — provider hasn't re-measured
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000, // latched from the first drop
        });
        expect(second.shouldDrop).toBe(false);
        expect(second.reason).toContain("pressure-episode-latched");
        // A fresh provider sample is still the same pressure LEVEL, not a new
        // application edge. The caller explicitly rearms only after force-band
        // exit or an independent provider-visible mutation.
        const third = planWithFloor({
            tags,
            maxTag: 20,
            protectedCutoff: null,
            currentTotalInputTokens: 95_000,
            ceilingTokens: 60_000,
            hasPriorDrop: true,
            priorInputSample: 100_000,
        });
        expect(third.shouldDrop).toBe(false);
        expect(third.reason).toContain("pressure-episode-latched");
    });

    it("counts tool input + reasoning bytes in BOTH floor and reclaim (no under-evict)", () => {
        // A single huge-input/tiny-output tool (e.g. write/apply_patch): output
        // is 400 bytes but the invocation args are 40000 bytes. The drop removes
        // all of it, so reclaim must count input bytes — otherwise the planner
        // sees ~no droppable tail and no-ops into overflow.
        const big = tag(1, "write", 400, { inputByteSize: 40_000, reasoningByteSize: 8_000 });
        const small = tag(2, "bash", 800);
        const plan = planWithFloor({
            tags: [big, small],
            maxTag: 2,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            // tail = (400+40000+8000 + 800) × 0.25 = 12300; floor = 20000-12300
            // = 7700; ceiling 12000 → target 7700+0.3×4300 = 8990 →
            // reclaim ≈ 11010. Dropping `big` alone reclaims (48400)×0.25 = 12100
            // ≥ reclaim → met without touching `small`.
            currentTotalInputTokens: 20_000,
            ceilingTokens: 12_000,
            // At 95% the T1/T2 recency reserve yields, so `big` is selectable.
            // Below it, `big` is the reserved newest T2 and `small` alone would
            // reclaim 200 tokens, which the minimum achievable reclaim rejects.
            usagePercentage: 95,
        });
        expect(plan.shouldDrop).toBe(true);
        // `big` (T2) is NOT dropped before T3 `small` — tier order wins — but
        // the key assertion is that the plan reclaims enough: it must include
        // `small` (T3, dropped first) and the math must recognize `big`'s value.
        expect(plan.tagNumbers).toContain(2); // T3 dropped first
        // The reclaim target (~11010) exceeds what output-only accounting would
        // see for these tags (300 tokens), proving input/reasoning are counted.
        expect(plan.reclaimTokens).toBeGreaterThan(10_000);
    });
});

describe("planEmergencyDrop — tier ordering", () => {
    it("protects newest ctx_reduce exemplars in the emergency band instead of evicting them as T3", () => {
        const tags = Array.from({ length: 5 }, (_, index) => tag(index + 1, "ctx_reduce", 4_000));
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("drops T3 before T2 before T1", () => {
        // Mix of tiers, all same size. reclaim forces dropping several.
        const tags = [
            tag(1, "read", 4000), // T1
            tag(2, "edit", 4000), // T2
            tag(3, "bash", 4000), // T3
            tag(4, "read", 4000), // T1
            tag(5, "edit", 4000), // T2
            tag(6, "bash", 4000), // T3
        ];
        // tail = 6×1000 = 6000 tokens; usage 6000, ceiling 1000 →
        // target 300 → reclaim ≈ 5700 → must drop almost everything.
        const plan = planWithFloor({
            tags,
            maxTag: 6,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // T3 (3, 6) come first in eviction order.
        const firstTwo = plan.tagNumbers.slice(0, 2).sort((a, b) => a - b);
        expect(firstTwo).toEqual([3, 6]);
    });

    it("reserves the newest 20% of T1/T2 tiers (ceil), never T3", () => {
        // 10 T2 edits. reserve = ceil(0.2×10) = 2 newest (tags 9,10).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "edit", 8000));
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000, // tail = 10×2000 = 20000
            ceilingTokens: 1_000, // target ≈ 300 → reclaim huge
        });
        expect(plan.shouldDrop).toBe(true);
        // newest 2 of the T2 tier are reserved.
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
        // older ones are evictable.
        expect(plan.tagNumbers).toContain(1);
    });

    it("a tiny T1/T2 tier reserves all of it (ceil keeps >=1)", () => {
        const tags = [tag(1, "read", 8000), tag(2, "bash", 8000)];
        // tail 4000 tokens, usage 4000, ceiling 500 → reclaim huge.
        const plan = planWithFloor({
            tags,
            maxTag: 2,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 4_000,
            ceilingTokens: 500,
        });
        // T1 read (tag 1) is the entire T1 tier → reserved (ceil(0.2×1)=1).
        expect(plan.tagNumbers).not.toContain(1);
        // T3 bash is fully depletable.
        expect(plan.tagNumbers).toContain(2);
    });
});

describe("planEmergencyDrop — idempotence via status='active' (no scalar watermark)", () => {
    it("re-considers ALL still-active tags (no scalar-watermark exclusion of lower tags)", () => {
        // The regression the scalar watermark caused: after a prior pass dropped
        // high-numbered tags, lower-numbered tags that are STILL active must
        // remain eligible. Here tags 6-10 are active and droppable; tags 1-5 were
        // dropped in a prior pass (status='dropped') so they're naturally skipped.
        const tags = [
            ...Array.from({ length: 5 }, (_, i) =>
                tag(i + 1, "bash", 4000, { status: "dropped" as const }),
            ),
            ...Array.from({ length: 5 }, (_, i) => tag(i + 6, "bash", 4000)),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: null,
            hasPriorDrop: false,
            // The caller reset the episode latch to 0 because another mutation
            // already priced this pass, so newly eligible tags may ride it.
            priorInputSample: 0,
            currentTotalInputTokens: 5_000,
            ceilingTokens: 1_000,
        });
        // dropped tags are never reselected (status guard)…
        for (const n of [1, 2, 3, 4, 5]) expect(plan.tagNumbers).not.toContain(n);
        // …but every still-ACTIVE tag is eligible, oldest-first.
        expect(plan.tagNumbers[0]).toBe(6);
    });

    it("no-ops when every active tag is already dropped", () => {
        const tags = Array.from({ length: 5 }, (_, i) =>
            tag(i + 1, "bash", 4000, { status: "dropped" as const }),
        );
        const plan = planWithFloor({
            tags,
            maxTag: 5,
            protectedCutoff: null,
            hasPriorDrop: true,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        // No active tail → no-ops (whether via reclaim<=min or no-candidates).
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
    });

    it("ignores already-dropped tags (status='dropped' is the re-selection guard)", () => {
        const tags = [
            tag(1, "bash", 4000, { status: "dropped" }),
            tag(2, "bash", 4000),
            tag(3, "bash", 4000),
        ];
        const plan = planWithFloor({
            tags,
            maxTag: 3,
            protectedCutoff: null,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 3_000,
            ceilingTokens: 200,
        });
        expect(plan.tagNumbers).not.toContain(1);
    });
});

describe("planEmergencyDrop — token protection window cutoff & >=95% yield (#423 parity)", () => {
    it("consumes exact tag-number cutoff directly in tag-number coordinate space", () => {
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        // Cutoff = 8 in tag-number coordinate space. Tags 8, 9, 10 are protected.
        const plan = planWithFloor({
            tags,
            maxTag: 10,
            protectedCutoff: 8,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 2_000,
            usagePercentage: 85,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toContain(1);
        expect(plan.tagNumbers).not.toContain(8);
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
    });

    it("branches on absent cutoff (null) applying no tag-number threshold (empty window)", () => {
        const tags = [tag(1, "bash", 40_000), tag(2, "bash", 40_000)];
        const plan = planWithFloor({
            tags,
            maxTag: 2,
            protectedCutoff: null, // absent cutoff
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 85,
        });

        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toContain(1);
        expect(plan.tagNumbers).toContain(2);
    });

    it("yields the window at >=95% usage (#423 parity)", () => {
        const tags = [tag(1, "bash", 40_000), tag(2, "bash", 40_000), tag(3, "bash", 40_000)];
        // Cutoff 1 would normally protect tags 1, 2, 3
        const plan = planWithFloor({
            tags,
            maxTag: 3,
            protectedCutoff: 1,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 95, // absolute emergency >= 95% -> window yields
        });

        expect(plan.shouldDrop).toBe(true);
        // Window yielded -> tags are dropped
        expect(plan.tagNumbers.length).toBeGreaterThan(0);
    });

    it("at 94% a fully-protected candidate set degrades to noop('no-candidates') without consuming episode latch", () => {
        const tags = [tag(10, "bash", 40_000), tag(11, "bash", 40_000)];
        // Cutoff 10 protects all candidate tags
        const plan = planWithFloor({
            tags,
            maxTag: 11,
            protectedCutoff: 10,
            hasPriorDrop: false,
            priorInputSample: 0,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 10_000,
            usagePercentage: 94, // 94% < 95% -> window does NOT yield
        });

        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason.startsWith("no-candidates")).toBe(true);
        // Episode latch remains unconsumed (plan returned shouldDrop: false)
    });
});

it("reclaim measurement charges retained skeleton tokens instead of original tag bytes", () => {
    expect(
        estimateEmergencyDropReclaimTokens({
            tagNumber: 1,
            type: "tool",
            status: "active",
            toolName: "read",
            byteSize: 400000,
            inputByteSize: 0,
            reasoningByteSize: 0,
            servedTokens: 15516.39,
            reclaimableTokens: 13964.751,
        }),
    ).toBe(13964.751);
});

describe("planEmergencyDrop — minimum achievable reclaim", () => {
    // A reachable fixed floor with a tiny candidate isolates the cache-price
    // minimum from the separate impossible-fixed-overhead guard.
    const workerShape = (extra: Partial<Parameters<typeof planEmergencyDrop>[0]> = {}) => {
        const fresh = tag(330, "bash", 596); // 596 bytes x 0.25 = 149 tokens
        const conversation = tag(1, null, 36_204, { type: "message" }); // ~9,051 tokens
        return planEmergencyDrop({
            tags: [fresh],
            floorTags: [fresh, conversation],
            maxTag: 330,
            protectedCutoff: null,
            usagePercentage: 100,
            currentTotalInputTokens: 335_200,
            ceilingTokens: 327_000,
            priorInputSample: 0,
            hasPriorDrop: false,
            ...extra,
        });
    };

    it("skips a pass whose selection reclaims less than the minimum", () => {
        const plan = workerShape();
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
        expect(plan.reason).toContain("achievable reclaim below minimum");
        expect(plan.reason).toContain("reclaim≈149 < 2000");
    });

    it("lets the same small selection ride a pass another mutation already prices", () => {
        const plan = workerShape({ passAlreadyPriced: true });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([330]);
    });

    it("commits a selection that reaches the minimum", () => {
        const big = tag(10, "bash", 12_000); // 3,000 tokens
        const fresh = tag(330, "bash", 596);
        const conversation = tag(1, null, 36_204, { type: "message" });
        const plan = planEmergencyDrop({
            tags: [big, fresh],
            floorTags: [big, fresh, conversation],
            maxTag: 330,
            protectedCutoff: null,
            usagePercentage: 100,
            currentTotalInputTokens: 338_200,
            ceilingTokens: 327_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([10, 330]);
    });
});

// Fixed overhead is not reclaimable by deleting tool results, even if a fit
// rebuild has already paid for the cache rewrite or real usage reaches 95%.
describe("issue 731 impossible fixed overhead", () => {
    for (const fixture of [
        { name: "subagent sample latch", usage: 90_000, active: 6_407, floor: 83_593, count: 2 },
        { name: "producer force gate", usage: 90_000, active: 6_407, floor: 83_593, count: 2 },
        {
            name: "protected episode at 90%",
            usage: 90_000,
            active: 10_195,
            floor: 79_805,
            count: 5,
        },
        {
            name: "protected episode at 96%",
            usage: 96_000,
            active: 10_195,
            floor: 85_805,
            count: 5,
        },
    ]) {
        it(`preserves the Rust ${fixture.name} fixture's impossible fixed floor`, () => {
            // Use the calibrated active-token totals reported by the Rust transform,
            // rather than assuming that a long run of one character is token-rich.
            const tools = Array.from({ length: fixture.count }, (_, n) =>
                tag(n + 1, "read", 1, { servedTokens: fixture.active / fixture.count }),
            );
            const plan = planEmergencyDrop({
                tags: tools,
                floorTags: tools,
                maxTag: fixture.count,
                protectedCutoff: null,
                currentTotalInputTokens: fixture.usage,
                ceilingTokens: 65_000,
                usagePercentage: fixture.usage / 1000,
                passAlreadyPriced: true,
                priorInputSample: 0,
                hasPriorDrop: false,
            });
            expect(plan.shouldDrop).toBe(false);
            expect(plan.tagNumbers).toEqual([]);
            expect(plan.reason).toContain(
                `fixed floor ≈${fixture.floor} already exceeds ceiling 65000`,
            );
        });
    }

    it("preserves every tool result above the ceiling, including on priced and real-95 passes", () => {
        const tools = [
            tag(3, "read", 1, { servedTokens: 1_600, reclaimableTokens: 1_350 }),
            tag(5, "bash", 1, { servedTokens: 1_581, reclaimableTokens: 1_368 }),
        ];
        for (const usagePercentage of [72.3, 95]) {
            for (const passAlreadyPriced of [true, false]) {
                const plan = planEmergencyDrop({
                    tags: tools,
                    floorTags: tools,
                    maxTag: 5,
                    protectedCutoff: null,
                    currentTotalInputTokens: 144_520,
                    ceilingTokens: 93_938,
                    usagePercentage,
                    passAlreadyPriced,
                    priorInputSample: 0,
                    hasPriorDrop: false,
                });
                expect(plan.shouldDrop).toBe(false);
                expect(plan.tagNumbers).toEqual([]);
                expect(plan.reason).toContain("fixed floor ≈141339 already exceeds ceiling 93938");
            }
        }
    });

    it("real 95 percent still yields the protected tail when drops reach the target", () => {
        const tools = [tag(1, "bash", 40_000), tag(2, "read", 40_000)];
        const plan = planEmergencyDrop({
            tags: tools,
            floorTags: tools,
            maxTag: 2,
            protectedCutoff: 1,
            currentTotalInputTokens: 20_000,
            ceilingTokens: 13_000,
            usagePercentage: 95,
            priorInputSample: 0,
            hasPriorDrop: false,
        });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual([1, 2]);
        expect(plan.reclaimTokens).toBe(16_100);
    });
});

describe("planEmergencyDrop — the request this pass serves", () => {
    // A force-band pass of a subagent on a prefix-bound thinking model: the
    // previous request read 288,351 provider tokens, and the queued drops that
    // landed earlier in the same pass took that request down to 63,730. What is
    // left active is 8 read results (31,874) and their arguments (287).
    const reads = Array.from({ length: 8 }, (_, n) =>
        tag(n + 1, "read", 1, { servedTokens: 4_020, reclaimableTokens: 3_900 }),
    );
    const base = {
        tags: reads,
        floorTags: reads,
        maxTag: 8,
        protectedCutoff: null,
        currentTotalInputTokens: 288_351,
        ceilingTokens: 250_000,
        usagePercentage: 95.4,
        priorInputSample: 0,
        hasPriorDrop: false,
        passAlreadyPriced: true,
    };

    it("does not count what the same pass already dropped as fixed floor", () => {
        const plan = planEmergencyDrop({ ...base, removedThisPassTokens: 288_351 - 63_730 });
        expect(plan.reason).not.toContain("already exceeds ceiling");
        // Floor of the served request: 63,730 − 8 × 4,020.
        expect(plan.reason).toContain("floor≈31570");
        expect(plan.reason).toContain("served≈63730");
        // That request is far below the ceiling: nothing more to drop.
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toContain("reclaim<=min");
    });

    it("still skips a pass whose fixed part of the served request exceeds the ceiling", () => {
        // Only 5,000 tokens left this pass: the served request still holds
        // ~251,000 tokens no tool drop can remove.
        const plan = planEmergencyDrop({ ...base, removedThisPassTokens: 5_000 });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.tagNumbers).toEqual([]);
        expect(plan.reason).toContain("fixed floor ≈251191 already exceeds ceiling 250000");
    });

    it("never takes the removed mass out of a reading too small to hold it and the active tags", () => {
        // The reading (96,000) is below the active tags (100,000) the request
        // still carries, so it does not describe this request. The planner
        // works against it as before, and the measured removal changes nothing.
        const tools = [
            tag(1, "bash", 1, { servedTokens: 60_000, reclaimableTokens: 60_000 }),
            tag(2, "read", 1, { servedTokens: 40_000, reclaimableTokens: 40_000 }),
        ];
        const input = {
            tags: tools,
            floorTags: tools,
            maxTag: 2,
            protectedCutoff: null,
            currentTotalInputTokens: 96_000,
            ceilingTokens: 65_000,
            usagePercentage: 96,
            priorInputSample: 0,
            hasPriorDrop: false,
            passAlreadyPriced: true,
        };
        const plan = planEmergencyDrop({ ...input, removedThisPassTokens: 372_390 });
        const today = planEmergencyDrop(input);
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toEqual(today.tagNumbers);
        expect(plan.reclaimTokens).toBe(today.reclaimTokens);
        expect(plan.reason).toContain("after ≈0 removed this pass (≈372390 measured)");
        // Between the two: only what the reading holds beyond the active tags
        // comes out of it.
        const partial = planEmergencyDrop({
            ...input,
            currentTotalInputTokens: 130_000,
            removedThisPassTokens: 50_000,
        });
        expect(partial.reason).toContain("served≈100000 after ≈30000 removed this pass");
    });

    it("a tag newer than the reading adds to what the pass serves without lowering the floor", () => {
        // The reading (100,000) measured 8 reads of 4,020 each; the newest
        // step's 30,000-token output arrived after it.
        const reads = Array.from({ length: 8 }, (_, n) =>
            tag(n + 1, "read", 1, { servedTokens: 4_020, reclaimableTokens: 3_900 }),
        );
        const input = {
            tags: reads,
            maxTag: 9,
            protectedCutoff: null,
            currentTotalInputTokens: 100_000,
            ceilingTokens: 60_000,
            usagePercentage: 90,
            priorInputSample: 0,
            hasPriorDrop: false,
            passAlreadyPriced: true,
        };
        const newest = tag(9, "bash", 1, { servedTokens: 30_000, reclaimableTokens: 30_000 });
        const withNewest = planEmergencyDrop({
            ...input,
            floorTags: [...reads, { ...newest, sinceReading: true }],
        });
        const without = planEmergencyDrop({ ...input, floorTags: reads });
        // The fixed part the reading holds is 100,000 − 8 × 4,020 either way.
        expect(withNewest.reason).toContain("fixed floor ≈67840 already exceeds ceiling 60000");
        expect(without.reason).toContain("fixed floor ≈67840 already exceeds ceiling 60000");
        // Counted as present at the reading, the same tag would have lowered it.
        const biased = planEmergencyDrop({ ...input, floorTags: [...reads, newest] });
        expect(biased.reason).toContain("floor≈37840");
        // Below the ceiling, the newer tag adds to the gap the drop must close.
        const room = { ...input, ceilingTokens: 120_000 };
        const gapWith = planEmergencyDrop({
            ...room,
            floorTags: [...reads, { ...newest, sinceReading: true }],
        });
        const gapWithout = planEmergencyDrop({ ...room, floorTags: reads });
        expect(gapWith.reclaimTokens - gapWithout.reclaimTokens).toBe(30_000);
    });

    it("at 95% a result that arrived after the reading is dropped even when the reading's own fixed part exceeds the ceiling", () => {
        // The previous request read 15,360 tokens, almost none of it tagged;
        // then a 325,000-token result arrived. The fixed part of the reading
        // (15,329) exceeds the 10,400 ceiling, but the request only overflows
        // the window because of the newer result, which a drop removes.
        const old = tag(1, "bash", 1, { servedTokens: 31, reclaimableTokens: 31 });
        const newest = {
            ...tag(2, "read", 1, { servedTokens: 325_852, reclaimableTokens: 325_841 }),
            sinceReading: true,
        };
        const input = {
            tags: [old, newest],
            floorTags: [old, newest],
            maxTag: 2,
            protectedCutoff: null,
            currentTotalInputTokens: 15_360,
            ceilingTokens: 10_400,
            usagePercentage: 96,
            priorInputSample: 0,
            hasPriorDrop: false,
            passAlreadyPriced: true,
        };
        const plan = planEmergencyDrop(input);
        expect(plan.shouldDrop).toBe(true);
        expect(plan.tagNumbers).toContain(2);
        expect(plan.reason).toContain("newer than the reading (counted in the reading)");
        // The same plan as when the newer result is counted in the reading.
        const counted = planEmergencyDrop({
            ...input,
            tags: [old, { ...newest, sinceReading: false }],
            floorTags: [old, { ...newest, sinceReading: false }],
        });
        expect(plan.tagNumbers).toEqual(counted.tagNumbers);
        expect(plan.reclaimTokens).toBe(counted.reclaimTokens);
        // Below 95% the accurate floor stands and the pass skips.
        expect(planEmergencyDrop({ ...input, usagePercentage: 90 }).reason).toContain(
            "fixed floor ≈15329 already exceeds ceiling 10400",
        );
        // With nothing newer, a fixed part above the ceiling still skips at 95%.
        const fixedOnly = planEmergencyDrop({ ...input, tags: [old], floorTags: [old] });
        expect(fixedOnly.shouldDrop).toBe(false);
        expect(fixedOnly.reason).toContain("already exceeds ceiling");
    });

    it("gauges the gap on the served request, so earlier drops count toward the target", () => {
        const tools = [tag(1, "bash", 1, { servedTokens: 40_000, reclaimableTokens: 40_000 })];
        const input = {
            tags: tools,
            floorTags: tools,
            maxTag: 1,
            protectedCutoff: null,
            currentTotalInputTokens: 200_000,
            ceilingTokens: 150_000,
            priorInputSample: 0,
            hasPriorDrop: false,
        };
        // Without earlier drops: floor 160,000 exceeds the ceiling.
        expect(planEmergencyDrop(input).reason).toContain("already exceeds ceiling");
        // 100,000 already left: floor 60,000, target 60,000 + 0.3 × 90,000 =
        // 87,000, served 100,000, gap 13,000; the one tool reaches it.
        const plan = planEmergencyDrop({ ...input, removedThisPassTokens: 100_000 });
        expect(plan.shouldDrop).toBe(true);
        expect(plan.reclaimTokens).toBe(13_000);
        expect(plan.tagNumbers).toEqual([1]);
    });
});

describe("emergency served-mass snapshot", () => {
    const calibration = { toolsRatio: 1, proseRatio: 1 };
    // A fake tool target whose content leaves the request when dropped, taking
    // the thinking beside it off the request too, as the real drop does.
    function toolTarget(output: string, thinking: Record<string, unknown>) {
        let dropped = false;
        const target: TagTarget = {
            dropReasoningParts: [thinking],
            measureReclaim: () => ({
                beforeTools: dropped ? 0 : estimateTokens(output),
                afterTools: 0,
                beforeProse: 0,
                afterProse: 0,
            }),
            setContent: () => false,
        };
        return {
            target,
            drop: () => {
                dropped = true;
                neutralizeDroppedReasoningPart(thinking);
            },
        };
    }

    it("counts the dropped tags and the reasoning they took off the request, each shared block once", () => {
        const shared = { type: "reasoning", text: "thinking ".repeat(200) };
        const first = toolTarget("first output ".repeat(300), shared);
        const second = toolTarget("second output ".repeat(300), shared);
        const kept = toolTarget("kept output ".repeat(300), {
            type: "reasoning",
            text: "kept thinking ".repeat(100),
        });
        const targets = new Map<number, TagTarget>([
            [1, first.target],
            [2, second.target],
            [3, kept.target],
        ]);
        const tags = [1, 2, 3].map((n) => tag(n, "bash", 1));
        // A block an earlier pass already took off the request.
        const unserved = { type: "reasoning", text: "old thinking ".repeat(200) };
        const fourth = toolTarget("fourth output ".repeat(300), unserved);
        targets.set(4, fourth.target);
        tags.push(tag(4, "bash", 1));
        const messages = [
            {
                info: { id: "a1", role: "assistant" },
                parts: [shared, kept.target.dropReasoningParts![0]],
            },
        ] as unknown as MessageLike[];
        const snapshot = snapshotEmergencyServedMass(tags, targets, calibration, messages);
        expect(emergencyServedMassRemovedSince(snapshot, targets, calibration)).toBe(0);

        first.drop();
        second.drop();
        fourth.drop();
        const expected =
            estimateTokens("first output ".repeat(300)) +
            estimateTokens("second output ".repeat(300)) +
            estimateTokens("fourth output ".repeat(300)) +
            estimateTokens("thinking ".repeat(200));
        expect(emergencyServedMassRemovedSince(snapshot, targets, calibration)).toBe(expected);
        // Measurements already taken on the current request are reused.
        expect(
            emergencyServedMassRemovedSince(
                snapshot,
                targets,
                calibration,
                new Map([[3, { servedTokens: 0 }]]),
            ),
        ).toBe(expected + estimateTokens("kept output ".repeat(300)));
    });
});

describe("tagsSinceReading", () => {
    it("marks the tags of the newest assistant with content and everything after it", () => {
        const message = (role: string, parts: unknown[]) => ({ info: { role }, parts });
        const oldText = { type: "text", text: "old" };
        const oldTool = { type: "tool", callID: "a" };
        const newText = { type: "text", text: "new" };
        const newTool = { type: "tool", callID: "b" };
        const followUp = { type: "text", text: "follow-up" };
        const messages = [
            message("user", [{ type: "text", text: "task" }]),
            message("assistant", [oldText, oldTool]),
            message("assistant", [newText, newTool]),
            message("user", [followUp]),
            // A pending shell with no content is not the reply to the reading.
            message("assistant", []),
        ];
        const target = (part: unknown, owner: (typeof messages)[number]): TagTarget => ({
            mutationParts: [{ message: owner as never, part }],
            setContent: () => false,
        });
        const targets = new Map<number, TagTarget>([
            [1, target(oldText, messages[1]!)],
            [2, target(oldTool, messages[1]!)],
            [3, target(newText, messages[2]!)],
            [4, target(newTool, messages[2]!)],
            [5, target(followUp, messages[3]!)],
            // A target known only by its message.
            [6, { message: messages[2] as never, setContent: () => false }],
        ]);
        expect([...tagsSinceReading(messages, targets)].sort()).toEqual([3, 4, 5, 6]);
        expect(tagsSinceReading([], targets).size).toBe(0);
    });
});
