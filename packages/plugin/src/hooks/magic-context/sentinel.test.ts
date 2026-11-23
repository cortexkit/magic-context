import { describe, expect, test } from "bun:test";
import { variantChangeBustsProviderCache } from "./sentinel";

describe("variantChangeBustsProviderCache", () => {
    test.each([
        ["Astra canonical xhigh -> high", "openai", "gpt-6-astra", false],
        ["Astra Codex alias xhigh -> high", "openai-codex", "gpt-6-astra", false],
        ["Astra Copilot alias xhigh -> high", "github-copilot", "gpt-6-astra", false],
        ["Fable 5.1 remains non-busting", "anthropic", "claude-fable-5-1", false],
        [
            "Fable 5.1 Bedrock alias remains non-busting",
            "bedrock",
            "anthropic.claude-fable-5-1-v1:0",
            false,
        ],
        ["Opus 5.5 effort flip is non-busting", "anthropic", "claude-opus-5-5", false],
        [
            "Opus 5.5 Bedrock behavior is unchanged",
            "amazon-bedrock",
            "us.anthropic.claude-opus-5-5-v1:0",
            true,
        ],
        ["older Anthropic behavior remains busting", "anthropic", "claude-opus-4-1", true],
        ["unlisted adjacent version still busts", "anthropic", "claude-mythos-5-21", true],
        ["unrelated OpenAI behavior remains non-busting", "openai", "gpt-5.6-sol", false],
        ["unknown identity remains non-busting", undefined, "gpt-6-astra", false],
    ] as const)("%s", (_label, providerID, modelID, expected) => {
        expect(variantChangeBustsProviderCache(providerID, modelID)).toBe(expected);
    });

    test.each([
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5-2",
        "claude-mythos-5-1",
        "claude-mythos-5-2",
    ])("%s keeps the cache on native, dated, Bedrock and Vertex IDs", (id) => {
        expect(variantChangeBustsProviderCache("anthropic", id)).toBe(false);
        expect(variantChangeBustsProviderCache("anthropic", `${id}-20261123`)).toBe(false);
        expect(variantChangeBustsProviderCache("amazon-bedrock", `us.anthropic.${id}-v1:0`)).toBe(
            false,
        );
        expect(variantChangeBustsProviderCache("google-vertex-anthropic", `${id}@20261123`)).toBe(
            false,
        );
    });
});
