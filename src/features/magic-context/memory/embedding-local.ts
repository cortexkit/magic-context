import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { EmbeddingProvider } from "./embedding-provider";

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
    model: string,
    options: { quantized: boolean },
) => Promise<EmbeddingPipeline>;

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

export class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    private readonly model: string;
    private pipeline: EmbeddingPipeline | null = null;
    private initPromise: Promise<void> | null = null;

    constructor(model = DEFAULT_LOCAL_EMBEDDING_MODEL) {
        this.model = model;
        this.modelId = `local:${model}`;
    }

    async initialize(): Promise<boolean> {
        if (this.pipeline) {
            return true;
        }

        if (this.initPromise) {
            await this.initPromise;
            return this.pipeline !== null;
        }

        this.initPromise = (async () => {
            try {
                const transformersModule = (await import("@huggingface/transformers")) as Record<
                    string,
                    unknown
                >;
                const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;
                this.pipeline = await createPipeline("feature-extraction", this.model, {
                    quantized: true,
                });
                log(`[magic-context] embedding model loaded: ${this.model}`);
            } catch (error) {
                log("[magic-context] embedding model failed to load:", error);
                this.pipeline = null;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
        return this.pipeline !== null;
    }

    async embed(text: string): Promise<Float32Array | null> {
        if (!(await this.initialize())) {
            return null;
        }

        try {
            if (!this.pipeline) {
                return null;
            }

            const result = await this.pipeline(text, {
                pooling: "mean",
                normalize: true,
            });

            return extractBatchEmbeddings(result, 1)[0] ?? null;
        } catch (error) {
            log("[magic-context] embedding failed:", error);
            return null;
        }
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        try {
            if (!this.pipeline) {
                return Array.from({ length: texts.length }, () => null);
            }

            const result = await this.pipeline(texts, {
                pooling: "mean",
                normalize: true,
            });

            return extractBatchEmbeddings(result, texts.length);
        } catch (error) {
            log("[magic-context] embedding batch failed:", error);
            return Array.from({ length: texts.length }, () => null);
        }
    }

    async dispose(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }

        if (!this.pipeline) {
            this.pipeline = null;
            this.initPromise = null;
            return;
        }

        try {
            await this.pipeline.dispose?.();
        } catch (error) {
            log("[magic-context] embedding model dispose failed:", error);
        } finally {
            this.pipeline = null;
            this.initPromise = null;
        }
    }

    isLoaded(): boolean {
        return this.pipeline !== null;
    }
}
