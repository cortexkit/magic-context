import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { normalizeCompartmentChunkMaxInputTokens } from "../compartment-chunk-embedding";
import { cosineSimilarity } from "./cosine-similarity";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import type { EmbeddingProvider } from "./embedding-provider";
import { SynapseEmbeddingProvider } from "./embedding-synapse";

export type {
    EmbeddingFeatures,
    ProjectEmbeddingRegistrationSnapshot,
} from "../project-embedding-registry";
export {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    contentSha256,
    embedBatchForProject,
    embedItemsForProject,
    embedShadowTextForProject,
    embedTextForProject,
    embedUnembeddedCompartmentChunksForProject,
    embedUnembeddedMemoriesForProject,
    enqueueShadowEmbeddingItems,
    flushShadowEmbeddingBacklog,
    getPrimaryEmbeddingMeasurementCohort,
    getProjectEmbeddingSnapshot,
    getShadowBackfillRemaining,
    getShadowBackfillStopReason,
    getShadowEmbeddingMeasurementCohort,
    markProjectLoadUntrusted,
    registerProjectEmbedding,
    registerProjectInObservationMode,
    registerProjectShadowEmbedding,
    type ShadowEmbeddingMeasurementCohort,
    sweepAllRegisteredProjects,
    unregisterProjectEmbedding,
} from "../project-embedding-registry";

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    provider: "local",
    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
    local_runtime: "auto",
};

let embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
let provider: EmbeddingProvider | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            local_runtime: config?.local_runtime ?? "auto",
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
            // local_dtype is spread CONDITIONALLY to preserve the byte-identical
            // default identity when unset (mirrors the schema transform). See #259.
            ...(config?.local_dtype ? { local_dtype: config.local_dtype } : {}),
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const queryInputType = config.query_input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.dimensions ? { dimensions: config.dimensions } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "off") {
        return { provider: "off" };
    }

    if (config.provider === "synapse") {
        return { ...config, max_input_tokens: 8192 };
    }

    throw new Error("Unknown embedding provider");
}

function resolveProviderIdentity(config: EmbeddingConfig): string {
    return getEmbeddingProviderIdentity(config);
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            truncate: config.truncate,
            dimensions: (config as unknown as { dimensions?: number }).dimensions,
            maxInputTokens: config.max_input_tokens,
        });
    }

    if (config.provider === "local") {
        return new LocalEmbeddingProvider(
            config.model,
            config.max_input_tokens,
            config.local_dtype,
            config.local_runtime,
        );
    }

    if (config.provider === "synapse") {
        const synapse = config as EmbeddingConfig & {
            model?: string;
            synapse_connection_file?: string;
            synapse_fingerprint?: string;
            synapse_table_epoch?: number;
            synapse_dims?: number;
            synapse_recommended_batch?: number;
            synapse_provenance?: unknown;
        };
        return new SynapseEmbeddingProvider({
            connectionFile: synapse.synapse_connection_file ?? "",
            projectRoot: "",
            session: "embedding",
            model: synapse.model,
            fingerprint: synapse.synapse_fingerprint,
            tableEpoch: synapse.synapse_table_epoch,
            dims: synapse.synapse_dims,
            recommendedBatch: synapse.synapse_recommended_batch,
            provenance: synapse.synapse_provenance,
        });
    }

    throw new Error("Unknown embedding provider");
}

function getOrCreateProvider(): EmbeddingProvider | null {
    if (provider) {
        return provider;
    }

    provider = createProvider(embeddingConfig);
    return provider;
}

export function initializeEmbedding(config: EmbeddingConfig): void {
    const nextConfig = resolveEmbeddingConfig(config);
    const nextProviderIdentity = resolveProviderIdentity(nextConfig);
    const previousProvider = provider;
    const previousProviderIdentity =
        previousProvider?.modelId ?? resolveProviderIdentity(embeddingConfig);

    if (previousProviderIdentity === nextProviderIdentity) {
        embeddingConfig = nextConfig;
        return;
    }

    embeddingConfig = nextConfig;
    provider = null;

    if (previousProvider) {
        void previousProvider.dispose().catch((error) => {
            log("[magic-context] embedding provider dispose failed:", error);
        });
    }
}

export function isEmbeddingEnabled(): boolean {
    return embeddingConfig.provider !== "off";
}

export async function ensureEmbeddingModel(): Promise<boolean> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return false;
    }

    return currentProvider.initialize();
}

export async function embedText(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return null;
    }

    if (!(await currentProvider.initialize())) {
        return null;
    }

    return currentProvider.embed(text, signal);
}

export function getEmbeddingModelId(): string {
    return getOrCreateProvider()?.modelId ?? "off";
}

export { cosineSimilarity };
