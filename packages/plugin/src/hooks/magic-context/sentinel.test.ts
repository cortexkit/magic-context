import { describe, expect, test } from "bun:test";
import {
    replaySentinelByMessageIds,
    variantChangeBustsProviderCache,
    WHOLE_MESSAGE_PLACEHOLDER_TEXT,
} from "./sentinel";

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
        ["older Anthropic behavior remains busting", "anthropic", "claude-opus-4-1", true],
        ["unrelated OpenAI behavior remains non-busting", "openai", "gpt-5.6-sol", false],
        ["unknown identity remains non-busting", undefined, "gpt-6-astra", false],
    ] as const)("%s", (_label, providerID, modelID, expected) => {
        expect(variantChangeBustsProviderCache(providerID, modelID)).toBe(expected);
    });
});

describe("replaySentinelByMessageIds", () => {
    test("normalizes an old empty whole-message sentinel for a model that rejects empty content", () => {
        const messages = [
            {
                info: { id: "assistant-1" },
                parts: [{ type: "text", text: "" }],
            },
        ];

        replaySentinelByMessageIds(messages, new Set(["assistant-1"]), false);

        expect(messages[0]?.parts).toEqual([
            { type: "text", text: WHOLE_MESSAGE_PLACEHOLDER_TEXT },
        ]);
    });

    test("normalizes an old placeholder for an Anthropic-wire model", () => {
        const messages = [
            {
                info: { id: "assistant-1" },
                parts: [{ type: "text", text: WHOLE_MESSAGE_PLACEHOLDER_TEXT }],
            },
        ];

        replaySentinelByMessageIds(messages, new Set(["assistant-1"]), true);

        expect(messages[0]?.parts).toEqual([{ type: "text", text: "" }]);
    });
});
