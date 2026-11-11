/**
 * Resolve per-model context limits from OpenCode's SDK — the single source of
 * truth — for OpenCode sessions.
 *
 * `client.config.providers()` returns OpenCode's fully-resolved config: the
 * live models.dev cache + compiled-in snapshot + opencode.json custom-provider
 * overrides + auth-plugin caps (e.g. the Codex-OAuth gpt-5.5 400k cap). We
 * consume ONLY that. We no longer read OpenCode's `models.json` file ourselves:
 * a torn read mid-write produced impossible limits (a 6748 "limit" for a session
 * that had run for hours), and a stale on-disk copy out-voted the live
 * auth-resolved cap (922k vs the real 400k). OpenCode reads that file safely in
 * its own process and hands us the merged answer.
 *
 * Layers:
 *   1. `apiCache` (authoritative): warmed once at startup from the SDK; seeded
 *      from a persisted last-known-good file on cold start so a restart uses the
 *      real limit immediately (no 128k-default budget-collapse window).
 *
 * All cached values are bounded to a sane [20k, 3M] range on insert, so torn /
 * unconfigured-default garbage can never be returned or persisted. The startup
 * warm retries a couple times when OpenCode's provider service isn't ready yet.
 *
 * Pi does NOT use this — it resolves from its own `ctx.getModel().contextWindow`
 * (instant at extension load), so `getSdkContextLimit()` returns `undefined`
 * for Pi and Pi's own path is used.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextLimitProvenance } from "./context-limit-provenance";
import { getMagicContextStorageDir } from "./data-path";
import { getHarness } from "./harness";
import { modelRefLookupOrder } from "./harness-provider-map";
import { sessionLog } from "./logger";
import { writeStorageFileAtomicSync } from "./storage-permissions";
import { deriveWindowGeometry, type WindowGeometryResult } from "./window-geometry";

interface OpencodeClientLike {
    config: {
        providers: () => Promise<{ data?: { providers?: unknown } }>;
    };
}

// Plausible bounds for a real model's prompt limit. A value outside this range
// is physically impossible for an agentic session and signals a transient/garbage
// read — e.g. a torn read of OpenCode's `models.json` mid-write once produced
// `contextLimit=6748` (smaller than a single system prompt) for a session that
// had been running for hours past 200k+ (issue #117). Such values must be
// REJECTED, not trusted as a "smaller real cap". A genuinely smaller real limit
// still comes through the overflow-detection path (detectedContextLimit).
export const MIN_SANE_LIMIT = 20_000;
export const MAX_SANE_LIMIT = 3_000_000;

/** True when `limit` is a plausible real prompt window — used to reject torn /
 *  unconfigured-default garbage in BOTH harnesses (OpenCode's SDK values and
 *  Pi's reported `contextWindow`). Exported so Pi applies the identical bound. */
export function isSaneLimit(limit: number | undefined): limit is number {
    return typeof limit === "number" && limit >= MIN_SANE_LIMIT && limit <= MAX_SANE_LIMIT;
}

export type OutputReserveConfig = number | { default: number; [modelKey: string]: number };

export interface ModelLimit {
    context?: number;
    input?: number;
    output?: number;
}

interface CachedModelMetadata {
    /** Legacy resolved value, retained so pre-upgrade persisted caches remain readable. */
    limit?: number;
    /** Raw combined context window. Reservation is applied only when the value is read. */
    contextLimit?: number;
    /** Provider-enforced prompt cap. Undefined when only a combined context window is known. */
    inputLimit?: number;
    /** Maximum generated tokens advertised by the provider/model catalog. */
    outputLimit?: number;
    /** Provider metadata says the model accepts image input. Unknown is false. */
    vision?: boolean;
    /**
     * The catalog's display name, such as `Gemini 3.8 Flash`. Kept in memory
     * only: the persisted cold-start file carries limits, so a name is known
     * once the first refresh after startup lands.
     */
    name?: string;
}

// Proven-separate allowlist only. Unknown providers reserve by default because
// wasting some input capacity is safer than a shared-window hard rejection.
const SEPARATE_OUTPUT_QUOTA_PROVIDERS = new Set(["google", "google-antigravity"]);
const MIN_PLAUSIBLE_CONTEXT_LIMIT = 1024;
const OUTPUT_RESERVE_CAP_RATIO = 0.25;
let outputReserveConfig: OutputReserveConfig | undefined;
const reserveClampLogSeen = new Set<string>();

