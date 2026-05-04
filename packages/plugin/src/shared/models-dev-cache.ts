/**
 * Resolve per-model context limits to match whatever OpenCode itself sees.
 *
 * Two layers:
 *
 *   1. API cache (primary): populated asynchronously via
 *      `client.config.providers()`. OpenCode's own provider service merges
 *      the live models.dev cache file, its compiled-in snapshot fallback,
 *      opencode.json custom provider overrides, and derived experimental
 *      modes. Whatever OpenCode reports is the source of truth.
 *
 *   2. File cache (fallback): read-from-disk parse of OpenCode's
 *      `models.json` plus `opencode.json(c)` custom provider entries.
 *      Used during cold starts before the API cache warms up and in any
 *      code path that cannot reach the SDK client.
 *
 * The public getters (`getModelsDevContextLimit()` and
 * `getModelsDevInterleavedField()`) are synchronous: they check the API cache
 * first, then the file cache. The plugin warms and refreshes the API cache
 * from `src/index.ts` at startup and on a timer.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getCacheDir } from "./data-path";
import { sessionLog } from "./logger";

interface OpencodeClientLike {
    config: {
        providers: () => Promise<{ data?: { providers?: unknown } }>;
    };
}

const RELOAD_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, matches OpenCode's TTL

interface CachedModelMetadata {
    limit?: number;
    interleavedField?: string;
}

type InterleavedConfig = boolean | { field?: string } | undefined;

/** Populated async from OpenCode SDK. Primary source of truth when available. */
let apiCache: Map<string, CachedModelMetadata> | null = null;
let apiLoadedAt = 0;

/** Populated sync from disk as fallback. */
let fileCache: Map<string, CachedModelMetadata> | null = null;
let fileLastAttempt = 0;

function hashFast(input: string): string {
    // Matches OpenCode's Hash.fast() (packages/shared/src/util/hash.ts).
    return createHash("sha1").update(input).digest("hex");
}

function getModelsJsonPath(): string {
    // 1. Explicit path override (OpenCode's OPENCODE_MODELS_PATH takes highest priority).
    const explicit = process.env.OPENCODE_MODELS_PATH?.trim();
    if (explicit) return explicit;

    // OpenCode uses `xdg-basedir`, which falls back to `<homedir>/.cache` on
    // every platform (including Windows) when XDG_CACHE_HOME is unset. See
    // shared/data-path.ts#getCacheDir for the shared helper.
    const cacheBase = getCacheDir();

    // 2. Custom models source → hashed filename (matches OpenCode).
    //    source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`
    const source = process.env.OPENCODE_MODELS_URL?.trim();
    const filename =
        source && source !== "https://models.dev"
            ? `models-${hashFast(source)}.json`
            : "models.json";

    return join(cacheBase, "opencode", filename);
}

function getOpencodeConfigPath(): string | null {
    const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    const configDir = envDir
        ? envDir
        : platform() === "win32"
          ? join(homedir(), ".config", "opencode")
          : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

    // Check jsonc first, then json (matches OpenCode's own lookup order).
    const jsonc = join(configDir, "opencode.jsonc");
    if (existsSync(jsonc)) return jsonc;
    const json = join(configDir, "opencode.json");
    if (existsSync(json)) return json;
    return null;
}

/**
 * Resolve the effective pressure limit for a model's `limit` object.
 *
 * Prefers `limit.input` (max prompt tokens the provider will accept) over
 * `limit.context` (total window including output). For GitHub Copilot and
 * several proxy providers, `context` is the marketing number (input + output
 * combined), and sending a prompt sized against `context` gets rejected.
 * OpenCode's own `session/overflow.ts` uses `input ?? context` for the same
 * reason — the denominator that drives overflow/pressure must be the number
 * the provider actually enforces on input.
 */
function resolveLimit(limit: { context?: number; input?: number } | undefined): number | undefined {
    if (!limit) return undefined;
    if (typeof limit.input === "number" && limit.input > 0) return limit.input;
    if (typeof limit.context === "number" && limit.context > 0) return limit.context;
    return undefined;
}

