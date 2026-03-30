import { isAnthropicProvider } from "../is-anthropic-provider";

const DEFAULT_CONTEXT_LIMIT = 200_000;

type CacheTtlConfig = string | Record<string, string>;

export function resolveContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    config: {
        modelContextLimitsCache?: Map<string, number>;
    },
): number {
    if (!providerID) {
        return DEFAULT_CONTEXT_LIMIT;
    }

    // Check model-specific cache first (populated from user provider config)
    if (modelID) {
        const modelSpecific = config.modelContextLimitsCache?.get(`${providerID}/${modelID}`);
        if (typeof modelSpecific === "number" && modelSpecific > 0) {
            return modelSpecific;
        }
    }

    // Anthropic models default to 1M context since Anthropic removed the beta requirement.
    // The plugin config hook does not receive models.dev data, so we cannot read the
    // snapshot limit here. 1M is correct for all current Anthropic models.
    if (isAnthropicProvider(providerID)) {
        return 1_000_000;
    }

    return DEFAULT_CONTEXT_LIMIT;
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

export function resolveExecuteThreshold(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
): number {
    const MAX_EXECUTE_THRESHOLD = 80;
    let resolved: number;

    if (typeof config === "number") {
        resolved = config;
    } else if (modelKey && typeof config[modelKey] === "number") {
        resolved = config[modelKey];
    } else if (modelKey) {
        const bareModelId = modelKey.split("/").slice(1).join("/");
        if (bareModelId && typeof config[bareModelId] === "number") {
            resolved = config[bareModelId];
        } else {
            resolved = config.default ?? fallback;
        }
    } else {
        resolved = config.default ?? fallback;
    }

    // Cap at 80% — higher values create a gap between execute_threshold and
    // forceMaterialization (85%) where shouldRunHeuristics fires on defer
    // passes without isCacheBustingPass, causing unguarded cache busts.
    return Math.min(resolved, MAX_EXECUTE_THRESHOLD);
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
