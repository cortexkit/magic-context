export type CacheBustDivergenceClass =
    | "no_mc_pass_row"
    | "system_row_shift"
    | "accounted_hard_model_change"
    | "accounted_hard_system_hash"
    | "accounted_hard_epoch"
    | "accounted_hard_pressure_refold"
    | "accounted_hard_marker_drain"
    | "accounted_hard_fold"
    | "accounted_tag_identity_repair"
    | "accounted_execute_published_history"
    | "accounted_soft_m1_execute"
    | "accounted_ctx_reduce"
    | "accounted_ctx_flush"
    | "accounted_force_band"
    | "accounted_drop_applied"
    | "accounted_provider_system_prompt_change"
    | "usage_missing"
    | "provider_full_miss"
    | "provider_short_read_identical_bytes"
    | "tail_shrink_no_rewrite"
    | "self_inflicted_epoch"
    | "unfaulted_epoch"
    | "accounted_lkg_frozen_release"
    | "unaccounted_defer_pass"
    | "unaccounted_double_bust"
    | "unaccounted_tail_rewrite"
    | "unaccounted_rewrite"
    | "provider_short_read_after_reclaim"
    | "double_bust_after_reclaim"
    | "idle_cache_expiry"
    | "missing_breakpoint_after_read";

export interface AnalyzedCacheRequest {
    session: string;
    at: string;
    timestampMs: number;
    verdict: "BASE" | "BUST" | "STABLE" | "LATENCY" | "UNMETERED";
    rewrittenTokens?: number;
    divergenceClass?: CacheBustDivergenceClass;
    firstDivergence: string;
    analyzerCmd: string;
    /** Render-identity components the matched pass reported as changed, when it logged them. */
    identityDelta?: string[];
    /**
     * The class the request would carry on its own, kept when a bust right after
     * a reclaim bust was relabelled `double_bust_after_reclaim` or
     * `provider_short_read_after_reclaim`, so the alert still names what happened.
     */
    cause?: CacheBustDivergenceClass;
}

export interface CacheBustSessionAnalysis {
    requests: AnalyzedCacheRequest[];
    highWaterMarkMs: number | null;
    directory?: string;
}

export interface CacheBustDecisionAttribution {
    timestampMs: number;
    requestObservedAtMs?: number;
    messageId?: string;
    decision: string;
    canonicalDecision?: string;
    deferReason?: string | null;
    /**
     * The reclaim ride the pass logged when it applied queued work, for example
     * "publishedHistory". Names why the pass was allowed to mutate, which the
     * scheduler decision alone does not say.
     */
    appliedRide?: string;
    /** The reason a frozen last-known-good replay was no longer served. */
    lkgFrozenReleaseReason?: string;
    materialized: boolean;
    materializeReason: string | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    /** Raw OpenCode message count observed by the Rust pass, when logged. */
    inputCount?: number;
    /** A restart, deploy, or explicit configuration epoch independently explains epoch_change. */
    externalEpoch?: boolean;
    /** Names the render-identity components changed during transformation. The `mur` entry
     * represents mural content; other entries show that an independent identity also changed. */
    identityDelta?: string[];
    flush: boolean;
    source: string;
    /**
     * Set on log markers that are not passes: a module fault, a full-array retry, a
     * fallback serve, or an adapter restart. Names the kind. Such records never
     * join a request; they only explain an epoch HARD that follows them.
     */
    disruption?: string;
}

export interface CacheBustAttributionInput {
    divergenceIndex: number;
    previousMessageCount: number;
    previousBustDivergenceIndex?: number;
    previousProvider?: string;
    currentProvider?: string;
    firstDivergenceRole?: string;
    firstDivergenceSize?: number;
    rewrittenTokens?: number;
    cacheCreationTokens?: number;
    promptTokens?: number;
    contentEvidence?: string;
    compactionSeam?: boolean;
    inheritedFold?: boolean;
    /** Provider cache-read component, excluding Anthropic direct input tokens. */
    providerComparableRead?: number;
    /** Direct/uncached input component of the current request. */
    directInput?: number;
    /** Total provider meter on the preceding request. */
    previousTotal?: number;
    previousModel?: string;
    currentModel?: string;
    /** The meter read short while the reusable byte prefix was unchanged. */
    providerShortReadWithIdenticalPrefix?: boolean;
    /**
     * Class of the request just before this one, when that request was also a
     * bust. A bust right after a reclaim bust means one threshold crossing was
     * paid twice; see classifyBustAfterReclaim.
     */
    previousBustClass?: CacheBustDivergenceClass;
    /** The only normalized wire change is a shorter tail, not a rewrite. */
    tailShrink?: boolean;
    /**
     * The short read came more than the cache TTL after the reusable prefix was
     * last read in full or written; see isIdleCacheExpiry.
     */
    idleCacheExpiry?: boolean;
    /**
     * Explicit-breakpoint meter (Anthropic): the short read came with no cache
     * write and a large uncached input; see isMissingBreakpointAfterRead.
     */
    missingBreakpointAfterRead?: boolean;
    /** Current raw OpenCode message count divided by the preceding pass count. */
    ocInputStepRatio?: number;
    decision?: CacheBustDecisionAttribution;
    /** The last session pass that rebuilt the cached prefix after its rendering identity changed. */
    previousEpochHard?: CacheBustDecisionAttribution;
    /**
     * The newest disruption in the 60 s before the matched pass. `undefined` means the
     * disruption markers were not available (no adapter log for the session); `null`
     * means the log was read and nothing disrupted the session in that window.
     */
    precedingDisruption?: string | null;
}