function resolveInterleavedField(interleaved: InterleavedConfig): string | undefined {
    if (
        interleaved &&
        typeof interleaved === "object" &&
        typeof interleaved.field === "string" &&
        interleaved.field.length > 0
    ) {
        return interleaved.field;
    }
    return undefined;
}

function setCachedModelMetadata(
    cache: Map<string, CachedModelMetadata>,
    key: string,
    model:
        | {
              limit?: { context?: number; input?: number };
              capabilities?: { interleaved?: InterleavedConfig };
              interleaved?: InterleavedConfig;
              experimental?: { modes?: Record<string, unknown> };
          }
        | undefined,
): void {
    const limit = resolveLimit(model?.limit);
    const interleavedField =
        resolveInterleavedField(model?.capabilities?.interleaved) ??
        resolveInterleavedField(model?.interleaved);

    if (limit === undefined && interleavedField === undefined) {
        return;
    }

    const value: CachedModelMetadata = {};
    if (limit !== undefined) value.limit = limit;
    if (interleavedField !== undefined) value.interleavedField = interleavedField;
    cache.set(key, value);

    // OpenCode creates derived model IDs from experimental.modes
    // e.g. gpt-5.4 + modes.fast → gpt-5.4-fast. These inherit the same
    // context limit and interleaved-reasoning contract as the parent model.
    const modes = model?.experimental?.modes;
    if (modes && typeof modes === "object") {
        for (const mode of Object.keys(modes)) {
            cache.set(`${key}-${mode}`, value);
        }
    }
}

function loadModelsDevMetadataFromFile(): Map<string, CachedModelMetadata> {
    const metadata = new Map<string, CachedModelMetadata>();

    // 1. Read OpenCode's models.dev cache file (base layer).
    const modelsJsonPath = getModelsJsonPath();
    let fileFound = false;
    try {
        if (existsSync(modelsJsonPath)) {
            fileFound = true;
            const raw = readFileSync(modelsJsonPath, "utf-8");
            const data = JSON.parse(raw) as Record<
                string,
                {
                    models?: Record<
                        string,
                        {
                            limit?: { context?: number; input?: number };
                            capabilities?: { interleaved?: InterleavedConfig };
                            interleaved?: InterleavedConfig;
                            experimental?: { modes?: Record<string, unknown> };
                        }
                    >;
                }
            >;

            for (const [providerId, provider] of Object.entries(data)) {
                if (!provider?.models || typeof provider.models !== "object") continue;
                for (const [modelId, model] of Object.entries(provider.models)) {
                    setCachedModelMetadata(metadata, `${providerId}/${modelId}`, model);
                }
            }
        }
    } catch (error) {
        sessionLog(
            "global",
            `models-dev-cache: failed to read models.json at ${modelsJsonPath}:`,
            error instanceof Error ? error.message : String(error),
        );
    }

    // 2. Overlay custom provider models from OpenCode config (higher priority).
    // Users define custom/proxy models via provider.<id>.models.<name>.limit.{input,context}
    // in opencode.json(c). These override models.dev entries for the same key.
    try {
        const configPath = getOpencodeConfigPath();
        if (configPath && existsSync(configPath)) {
            let raw = readFileSync(configPath, "utf-8");
            // Strip JSONC single-line comments while preserving // inside strings.
            raw = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$/gm, (match) =>
                match.startsWith('"') ? match : "",
            );
            const config = JSON.parse(raw) as {
                provider?: Record<
                    string,
                    {
                        models?: Record<string, { limit?: { context?: number; input?: number } }>;
                    }
                >;
            };

            if (config.provider && typeof config.provider === "object") {
                for (const [providerId, provider] of Object.entries(config.provider)) {
                    if (!provider?.models || typeof provider.models !== "object") continue;
                    for (const [modelId, model] of Object.entries(provider.models)) {
                        setCachedModelMetadata(metadata, `${providerId}/${modelId}`, model);
                    }
                }
            }
        }
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: failed to read opencode config for custom models:",
            error instanceof Error ? error.message : String(error),
        );
    }

    sessionLog(
        "global",
        `models-dev-cache: file-layer loaded ${metadata.size} model metadata entries (modelsJsonPath=${modelsJsonPath}, found=${fileFound})`,
    );

    return metadata;
}

