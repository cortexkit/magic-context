import { describe, expect, it } from "bun:test";
import { parseOmpModelsOutput } from "./omp-helpers";

describe("OMP model discovery", () => {
    it("parses model selectors without flattening scoped or nested IDs", () => {
        const output = JSON.stringify({
            models: [
                {
                    provider: "anthropic",
                    id: "claude-opus",
                    selector: "anthropic/claude-opus",
                },
                {
                    provider: "modal",
                    id: "@modal/qwen/model-v1",
                    selector: "modal/@modal/qwen/model-v1",
                },
                { provider: "openai", id: "fallback/model" },
            ],
        });

        expect(parseOmpModelsOutput(output)).toEqual([
            "anthropic/claude-opus",
            "modal/@modal/qwen/model-v1",
            "openai/fallback/model",
        ]);
    });
});
