// Tiered target-headroom emergency tool-output drop (Phase 2).
//
// This is the EMERGENCY floor that replaces the old `dropAllTools` nuke at the
// derived force-materialize pass. It is need-aware (tier-ordered) and target-driven
// (reclaim down to ~30% of working space) instead of need-blind ("drop all" /
// "older than X"). Selection is PURE here; the harness applies the returned
// plan (drop primitive + `updateTagStatus(...,"dropped")` + watermark persist),
// so OpenCode and Pi run identical selection logic.
//
// CACHE CONTRACT (see ARCHITECTURE.md, tiered emergency drop and reclaim episodes):
//   - The caller MUST invoke this only on the ≥derived force-materialize pass (a
//     cache-busting pass, never a defer pass).
//   - Each tag is dropped AT MOST ONCE because dropped tags leave the active set.
//   - A continuous stay in the force band gets one non-empty emergency batch.
//     Leaving that band or another provider-visible mutation rearms selection,
//     so accumulated candidates share one rewrite instead of trickling.
//   - All accounting is in TOKENS. Tags store BYTES, so we convert with the one
//     canonical estimator (`TOKENS_PER_BYTE`, shared with the Phase 1 nudge).

import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import { TOKENS_PER_BYTE } from "./ctx-reduce-nudge";
import { estimateTokens } from "./read-session-formatting";
import type { TagTarget } from "./tag-messages";

/** Reclaim target = fixedFloor + TARGET_FRACTION × (ceiling − fixedFloor). */
export const TARGET_FRACTION = 0.3;

/** Keep the newest `ceil(RESERVE × tierCount)` of T1/T2 as continuation context. */
export const TIER_RECENCY_RESERVE = 0.2;

/**
 * Don't bust the cache for a trivial reclaim. If the computed reclaim is at or
 * below this, the pass is a no-op (combined with the watermark, this prevents
 * force-band-to-94.9% oscillation).
 */
export const EMERGENCY_REARM_MIN_TOKENS = 2000;

/**
 * The selected candidates must together reclaim at least this many tokens, or
 * the pass is skipped. The gap check above only proves there is something to
 * close; it says nothing about what the candidates can actually win back. One
 * live session spent an hour at 100% context dropping one fresh tool result
 * per pass, 28 to 149 tokens each against a ~9,200-token gap, rewriting a
 * cached prefix of ~300K tokens every time.
 */
export const EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS = EMERGENCY_REARM_MIN_TOKENS;

export type Tier = 1 | 2 | 3;

// Tier keys are matched against the normalized (lowercased, `mcp_`-stripped)
// tool name. Verified against the production tag corpus: stored `tool_name`
// values are bare (`read`, `edit`, `bash`, …) with no `mcp_` prefix; the strip
// is defensive insurance for environments that surface MCP-prefixed names.
const T1_TOOLS = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom"]);
const T2_TOOLS = new Set(["edit", "write", "apply_patch", "grep", "glob", "aft_search"]);

/** Normalize a stored tool name for tier matching. */
function normalizeToolName(toolName: string | null): string {
    if (!toolName) return "";
    let name = toolName.toLowerCase();
    if (name.startsWith("mcp_")) name = name.slice(4);
    return name;
}

/**
 * Classify a tool into its drop tier. T1 (keep longest) = navigation/structure
 * the agent re-uses; T2 (medium) = edit-class continuation context; T3 (drop
 * first) = everything else (the default — bash, ctx_reduce, inspect, web, …).
 */
export function resolveToolTier(toolName: string | null): Tier {
    const name = normalizeToolName(toolName);
    if (T1_TOOLS.has(name)) return 1;
    if (T2_TOOLS.has(name)) return 2;
    return 3;
}

/** Minimal tag shape the planner needs (subset of TagEntry, harness-agnostic). */
export interface EmergencyDropTag {
    tagNumber: number;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    toolName: string | null;
    byteSize: number;
    /** Tool-arg bytes — `drop()` removes the invocation too, so these reclaim. */
    inputByteSize: number;
    reasoningByteSize: number;
    /** Provider-token observations from the current representation, never persisted raw tag counts. */
    servedTokens?: number;
    reclaimableTokens?: number;
}