/**
 * Authoritative source (OpenCode only): populated async from the SDK
 * `config.providers()`, which is OpenCode's fully-resolved config — models.dev +
 * compiled-in snapshot + opencode.json overrides + auth-plugin caps (e.g. the
 * Codex-OAuth gpt-5.5 400k cap). When present, this WINS unconditionally; the
 * disk file is never consulted (no torn-read exposure, no stale value
 * out-voting the live limit). Pi never warms this — it has its own
 * `contextWindow` source — so for Pi this stays null and resolution falls
 * through to the file fallback exactly as before.
 */
let apiCache: Map<string, CachedModelMetadata> | null = null;
let apiLoadedAt = 0;

// Persisted last-known-good apiCache (OpenCode). Survives restart so a cold
// start uses the real limit instantly instead of falling to the disk file or the
// 128k default for the warm-up window (which over-shrinks the history budget).
// Harness-scoped: only OpenCode warms/persists apiCache, so Pi's file (which is
// never written) stays absent and Pi seeds nothing — keeping Pi byte-identical.
let persistSeedLoaded = false;

function persistFilePath(): string {
    return join(getMagicContextStorageDir(), `model-context-limits-${getHarness()}.json`);
}

/** Seed apiCache from the persisted last-known-good file once per process, only
 *  when apiCache hasn't been warmed yet. Values are sane-filtered on load so a
 *  stale garbage entry can never resurrect. */
function loadPersistedApiCacheOnce(): void {
    if (persistSeedLoaded || apiCache !== null) return;
    persistSeedLoaded = true;
    try {
        const raw = readFileSync(persistFilePath(), "utf-8");
        const obj = JSON.parse(raw) as Record<
            string,
            | number
            | {
                  limit?: number;
                  contextLimit?: number;
                  inputLimit?: number;
                  outputLimit?: number;
                  vision?: boolean;
              }
        >;
        const map = new Map<string, CachedModelMetadata>();
        for (const [key, persisted] of Object.entries(obj)) {
            const limit = typeof persisted === "number" ? persisted : persisted.limit;
            const contextLimit = typeof persisted === "number" ? undefined : persisted.contextLimit;
            const inputLimit = typeof persisted === "number" ? undefined : persisted.inputLimit;
            const outputLimit = typeof persisted === "number" ? undefined : persisted.outputLimit;
            const vision = typeof persisted === "number" ? false : persisted.vision === true;
            if (isSaneLimit(contextLimit) || isSaneLimit(limit)) {
                map.set(key, {
                    limit: isSaneLimit(limit) ? limit : undefined,
                    contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
                    inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
                    outputLimit: isFinitePositive(outputLimit) ? outputLimit : undefined,
                    vision,
                });
            }
        }
        if (map.size > 0) {
            apiCache = map;
            sessionLog(
                "global",
                `models-dev-cache: seeded ${map.size} entries from persisted cache (cold start)`,
            );
        }
    } catch {
        // No persisted cache yet, or unreadable — fall through to file/SDK.
    }
}

/** Atomically persist the current (sane-filtered) apiCache so the next process
 *  cold-starts with the real limits. Temp-write + rename so a concurrent reader
 *  never sees a torn file (the exact failure mode we're eliminating). */
function persistApiCache(): void {
    if (!apiCache) return;
    const obj: Record<string, CachedModelMetadata> = {};
    for (const [key, value] of apiCache) {
        if (isSaneLimit(value.limit)) {
            obj[key] = {
                limit: value.limit,
                contextLimit: isSaneLimit(value.contextLimit) ? value.contextLimit : undefined,
                inputLimit: isSaneLimit(value.inputLimit) ? value.inputLimit : undefined,
                outputLimit: isFinitePositive(value.outputLimit) ? value.outputLimit : undefined,
                vision: value.vision === true,
            };
        }
    }
    try {
        const target = persistFilePath();
        writeStorageFileAtomicSync(target, JSON.stringify(obj));
    } catch {
        // best-effort — a failed persist only loses cold-start warmth, not correctness
    }
}

