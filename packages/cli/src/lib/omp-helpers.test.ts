import { describe, expect, it } from "bun:test";
import { parseOmpModelsOutput, runOmpCommand } from "./omp-helpers";

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

describe("OMP command execution", () => {
    it("preserves spawn timeout errors when stderr is empty", () => {
        const result = runOmpCommand(process.execPath, ["-e", "while (true) {}"], 10);
        expect(result.ok).toBe(false);
        expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("captures JSON-sized output above Node's default buffer", () => {
        const result = runOmpCommand(process.execPath, [
            "-e",
            "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
        ]);
        expect(result.ok).toBe(true);
        expect(result.stdout.length).toBe(2 * 1024 * 1024);
    });
});
