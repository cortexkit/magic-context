import { describe, expect, it } from "bun:test";
import { cosineSimilarity } from "./cosine-similarity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";

describe("embedding module", () => {
    describe("#given cosine similarity", () => {
        it("returns 1 for identical vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2, 3]),
            );

            //#then
            expect(similarity).toBe(1);
        });

        it("returns 0 for orthogonal vectors", () => {
            //#when
            const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));

            //#then
            expect(similarity).toBe(0);
        });

        it("returns -1 for opposite vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 0]),
                new Float32Array([-1, 0]),
            );

            //#then
            expect(similarity).toBe(-1);
        });

        it("handles zero vectors gracefully", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([0, 0, 0]),
                new Float32Array([0, 0, 0]),
            );

            //#then
            expect(similarity).toBe(0);
        });

        it("handles different length vectors", () => {
            //#when
            const similarity = cosineSimilarity(
                new Float32Array([1, 2, 3]),
                new Float32Array([1, 2]),
            );

            //#then
            expect(similarity).toBe(0);
        });
    });

    describe("#given embedding providers", () => {
        it("local provider uses default model id and starts unloaded", () => {
            const provider = new LocalEmbeddingProvider();

            expect(provider.modelId).toBe("local:Xenova/all-MiniLM-L6-v2");
            expect(provider.isLoaded()).toBe(false);
        });

        it("openai-compatible provider normalizes endpoint in model id", () => {
            const provider = new OpenAICompatibleEmbeddingProvider({
                endpoint: "http://localhost:1234/v1/",
                model: "text-embedding-3-small",
                apiKey: "secret",
            });

            expect(provider.modelId).toBe(
                "openai-compat:http://localhost:1234/v1:text-embedding-3-small",
            );
            expect(provider.isLoaded()).toBe(false);
        });
    });
});