export interface CacheBustRule {
    divergenceClass: CacheBustDivergenceClass;
    accounted: boolean;
    rule: string;
}

export const CACHE_BUST_RULE_TABLE: readonly CacheBustRule[] = [
    {
        divergenceClass: "system_row_shift",
        accounted: true,
        rule: "message[0]/system divergence rewrites less than 5% of the prompt",
    },
    {
        divergenceClass: "no_mc_pass_row",
        accounted: false,
        rule: "no MC pass record in [request - 30 s, request + 5 s]",
    },
    {
        divergenceClass: "accounted_ctx_flush",
        accounted: true,
        rule: "matched pass records an explicit /ctx-flush",
    },
    {
        divergenceClass: "accounted_force_band",
        accounted: true,
        rule: "matched pass records a forced emergency drop batch",
    },
    {
        divergenceClass: "accounted_hard_marker_drain",
        accounted: true,
        rule: "matched HARD/m0 pass records marker_drain or a compaction-marker seam",
    },
    {
        divergenceClass: "accounted_hard_model_change",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=model_change",
    },
    {
        divergenceClass: "accounted_hard_system_hash",
        accounted: true,
        rule: "matched HARD/m0 pass records system_hash, or a large system-prompt replacement",
    },
    {
        divergenceClass: "accounted_hard_epoch",
        accounted: true,
        rule: "matched HARD/m0 pass records a project, render, or session epoch change",
    },
    {
        divergenceClass: "accounted_hard_pressure_refold",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=pressure_refold",
    },
    {
        divergenceClass: "accounted_hard_fold",
        accounted: true,
        rule: "matched pass records another materialized HARD/m0 fold; tiny mid-history defer/first_render seams are excluded",
    },
    {
        divergenceClass: "accounted_tag_identity_repair",
        accounted: true,
        rule: "matched pass records materialize_reason=tag_identity_repair (Pi kept the newest of two tag numbers for one call or message and rebuilt once)",
    },
    {
        divergenceClass: "accounted_ctx_reduce",
        accounted: true,
        rule: "matched pass applies drops at an agent ctx_reduce landing",
    },
    {
        divergenceClass: "accounted_drop_applied",
        accounted: true,
        rule: "matched pass records applied drops",
    },
    {
        divergenceClass: "accounted_execute_published_history",
        accounted: true,
        rule: "matched execute pass drained queued work on a publishedHistory reclaim ride",
    },
    {
        divergenceClass: "accounted_soft_m1_execute",
        accounted: true,
        rule: "matched canonical execute pass refreshes m1",
    },
    {
        divergenceClass: "usage_missing",
        accounted: true,
        rule: "provider cache read and direct input are both 0 or usage is absent; the pass is in flight/unmetered and never becomes a bust baseline",
    },
    {
        divergenceClass: "provider_full_miss",
        accounted: true,
        rule: "provider cache read is exactly 0 with prevTotal ≥ 10,000; ordinary short reads stay unaccounted; show wire model prev → cur when it changes",
    },
    {
        divergenceClass: "provider_short_read_identical_bytes",
        accounted: true,
        rule: "provider read fell short while the reusable byte prefix was unchanged; provider-side latency or eviction, not a prompt rewrite",
    },
    {
        divergenceClass: "tail_shrink_no_rewrite",
        accounted: true,
        rule: "the tail became shorter and the meter estimates at most 64 rewritten tokens; no meaningful cache write occurred",
    },
    {
        divergenceClass: "self_inflicted_epoch",
        accounted: false,
        rule: "epoch_change has no restart/deploy/config epoch and either only mur: changed or raw OpenCode input stepped by at least 4×",
    },
    {
        divergenceClass: "unfaulted_epoch",
        accounted: false,
        rule: "epoch_change has no restart/deploy/config epoch and the adapter log shows no module fault, full-array retry, fallback serve, or adapter restart in the preceding 60 s; the wake names identity_delta",
    },
    {
        divergenceClass: "accounted_lkg_frozen_release",
        accounted: true,
        rule: "matched pass records why it stopped serving the frozen last-known-good request in materialize_reason",
    },
    {
        divergenceClass: "unaccounted_defer_pass",
        accounted: false,
        rule: "matched canonical defer pass, including a tiny mid-history first_render seam, diverges",
    },
    {
        divergenceClass: "accounted_provider_system_prompt_change",
        accounted: true,
        rule: "matched non-defer pass has a user-visible provider change",
    },
    {
        divergenceClass: "unaccounted_double_bust",
        accounted: false,
        rule: "matched otherwise-unattributed pass repeats the previous divergence offset",
    },
    {
        divergenceClass: "unaccounted_tail_rewrite",
        accounted: false,
        rule: "matched otherwise-unattributed pass rewrites the previous request tail",
    },
    {
        divergenceClass: "unaccounted_rewrite",
        accounted: false,
        rule: "matched pass has no accounted attribution",
    },
    {
        divergenceClass: "provider_short_read_after_reclaim",
        accounted: false,
        rule: "overrides provider_short_read_identical_bytes on the request right after a reclaim bust: its bytes extend the reclaim request unchanged, yet the provider did not serve the prefix that request wrote, so one threshold crossing was billed twice; provider-side, not a Magic Context rewrite",
    },
    {
        divergenceClass: "double_bust_after_reclaim",
        accounted: false,
        rule: "overrides any other accounted class on the request right after a reclaim bust; one threshold crossing must cost one bust, and the wake names the overridden class as its cause",
    },
    {
        divergenceClass: "idle_cache_expiry",
        accounted: true,
        rule: "the short read came more than the cache TTL (default 5 min) after the reusable prefix was last read in full or written; the provider dropped it while idle",
    },
    {
        divergenceClass: "missing_breakpoint_after_read",
        accounted: false,
        rule: "explicit-breakpoint meter: the read fell short of the previous cached prefix, nothing was written, and at least 1,024 tokens were billed as uncached input; the request carried no cache breakpoint past the read point",
    },
] as const;

