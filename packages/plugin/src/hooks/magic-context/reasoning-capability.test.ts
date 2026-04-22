import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { modelRequiresInterleavedReasoning } from "./reasoning-capability";

describe("reasoning-capability", () => {
    let tempDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-reasoning-capability-"));
        originalEnv = {
            OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
            OPENCODE_MODELS_URL: process.env.OPENCODE_MODELS_URL,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        };
        delete process.env.OPENCODE_MODELS_PATH;
        delete process.env.OPENCODE_MODELS_URL;
        process.env.XDG_CACHE_HOME = tempDir;
        const emptyConfigDir = join(tempDir, "config", "opencode");
        mkdirSync(emptyConfigDir, { recursive: true });
        process.env.OPENCODE_CONFIG_DIR = emptyConfigDir;
        clearModelsDevCache();
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(tempDir, { recursive: true, force: true });
        clearModelsDevCache();
    });

    it("returns true for models whose metadata declares an interleaved reasoning field", () => {
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                "opencode-go": {
                    models: {
                        "kimi-k2.6": {
                            limit: { context: 262144 },
                            interleaved: { field: "reasoning_content" },
                        },
                    },
                },
            }),
        );

        expect(
            modelRequiresInterleavedReasoning({ providerID: "opencode-go", modelID: "kimi-k2.6" }),
        ).toBe(true);
    });

    it("returns false for models without an interleaved reasoning field", () => {
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                openai: {
                    models: {
                        "gpt-4o": {
                            limit: { context: 128000 },
                        },
                    },
                },
            }),
        );

        expect(modelRequiresInterleavedReasoning({ providerID: "openai", modelID: "gpt-4o" })).toBe(
            false,
        );
    });

    it("returns false for unknown models instead of speculating", () => {
        expect(
            modelRequiresInterleavedReasoning({ providerID: "unknown", modelID: "unknown" }),
        ).toBe(false);
        expect(modelRequiresInterleavedReasoning(undefined)).toBe(false);
    });
});
