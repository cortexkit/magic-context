import type {
    EmbeddingConfig,
    EmbeddingFallbackProvider,
    MagicContextConfig,
} from "../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../config/schema/magic-context";
import {
    getSynapseLaneIdentity,
    SYNAPSE_DEFAULT_MODEL,
    SynapseEmbeddingProvider,
    type SynapseLaneMetadata,
} from "../features/magic-context/memory/embedding-synapse";
import { log } from "../shared/logger";

export interface ResolvedSynapseEmbeddingConfig {
    provider: "synapse";
    model: string;
    max_input_tokens: 8192;
    synapse_connection_file: string;
    synapse_fingerprint: string;
    synapse_table_epoch: number;
    // Dims are absent until the first embed response pins them; the registry
    // treats a missing value as adopt-on-first-write.
    synapse_dims?: number;
    synapse_recommended_batch?: number;
    synapse_provenance?: unknown;
}

const SYNAPSE_PROBE_TTL_MS = 60_000;
const synapseProbeCache = new Map<
    string,
    { expiresAt: number; promise: Promise<SynapseLaneMetadata> }
>();

export interface ResolvedEmbeddingRouting {
    /** Provider config for the authoritative lane. */
    primary: EmbeddingConfig | ResolvedSynapseEmbeddingConfig;
    /** Separate Synapse config for the developer mirror, when armed. */
    shadow: ResolvedSynapseEmbeddingConfig | null;
    /** Human-readable warnings produced while selecting a lane. */
    warnings: string[];
}

function fallbackConfig(
    config: EmbeddingConfig,
    provider: EmbeddingFallbackProvider | undefined,
): EmbeddingConfig {
    const raw = config as unknown as Record<string, unknown>;
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
    const apiKey = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
    const inputType = typeof raw.input_type === "string" ? raw.input_type.trim() : "";
    const queryInputType =
        typeof raw.query_input_type === "string" ? raw.query_input_type.trim() : "";
    const truncate = typeof raw.truncate === "string" ? raw.truncate.trim() : "";
    const dimensions = typeof raw.dimensions === "number" ? raw.dimensions : undefined;
    const maxInputTokens =
        typeof raw.max_input_tokens === "number" ? raw.max_input_tokens : undefined;

    if (provider === "off") return { provider: "off" };
    if (provider === "openai-compatible") {
        return {
            provider: "openai-compatible",
            model,
            endpoint,
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(dimensions !== undefined ? { dimensions } : {}),
            ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
        };
    }
    return {
        provider: "local",
        model: model || DEFAULT_LOCAL_EMBEDDING_MODEL,
        local_runtime:
            raw.local_runtime === "native" || raw.local_runtime === "wasm"
                ? raw.local_runtime
                : "auto",
        ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
    };
}

function synapseOptions(
    config: EmbeddingConfig,
    subc: NonNullable<MagicContextConfig["subc"]>,
    projectRoot: string,
    session: string,
    metadata?: SynapseLaneMetadata,
) {
    return {
        connectionFile: subc.connection_file,
        projectRoot,
        session,
        model:
            metadata?.model ??
            (config.provider === "synapse" && "model" in config ? config.model : undefined) ??
            SYNAPSE_DEFAULT_MODEL,
        ...(metadata
            ? {
                  fingerprint: metadata.fingerprint,
                  tableEpoch: metadata.table_epoch,
                  dims: metadata.dims,
                  recommendedBatch: metadata.recommended_batch,
                  provenance: metadata.provenance,
              }
            : {}),
    };
}

function probeKey(subc: NonNullable<MagicContextConfig["subc"]>, config: EmbeddingConfig): string {
    const model =
        config.provider === "synapse" && "model" in config ? config.model : SYNAPSE_DEFAULT_MODEL;
    return `${subc.connection_file}\u0000${model ?? SYNAPSE_DEFAULT_MODEL}`;
}

