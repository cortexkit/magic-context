import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { cosineSimilarity } from "./cosine-similarity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import type { EmbeddingProvider } from "./embedding-provider";
import { computeNormalizedHash } from "./normalize-hash";

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    provider: "local",
    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
};

let embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
let provider: EmbeddingProvider | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
        };
    }

    return { provider: "off" };
}

function resolveModelId(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "off";
    }

    if (config.provider === "openai-compatible") {
        const endpoint = config.endpoint.trim();
        const model = config.model.trim();
        const keyHash = config.api_key ? computeNormalizedHash(config.api_key) : "nokey";
        return `openai-compat:${endpoint}:${model}:${keyHash}`;
    }

    return config.model.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
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
        });
    }

    return new LocalEmbeddingProvider(config.model);
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
    const nextModelId = resolveModelId(nextConfig);
    const previousProvider = provider;
    const previousModelId = previousProvider?.modelId ?? resolveModelId(embeddingConfig);

    if (previousModelId === nextModelId) {
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

export async function embedText(text: string): Promise<Float32Array | null> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return null;
    }

    if (!(await currentProvider.initialize())) {
        return null;
    }

    return currentProvider.embed(text);
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) {
        return [];
    }

    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return Array.from({ length: texts.length }, () => null);
    }

    if (!(await currentProvider.initialize())) {
        return Array.from({ length: texts.length }, () => null);
    }

    return currentProvider.embedBatch(texts);
}

export function getEmbeddingModelId(): string {
    return getOrCreateProvider()?.modelId ?? "off";
}

export { cosineSimilarity };

export async function disposeEmbeddingModel(): Promise<void> {
    const currentProvider = provider;
    provider = null;

    if (!currentProvider) {
        return;
    }

    await currentProvider.dispose();
}
