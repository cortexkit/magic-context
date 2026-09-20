import { expect, test } from "bun:test";
import { catalogProvidersPayload } from "./model-limit-cache";

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
