import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getOverflowState,
    loadPersistedUsage,
} from "../../features/magic-context/storage-meta-persisted";
import { escalationBands, MAX_EXECUTE_THRESHOLD } from "../../shared/escalation-bands";
import { modelRefLookupOrder, piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log, sessionLog } from "../../shared/logger";
import {
    getSdkContextLimit,
    getSdkWindowGeometry,
    isSaneLimit,
} from "../../shared/models-dev-cache";
import { resolveModelConfigOrDefault } from "../../shared/prompt-surface";

export { escalationBands, MAX_EXECUTE_THRESHOLD };
export const DEFAULT_CONTEXT_LIMIT = 200_000;

export function resolveContextWindowGeometry(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
) {
    if (!providerID || !modelID) return undefined;
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // Geometry resolution remains best-effort when session metadata is unavailable.
        }
    }
    return getSdkWindowGeometry(providerID, modelID, detected, {
        detectedLimitProvenance,
        harness: "opencode",
    });
}

type CacheTtlConfig = string | Record<string, string>;

/**
 * Resolve the effective context limit for a provider/model pair. By default
 * this returns the output-reserved safe input budget. `reservation: "none"`
 * preserves the same catalog, detected-limit, and fallback resolution while
 * exposing the unreserved window for native-usage display metrics only.
 */
export function resolveContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: {
        db?: ContextDatabase;
        sessionID?: string;
        reservation?: "default" | "none";
    },
): number {
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // Reading session meta is best-effort — fall through to the catalog.
        }
    }

    // Combined/unknown detections narrow the raw context before output
    // reservation. Prompt-only detections enter the pre-carved input arm.
    const fromModelsDev =
        providerID && modelID
            ? getSdkContextLimit(providerID, modelID, detected, {
                  reservation: ctx?.reservation,
                  detectedLimitProvenance,
              })
            : undefined;
    return fromModelsDev ?? detected ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * Like resolveContextLimit, but returns a limit ONLY when it is TRUSTED for the
 * current model, rather than the generic 200K `DEFAULT_CONTEXT_LIMIT`.
 *
 * Resolution precedence is:
 *   1. models.dev or a user provider override.
 *   2. A detected-overflow limit when it is smaller than the models.dev limit,
 *      or whenever models.dev has no entry.
 *   3. A sane persisted usage-reported limit when models.dev and overflow
 *      detection are both unavailable, but only when its observed model key
 *      matches the current model key.
 *
 * The history-budget resolver needs this distinction: deriving the decay budget
 * from a bare 128K guess for an UNKNOWN model would shrink history below what
 * the live-usage back-derivation would yield for a large-context model. So the
 * budget resolver only trusts a real, detected, or model-matched usage-reported
 * limit and otherwise falls back to live-usage. (resolveContextLimit itself must
 * keep returning 128K for pressure math, which needs a positive denominator.)
 */
export function resolveTrustedContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
): number | undefined {
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // best-effort; ignore
        }
    }

    // Apply measured wire truth to the matching resolver arm. Comparing a
    // combined detection against an already-reserved budget would double-count
    // output, while a prompt-only detection must not reserve output again.
    const fromModelsDev =
        providerID && modelID
            ? getSdkContextLimit(providerID, modelID, detected, {
                  detectedLimitProvenance,
              })
            : undefined;
    if (typeof fromModelsDev === "number" && fromModelsDev > 0) return fromModelsDev;
    if (detected !== undefined) return detected;

    // Usage reports are trusted only for the model that produced them. A
    // session-scoped limit from a previous model must not leak across a switch.
    if (modelKey && ctx?.db && ctx.sessionID) {
        try {
            const persisted = loadPersistedUsage(ctx.db, ctx.sessionID);
            if (
                persisted !== null &&
                piModelRefToCanonical(persisted.lastObservedModelKey ?? "") ===
                    piModelRefToCanonical(modelKey) &&
                isSaneLimit(persisted.lastUsageContextLimit)
            ) {
                return persisted.lastUsageContextLimit;
            }
        } catch {
            // best-effort; ignore
        }
    }

    return undefined;
}

export function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string {
    if (typeof cacheTtl === "string") {
        return cacheTtl;
    }

    return resolveModelConfigOrDefault(cacheTtl, modelKey, cacheTtl.default ?? "5m");
}

type ExecuteThresholdConfig = number | { default: number; [modelKey: string]: number };
type ExecuteThresholdTokensConfig =
    | { default?: number; [modelKey: string]: number | undefined }
    | undefined;

export interface ExecuteThresholdOptions {
    /** Optional tokens-based threshold config. When matched for the given modelKey,
     *  overrides the percentage-based threshold. */
    tokensConfig?: ExecuteThresholdTokensConfig;
    /** Required when `tokensConfig` is provided — used to convert tokens → percentage
     *  and to clamp values above 90% × context_limit. */
    contextLimit?: number;
    /** Session ID for warn logs when clamping. If absent, warns to global log. */
    sessionId?: string;
}

