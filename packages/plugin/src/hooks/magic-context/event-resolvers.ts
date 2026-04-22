import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { log, sessionLog } from "../../shared/logger";
import { getModelsDevContextLimit } from "../../shared/models-dev-cache";

const DEFAULT_CONTEXT_LIMIT = 128_000;
const MAX_EXECUTE_THRESHOLD = 80;

type CacheTtlConfig = string | Record<string, string>;

/**
 * Resolve the effective context limit for a (providerID, modelID) pair.
 *
 * Resolution order:
 *   1. Detected limit from a prior overflow error, when smaller than the
 *      configured/cache limit. Providers report the REAL limit in the error
 *      message, which is authoritative for the current deployment.
 *   2. OpenCode's models.dev cache (overlaid with user's
 *      `provider.*.models.*.limit.context`).
 *   3. Conservative default (128k).
 *
 * The session context (db + sessionID) is optional — callers that operate
 * outside a specific session (e.g. warm-up, status-bar summaries) can omit it
 * and fall back to the global cache/default.
 */
export function resolveContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
): number {
    const fromModelsDev =
        providerID && modelID ? getModelsDevContextLimit(providerID, modelID) : undefined;
    const baseline = fromModelsDev ?? DEFAULT_CONTEXT_LIMIT;

    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID);
            // A detected limit only wins when it is smaller than the baseline —
            // providers never under-report their real limit. If the baseline is
            // already accurate, no need to downgrade.
            if (overflow.detectedContextLimit > 0 && overflow.detectedContextLimit < baseline) {
                return overflow.detectedContextLimit;
            }
        } catch {
            // Reading session meta is best-effort — fall through to baseline.
        }
    }

    return baseline;
}

export function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string {
    if (typeof cacheTtl === "string") {
        return cacheTtl;
    }

    if (modelKey && typeof cacheTtl[modelKey] === "string") {
        return cacheTtl[modelKey];
    }

    if (modelKey) {
        const bareModelId = modelKey.split("/").slice(1).join("/");
        if (bareModelId && typeof cacheTtl[bareModelId] === "string") {
            return cacheTtl[bareModelId];
        }
    }

    return cacheTtl.default ?? "5m";
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
     *  and to clamp values above 80% × context_limit. */
    contextLimit?: number;
    /** Session ID for warn logs when clamping. If absent, warns to global log. */
    sessionId?: string;
}

export type ExecuteThresholdMode = "percentage" | "tokens";

export interface ExecuteThresholdDetail {
    /** Effective execute threshold as a percentage (0–80). Downstream math keys off this. */
    percentage: number;
    /** Which source was authoritative: tokens config (when matched + valid context) or percentage. */
    mode: ExecuteThresholdMode;
    /** When mode is "tokens", the absolute token value after clamping (≤ 80% × contextLimit). */
    absoluteTokens?: number;
    /** The config key that matched, if any (for display/debugging). `"default"` when default fallback. */
    matchedKey?: string;
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
    const provider = slash >= 0 ? modelKey.slice(0, slash) : "";
    let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;

    while (modelId.length > 0) {
        if (provider) yield `${provider}/${modelId}`;
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
                    const msg = `execute_threshold_tokens clamped: ${tokenMatch.value} → ${effectiveTokens} (80% of ${contextLimit}) for ${modelKey ?? "default"}`;
                    if (options.sessionId) {
                        sessionLog(options.sessionId, `WARN: ${msg}`);
                    } else {
                        log(`[magic-context] WARN: ${msg}`);
                    }
                }
            }
            const percentage = (effectiveTokens / contextLimit) * 100;
            return {
                percentage: Math.min(percentage, MAX_EXECUTE_THRESHOLD),
                mode: "tokens",
                absoluteTokens: Math.floor(effectiveTokens),
                matchedKey: tokenMatch.matchedKey,
            };
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

    // Cap at 80% — higher values create a gap between execute_threshold and
    // forceMaterialization (85%) where shouldRunHeuristics fires on defer
    // passes without isCacheBustingPass, causing unguarded cache busts.
    return {
        percentage: Math.min(resolved, MAX_EXECUTE_THRESHOLD),
        mode: "percentage",
        matchedKey,
    };
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

    return `${providerID}/${modelID}`;
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
