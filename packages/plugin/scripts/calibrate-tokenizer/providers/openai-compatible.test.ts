import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { measureOpenAICompatible } from "./openai-compatible";

const originalFetch = globalThis.fetch;
const modelCatalog = JSON.parse(
    readFileSync(new URL("../models.json", import.meta.url), "utf-8"),
) as {
    tests: Array<{ label: string; provider: string; modelId: string }>;
};

const regionalEndpoints = {
    minimax: "https://api.minimax.io/v1/chat/completions",
    "minimax-cn": "https://api.minimaxi.com/v1/chat/completions",
};

afterEach(() => {
    globalThis.fetch = originalFetch;
});

async function expectProviderRequest(
    test: { label: string; provider: string; modelId: string },
    expectedUrl: string,
): Promise<void> {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const totals = [10, 30, 50];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init: init ?? {} });
        const promptTokens = totals[requests.length - 1];
        return new Response(JSON.stringify({ usage: { prompt_tokens: promptTokens } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;

    const result = await measureOpenAICompatible(
        test,
        { type: "api", key: "test-key" },
        "system prompt",
        [{ name: "tool", description: "Tool", input_schema: { type: "object" } }],
    );

    expect(requests.map(({ url }) => url)).toEqual([expectedUrl, expectedUrl, expectedUrl]);
    for (const { init } of requests) {
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    }
    const common = { model: test.modelId, max_tokens: 1, stream: false };
    // Exact serialized bodies also guard against unsupported thinking, effort,
    // service-tier or reasoning-split overrides being added to these probes.
    expect(requests.map(({ init }) => JSON.parse(String(init.body)))).toEqual([
        { ...common, messages: [{ role: "user", content: "x" }] },
        {
            ...common,
            messages: [
                { role: "system", content: "system prompt" },
                { role: "user", content: "x" },
            ],
        },
        {
            ...common,
            messages: [{ role: "user", content: "x" }],
            tools: [{
                type: "function",
                function: { name: "tool", description: "Tool", parameters: { type: "object" } },
            }],
        },
    ]);
    expect(result).toEqual({ systemApi: 20, toolsApi: 40 });
}

describe("measureOpenAICompatible", () => {
    for (const [provider, endpoint] of Object.entries(regionalEndpoints)) {
        it(`calibrates the Flash-first default catalog for ${provider}`, async () => {
            const tests = modelCatalog.tests.filter((test) => test.provider === provider);
            expect(tests.map((test) => test.modelId)).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"]);
            for (const test of tests) await expectProviderRequest(test, endpoint);
        });

        for (const modelId of ["MiniMax-M2.7", "custom-model"]) {
            it(`preserves the explicitly configured ${provider}/${modelId}`, async () => {
                await expectProviderRequest({ label: `${provider}/${modelId}`, provider, modelId }, endpoint);
            });
        }
    }
});