/**
 * Bytes a drop actually reclaims for a tool tag: output + invocation args +
 * preceding reasoning (the drop primitive removes all tool occurrences and
 * clears the thinking parts). Used for BOTH the fixedFloor tail sum and the
 * per-tag reclaim accumulator so they can never disagree (a mismatch is how
 * the planner under-evicts into overflow).
 */
function tagReclaimBytes(tag: EmergencyDropTag): number {
    return tag.byteSize + tag.inputByteSize + tag.reasoningByteSize;
}

export interface EmergencyDropPlan {
    /** Whether the caller should perform any drop this pass. */
    shouldDrop: boolean;
    /** Tool tag numbers to drop, in eviction order (T3→T2→T1, oldest-first). */
    tagNumbers: number[];
    /** Reclaim target in tokens (for logging). */
    reclaimTokens: number;
    /** Human-readable reason (no-op explanation or drop summary), for logs. */
    reason: string;
}

export function estimateEmergencyDropReclaimTokens(tag: EmergencyDropTag): number {
    if (tag.reclaimableTokens !== undefined)
        return Number.isFinite(tag.reclaimableTokens) ? Math.max(0, tag.reclaimableTokens) : 0;
    return Math.round(tagReclaimBytes(tag) * TOKENS_PER_BYTE);
}

/**
 * Plan a tiered target-headroom emergency drop. Pure: returns the ordered set of
 * tool tag numbers to drop, a token target, and a reason; the caller applies them.
 *
 * fixedFloor is estimated as current provider input minus measured active-tail mass.
 * Content with no observable token count remains in that fixed portion. This is
 * conservative reclaim planning, not proof that every remaining token is irreducible.
 *
 * The two tag sets serve DIFFERENT contracts and must not be conflated:
 * - `floorTags`: the ENTIRE active live-window tag set (all types, including
 *   non-droppable tool tags). Their served mass determines the estimated fixed floor. Passing a narrower set (e.g.
 *   tool-only) folds real conversation/reasoning tail into the "floor",
 *   raising the target and systematically under-evicting at the derived force band.
 * - `tags`: the evictable candidates — active tool tags whose drop target
 *   would actually reclaim bytes (caller pre-filters on `canDrop()` so no
 *   phantom tag is counted as reclaimed).
 */
/**
 * A force-band LEVEL is not a new application EDGE. Once an emergency batch has
 * acted in this pressure episode, fresh provider samples must not release one
 * newly-unprotected tag per execute pass. Only the absolute 95% arm overrides the
 * latch; the caller clears it after pressure exits or when another mutation has
 * already priced the pass.
 */
export function emergencyEpisodeLatched(hasPriorDrop: boolean, usagePercentage: number): boolean {
    return hasPriorDrop && !(usagePercentage >= 95);
}

