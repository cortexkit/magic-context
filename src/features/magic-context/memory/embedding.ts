import { log } from "../../../shared/logger";

export interface EmbeddingProviderConfig {
    embedding_provider?: string | null;
}

type EmbeddingPipelineResult = {
    data: ArrayLike<number> | ArrayLike<number>[];
    dims?: number[];
};

type EmbeddingPipeline = {
    (
        input: string | string[],
        options: { pooling: "mean"; normalize: true },
    ): Promise<EmbeddingPipelineResult>;
    dispose?: () => Promise<void> | void;
};

type CreateEmbeddingPipeline = (
    task: "feature-extraction",
    model: "Xenova/all-MiniLM-L6-v2",
    options: { quantized: boolean },
) => Promise<EmbeddingPipeline>;

let pipeline: unknown = null;
let initPromise: Promise<void> | null = null;

function embeddingsDisabled(providerConfig?: EmbeddingProviderConfig): boolean {
    return providerConfig?.embedding_provider === "off";
}

function getPipeline(): EmbeddingPipeline | null {
    return pipeline as EmbeddingPipeline | null;
}

function isArrayLikeNumber(value: unknown): value is ArrayLike<number> {
    return typeof value === "object" && value !== null && "length" in value;
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
    return values instanceof Float32Array
        ? new Float32Array(values)
        : Float32Array.from(Array.from(values));
}

function extractBatchEmbeddings(
    result: EmbeddingPipelineResult,
    expectedCount: number,
): (Float32Array | null)[] {
    const { data } = result;

    if (
        Array.isArray(data) &&
        data.length === expectedCount &&
        data.every((entry) => typeof entry !== "number" && isArrayLikeNumber(entry))
    ) {
        return data.map((entry) => toFloat32Array(entry));
    }

    if (!isArrayLikeNumber(data)) {
        log("[magic-context] embedding batch returned unexpected data shape");
        return Array.from({ length: expectedCount }, () => null);
    }

    const flatData = toFloat32Array(data);
    const dimension = result.dims?.at(-1) ?? flatData.length / expectedCount;

    if (
        !Number.isInteger(dimension) ||
        dimension <= 0 ||
        flatData.length !== expectedCount * dimension
    ) {
        log("[magic-context] embedding batch returned invalid dimensions");
        return Array.from({ length: expectedCount }, () => null);
    }

    const embeddings: Float32Array[] = [];
    for (let index = 0; index < expectedCount; index++) {
        embeddings.push(flatData.slice(index * dimension, (index + 1) * dimension));
    }

    return embeddings;
}

/**
 * Lazily initialize the embedding model. Only downloads/loads on first call.
 * Returns false if embedding provider is "off" or initialization fails.
 */
export async function ensureEmbeddingModel(
    providerConfig?: EmbeddingProviderConfig,
): Promise<boolean> {
    if (embeddingsDisabled(providerConfig)) {
        return false;
    }

    if (pipeline) {
        return true;
    }

    if (initPromise) {
        await initPromise;
        return pipeline !== null;
    }

    initPromise = (async () => {
        try {
            const transformersModule = (await import("@huggingface/transformers")) as Record<
                string,
                unknown
            >;
            const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;
            pipeline = await createPipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
                quantized: true,
            });
            log("[magic-context] embedding model loaded: Xenova/all-MiniLM-L6-v2");
        } catch (error) {
            log("[magic-context] embedding model failed to load:", error);
            pipeline = null;
        } finally {
            initPromise = null;
        }
    })();

    await initPromise;
    return pipeline !== null;
}

/**
 * Embed a single text string. Returns null if embeddings are disabled or init failed.
 */
export async function embedText(
    text: string,
    providerConfig?: EmbeddingProviderConfig,
): Promise<Float32Array | null> {
    if (!(await ensureEmbeddingModel(providerConfig))) {
        return null;
    }

    try {
        const embeddingPipeline = getPipeline();
        if (!embeddingPipeline) {
            return null;
        }

        const result = await embeddingPipeline(text, {
            pooling: "mean",
            normalize: true,
        });

        return extractBatchEmbeddings(result, 1)[0] ?? null;
    } catch (error) {
        log("[magic-context] embedding failed:", error);
        return null;
    }
}

export async function embed(
    text: string,
    providerConfig?: EmbeddingProviderConfig,
): Promise<Float32Array | null> {
    return embedText(text, providerConfig);
}

/**
 * Embed multiple texts in a batch. Returns null entries for failures.
 */
export async function embedBatch(
    texts: string[],
    providerConfig?: EmbeddingProviderConfig,
): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) {
        return [];
    }

    if (!(await ensureEmbeddingModel(providerConfig))) {
        return Array.from({ length: texts.length }, () => null);
    }

    try {
        const embeddingPipeline = getPipeline();
        if (!embeddingPipeline) {
            return Array.from({ length: texts.length }, () => null);
        }

        const result = await embeddingPipeline(texts, {
            pooling: "mean",
            normalize: true,
        });

        return extractBatchEmbeddings(result, texts.length);
    } catch (error) {
        log("[magic-context] embedding batch failed:", error);
        return Array.from({ length: texts.length }, () => null);
    }
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Pure math - no model dependency.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < a.length; index++) {
        dotProduct += a[index]! * b[index]!;
        normA += a[index]! * a[index]!;
        normB += b[index]! * b[index]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Check if the embedding model is currently loaded.
 */
export function isEmbeddingModelLoaded(): boolean {
    return pipeline !== null;
}

/**
 * Dispose the loaded model to free memory.
 */
export async function disposeEmbeddingModel(): Promise<void> {
    if (initPromise) {
        await initPromise;
    }

    const embeddingPipeline = getPipeline();
    if (!embeddingPipeline) {
        pipeline = null;
        initPromise = null;
        return;
    }

    try {
        await embeddingPipeline.dispose?.();
    } catch (error) {
        log("[magic-context] embedding model dispose failed:", error);
    } finally {
        pipeline = null;
        initPromise = null;
    }
}