const ACCOUNTED_CLASSES = new Set(
    CACHE_BUST_RULE_TABLE.filter((row) => row.accounted).map((row) => row.divergenceClass),
);
const EPOCH_REASONS = new Set(["project_memory_epoch", "epoch_change", "compartment_render_epoch"]);
const TAIL_SHRINK_REWRITE_NOISE_TOKENS = 64;

/**
 * Tolerance below the previous cached prefix that still counts as a full read.
 * Anthropic reports exact counts (a warm request reads the previous read plus
 * write to the token), so this only absorbs small tail trims.
 */
export const CACHE_READ_EPSILON_TOKENS = 64;
/**
 * How long an idle provider prefix is assumed to survive: Anthropic's default
 * ephemeral cache_control TTL, and Magic Context's own `cache_ttl` default.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
/**
 * Smallest uncached input that, with no cache write, marks a missing breakpoint.
 * A request whose last breakpoint sits on its newest message leaves only a few
 * tokens uncached; 1,024 is Anthropic's smallest minimum cacheable length.
 */
export const MISSING_BREAKPOINT_MIN_UNCACHED_TOKENS = 1_024;

/** One request's prompt meter: cached read, cache write, and uncached input. */
export interface CacheMeterReading {
    read: number;
    write: number;
    input: number;
}

/**
 * Lowest cache read that still reuses everything the previous request left
 * cached. Uncached input is deliberately absent: it was billed in full and
 * cached nothing, so counting it as reuse hides a request that read only the
 * head of the prompt.
 */
export function cachedPrefixFloor(previous: CacheMeterReading): number {
    return previous.read + previous.write - CACHE_READ_EPSILON_TOKENS;
}

/**
 * A short read on an explicit-breakpoint meter that wrote nothing while a large
 * span went uncached. With a breakpoint after the read point the provider would
 * have written that span; with none, it bills it as plain input every time.
 */