/**
 * Asynchronously refresh the API-layer cache from OpenCode's SDK.
 *
 * Call this at plugin startup and periodically (e.g. every 5 minutes) from
 * `src/index.ts`. OpenCode's `/config/providers` endpoint returns every
 * provider with full model metadata — including `limit.context` — resolved
 * through the same path OpenCode itself uses (live cache + compiled-in
 * snapshot + opencode.json overrides + derived experimental modes).
 *
 * Safe to call concurrently; only overwrites the cache on success.
 */
export async function refreshModelLimitsFromApi(client: OpencodeClientLike): Promise<void> {
    try {
        const result = await client.config.providers();
        const data = (result as { data?: { providers?: Array<unknown> } }).data;
        const providers = data?.providers;
        if (!Array.isArray(providers)) {
            sessionLog("global", "models-dev-cache: API refresh returned no providers payload");
            return;
        }

        const map = new Map<string, CachedModelMetadata>();
        for (const entry of providers) {
            const p = entry as {
                id?: string;
                models?: Record<
                    string,
                    {
                        limit?: { context?: number; input?: number };
                        capabilities?: { interleaved?: InterleavedConfig };
                        interleaved?: InterleavedConfig;
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
        // Log only on first successful load or when the model count changes,
        // so the 5-minute periodic refresh doesn't spam the log.
        if (previousSize === null || previousSize !== map.size) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries${
                    previousSize !== null ? ` (was ${previousSize})` : ""
                }`,
            );
        }
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: API refresh failed:",
            error instanceof Error ? error.message : String(error),
        );
    }
}

/**
 * Returns the context limit for a provider/model.
 *
 * Lookup order:
 *   1. API cache (populated by {@link refreshModelLimitsFromApi}). Matches
 *      what OpenCode sees exactly, including snapshot-only models.
 *   2. File cache (parsed from models.json + opencode.json overrides).
 *      Used before the API cache warms and as a last resort.
 *
 * Returns `undefined` if neither layer knows the model.
 */
export function getModelsDevContextLimit(providerID: string, modelID: string): number | undefined {
    const key = `${providerID}/${modelID}`;

    if (apiCache) {
        const fromApi = apiCache.get(key)?.limit;
        if (typeof fromApi === "number") return fromApi;
    }

    const now = Date.now();
    if (!fileCache || now - fileLastAttempt > RELOAD_INTERVAL_MS) {
        fileLastAttempt = now;
        fileCache = loadModelsDevMetadataFromFile();
    }
    return fileCache.get(key)?.limit;
}

/**
 * Returns the provider-specific interleaved reasoning field when the model
 * requires one (for example `reasoning_content` for Moonshot/Kimi style
 * providers). Undefined means the cache has no such capability recorded.
 */
export function getModelsDevInterleavedField(
    providerID: string,
    modelID: string,
): string | undefined {
    const key = `${providerID}/${modelID}`;

    if (apiCache) {
        const fromApi = apiCache.get(key)?.interleavedField;
        if (typeof fromApi === "string" && fromApi.length > 0) {
            return fromApi;
        }
    }

    const now = Date.now();
    if (!fileCache || now - fileLastAttempt > RELOAD_INTERVAL_MS) {
        fileLastAttempt = now;
        fileCache = loadModelsDevMetadataFromFile();
    }

    const fromFile = fileCache.get(key)?.interleavedField;
    return typeof fromFile === "string" && fromFile.length > 0 ? fromFile : undefined;
}

/** Clear in-memory caches (for testing). */
export function clearModelsDevCache(): void {
    apiCache = null;
    apiLoadedAt = 0;
    fileCache = null;
    fileLastAttempt = 0;
}

/** Inspection helpers (for logging / debugging). */
export function getModelsDevCacheState(): {
    apiLoaded: boolean;
    apiCount: number;
    apiAgeMs: number;
    fileCount: number;
} {
    return {
        apiLoaded: apiCache !== null,
        apiCount: apiCache?.size ?? 0,
        apiAgeMs: apiLoadedAt > 0 ? Date.now() - apiLoadedAt : -1,
        fileCount: fileCache?.size ?? 0,
    };
}