export type ExecuteThresholdMode = "percentage" | "tokens";

export interface ExecuteThresholdDetail {
    /** Effective execute threshold as a percentage (0–90). Downstream math keys off this. */
    percentage: number;
    /** Which source was authoritative: tokens config (when matched + valid context) or percentage. */
    mode: ExecuteThresholdMode;
    /** When mode is "tokens", the absolute token value after clamping (≤ 90% × contextLimit). */
    absoluteTokens?: number;
    /** The config key that matched, if any (for display/debugging). `"default"` when default fallback. */
    matchedKey?: string;
    /**
     * True when the user's configured value exceeded the safe cap and was reduced.
     * Tokens mode: configured tokens > 90% × contextLimit. Percentage mode:
     * configured percentage > MAX_EXECUTE_THRESHOLD (90). Display surfaces read this
     * to tell the user their value was clamped instead of silently ignoring it (#241).
     * Only present (true) when a clamp actually happened; absent otherwise.
     */
    clamped?: boolean;
    /**
     * The raw configured value before clamping — a token count in tokens mode, a
     * percentage in percentage mode. Populated only alongside `clamped` so display
     * surfaces can show the math (e.g. "190,000 > 90% of 128,000").
     */
    configuredValue?: number;
}

// Module-level dedupe for clamp warnings. Key: `${sessionId}|${modelKey}|${tokenVal}|${cap}`.
// The hot transform path may call resolveExecuteThreshold many times per second; without dedupe
// an over-cap token config would spam the log file continuously until the user fixes it.
const clampWarnSeen = new Set<string>();

/**
 * Return true iff `v` is a finite positive number. Schema normally forbids junk values, but
 * runtime callers may derive contextLimit from `inputTokens / (percentage/100)` (NaN when
 * percentage is 0) or accept externally-mutated configs. Guarding here keeps resolver
 * output deterministic and within bounds.
 */
function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Yield progressively-less-specific lookup keys for a given `provider/model`.
 *
 * OpenCode's `experimental.modes` feature derives model IDs like
 * `gpt-5.4-fast` from a base model `gpt-5.4`. Users may put EITHER the
 * derived key OR the base key in their per-model config. This generator
 * returns keys in specificity order so we pick the most specific match
 * the user actually wrote:
 *
 *   "openai/gpt-5.4-fast"  (exact)
 *   "gpt-5.4-fast"         (bare, derived)
 *   "openai/gpt-5.4"       (base, with provider)
 *   "gpt-5.4"              (base, bare)
 *   ...etc. stripping one "-segment" at a time
 */
function* modelKeyLookupOrder(modelKey: string): Generator<string> {
    const slash = modelKey.indexOf("/");
    const providerRefs = slash >= 0 ? modelRefLookupOrder(modelKey) : [];
    let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;

    while (modelId.length > 0) {
        for (const providerRef of providerRefs) {
            const providerSlash = providerRef.indexOf("/");
            yield `${providerRef.slice(0, providerSlash)}/${modelId}`;
        }
        yield modelId;
        const lastDash = modelId.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelId = modelId.slice(0, lastDash);
    }
}

/**
 * Single source of truth for execute-threshold resolution. Returns the effective
 * percentage plus which config source was authoritative. Callers that only need
 * the percentage can use `resolveExecuteThreshold` (thin wrapper below); callers
 * that surface the mode to users (`/ctx-status`, TUI, RPC) must use this directly
 * to avoid the "progressive lookup drift" bug where two call sites disagree on
 * whether tokens mode is active.
 */
