import type { EmbeddingFailure } from "./embedding-failure";

export type EmbeddingPurpose = "query" | "passage";

export interface EmbeddingProvider {
    readonly modelId: string;
    /** Maximum safe input window for one embedding request. Unknown providers default to 512. */
    readonly maxInputTokens?: number;
    initialize(): Promise<boolean>;
    /** Embed a single text. `signal` lets callers abort the underlying network
     *  request (or long-running local inference) before the provider's internal
     *  timeout fires — used by transform-hot-path callers that have their own
     *  sub-timeout (e.g. 3s auto-search wants to cancel the 30s embed fetch).
     *  `purpose` selects asymmetric input_type on openai-compatible providers;
     *  defaults to `"passage"` (indexed/stored content). */
    embed(
        text: string,
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<Float32Array | null>;
    /** Batch variant of `embed`. Same signal semantics: aborting cancels the
     *  whole batch request (including the underlying HTTP call for remote providers).
     *  `purpose` defaults to `"passage"`. */
    embedBatch(
        texts: string[],
        signal?: AbortSignal,
        purpose?: EmbeddingPurpose,
    ): Promise<(Float32Array | null)[]>;
    /** Domain-item batch form for providers that can preserve item identity across retries. */
    embedItems?(
        items: readonly { id: string; text: string; contentSha256: string }[],
        signal?: AbortSignal,
    ): Promise<Map<string, Float32Array>>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
    /** Most recent classified provider failure, if this provider exposes one. */
    getLastFailureReason?(): EmbeddingFailure | null;
}