function discoverSynapseLane(
    config: EmbeddingConfig,
    subc: NonNullable<MagicContextConfig["subc"]>,
    projectRoot: string,
    session: string,
): Promise<SynapseLaneMetadata> {
    const key = probeKey(subc, config);
    const cached = synapseProbeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = SynapseEmbeddingProvider.discover(
        synapseOptions(config, subc, projectRoot, session),
    );
    synapseProbeCache.set(key, { expiresAt: Date.now() + SYNAPSE_PROBE_TTL_MS, promise });
    void promise.catch(() => undefined);
    return promise;
}

function resolvedSynapseConfig(
    subc: NonNullable<MagicContextConfig["subc"]>,
    metadata: SynapseLaneMetadata,
    projectRoot: string,
    session: string,
): ResolvedSynapseEmbeddingConfig {
    void projectRoot;
    void session;
    return {
        provider: "synapse",
        model: metadata.model,
        max_input_tokens: 8192,
        synapse_connection_file: subc.connection_file,
        synapse_fingerprint: metadata.fingerprint,
        synapse_table_epoch: metadata.table_epoch,
        ...(typeof metadata.dims === "number" ? { synapse_dims: metadata.dims } : {}),
        ...(metadata.recommended_batch
            ? { synapse_recommended_batch: metadata.recommended_batch }
            : {}),
        ...(metadata.provenance !== undefined ? { synapse_provenance: metadata.provenance } : {}),
    };
}

/**
 * Resolve daemon availability before registration so a fallback vector can never
 * be written under a Synapse identity. The registry receives only the selected
 * lane's provider fields, not the raw routing controls.
 */
export async function resolveEmbeddingRouting(args: {
    config: MagicContextConfig;
    projectRoot: string;
    session?: string;
}): Promise<ResolvedEmbeddingRouting> {
    const config = args.config.embedding;
    const subc = args.config.subc;
    const shadowEnabled = args.config.shadow_embedding?.enabled === true;
    const warnings: string[] = [];

    if (config.provider !== "synapse") {
        let shadow: ResolvedSynapseEmbeddingConfig | null = null;
        if (shadowEnabled && config.provider === "off") {
            warnings.push("shadow_embedding is ignored when embedding.provider is off");
        } else if (shadowEnabled && !subc) {
            warnings.push("shadow_embedding requires a subc block; shadow lane is disabled");
        } else if (shadowEnabled && subc) {
            try {
                const metadata = await discoverSynapseLane(
                    config,
                    subc,
                    args.projectRoot,
                    args.session ?? "routing",
                );
                shadow = resolvedSynapseConfig(
                    subc,
                    metadata,
                    args.projectRoot,
                    args.session ?? "routing",
                );
            } catch (error) {
                warnings.push(
                    `shadow_embedding is unavailable; using the primary ${config.provider} lane: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return { primary: config, shadow, warnings };
    }

    if (shadowEnabled) {
        warnings.push("shadow_embedding is ignored when the primary provider is synapse");
    }

    const fallbackProvider = config.fallback_provider;
    const fallback = fallbackConfig(config, fallbackProvider);
    if (!subc) {
        warnings.push("embedding.provider synapse requires a subc block; using fallback provider");
        return { primary: fallback, shadow: null, warnings };
    }
    if (!fallbackProvider) {
        warnings.push(
            "embedding.provider synapse requires embedding.fallback_provider; using local fallback",
        );
        return { primary: fallbackConfig(config, "local"), shadow: null, warnings };
    }

    try {
        const metadata = await discoverSynapseLane(
            config,
            subc,
            args.projectRoot,
            args.session ?? "routing",
        );
        return {
            primary: resolvedSynapseConfig(
                subc,
                metadata,
                args.projectRoot,
                args.session ?? "routing",
            ),
            shadow: null,
            warnings,
        };
    } catch (error) {
        warnings.push(
            `Synapse is not ready; using embedding.fallback_provider=${fallbackProvider}: ${error instanceof Error ? error.message : String(error)}`,
        );
        log(`[magic-context] Synapse routing fell back: ${warnings.at(-1)}`);
        return { primary: fallback, shadow: null, warnings };
    }
}

export function getResolvedSynapseProviderIdentity(config: ResolvedSynapseEmbeddingConfig): string {
    return getSynapseLaneIdentity(config.model, config.synapse_fingerprint);
}
