import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearModelsDevCache,
    getModelsDevCacheState,
    getModelsDevContextLimit,
    getModelsDevInterleavedField,
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
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        };
        // Isolate from user environment — including user's ~/.config/opencode/opencode.jsonc
        // which may have custom provider limits that would override models.json entries.
        delete process.env.OPENCODE_MODELS_PATH;
        delete process.env.OPENCODE_MODELS_URL;
        process.env.XDG_CACHE_HOME = tempDir;
        // Point at an empty directory so no opencode.json{c} is read unless the test writes one.
        const emptyConfigDir = join(tempDir, "config", "opencode");
        mkdirSync(emptyConfigDir, { recursive: true });
        process.env.OPENCODE_CONFIG_DIR = emptyConfigDir;
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

    test("prefers limit.input over limit.context when both are present", () => {
        //#given — GitHub Copilot shape: input is max prompt, context is total window.
        // Matches real-world github-copilot/gpt-5.3-codex which has
        //   limit.context = 400000 (total), limit.input = 272000 (max prompt).
        // Our pressure math must use the input cap; sending a 400K prompt gets rejected.
        // OpenCode's own session/overflow.ts follows the same rule.
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                "github-copilot": {
                    models: {
                        "gpt-5.3-codex": { limit: { context: 400000, input: 272000 } },
                        "claude-opus-4.6": { limit: { context: 144000, input: 128000 } },
                        // Context-only model (no input) falls back to context.
                        "legacy-only-context": { limit: { context: 100000 } },
                    },
                },
            }),
        );

        //#then
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
        expect(getModelsDevContextLimit("github-copilot", "claude-opus-4.6")).toBe(128000);
        expect(getModelsDevContextLimit("github-copilot", "legacy-only-context")).toBe(100000);
    });

    test("derived experimental.modes inherit the effective (input) limit", () => {
        //#given — parent has input < context; derived modes should inherit input, not context
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        writeFileSync(
            join(opencodeDir, "models.json"),
            JSON.stringify({
                openai: {
                    models: {
                        "gpt-5.4": {
                            limit: { context: 1050000, input: 922000 },
                            experimental: { modes: { fast: {}, mini: {} } },
                        },
                    },
                },
            }),
        );

        //#then
        expect(getModelsDevContextLimit("openai", "gpt-5.4")).toBe(922000);
        expect(getModelsDevContextLimit("openai", "gpt-5.4-fast")).toBe(922000);
        expect(getModelsDevContextLimit("openai", "gpt-5.4-mini")).toBe(922000);
    });

    test("custom opencode.json provider overlay uses limit.input preferentially", () => {
        //#given — user defines a proxy provider in opencode.json with input < context
        const opencodeDir = join(tempDir, "opencode");
        mkdirSync(opencodeDir, { recursive: true });
        const configDir = join(tempDir, "config", "opencode");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "opencode.json"),
            JSON.stringify({
                provider: {
                    "my-proxy": {
                        models: {
                            "split-model": { limit: { context: 400000, input: 200000 } },
                        },
                    },
                },
            }),
        );
        process.env.OPENCODE_CONFIG_DIR = configDir;
        clearModelsDevCache();

        //#then
        expect(getModelsDevContextLimit("my-proxy", "split-model")).toBe(200000);

        // Cleanup: restore env (afterEach also handles this, but we added a new var)
        delete process.env.OPENCODE_CONFIG_DIR;
    });

    test("API cache uses limit.input preferentially", async () => {
        //#given — API response shape mirrors file layer
        const mockClient = {
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "github-copilot",
                                models: {
                                    "gpt-5.3-codex": {
                                        limit: { context: 400000, input: 272000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        };
        await refreshModelLimitsFromApi(mockClient);

        //#then
        expect(getModelsDevContextLimit("github-copilot", "gpt-5.3-codex")).toBe(272000);
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
        await refreshModelLimitsFromApi(mockClient);

        // API value wins.
        expect(getModelsDevContextLimit("anthropic", "claude-4")).toBe(1000000);

        const state = getModelsDevCacheState();
        expect(state.apiLoaded).toBe(true);
        expect(state.apiCount).toBe(1);
    });

    test("reads interleaved reasoning field metadata from models.json", () => {
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
                        "plain-model": {
                            limit: { context: 262144 },
                        },
                    },
                },
            }),
        );

        expect(getModelsDevInterleavedField("opencode-go", "kimi-k2.6")).toBe("reasoning_content");
        expect(getModelsDevInterleavedField("opencode-go", "plain-model")).toBeUndefined();
    });

    test("API cache exposes interleaved reasoning metadata", async () => {
        const mockClient = {
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "opencode-go",
                                models: {
                                    "kimi-k2.6": {
                                        limit: { context: 262144 },
                                        capabilities: {
                                            interleaved: { field: "reasoning_content" },
                                        },
                                    },
                                    "plain-model": {
                                        limit: { context: 262144 },
                                        capabilities: { interleaved: false },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        };
        await refreshModelLimitsFromApi(mockClient);

        expect(getModelsDevInterleavedField("opencode-go", "kimi-k2.6")).toBe("reasoning_content");
        expect(getModelsDevInterleavedField("opencode-go", "plain-model")).toBeUndefined();
    });

    test("refreshModelLimitsFromApi tolerates empty/malformed responses", async () => {
        // Undefined data.
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: undefined }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        // Non-array providers.
        await refreshModelLimitsFromApi({
            config: { providers: async () => ({ data: { providers: "not an array" } }) },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);

        // Thrown error.
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => {
                    throw new Error("network error");
                },
            },
        });
        expect(getModelsDevCacheState().apiLoaded).toBe(false);
    });

    test("suppresses repeated logs when API count oscillates between known sizes", async () => {
        // Simulates github-copilot's /models endpoint returning different model sets
        // between calls. We want first sighting of each new size to log, but once a
        // size has been seen before, further flips between known sizes should be
        // silent (with one "oscillating" notice).
        const sizeA = {
            data: {
                providers: [
                    {
                        id: "p",
                        models: {
                            m1: { limit: { context: 100 } },
                            m2: { limit: { context: 100 } },
                            m3: { limit: { context: 100 } },
                        },
                    },
                ],
            },
        };
        const sizeB = {
            data: {
                providers: [
                    {
                        id: "p",
                        models: {
                            m1: { limit: { context: 100 } },
                            m2: { limit: { context: 100 } },
                        },
                    },
                ],
            },
        };

        const clientA = { config: { providers: async () => sizeA } };
        const clientB = { config: { providers: async () => sizeB } };

        // First sighting of size 3 → logs "loaded 3 entries".
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        // First sighting of size 2 → logs "loaded 2 entries (was 3)".
        await refreshModelLimitsFromApi(clientB);
        expect(getModelsDevCacheState().apiCount).toBe(2);

        // Second sighting of size 3 → logs the "oscillating" notice once.
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        // Second sighting of size 2 → silent (no new log expected).
        await refreshModelLimitsFromApi(clientB);
        expect(getModelsDevCacheState().apiCount).toBe(2);

        // Third sighting of size 3 → still silent.
        await refreshModelLimitsFromApi(clientA);
        expect(getModelsDevCacheState().apiCount).toBe(3);

        // The cache itself still updates on every call (model contents are correct
        // for whichever provider response just arrived). The suppression is purely
        // a logging concern. Last call was clientA → all three models present.
        expect(getModelsDevContextLimit("p", "m1")).toBe(100);
        expect(getModelsDevContextLimit("p", "m2")).toBe(100);
        expect(getModelsDevContextLimit("p", "m3")).toBe(100);
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
        await refreshModelLimitsFromApi(mockClient);

        // API-only key comes from API.
        expect(getModelsDevContextLimit("anthropic", "claude-only-in-api")).toBe(888888);
        // File-only key falls through to file layer.
        expect(getModelsDevContextLimit("anthropic", "claude-only-in-file")).toBe(777777);
    });
});
