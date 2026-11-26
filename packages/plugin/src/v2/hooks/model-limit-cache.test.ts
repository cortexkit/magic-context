import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "../../shared/data-path";
import * as harness from "../../shared/harness";
import {
    clearModelsDevCache,
    getSdkContextLimit,
    getSdkOutputLimit,
    modelSupportsVision,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import {
    catalogProvidersPayload,
    modelLimitCacheWarm,
    resetModelLimitCacheWarmForTest,
    warmModelLimitCacheFromCatalog,
} from "./model-limit-cache";
import type { V2Context } from "./types";

function catalogContext(
    models: Array<Record<string, unknown>>,
    counter?: { calls: number },
): V2Context {
    return {
        model: {
            list: () => {
                if (counter) counter.calls += 1;
                return models;
            },
        },
    } as unknown as V2Context;
}

test("groups raw catalog rows by provider and keeps their metadata", () => {
    const payload = catalogProvidersPayload([
        {
            id: "deepseek/deepseek-v4.1-flash",
            providerID: "commandcode",
            limit: { context: 1_000_000, output: 65_536 },
        },
        {
            id: "deepseek/deepseek-v4-flash",
            providerID: "commandcode",
            limit: { context: 1_000_000 },
        },
        {
            id: "muse-spark-1.3-contributor",
            providerID: "opencode-go",
            limit: { context: 200_000 },
        },
    ]);
    expect(payload.map((provider) => provider.id)).toEqual(["commandcode", "opencode-go"]);
    const commandcode = payload[0]!;
    expect(Object.keys(commandcode.models)).toEqual([
        "deepseek/deepseek-v4.1-flash",
        "deepseek/deepseek-v4-flash",
    ]);
    expect(commandcode.models["deepseek/deepseek-v4.1-flash"]).toEqual({
        id: "deepseek/deepseek-v4.1-flash",
        providerID: "commandcode",
        limit: { context: 1_000_000, output: 65_536 },
    });
});

test("accepts the { data } list envelope and skips malformed rows", () => {
    const payload = catalogProvidersPayload({
        data: [
            { id: "a", providerID: "p", limit: { context: 100_000 } },
            null,
            { id: "b" },
            42,
            { providerID: "p" },
        ],
    });
    expect(payload).toEqual([
        {
            id: "p",
            models: { a: { id: "a", providerID: "p", limit: { context: 100_000 } } },
        },
    ]);
});

test("returns an empty payload for unusable input", () => {
    expect(catalogProvidersPayload(null)).toEqual([]);
    expect(catalogProvidersPayload({})).toEqual([]);
});

test("retries the warm after a failed attempt", async () => {
    clearModelsDevCache();
    resetModelLimitCacheWarmForTest();
    const counter = { calls: 0 };
    const context = catalogContext([], counter);
    await warmModelLimitCacheFromCatalog(context, { retries: 0, retryDelayMs: 0 });
    expect(modelLimitCacheWarm()).toBe(false);
    await warmModelLimitCacheFromCatalog(context, { retries: 0, retryDelayMs: 0 });
    expect(counter.calls).toBe(2);
    clearModelsDevCache();
    resetModelLimitCacheWarmForTest();
});

test("latches once the cache holds entries", async () => {
    clearModelsDevCache();
    resetModelLimitCacheWarmForTest();
    await warmModelLimitCacheFromCatalog(
        catalogContext([{ id: "m", providerID: "p", limit: { context: 200_000 } }]),
        { retries: 0, retryDelayMs: 0 },
    );
    expect(modelLimitCacheWarm()).toBe(true);
    const counter = { calls: 0 };
    await warmModelLimitCacheFromCatalog(
        catalogContext([{ id: "other", providerID: "q", limit: { context: 200_000 } }], counter),
        { retries: 0, retryDelayMs: 0 },
    );
    expect(counter.calls).toBe(0);
    clearModelsDevCache();
    resetModelLimitCacheWarmForTest();
});

describe("OpenCode 2 usage limit refresh", () => {
    let tempDir: string;
    let file: string;
    let previousDataHome: string | undefined;
    let restoreHarness: () => void;

    const visionModel = {
        id: "vision",
        providerID: "p",
        limit: { context: 200_000, input: 170_000, output: 30_000 },
        capabilities: { input: ["text", "image"] },
        experimental: { modes: { fast: {} } },
    };
    const secondModel = {
        id: "other",
        providerID: "q",
        limit: { context: 180_000, output: 10_000 },
    };

    function warm(...rows: Array<Record<string, unknown>>) {
        return warmModelLimitCacheFromCatalog(catalogContext(rows), { retries: 0 });
    }

    function update(
        limit: { context: number; input?: number; output?: number },
        capabilities?: { input: string[] },
    ) {
        const usageUpdate = { retries: 0, mode: "merge" as const };
        return refreshModelLimitsFromApi(
            {
                config: {
                    providers: async () => ({
                        data: {
                            providers: [{ id: "p", models: { vision: { limit, capabilities } } }],
                        },
                    }),
                },
            },
            usageUpdate,
        );
    }

    const disk = () => JSON.parse(readFileSync(file, "utf8"));

    beforeEach(() => {
        tempDir = createTestTempDir("mc-v2-usage-limits-").dir;
        previousDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = tempDir;
        const storage = getMagicContextStorageDir();
        mkdirSync(storage, { recursive: true });
        file = join(storage, "model-context-limits-opencode2.json");
        const selected = spyOn(harness, "getHarness").mockReturnValue("opencode2");
        restoreHarness = () => selected.mockRestore();
        clearModelsDevCache();
        resetModelLimitCacheWarmForTest();
    });

    afterEach(() => {
        clearModelsDevCache();
        resetModelLimitCacheWarmForTest();
        restoreHarness();
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousDataHome;
        cleanupTestTempDir(tempDir);
    });

    test("keeps other models' limits and experimental aliases after a usage update", async () => {
        await warm(visionModel, secondModel);
        await update({ context: 200_000 });

        expect(getSdkContextLimit("q", "other", undefined, { reservation: "none" })).toBe(180_000);
        expect(getSdkOutputLimit("q", "other")).toBe(10_000);
        expect(modelSupportsVision("p", "vision-fast")).toBe(true);
        expect(disk()).toMatchObject({
            "q/other": { contextLimit: 180_000, outputLimit: 10_000 },
            "p/vision-fast": { contextLimit: 200_000, outputLimit: 30_000, vision: true },
        });
    });

    test("updates supplied limits without downgrading the selected model's metadata", async () => {
        await warm(visionModel);
        await update({ context: 190_000, output: 20_000 });

        expect(disk()["p/vision"]).toEqual({
            limit: 190_000,
            contextLimit: 190_000,
            inputLimit: 170_000,
            outputLimit: 20_000,
            vision: true,
        });
    });

    test("keeps a damaged file repaired by startup without resurrecting removed models", async () => {
        writeFileSync(
            file,
            JSON.stringify({
                "p/vision": { limit: 190_000, contextLimit: 190_000, vision: false },
                "p/removed": { limit: 180_000, contextLimit: 180_000, vision: false },
            }),
        );
        expect(modelSupportsVision("p", "vision")).toBe(false);
        expect(getSdkContextLimit("p", "removed")).toBe(180_000);

        await warm(visionModel, secondModel);
        expect(disk()["p/vision"]).toMatchObject({ contextLimit: 200_000, vision: true });
        expect(disk()["p/removed"]).toBeUndefined();
        await update({ context: 190_000 });
        clearModelsDevCache();

        expect(modelSupportsVision("p", "vision")).toBe(true);
        expect(getSdkOutputLimit("q", "other")).toBe(10_000);
        expect(getSdkContextLimit("p", "removed")).toBeUndefined();
    });

    test("first-use catalog evidence repairs a damaged project-local model's vision flag", async () => {
        writeFileSync(
            file,
            JSON.stringify({
                "p/vision": { limit: 190_000, contextLimit: 190_000, vision: false },
            }),
        );
        expect(modelSupportsVision("p", "vision")).toBe(false);
        expect(getSdkContextLimit("p", "vision")).toBe(190_000);

        await update({ context: 200_000 }, { input: ["text", "image"] });
        expect(disk()["p/vision"]).toMatchObject({ contextLimit: 200_000, vision: true });
        await update({ context: 210_000 }, { input: ["text"] });
        expect(disk()["p/vision"]).toMatchObject({ contextLimit: 210_000, vision: false });
    });
});
