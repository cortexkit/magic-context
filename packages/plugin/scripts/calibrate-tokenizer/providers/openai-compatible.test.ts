import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { measureOpenAICompatible } from "./openai-compatible";

const originalFetch = globalThis.fetch;
const modelCatalog = JSON.parse(
    readFileSync(new URL("../models.json", import.meta.url), "utf-8"),
) as {
    tests: Array<{ provider: string; modelId: string }>;
};

afterEach(() => {
    globalThis.fetch = originalFetch;
});

async function expectProviderEndpoint(provider: string, expectedUrl: string): Promise<void> {
    const urls: string[] = [];
    const totals = [10, 30, 50];
    globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(String(input));
        const promptTokens = totals[urls.length - 1];
        return new Response(JSON.stringify({ usage: { prompt_tokens: promptTokens } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;

    const result = await measureOpenAICompatible(
        {
            label: `${provider}/MiniMax-M3`,
            provider,
            modelId: "MiniMax-M3",
        },
        { type: "api", key: "test-key" },
        "system prompt",
        [{ name: "tool", description: "Tool", input_schema: { type: "object" } }],
    );

    expect(urls).toEqual([expectedUrl, expectedUrl, expectedUrl]);
    expect(result).toEqual({ systemApi: 20, toolsApi: 40 });
}

describe("measureOpenAICompatible", () => {
    it("catalogs both current MiniMax models for each regional route", () => {
        for (const provider of ["minimax", "minimax-cn"]) {
            const modelIds = modelCatalog.tests
                .filter((test) => test.provider === provider)
                .map((test) => test.modelId);
            expect(modelIds).toEqual(["MiniMax-M3", "MiniMax-M2.7"]);
        }
    });

    it("routes MiniMax global calibration requests", async () => {
        await expectProviderEndpoint(
            "minimax",
            "https://api.minimax.io/v1/chat/completions",
        );
    });

    it("routes MiniMax China calibration requests", async () => {
        await expectProviderEndpoint(
            "minimax-cn",
            "https://api.minimaxi.com/v1/chat/completions",
        );
    });
});