export function planEmergencyDrop(input: {
    /** Evictable candidates: active tool tags with a working drop target. */
    tags: readonly EmergencyDropTag[];
    protectedTools?: Readonly<Record<string, number>>;
    protectedToolTags?: ReadonlySet<number>;
    /**
     * FULL active live-window tag set (all types) — floor accounting only.
     * See the fixedFloor contract above.
     */
    floorTags: readonly EmergencyDropTag[];
    maxTag: number;
    /**
     * Union projection form: exact tag-number cutoff directly.
     * Coordinate space: tag-number space (number | null).
     * Empty-window behavior: branches on absent cutoff (null), applying no tag-number threshold.
     */
    protectedCutoff: number | null;
    /** Provider-proven or estimated pressure; at 95% only open arcs and exemplars survive. */
    usagePercentage?: number;
    currentTotalInputTokens: number;
    /** ceiling = contextLimit × executeThreshold%. */
    ceilingTokens: number;
    /**
     * `last_emergency_input_sample` is retained as the pressure-episode latch:
     * zero means armed, non-zero means this force-band episode already had its
     * originating batch. The caller rearms on pressure exit or an independent
     * bust. There is deliberately no tag-number watermark because a scalar
     * cursor would exclude still-active lower-numbered tags after tiered drops.
     */
    priorInputSample: number;
    /** True while the persisted pressure-episode latch is non-zero. */
    hasPriorDrop: boolean;
    /**
     * True when another mutation already rewrites the cached prefix on this
     * pass. The selection then rides that rewrite for free, so the minimum
     * achievable reclaim does not apply.
     */
    passAlreadyPriced?: boolean;
}): EmergencyDropPlan {
    const {
        tags,
        floorTags,
        currentTotalInputTokens,
        ceilingTokens,
        priorInputSample,
        hasPriorDrop,
    } = input;

    const noop = (reason: string): EmergencyDropPlan => ({
        shouldDrop: false,
        tagNumbers: [],
        reclaimTokens: 0,
        reason,
    });

    // Guard: unknown / not-yet-resolved context limit → skip (the 95% block is
    // the backstop). Never guess a limit.
    if (!Number.isFinite(ceilingTokens) || ceilingTokens <= 0) {
        return noop("unknown-ceiling");
    }
    if (!Number.isFinite(currentTotalInputTokens) || currentTotalInputTokens <= 0) {
        return noop("unknown-usage");
    }

    // The caller clears the persisted latch only after pressure exits or when
    // another mutation has already priced the pass, allowing the whole
    // accumulated set to ride that independent bust.
    if (emergencyEpisodeLatched(hasPriorDrop, input.usagePercentage ?? 0)) {
        return noop(
            `pressure-episode-latched (prior sample ${priorInputSample}; awaiting exit or independent bust)`,
        );
    }

    // fixedFloor from the FULL active live-window content (floorTags — see the
    // contract above). The evictable `tags` set stays tool-only+canDrop so every
    // selected tag below actually reclaims its bytes; the floor sum deliberately
    // includes everything else (message text, files, reasoning, non-droppable
    // tools) because those bytes are on the wire and NOT irreducible prefix.
    let tailTokens = 0;
    for (const tag of floorTags) {
        if (tag.status !== "active") continue;
        tailTokens += tag.servedTokens ?? estimateEmergencyDropReclaimTokens(tag);
    }
    const fixedFloor = Math.max(currentTotalInputTokens - tailTokens, 0);
    const workingSpan = Math.max(ceilingTokens - fixedFloor, 0);
    const target = fixedFloor + TARGET_FRACTION * workingSpan;
    const reclaimTokens = Math.round(currentTotalInputTokens - target);
    // Tool drops cannot repair oversized fixed overhead. Preserve the working
    // results and leave admission to the overflow/refusal path, even on a pass
    // whose cache rewrite is already priced by another mutation.
    if (fixedFloor > ceilingTokens) {
        return noop(
            `fixed floor ≈${Math.round(fixedFloor)} already exceeds ceiling ${Math.round(ceilingTokens)}: tool drops cannot reach the target`,
        );
    }

    // Already at/under target, or reclaim too small to justify a cache bust.
    if (reclaimTokens <= EMERGENCY_REARM_MIN_TOKENS) {
        return noop(`reclaim<=min (${reclaimTokens} <= ${EMERGENCY_REARM_MIN_TOKENS})`);
    }

    // Union projection form: exact tag-number cutoff directly.
    // Coordinate space: tag-number space (number | null).
    // Empty-window behavior: branches on absent cutoff (null), applying no tag-number threshold.
    // At >=95%, the token window and newest-3 minimum yield (parity with #423).
    const cutoff = input.protectedCutoff;
    const windowYields = absoluteEmergency;

    // Below 95%, reserve the newest ceil(20%) of T1/T2 as continuation context.
    // At absolute emergency pressure, only open arcs and ctx_reduce exemplars remain protected.
    const tierActive: Record<1 | 2, number[]> = { 1: [], 2: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;
        const tier = resolveToolTier(tag.toolName);
        if (tier === 1 || tier === 2) tierActive[tier].push(tag.tagNumber);
    }
    const reserved = new Set<number>();
    for (const tier of [1, 2] as const) {
        const nums = tierActive[tier];
        if (nums.length === 0) continue;
        nums.sort((a, b) => b - a); // newest first
        const reserveCount = absoluteEmergency ? 0 : Math.ceil(TIER_RECENCY_RESERVE * nums.length);
        for (let i = 0; i < reserveCount && i < nums.length; i++) {
            reserved.add(nums[i]);
        }
    }

    // Protect the same newest ctx_reduce exemplars even though resolveToolTier
    // classifies them as T3. This is safe without changing the target math:
    // fixedFloor above derives from every active floor tag, so removing candidates
    // changes neither the floor nor the target (panel-verified emergency interaction).
    const protectedTags =
        input.protectedToolTags ?? protectedToolTagNumbers(floorTags, input.protectedTools);

    // Build evictable candidates per tier. Only active tags are eligible, so a
    // tag dropped on a prior pass (now status!=='active') is never re-selected —
    // that, plus the input-sample latch above, is the full idempotence story.
    const byTier: Record<Tier, EmergencyDropTag[]> = { 1: [], 2: [], 3: [] };
    for (const tag of tags) {
        if (tag.status !== "active" || tag.type !== "tool") continue;

        // Window protection check:
        // When window yields (>=95%), window does not protect tags.
        // Below 95%:
        // If cutoff is present (non-null), tool tags with tag_number >= cutoff are protected.
        // If cutoff is ABSENT (null), branch explicitly on absence and apply NO tag-number threshold!
        if (!windowYields) {
            if (cutoff !== null) {
                if (tag.tagNumber >= cutoff) continue;
            } else {
                // Branch: cutoff is absent (empty window) -> apply no tag-number threshold
            }
        }

        if (protectedTags.has(tag.tagNumber)) continue;
        const tier = resolveToolTier(tag.toolName);
        if ((tier === 1 || tier === 2) && reserved.has(tag.tagNumber)) continue;
        byTier[tier].push(tag);
    }

    // Walk T3 → T2 → T1, oldest-first within tier, until reclaim met.
    const selected: number[] = [];
    let reclaimed = 0;
    outer: for (const tier of [3, 2, 1] as const) {
        const group = byTier[tier];
        group.sort((a, b) => a.tagNumber - b.tagNumber); // oldest first
        for (const tag of group) {
            selected.push(tag.tagNumber);
            // Match the floor's tagReclaimBytes exactly: drop() removes output +
            // invocation args + preceding reasoning, so all three reclaim.
            reclaimed += estimateEmergencyDropReclaimTokens(tag);
            if (reclaimed >= reclaimTokens) break outer;
        }
    }

    if (selected.length === 0) {
        // No cache rewrite occurred; the caller leaves the episode armed so
        // later completed outputs can form a batch.
        return noop("no-candidates");
    }

    // Price the selection before committing it. Skipping leaves the episode
    // armed, so the candidates can still ride a later rewrite.
    if (!input.passAlreadyPriced && reclaimed < EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS) {
        return noop(
            `achievable reclaim below minimum (${selected.length} tags, reclaim≈${Math.round(reclaimed)} < ${EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS} against gap ${reclaimTokens})`,
        );
    }

    return {
        shouldDrop: true,
        tagNumbers: selected,
        reclaimTokens,
        reason: `tiered drop: ${selected.length} tags, reclaim≈${reclaimed}/${reclaimTokens} tokens (floor≈${fixedFloor}, ceiling=${Math.round(ceilingTokens)})`,
    };
}

/** Count current content and the planned replacement without mutating either cached representation. */
export function measureEmergencyTag<T extends EmergencyDropTag>(
    tag: T,
    target: TagTarget | undefined,
    calibration: { toolsRatio: number; proseRatio: number },
    skeleton: boolean,
): T & EmergencyDropTag {
    const observation = target?.measureReclaim?.(skeleton);
    if (observation) {
        const before =
            observation.beforeTools * calibration.toolsRatio +
            observation.beforeProse * calibration.proseRatio;
        const after =
            observation.afterTools * calibration.toolsRatio +
            observation.afterProse * calibration.proseRatio;
        return { ...tag, servedTokens: before, reclaimableTokens: Math.max(0, before - after) };
    }
    const content = target?.getContent?.();
    const served = content
        ? estimateTokens(content) *
          (tag.type === "tool" ? calibration.toolsRatio : calibration.proseRatio)
        : 0;
    // No replacement observation means no reclaim credit; original byte_size may describe unserved content.
    return { ...tag, servedTokens: served, reclaimableTokens: 0 };
}
