import { log } from "../../../shared/logger";
import type { EmbeddingProvider } from "./embedding-provider";

interface OpenAICompatibleEmbeddingProviderOptions {
    endpoint?: string;
    model?: string;
    apiKey?: string;
}

interface EmbeddingResponseBody {
    data?: Array<{
        embedding?: number[];
    }>;
}

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    private readonly endpoint: string;
    private readonly model: string;
    private readonly apiKey: string;
    private initialized = false;

    constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.model = options.model?.trim() ?? "";
        this.apiKey = options.apiKey?.trim() ?? "";
        this.modelId = `openai-compat:${this.endpoint}:${this.model}`;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.model) {
            log(
                "[magic-context] openai-compatible embedding provider is missing endpoint or model",
            );
            this.initialized = false;
            return false;
        }

        this.initialized = true;
        return true;
    }

    async embed(text: string): Promise<Float32Array | null> {
        const [embedding] = await this.embedBatch([text]);
        return embedding ?? null;
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        try {
            const response = await fetch(`${this.endpoint}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    input: texts,
                }),
            });

            if (!response.ok) {
                log(
                    `[magic-context] openai-compatible embedding request failed: ${response.status} ${response.statusText}`,
                );
                return Array.from({ length: texts.length }, () => null);
            }

            const body = (await response.json()) as EmbeddingResponseBody;
            const items = Array.isArray(body.data) ? body.data : [];

            return Array.from({ length: texts.length }, (_, index) => {
                const embedding = items[index]?.embedding;
                return Array.isArray(embedding) ? Float32Array.from(embedding) : null;
            });
        } catch (error) {
            log("[magic-context] openai-compatible embedding request failed:", error);
            return Array.from({ length: texts.length }, () => null);
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
    }

    isLoaded(): boolean {
        return this.initialized;
    }
}
