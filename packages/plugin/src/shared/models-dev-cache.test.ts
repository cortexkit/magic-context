import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearModelsDevCache,
    getModelsDevCacheState,
    getModelsDevContextLimit,
    refreshModelLimitsFromApi,
} from "./models-dev-cache";

describe("models-dev-cache", () => {
    let tempDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "mc-models-dev-"));
        originalEnv = {
            OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
            OPENCODE_MODELS_URL: process.env.OPENCODE_MODELS_URL,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        };
        // Isolate from user environment.
        delete process.env.OPENCODE_MODELS_PATH;
        delete process.env.OPENCODE_MODELS_URL;
        process.env.XDG_CACHE_HOME = tempDir;
        clearModelsDevCache();
    });

    afterEach(() => {
        // Restore env.
        for (const [k, v] of Object.entries(originalEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmSync(tempDir, { recursive: true, force: true });
        clearModelsDevCache();
    });

    test("reads context limits from models.json under XDG_CACHE_HOME", () => {
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                anthropic: {
                    models: {
                        "claude-sonnet-4-6": { limit: { context: 200000 } },
                    },
                },
                "github-copilot": {
                    models: {
                        "gpt-5.3-codex": { limit: { context: 400000 } },
                    },
                },
            }),
        );

        expect(getModelsDevContextLimit("anthropic", "claude-sonnet-4-6")).toBe(200000);
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.3-codex")).toBe(400000);
        expect(getModelsDevContextLimit("unknown", "unknown")).toBeUndefined();
    });

    test("expands experimental.modes into derived model IDs with parent context", () => {
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                "github-copilot": {
                    models: {
                        "gpt-5.4": {
                            limit: { context: 400000 },
                            experimental: { modes: { fast: {}, high: {} } },
                        },
                    },
                },
            }),
        );

        // Parent ID works.
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.4")).toBe(400000);
        // Derived mode IDs inherit parent context.
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.4-fast")).toBe(400000);
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.4-high")).toBe(400000);
    });

    test("OPENCODE_MODELS_PATH env overrides default path", () => {
        // Write real file somewhere unexpected.
        const customPath = join(tempDir, "elsewhere", "my-models.json");
        mkdirSync(join(tempDir, "elsewhere"), { recursive: true });
        writeFileSync(
            customPath,
            JSON.stringify({
                anthropic: { models: { "claude-4": { limit: { context: 1000000 } } } },
            }),
        );
        process.env.OPENCODE_MODELS_PATH = customPath;
        clearModelsDevCache();

        expect(getModelsDevContextLimit("anthropic", "claude-4")).toBe(1000000);
    });

    test("OPENCODE_MODELS_URL (non-default) selects hashed filename", () => {
        // We can't easily verify the exact hash without duplicating the hash logic,
        // but we can confirm that setting OPENCODE_MODELS_URL prevents reading
        // the default models.json when that file exists with different data.
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                anthropic: { models: { "claude-4": { limit: { context: 500000 } } } },
            }),
        );

        process.env.OPENCODE_MODELS_URL = "https://custom.example.com/models";
        clearModelsDevCache();

        // Should NOT find claude-4 because we're looking at a hashed filename now,
        // not models.json.
        expect(getModelsDevContextLimit("anthropic", "claude-4")).toBeUndefined();
    });

    test("API cache takes priority over file cache", async () => {
        // Seed file layer with one value.
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                anthropic: { models: { "claude-4": { limit: { context: 100000 } } } },
            }),
        );

        // Sanity: file layer returns 100000 before API refresh.
        expect(getModelsDevContextLimit("anthropic", "claude-4")).toBe(100000);

        // Mock client providing DIFFERENT value via API.
        const mockClient = {
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "anthropic",
                                models: {
                                    "claude-4": { limit: { context: 1000000 } },
                                },
                            },
                        ],
                    },
                }),
            },
        };
        // @ts-expect-error mock narrow shape
        await refreshModelLimitsFromApi(mockClient);

        // API value wins.
        expect(getModelsDevContextLimit("anthropic", "claude-4")).toBe(1000000);

        const state = getModelsDevCacheState();
        expect(state.apiLoaded).toBe(true);
        expect(state.apiCount).toBe(1);
    });

    test("refreshModelLimitsFromApi tolerates empty/malformed responses", async () => {
        // Undefined data.
        // @ts-expect-error mock narrow shape
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: undefined }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        // Non-array providers.
        // @ts-expect-error mock narrow shape
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: { providers: "not an array" } }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        // Thrown error.
        // @ts-expect-error mock narrow shape
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => {
                    throw new Error("network error");
                },
            },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);
    });

    test("falls back to file layer when API provider/model key is missing", async () => {
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                anthropic: { models: { "claude-only-in-file": { limit: { context: 777777 } } } },
            }),
        );

        const mockClient = {
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "anthropic",
                                models: {
                                    "claude-only-in-api": { limit: { context: 888888 } },
                                },
                            },
                        ],
                    },
                }),
            },
        };
        // @ts-expect-error mock narrow shape
        await refreshModelLimitsFromApi(mockClient);

        // API-only key comes from API.
        expect(getModelsDevContextLimit("anthropic", "claude-only-in-api")).toBe(888888);
        // File-only key falls through to file layer.
        expect(getModelsDevContextLimit("anthropic", "claude-only-in-file")).toBe(777777);
    });
});