function isFinitePositive(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function modelKeyLookupOrder(providerID: string, modelID: string): string[] {
    const candidates = [...modelRefLookupOrder(`${providerID}/${modelID}`), modelID];
    const colon = modelID.lastIndexOf(":");
    if (colon > 0) {
        const bareModel = modelID.slice(0, colon);
        candidates.push(...modelRefLookupOrder(`${providerID}/${bareModel}`), bareModel);
    }
    return [...new Set(candidates)];
}

/** Resolve the user-tier output reservation for one runtime model. */
export function resolveOutputReserve(
    providerID: string,
    modelID: string,
    config: OutputReserveConfig | undefined = outputReserveConfig,
): number | undefined {
    if (typeof config === "number")
        return Number.isFinite(config) && config >= 0 ? config : undefined;
    if (!config) return undefined;
    for (const candidate of modelKeyLookupOrder(providerID, modelID)) {
        const value = config[candidate];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return Number.isFinite(config.default) && config.default >= 0 ? config.default : undefined;
}

function logReserveClampOnce(key: string, message: string): void {
    if (reserveClampLogSeen.has(key)) return;
    reserveClampLogSeen.add(key);
    sessionLog("global", `models-dev-cache: ${message}`);
}

/** Set the user-tier reservation override shared by every resolved-limit consumer. */
export function setOutputReserveConfig(config: OutputReserveConfig | undefined): void {
    outputReserveConfig = config;
}

/**
 * Resolve the usable prompt budget from raw provider metadata.
 *
 * A genuinely smaller input cap is already pre-carved and wins unchanged. All
 * other providers reserve generated tokens from the shared context window by
 * default, except the small allowlist whose APIs document a separate output
 * quota. `output_reserve` overrides that shared/separate decision, including 0
 * to disable reservation. Reservation can never leave less than half the raw
 * context window or the module's 1024-token plausibility floor.
 */
export function resolveLimit(
    limit: ModelLimit | undefined,
    providerID: string,
    modelID: string,
    reserveConfig: OutputReserveConfig | undefined = outputReserveConfig,
): number | undefined {
    if (!limit) return undefined;
    const context = isFinitePositive(limit.context) ? limit.context : undefined;
    const input = isFinitePositive(limit.input) ? limit.input : undefined;
    if (input !== undefined && (context === undefined || input < context)) return input;
    if (context === undefined) return undefined;

    const configuredReserve = resolveOutputReserve(providerID, modelID, reserveConfig);
    let reserve: number;
    if (configuredReserve !== undefined) {
        reserve = configuredReserve;
    } else if (SEPARATE_OUTPUT_QUOTA_PROVIDERS.has(providerID)) {
        reserve = 0;
    } else {
        const output = isFinitePositive(limit.output) ? limit.output : 0;
        const cap = context * OUTPUT_RESERVE_CAP_RATIO;
        reserve = Math.min(output, cap);
        if (output > cap) {
            logReserveClampOnce(
                `cap|${providerID}/${modelID}|${context}|${output}`,
                `output reserve capped at 25% for ${providerID}/${modelID}: ${output} → ${cap}`,
            );
        }
    }

    const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, context * 0.5);
    const maxReserve = Math.max(0, context - floor);
    if (reserve > maxReserve) {
        logReserveClampOnce(
            `floor|${providerID}/${modelID}|${context}|${reserve}`,
            `output reserve clamped for ${providerID}/${modelID}: ${reserve} → ${maxReserve} (usable floor ${floor})`,
        );
        reserve = maxReserve;
    }
    return Math.floor(context - reserve);
}

function setCachedModelMetadata(
    cache: Map<string, CachedModelMetadata>,
    key: string,
    model:
        | {
              limit?: ModelLimit;
              name?: unknown;
              experimental?: { modes?: Record<string, unknown> };
              capabilities?: unknown;
              modalities?: unknown;
              input?: unknown;
              attachment?: unknown;
          }
        | undefined,
): void {
    const contextLimit = model?.limit?.context;
    const inputLimit = model?.limit?.input;
    const outputLimit = model?.limit?.output;
    const rawLimit = isSaneLimit(contextLimit)
        ? contextLimit
        : isSaneLimit(inputLimit)
          ? inputLimit
          : undefined;

    // Validate the raw provider metadata before reservation. A legitimate 20K
    // context may resolve below MIN_SANE_LIMIT after carving output, but it must
    // still remain cached; the 50%/1024 usable floor protects the result.
    if (rawLimit === undefined) return;

    const values = [model?.capabilities, model?.modalities, model?.input, model?.attachment];
    const vision = values.some(
        (value) =>
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("image") ||
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("vision"),
    );
    const value: CachedModelMetadata = {
        // Keep a sane raw fallback for old persisted-cache readers. Runtime
        // resolution below uses context/input/output so user overrides stay live.
        limit: rawLimit,
        contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
        inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
        outputLimit: isFinitePositive(outputLimit) ? outputLimit : undefined,
        vision,
        name: typeof model?.name === "string" && model.name.trim() !== "" ? model.name : undefined,
    };
    cache.set(key, value);

    // OpenCode creates derived model IDs from experimental.modes
    // e.g. gpt-5.4 + modes.fast → gpt-5.4-fast. These inherit the same
    // context limit as the parent model.
    const modes = model?.experimental?.modes;
    if (modes && typeof modes === "object") {
        for (const mode of Object.keys(modes)) {
            cache.set(`${key}-${mode}`, value);
        }
    }
}

/**
 * Asynchronously refresh the API-layer cache from OpenCode's SDK.
 *
 * Call this at plugin startup and from the issue #77 regression-recovery path.
 * OpenCode's `/config/providers` endpoint returns every provider with full
 * model metadata — including `limit.context` — resolved through the same path
 * OpenCode itself uses (live cache + compiled-in snapshot + opencode.json
 * overrides + derived experimental modes + auth-plugin caps).
 *
 * `retries`/`retryDelayMs`: when OpenCode's provider service isn't ready at our
 * startup, `config.providers()` can return an empty/no-providers payload. Retry
 * a few times so the cache warms instead of leaving the session on the 128k
 * default until the next restart. A successful load (any providers) stops early.
 *
 * Safe to call concurrently; only overwrites the cache on success.
 */
export async function refreshModelLimitsFromApi(
    client: OpencodeClientLike,
    options?: { retries?: number; retryDelayMs?: number },
): Promise<void> {
    const attempts = Math.max(1, (options?.retries ?? 0) + 1);
    const delayMs = options?.retryDelayMs ?? 1000;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const ok = await refreshModelLimitsOnce(client);
        if (ok) return;
        if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

// Once-per-process latch for the after-auth re-warm below.
let authRewarmDone = false;

/**
 * Re-warm the limit cache ONCE per process, after auth is provably live.
 *
 * The startup warm (index.ts) can run before the user's provider auth is
 * loaded. When it does, an auth-conditional limit patch hasn't applied yet, so
 * `config.providers()` returns the RAW catalog limit (e.g. OpenAI gpt-5.5 OAuth
 * is downshifted to a 272k input cap by OpenCode's Codex auth plugin only when
 * `ctx.auth.type === "oauth"`; before auth loads it reports the raw 922k). That
 * too-high value gets cached AND persisted as last-known-good, survives
 * restarts, and the existing recovery only re-resolves a too-LOW limit
 * (overflow / `percentage > 100`), so a too-HIGH one never self-corrects: the
 * sidebar shows huge headroom while the backend rejects at the real cap (#179).
 *
 * The first `message.updated` carrying usage tokens proves a request succeeded,
 * so auth + providers are fully resolved. Re-warming there overwrites any stale
 * pre-auth limit with the live auth-adjusted one. Idempotent and cheap: a single
 * `config.providers()` round-trip, then a no-op for the rest of the process. The
 * latch is set before the await so concurrent `message.updated` events don't
 * stack duplicate warms; a failed warm resets it so a later message retries.
 */
export async function refreshModelLimitsAfterAuthOnce(client: OpencodeClientLike): Promise<void> {
    if (authRewarmDone) return;
    authRewarmDone = true;
    const ok = await refreshModelLimitsOnce(client);
    if (!ok) authRewarmDone = false;
}

/** Test-only: reset the after-auth re-warm latch between cases. */
export function resetAuthRewarmLatchForTest(): void {
    authRewarmDone = false;
}

/** Single SDK fetch + cache rebuild. Returns true when providers were loaded. */
async function refreshModelLimitsOnce(client: OpencodeClientLike): Promise<boolean> {
    try {
        const result = await client.config.providers();
        const data = (result as { data?: { providers?: Array<unknown> } }).data;
        const providers = data?.providers;
        if (!Array.isArray(providers) || providers.length === 0) {
            sessionLog(
                "global",
                "models-dev-cache: API refresh returned no providers payload (will retry if attempts remain)",
            );
            return false;
        }

        const map = new Map<string, CachedModelMetadata>();
        for (const entry of providers) {
            const p = entry as {
                id?: string;
                models?: Record<
                    string,
                    {
                        limit?: ModelLimit;
                        experimental?: { modes?: Record<string, unknown> };
                    }
                >;
            };
            if (!p?.id || !p.models || typeof p.models !== "object") continue;
            for (const [modelId, model] of Object.entries(p.models)) {
                setCachedModelMetadata(map, `${p.id}/${modelId}`, model);
            }
        }

        const previousSize = apiCache?.size ?? null;
        apiCache = map;
        apiLoadedAt = Date.now();
        // Persist the freshly-resolved (sane-filtered) limits so the next process
        // cold-starts with the real values instead of the 128k default.
        persistApiCache();

        if (previousSize === null) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries`,
            );
        } else if (previousSize !== map.size) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries (was ${previousSize})`,
            );
        }
        return true;
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: API refresh failed:",
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

/**
 * Resolve a model's prompt limit from OpenCode's SDK (`config.providers()`),
 * the single source of truth: it already merges models.dev + compiled-in
 * snapshot + opencode.json overrides + auth-plugin caps (e.g. the Codex-OAuth
 * gpt-5.5 400k cap). We deliberately do NOT read OpenCode's `models.json` file
 * ourselves — a torn read of that file mid-write produced garbage limits, and a
 * stale on-disk copy out-voted the live auth-resolved cap (922k vs the real
 * 400k). OpenCode reads that file safely within its own process and exposes the
 * merged result here.
 *
 * Resolution:
 *   1. Seed `apiCache` from the persisted last-known-good file once (cold start).
 *   2. Resolve the sane raw SDK metadata into its output-reserved usable value.
 *   3. `undefined` when the SDK hasn't reported this model yet → the caller
 *      defaults / retries (the startup warm retries when OpenCode isn't ready).
 *
 * OpenCode-only: Pi never warms `apiCache` (it resolves from its own
 * `ctx.model.contextWindow`), so for Pi this returns `undefined` and Pi's
 * own resolution path is used.
 */
export function getSdkWindowGeometry(
    providerID: string,
    modelID: string,
    detectedContextLimit?: number,
    options?: {
        detectedLimitProvenance?: ContextLimitProvenance;
        harness?: "opencode" | "pi";
    },
): WindowGeometryResult | undefined {
    loadPersistedApiCacheOnce();
    const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
    if (!metadata) return undefined;
    const rawContext = metadata.contextLimit ?? metadata.limit;
    const promptOnlyDetected =
        options?.detectedLimitProvenance === "prompt_only" && isFinitePositive(detectedContextLimit)
            ? detectedContextLimit
            : undefined;
    const result = deriveWindowGeometry(
        providerID,
        modelID,
        {
            context: rawContext,
            input: metadata.inputLimit,
            output: metadata.outputLimit,
        },
        {
            outputReserveOverride: resolveOutputReserve(providerID, modelID),
            harness: options?.harness ?? "opencode",
            contextCap:
                promptOnlyDetected === undefined && isFinitePositive(detectedContextLimit)
                    ? detectedContextLimit
                    : undefined,
        },
    );
    if (!result || promptOnlyDetected === undefined) return result;
    // A declared input cap bounds the prompt wall; without one the wall is
    // already pre-carved and may exceed the catalog-derived window.
    const usableSoft = isFinitePositive(metadata.inputLimit)
        ? Math.min(promptOnlyDetected, result.usableSoft)
        : promptOnlyDetected;
    return {
        ...result,
        usableSoft,
        usableHard: Math.max(usableSoft, Math.min(result.usableHard, promptOnlyDetected)),
    };
}

export function getSdkContextLimit(
    providerID: string,
    modelID: string,
    detectedContextLimit?: number,
    options?: {
        reservation?: "default" | "none";
        detectedLimitProvenance?: ContextLimitProvenance;
    },
): number | undefined {
    if (options?.reservation !== "none") {
        return getSdkWindowGeometry(providerID, modelID, detectedContextLimit, {
            detectedLimitProvenance: options?.detectedLimitProvenance,
        })?.usableSoft;
    }
    loadPersistedApiCacheOnce();
    const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
    if (!metadata) return undefined;
    const rawContext = metadata.contextLimit ?? metadata.limit;
    const promptOnlyDetected =
        options?.detectedLimitProvenance === "prompt_only" && isFinitePositive(detectedContextLimit)
            ? detectedContextLimit
            : undefined;
    const context =
        promptOnlyDetected === undefined &&
        isFinitePositive(detectedContextLimit) &&
        isFinitePositive(rawContext)
            ? Math.min(rawContext, detectedContextLimit)
            : promptOnlyDetected === undefined && isFinitePositive(detectedContextLimit)
              ? detectedContextLimit
              : rawContext;
    const inputCandidates = [metadata.inputLimit, promptOnlyDetected].filter(isFinitePositive);
    const input = inputCandidates.length > 0 ? Math.min(...inputCandidates) : undefined;
    return resolveLimit(
        {
            context,
            input,
            output: metadata.outputLimit,
        },
        providerID,
        modelID,
        options?.reservation === "none" ? 0 : undefined,
    );
}

/**
 * Return only a provider-declared input cap. A combined context window is useful
 * for scheduling but is not safe as a fail-closed prompt boundary.
 */
/** Resolve image-input support from the same models.dev metadata cache as limits. */
export function modelSupportsVision(providerID: string, modelID: string): boolean {
    loadPersistedApiCacheOnce();
    if (!apiCache) return false;
    const exact = apiCache.get(`${providerID}/${modelID}`);
    if (exact?.vision === true) return true;
    const colon = modelID.lastIndexOf(":");
    return colon > 0
        ? apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.vision === true
        : false;
}

export function getSdkOutputLimit(providerID: string, modelID: string): number | undefined {
    loadPersistedApiCacheOnce();
    return lookupMetadataWithTagFallback(apiCache, providerID, modelID)?.outputLimit;
}

/** The catalog display name of a model, or undefined before a refresh has named it. */
export function getSdkModelName(providerID: string, modelID: string): string | undefined {
    return lookupMetadataWithTagFallback(apiCache, providerID, modelID)?.name;
}

export function getSdkInputLimit(providerID: string, modelID: string): number | undefined {
    loadPersistedApiCacheOnce();
    if (!apiCache) return undefined;
    const direct = apiCache.get(`${providerID}/${modelID}`)?.inputLimit;
    if (isSaneLimit(direct)) return direct;
    const colon = modelID.indexOf(":");
    if (colon > 0) {
        const tagless = apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.inputLimit;
        if (isSaneLimit(tagless)) return tagless;
    }
    return undefined;
}

/**
 * Look up a model's limit in the cache, with an ollama-style tag-suffix
 * fallback. ollama invokes cloud models with a tag at runtime
 * (`deepseek-v4-pro:cloud`) while the underlying metadata key is tag-less
 * (`deepseek-v4-pro`), so an exact-only match misses.
 *
 * Strategy: exact match first (never collapses a legitimately-tagged model),
 * then retry once with the last `:tag` segment stripped.
 */
function lookupMetadataWithTagFallback(
    cache: Map<string, CachedModelMetadata> | null,
    providerID: string,
    modelID: string,
): CachedModelMetadata | undefined {
    if (!cache) return undefined;
    const exact = cache.get(`${providerID}/${modelID}`);
    if (exact) return exact;

    const colonIdx = modelID.lastIndexOf(":");
    if (colonIdx > 0) {
        return cache.get(`${providerID}/${modelID.slice(0, colonIdx)}`);
    }
    return undefined;
}

/** Clear in-memory caches (for testing and the regression-recovery refetch). */
export function clearModelsDevCache(): void {
    apiCache = null;
    apiLoadedAt = 0;
    persistSeedLoaded = false;
}

/** Inspection helpers (for logging / debugging). */
export function getModelsDevCacheState(): {
    apiLoaded: boolean;
    apiCount: number;
    apiAgeMs: number;
} {
    return {
        apiLoaded: apiCache !== null,
        apiCount: apiCache?.size ?? 0,
        apiAgeMs: apiLoadedAt > 0 ? Date.now() - apiLoadedAt : -1,
    };
}