export function isMissingBreakpointAfterRead(
    current: CacheMeterReading,
    options: { shortRead: boolean; explicitBreakpoints: boolean },
): boolean {
    return (
        options.shortRead &&
        options.explicitBreakpoints &&
        current.write === 0 &&
        current.read > 0 &&
        current.input >= MISSING_BREAKPOINT_MIN_UNCACHED_TOKENS
    );
}

/**
 * Does this request keep the cache clock running? A full read refreshes the
 * provider's TTL and a write starts a new prefix. On an explicit-breakpoint
 * meter a short read that wrote nothing touched only the head, so the rest of
 * the prefix keeps ageing from the last request that did. Implicit-prefix
 * caches (OpenAI, Gemini) store every prompt they serve, so every request
 * refreshes them.
 */
export function refreshesCachedPrefix(
    current: CacheMeterReading,
    options: { shortRead: boolean; explicitBreakpoints: boolean },
): boolean {
    return !options.shortRead || current.write > 0 || !options.explicitBreakpoints;
}

/** A short read more than the TTL after the prefix was last refreshed. */
export function isIdleCacheExpiry(
    requestMs: number,
    prefixRefreshedAtMs: number | undefined,
    cacheTtlMs: number,
): boolean {
    return prefixRefreshedAtMs !== undefined && requestMs - prefixRefreshedAtMs > cacheTtlMs;
}

/** Parse a `--cache-ttl` value such as 5m, 1h, or 300s into milliseconds. */
export function parseCacheTtl(value: string | undefined): number {
    if (value === undefined) return DEFAULT_CACHE_TTL_MS;
    const match = /^(\d+)(ms|s|m|h)$/.exec(value);
    if (!match) throw new Error(`Invalid --cache-ttl ${value}; expected a duration such as 5m or 1h`);
    const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
    return Number(match[1]) * unitMs;
}

export function isUnaccountedCacheBustClass(divergenceClass: string): boolean {
    return !ACCOUNTED_CLASSES.has(divergenceClass as CacheBustDivergenceClass);
}

/**
 * Classes that are not a meaningful second rewrite: missing usage, a tail that
 * only got shorter, or a small system-row shift (see the rule table).
 */
const NOT_A_SECOND_REWRITE = new Set<string>([
    "usage_missing",
    "tail_shrink_no_rewrite",
    "system_row_shift",
    "idle_cache_expiry",
]);

/** A bust Magic Context caused on purpose and accounted for: a reclaim, fold, or flush. */
export function isReclaimBustClass(divergenceClass: string | undefined): boolean {
    return divergenceClass?.startsWith("accounted_") === true;
}

/**
 * Class for a bust that directly follows another bust. One threshold crossing
 * must cost one bust, so a second bust right after a reclaim always alerts,
 * even when its own class is accounted. A request whose bytes merely extend the
 * reclaim request is named as the provider's doing; any other accounted class
 * becomes `double_bust_after_reclaim`. Unaccounted classes already alert under
 * their own name and are kept.
 */
export function classifyBustAfterReclaim(
    previousBustClass: string | undefined,
    own: CacheBustDivergenceClass,
): CacheBustDivergenceClass {
    if (!isReclaimBustClass(previousBustClass)) return own;
    if (own === "provider_short_read_identical_bytes") return "provider_short_read_after_reclaim";
    if (isUnaccountedCacheBustClass(own) || NOT_A_SECOND_REWRITE.has(own)) return own;
    return "double_bust_after_reclaim";
}

export function nearestCacheBustDecision(
    decisions: readonly CacheBustDecisionAttribution[],
    requestTimestampMs: number,
    messageId?: string,
): CacheBustDecisionAttribution | undefined {
    const timeDelta = (decision: CacheBustDecisionAttribution): number =>
        (decision.requestObservedAtMs ?? decision.timestampMs) - requestTimestampMs;
    const withinJoinWindow = (decision: CacheBustDecisionAttribution): boolean => {
        const delta = timeDelta(decision);
        return decision.disruption === undefined && delta >= -DEFAULT_CACHE_TTL_MS && delta <= 0;
    };
    // A pass prepares a request before it is sent. Allow a slow pass or host send
    // delay up to one default cache TTL, but never borrow the next request's pass.
    const byServeOrder = (
        left: CacheBustDecisionAttribution,
        right: CacheBustDecisionAttribution,
    ): number => timeDelta(right) - timeDelta(left);
    const exact = messageId
        ? decisions
              .filter((decision) => decision.messageId === messageId && withinJoinWindow(decision))
              .sort(byServeOrder)[0]
        : undefined;
    if (exact) return exact;
    return decisions.filter(withinJoinWindow).sort(byServeOrder)[0];
}

