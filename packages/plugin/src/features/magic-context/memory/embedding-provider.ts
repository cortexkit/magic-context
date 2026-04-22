export interface EmbeddingProvider {
    readonly modelId: string;
    initialize(): Promise<boolean>;
    /** Embed a single text. `signal` lets callers abort the underlying network
     *  request (or long-running local inference) before the provider's internal
     *  timeout fires — used by transform-hot-path callers that have their own
     *  sub-timeout (e.g. 3s auto-search wants to cancel the 30s embed fetch). */
    embed(text: string, signal?: AbortSignal): Promise<Float32Array | null>;
    /** Batch variant of `embed`. Same signal semantics: aborting cancels the
     *  whole batch request (including the underlying HTTP call for remote providers). */
    embedBatch(texts: string[], signal?: AbortSignal): Promise<(Float32Array | null)[]>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
