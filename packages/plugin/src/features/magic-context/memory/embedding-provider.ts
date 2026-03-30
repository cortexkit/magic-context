export interface EmbeddingProvider {
    readonly modelId: string;
    initialize(): Promise<boolean>;
    embed(text: string): Promise<Float32Array | null>;
    embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
    dispose(): Promise<void>;
    isLoaded(): boolean;
}
