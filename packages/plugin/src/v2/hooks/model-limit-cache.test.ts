import { expect, test } from "bun:test";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
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
