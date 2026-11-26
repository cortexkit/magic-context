/**
 * The emergency tool-drop planner exactly as released in Magic Context
 * 0.49.81 (commit 4d55b630cc, `planEmergencyDrop` in emergency-drop.ts),
 * kept as the reference for the differential test. The current planner may
 * only lower the fixed part it infers, so for any input its selection must be
 * this one's or an extension of it in the same order. Do not edit this copy
 * to follow later planner changes: its value is that it does not move.
 *
 * The helpers it calls (tiers, reclaim estimates, protected tags) are imported
 * from the current module; the planner's own arithmetic is what is pinned.
 */
import { protectedToolTagNumbers } from "../../../features/magic-context/reclaim-protection";
import {
    EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS,
    EMERGENCY_REARM_MIN_TOKENS,
    type EmergencyDropPlan,
    type EmergencyDropTag,
    estimateEmergencyDropReclaimTokens,
    resolveToolTier,
    TARGET_FRACTION,
    TIER_RECENCY_RESERVE,
    type Tier,
} from "../emergency-drop";

export function releasePlanEmergencyDrop(input: {
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
    /**
     * Provider tokens that were in the request `currentTotalInputTokens`
     * measured but that this pass already removed before planning (queued
     * drops and the reasoning they took with them). The planner works on the
     * request this pass serves, so this mass is neither fixed floor nor
     * something left to reclaim. Zero when the caller does not measure it.
     */
    removedThisPassTokens?: number;
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

    // A force-band LEVEL is not a new application EDGE. Once an emergency batch
    // has acted in this pressure episode, fresh provider samples must not release
    // one newly-unprotected tag per execute pass. The caller clears the persisted
    // latch only after pressure exits or when another mutation has already priced
    // the pass, allowing the whole accumulated set to ride that independent bust.
    const absoluteEmergency = (input.usagePercentage ?? 0) >= 95;
    if (hasPriorDrop && !absoluteEmergency) {
        return noop(
            `pressure-episode-latched (prior sample ${priorInputSample}; awaiting exit or independent bust)`,
        );
    }

    // fixedFloor from the FULL active live-window content (floorTags — see the
    // contract above). The evictable `tags` set stays tool-only+canDrop so every
    // selected tag below actually reclaims its bytes; the floor sum deliberately
    // includes everything else (message text, files, reasoning, non-droppable
    // tools) because those bytes are on the wire and NOT irreducible prefix.
    //
    // The provider's reading measured the previous request. Tags created after
    // it (the newest step's output and text) are not part of that reading, so
    // only the tags present at the reading are subtracted from it; the newer
    // ones only add to what this pass serves.
    let tailTokens = 0;
    let newerTailTokens = 0;
    for (const tag of floorTags) {
        if (tag.status !== "active") continue;
        const tokens = tag.servedTokens ?? estimateEmergencyDropReclaimTokens(tag);
        if (tag.sinceReading) newerTailTokens += tokens;
        else tailTokens += tokens;
    }
    // `floorTags` is the active set after this pass's own earlier drops. Take
    // those drops off the reading first, so the floor and the active mass
    // subtracted from it describe the same request: the one this pass serves.
    // Otherwise everything the pass just dropped is counted as fixed overhead,
    // and a pass that has already shrunk the request far below the ceiling
    // skips as if tool drops could never reach it.
    //
    // The removed mass comes out of the floor only: at most what the reading
    // holds beyond the active tags it measured. A reading too small to hold
    // even those tags does not describe this request (a test that sets usage
    // directly, or a usage sample taken in other units than the local count):
    // it keeps today's meaning, the size the planner works against, with a
    // fixed floor of zero.
    const removedMeasured = Math.max(input.removedThisPassTokens ?? 0, 0);
    // Floor, served size and gap of one accounting. `newerInReading` says
    // whether the tags newer than the reading are treated as part of it.
    const account = (newerInReading: boolean) => {
        const measuredTail = newerInReading ? tailTokens + newerTailTokens : tailTokens;
        const removed = Math.min(
            removedMeasured,
            Math.max(currentTotalInputTokens - measuredTail, 0),
        );
        const floor = Math.max(currentTotalInputTokens - removed - measuredTail, 0);
        const served =
            currentTotalInputTokens >= measuredTail
                ? currentTotalInputTokens - removed + (newerInReading ? 0 : newerTailTokens)
                : currentTotalInputTokens;
        const target = floor + TARGET_FRACTION * Math.max(ceilingTokens - floor, 0);
        return { removed, floor, served, reclaim: Math.round(served - target) };
    };
    let accounting = account(false);
    let olderAccounting = false;
    // Tool drops cannot repair oversized fixed overhead, so a floor above the
    // ceiling skips the pass (below). Content that arrived after the reading
    // is not overhead, though: it is what pushed the request past the reading,
    // and at 95% or more the newest results are candidates and the refusal
    // path waits if they stay. There a floor that exceeds the ceiling only
    // because the newer tags are left out of it falls back to the older
    // accounting, which treats them as part of the reading, so a request
    // those drops would make fit is never refused for keeping them.
    if (accounting.floor > ceilingTokens && absoluteEmergency && newerTailTokens > 0) {
        const older = account(true);
        if (older.floor <= ceilingTokens) {
            accounting = older;
            olderAccounting = true;
        }
    }
    const { removed: removedThisPass, floor: fixedFloor, served: servedInputTokens } = accounting;
    const reclaimTokens = accounting.reclaim;
    const servedNote =
        removedMeasured > 0 || newerTailTokens > 0
            ? `, served≈${Math.round(servedInputTokens)} after ≈${Math.round(removedThisPass)} removed this pass${removedThisPass < removedMeasured ? ` (≈${Math.round(removedMeasured)} measured)` : ""}${newerTailTokens > 0 ? `, ≈${Math.round(newerTailTokens)} newer than the reading${olderAccounting ? " (counted in the reading)" : ""}` : ""}`
            : "";
    // Tool drops cannot repair oversized fixed overhead. Preserve the working
    // results and leave admission to the overflow/refusal path, even on a pass
    // whose cache rewrite is already priced by another mutation.
    if (fixedFloor > ceilingTokens) {
        return noop(
            `fixed floor ≈${Math.round(fixedFloor)} already exceeds ceiling ${Math.round(ceilingTokens)}: tool drops cannot reach the target${servedNote}`,
        );
    }

    // Already at/under target, or reclaim too small to justify a cache bust.
    if (reclaimTokens <= EMERGENCY_REARM_MIN_TOKENS) {
        return noop(
            `reclaim<=min (${reclaimTokens} <= ${EMERGENCY_REARM_MIN_TOKENS}; floor≈${Math.round(fixedFloor)}${servedNote})`,
        );
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
        reason: `tiered drop: ${selected.length} tags, reclaim≈${reclaimed}/${reclaimTokens} tokens (floor≈${fixedFloor}, ceiling=${Math.round(ceilingTokens)}${servedNote})`,
    };
}