/** Join one session's requests in send order, claiming each pass at most once. */
export function createCacheBustDecisionJoiner(
    decisions: readonly CacheBustDecisionAttribution[],
): (requestTimestampMs: number, messageId?: string) => CacheBustDecisionAttribution | undefined {
    const claimed = new Set<CacheBustDecisionAttribution>();
    return (requestTimestampMs, messageId) => {
        const matched = nearestCacheBustDecision(
            decisions.filter((decision) => !claimed.has(decision)),
            requestTimestampMs,
            messageId,
        );
        if (matched) claimed.add(matched);
        return matched;
    };
}

export function classifyCacheBust(input: CacheBustAttributionInput): CacheBustDivergenceClass {
    return classifyBustAfterReclaim(input.previousBustClass, classifyOwnCacheBust(input));
}

/** The request's class judged on its own, ignoring the request before it. */
function classifyOwnCacheBust(input: CacheBustAttributionInput): CacheBustDivergenceClass {
    // The provider drops an idle prefix whatever the request looks like, so an
    // expiry outranks every request-shape class below.
    if (input.idleCacheExpiry) return "idle_cache_expiry";
    // A request that wrote nothing while most of its prompt went uncached had no
    // breakpoint to write at. That is the request's own shape, so it outranks the
    // identical-bytes provider class and any pass the request joins.
    if (input.missingBreakpointAfterRead) return "missing_breakpoint_after_read";
    // No transform pass can explain a short provider read when the reusable bytes
    // are unchanged, so this case is settled before joining any pass row.
    if (input.providerShortReadWithIdenticalPrefix) return "provider_short_read_identical_bytes";
    const isSystemRow = input.divergenceIndex === 0 && input.firstDivergenceRole === "system";
    const rewrittenRatio =
        input.rewrittenTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.rewrittenTokens / input.promptTokens
            : Number.POSITIVE_INFINITY;
    const creationRatio =
        input.cacheCreationTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.cacheCreationTokens / input.promptTokens
            : 0;
    if (isSystemRow && rewrittenRatio < 0.05 && creationRatio < 0.05) return "system_row_shift";

    // Provider-side signals are read before the pass-row join: a request whose
    // provider read is exactly zero is a cold miss on their side (a wire model
    // swap, an expired prefix, a billing-header rotation) whatever MC did or did
    // not record for it. Classifying it "no_mc_pass_row" made the sentinel wake
    // the operator for a rotation of the auth plugin's billing header on a
    // subagent session with no decision row (2026-09-21).
    const previousTotal = input.previousTotal ?? input.promptTokens;
    const usageMissing = input.providerComparableRead === 0 && input.directInput === 0;
    const providerFullMiss =
        input.providerComparableRead === 0 &&
        previousTotal !== undefined &&
        previousTotal >= 10_000;

    // A shorter tail can make the meter read below the previous total without
    // rewriting any reusable prefix. Allow only the provider's 64-token noise
    // floor here so genuine 1k+ tail rewrites remain actionable.
    if (
        !usageMissing &&
        !providerFullMiss &&
        input.tailShrink &&
        input.rewrittenTokens !== undefined &&
        input.rewrittenTokens <= TAIL_SHRINK_REWRITE_NOISE_TOKENS
    ) {
        return "tail_shrink_no_rewrite";
    }

    const decision = input.decision;
    if (!decision) {
        if (usageMissing) return "usage_missing";
        if (providerFullMiss) return "provider_full_miss";
        return "no_mc_pass_row";
    }

    const canonicalDecision = (decision.canonicalDecision ?? decision.decision).toLowerCase();
    const materializeReason = decision.materializeReason?.toLowerCase() ?? null;
    const isTinyFirstRenderDefer =
        materializeReason === "first_render" &&
        canonicalDecision === "defer" &&
        !input.inheritedFold &&
        input.firstDivergenceSize !== undefined &&
        input.firstDivergenceSize <= 256 &&
        input.divergenceIndex < Math.max(0, input.previousMessageCount - 2);
    if (decision.flush || materializeReason === "explicit_flush" || materializeReason === "user_flush") return "accounted_ctx_flush";
    if (materializeReason === "fit_retry") return "accounted_force_band";
    if (materializeReason === "system_hash") return "accounted_hard_system_hash";
    if (decision.emergency && decision.droppedCount > 0) return "accounted_force_band";
    if (decision.lkgFrozenReleaseReason) return "accounted_lkg_frozen_release";
    if (isTinyFirstRenderDefer && (usageMissing || providerFullMiss)) {
        return usageMissing ? "usage_missing" : "provider_full_miss";
    }
    if (isTinyFirstRenderDefer) return "unaccounted_defer_pass";
    // A scheduler-only defer does not show that a compaction actually ran. Nearby
    // old marker text or a changed billing header cannot prove that mutation.
    if (decision.source === "transform scheduler log" && canonicalDecision === "defer") {
        if (usageMissing) return "usage_missing";
        if (providerFullMiss) return "provider_full_miss";
        return "unaccounted_defer_pass";
    }
    // A pass that logged its reclaim ride states outright why it was allowed to
    // mutate, so it outranks the compaction-marker seam below, which only infers
    // a cause from nearby content. A fold the pass explicitly recorded, and the
    // provider-side zero-read facts, still win over it.
    if (
        !decision.materialized &&
        !usageMissing &&
        !providerFullMiss &&
        canonicalDecision === "execute" &&
        (decision.appliedRide ?? "").includes("publishedHistory")
    ) {
        return "accounted_execute_published_history";
    }
    if (
        materializeReason === "marker_drain" ||
        input.compactionSeam ||
        (input.contentEvidence ?? "").includes("[Compacted by magic-context")
    ) {
        return "accounted_hard_marker_drain";
    }
    if (usageMissing) return "usage_missing";
    // A declared Pi tag-identity repair rebuilds the array whether or not m[0]
    // was rematerialized; without this class an unmaterialized repair read as an
    // m1 refresh and a materialized one as an unnamed fold.
    if (materializeReason === "tag_identity_repair") return "accounted_tag_identity_repair";
    if (decision.materialized) {
        if (materializeReason === "model_change") return "accounted_hard_model_change";
        if (materializeReason === "system_hash") return "accounted_hard_system_hash";
        const muralOnlyIdentityDelta =
            decision.identityDelta?.length === 1 && decision.identityDelta[0] === "mur";
        const repeatedEpochHard = input.previousEpochHard !== undefined &&
            input.previousEpochHard.materialized &&
            input.previousEpochHard.materializeReason?.toLowerCase() === "epoch_change" &&
            !input.previousEpochHard.externalEpoch &&
            decision.timestampMs > input.previousEpochHard.timestampMs &&
            decision.timestampMs - input.previousEpochHard.timestampMs <= 60_000;
        if (
            materializeReason === "epoch_change" &&
            !decision.externalEpoch &&
            (repeatedEpochHard || muralOnlyIdentityDelta || (input.ocInputStepRatio ?? 0) >= 4)
        ) {
            return "self_inflicted_epoch";
        }
        // A render identity that changes with nothing around it to explain the change
        // (no fault, retry, fallback, or restart) is the spontaneous case; the wake
        // carries identity_delta so it names the component that moved.
        if (
            materializeReason === "epoch_change" &&
            !decision.externalEpoch &&
            input.precedingDisruption === null
        ) {
            return "unfaulted_epoch";
        }
        if (materializeReason && EPOCH_REASONS.has(materializeReason)) {
            return "accounted_hard_epoch";
        }
        if (materializeReason === "pressure_refold") {
            return "accounted_hard_pressure_refold";
        }
        return "accounted_hard_fold";
    }

    if (decision.droppedCount > 0 || decision.droppedTokens > 0) {
        return /\bctx_reduce\b/.test(input.contentEvidence ?? "")
            ? "accounted_ctx_reduce"
            : "accounted_drop_applied";
    }
    if (canonicalDecision === "execute") return "accounted_soft_m1_execute";
    if (isSystemRow) return "accounted_hard_system_hash";
    if (usageMissing) return "usage_missing";
    if (providerFullMiss) return "provider_full_miss";
    if (canonicalDecision === "defer") return "unaccounted_defer_pass";
    if (
        input.previousProvider &&
        input.currentProvider &&
        input.previousProvider !== input.currentProvider
    ) {
        return "accounted_provider_system_prompt_change";
    }
    if (
        input.previousBustDivergenceIndex !== undefined &&
        input.previousBustDivergenceIndex === input.divergenceIndex
    ) {
        return "unaccounted_double_bust";
    }
    if (input.divergenceIndex >= Math.max(0, input.previousMessageCount - 2)) {
        return "unaccounted_tail_rewrite";
    }
    return "unaccounted_rewrite";
}
