import { expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { measureOpenAICompatible } from "./openai-compatible";
import { measureOpenAICodex } from "./openai-codex";

it("generation-only adapters refuse paid requests without explicit opt-in", async () => {
    const urls: string[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ usage: { prompt_tokens: 10 } });
    }) as typeof fetch);
    try {
        const model = { label: "minimax/test", provider: "minimax", modelId: "test" };
        // Check the URL list first so a regression reports the actual paid request, not only a missing rejection.
        const outcome = await measureOpenAICompatible(model, { type: "api", key: "fake" }, "system", []).then(() => "accepted", (error: Error) => error.message);
        expect(urls).toEqual([]);
        expect(outcome).toContain("--allow-generation");
        await expect(measureOpenAICodex(model, { type: "oauth", access: "fake" }, "system", [])).rejects.toThrow("--allow-generation");
        expect(urls).toEqual([]);
    } finally { mock.mockRestore(); }
});

it("contains no Anthropic generation URL, token budget or usage method to re-enable", () => {
    const source = readFileSync(new URL("./anthropic.ts", import.meta.url), "utf8");
    expect(source).not.toContain("https://api.anthropic.com/v1/messages?beta=true");
    expect(source).not.toContain("max_tokens");
    expect(source).not.toContain('"usage"');
});