export function resolveExecuteThresholdDetail(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): ExecuteThresholdDetail {
    // 1. Tokens-based resolution takes precedence when configured. Token values
    //    only make sense against a known context_limit — callers must supply it.
    //    Guard: tokensConfig must exist, contextLimit must be finite + positive.
    //    Junk values (NaN, negatives, zero) silently fall through to percentage;
    //    zod normally blocks them at config-load but runtime derivations (e.g.
    //    inputTokens/percentage) can produce NaN that must not poison the resolver.
    if (options?.tokensConfig && isFinitePositive(options.contextLimit)) {
        const contextLimit = options.contextLimit;
        const tokenMatch = resolveTokensMatchWithKey(options.tokensConfig, modelKey);
        // Also guard the matched token value — must be a finite positive number.
        if (tokenMatch && isFinitePositive(tokenMatch.value)) {
            const cap = contextLimit * (MAX_EXECUTE_THRESHOLD / 100);
            const effectiveTokens = Math.min(tokenMatch.value, cap);
            if (effectiveTokens < tokenMatch.value) {
                // Dedupe: only warn once per (session, modelKey, token value, cap) tuple.
                // The hot transform path would otherwise spam the log until the user fixes config.
                const dedupeKey = `${options.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${tokenMatch.value}|${cap}`;
                if (!clampWarnSeen.has(dedupeKey)) {
                    clampWarnSeen.add(dedupeKey);
                    const msg = `execute_threshold_tokens clamped: ${tokenMatch.value} → ${effectiveTokens} (${MAX_EXECUTE_THRESHOLD}% of ${contextLimit}) for ${modelKey ?? "default"}`;
                    if (options.sessionId) {
                        sessionLog(options.sessionId, `WARN: ${msg}`);
                    } else {
                        log(`[magic-context] WARN: ${msg}`);
                    }
                }
            }
            const percentage = (effectiveTokens / contextLimit) * 100;
            const detail: ExecuteThresholdDetail = {
                percentage: Math.min(percentage, MAX_EXECUTE_THRESHOLD),
                mode: "tokens",
                absoluteTokens: Math.floor(effectiveTokens),
                matchedKey: tokenMatch.matchedKey,
            };
            // effectiveTokens < requested means Math.min(value, cap) clamped the
            // user's token budget down to MAX_EXECUTE_THRESHOLD × contextLimit. Record the original
            // value so status surfaces can show "190000 > 90% of 128000" (#241).
            if (effectiveTokens < tokenMatch.value) {
                detail.clamped = true;
                detail.configuredValue = tokenMatch.value;
            }
            return detail;
        }
    }

    // 2. Fall through to percentage-based resolution.
    let resolved: number;
    let matchedKey: string | undefined;

    if (typeof config === "number") {
        resolved = config;
    } else if (modelKey) {
        let matched: number | undefined;
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            if (typeof config[candidate] === "number") {
                matched = config[candidate];
                matchedKey = candidate;
                break;
            }
        }
        if (matched === undefined && typeof config.default === "number") {
            resolved = config.default;
            matchedKey = "default";
        } else {
            resolved = matched ?? fallback;
        }
    } else if (typeof config.default === "number") {
        resolved = config.default;
        matchedKey = "default";
    } else {
        resolved = fallback;
    }

    // Guard against non-finite/negative config values that could bypass schema.
    if (!Number.isFinite(resolved) || resolved < 0) {
        resolved = fallback;
    }

    // Cap at 90% of the output-reserved safe window. The escalation band is
    // derived from this effective threshold, so it remains strictly above normal
    // execution and below the absolute 95% provider wall.
    const cappedPercentage = Math.min(resolved, MAX_EXECUTE_THRESHOLD);
    const percentageClamped = cappedPercentage < resolved;
    if (percentageClamped) {
        const dedupeKey = `pct|${options?.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${resolved}`;
        if (!clampWarnSeen.has(dedupeKey)) {
            clampWarnSeen.add(dedupeKey);
            const msg = `execute_threshold clamped ${resolved}% → ${MAX_EXECUTE_THRESHOLD}% for ${modelKey ?? "default"} (capped against the output-reserved safe window; 10% remains for mid-turn growth before the absolute 95% wall)`;
            if (options?.sessionId) {
                sessionLog(options.sessionId, `WARN: ${msg}`);
            } else {
                log(`[magic-context] WARN: ${msg}`);
            }
        }
    }
    const detail: ExecuteThresholdDetail = {
        percentage: cappedPercentage,
        mode: "percentage",
        matchedKey,
    };
    // A runtime-derived percentage above the 90% cap was reduced. Record the
    // original so status surfaces can show "95% > 90%" alongside the value (#241).
    if (percentageClamped) {
        detail.clamped = true;
        detail.configuredValue = resolved;
    }
    return detail;
}

/**
 * Backward-compatible wrapper around `resolveExecuteThresholdDetail`.
 * Use the detail version when you also need the mode or absolute token value.
 */
export function resolveExecuteThreshold(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): number {
    return resolveExecuteThresholdDetail(config, modelKey, fallback, options).percentage;
}

// Variant of resolveTokensMatch that also returns which key matched, for mode display.
function resolveTokensMatchWithKey(
    tokensConfig: ExecuteThresholdTokensConfig,
    modelKey: string | undefined,
): { value: number; matchedKey: string } | undefined {
    if (!tokensConfig) {
        return undefined;
    }

    if (modelKey) {
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            const value = tokensConfig[candidate];
            if (typeof value === "number") {
                return { value, matchedKey: candidate };
            }
        }
    }

    if (typeof tokensConfig.default === "number") {
        return { value: tokensConfig.default, matchedKey: "default" };
    }

    return undefined;
}

export function resolveModelKey(
    providerID: string | undefined,
    modelID: string | undefined,
): string | undefined {
    if (!providerID || !modelID) {
        return undefined;
    }

    return piModelRefToCanonical(`${providerID}/${modelID}`);
}

export function resolveSessionId(
    properties: { info?: unknown; sessionID?: string } | undefined,
): string | undefined {
    if (typeof properties?.sessionID === "string") {
        return properties.sessionID;
    }

    const info = properties?.info;
    if (info === null || typeof info !== "object") {
        return undefined;
    }

    const record = info as Record<string, unknown>;
    if (typeof record.sessionID === "string") {
        return record.sessionID;
    }
    if (typeof record.id === "string") {
        return record.id;
    }

    return undefined;
}
