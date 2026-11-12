import { afterEach, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { credentialsFromEnv, PROVIDER_VARIABLES } from "./credentials";
import { measureOne, type ModelTest, parseArgs } from "./index";

let mock: ReturnType<typeof spyOn> | undefined;
afterEach(() => mock?.mockRestore());
const models = (JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8")) as { tests: ModelTest[] }).tests;
const fakeEnv = Object.fromEntries(Object.values(PROVIDER_VARIABLES).filter((v) => !v.includes(" or ")).map((v) => [v, "fake-secret"]));
const auth = credentialsFromEnv({ ...fakeEnv, ANTHROPIC_OAUTH_TOKEN: "fake-oauth" });
const isGeneration = (url: string) => /\/(chat\/completions|responses|messages)(\?|$)/.test(url);

function mockCounts(urls: string[]) {
    mock = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("chatgpt.com")) return new Response('data: {"usage":{"input_tokens":10}}\n\n');
        return Response.json({ input_tokens: 10, totalTokens: 10, token_ids: [1, 2], usage: { prompt_tokens: 10 }, data: { total_tokens: 10 } });
    }) as typeof fetch);
}

it("defaults every catalog adapter to counting only, never a generation endpoint", async () => {
    const urls: string[] = [];
    mockCounts(urls);
    for (const model of models.filter((m) => m.provider !== "deepseek")) {
        const start = urls.length;
        const result = await measureOne(model, auth, "system", [], { docs: "prose" });
        if (result.method === "usage") {
            expect(result.error).toContain("pass --allow-generation");
            expect(urls.length).toBe(start);
        }
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some(isGeneration)).toBe(false);
});

it("allows only generation-only models to generate when explicitly requested, never Anthropic", async () => {
    const urls: string[] = [];
    mockCounts(urls);
    for (const model of models.filter((m) => m.provider !== "deepseek")) {
        const start = urls.length;
        const result = await measureOne(model, auth, "system", [], { docs: "prose" }, true);
        expect(result.error).toBeNull();
        expect(urls.slice(start).some(isGeneration)).toBe(result.method === "usage");
    }
    expect(parseArgs([]).allowGeneration).toBe(false);
    expect(parseArgs(["--allow-generation"]).allowGeneration).toBe(true);
});

it("refuses conflicting Anthropic variables without revealing their values", () => {
    expect(() => credentialsFromEnv({ ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_OAUTH_TOKEN: "fake-token" })).toThrow("both are set");
    expect(credentialsFromEnv({ ANTHROPIC_API_KEY: " fake-key " }).anthropic).toEqual({ type: "api", key: "fake-key" });
    expect(credentialsFromEnv({ ANTHROPIC_OAUTH_TOKEN: " fake-token " }).anthropic).toEqual({ type: "oauth", access: "fake-token" });
});

it("treats auth failures as fatal and other HTTP failures as model-local for every network provider", async () => {
    const representatives = new Map(models.filter((m) => m.provider !== "deepseek").map((m) => [m.label.startsWith("openai-codex/") ? "openai-codex" : m.provider, m]));
    for (const status of [401, 403, 404, 500]) {
        for (const [provider, model] of representatives) {
            let requests = 0;
            mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request, _init?: RequestInit) => {
                requests++;
                return Response.json({ error: { message: "secret-response-body" } }, { status, headers: { authorization: "secret-response-header" } });
            }) as typeof fetch);
            try {
                if (status === 404 || status === 500) {
                    const result = await measureOne(model, auth, "system", [], {}, true);
                    if (status === 404) expect(result.error).toBe("model not found for this credential");
                    else expect(result.error).toContain("HTTP 500");
                } else {
                    await expect(measureOne(model, auth, "system", [], {}, true)).rejects.toThrow(`${provider} ${model.modelId} HTTP ${status}`);
                }
                expect(requests).toBe(1);
            } finally { mock.mockRestore(); }
        }
    }
});
