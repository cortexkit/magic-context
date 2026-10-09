import { describe, expect, test } from "bun:test";
import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";
import {
    detectOverflow,
    detectThinkingBindingMismatch,
    extractErrorMessage,
    isPrefixBoundThinkingModel,
    parseReportedInputTokens,
    parseReportedLimit,
} from "./overflow-detection";

describe("overflow-detection / extractErrorMessage", () => {
    test("returns message from Error instance", () => {
        expect(extractErrorMessage(new Error("prompt is too long"))).toBe("prompt is too long");
    });

    test("returns raw string", () => {
        expect(extractErrorMessage("context length exceeded")).toBe("context length exceeded");
    });

    test("unwraps nested provider SDK error (error.error.message)", () => {
        const nested = {
            error: { message: "Input token count 200000 exceeds the maximum of 128000" },
        };
        expect(extractErrorMessage(nested)).toContain("exceeds the maximum");
    });

    test("reads top-level message property", () => {
        expect(extractErrorMessage({ message: "prompt is too long" })).toBe("prompt is too long");
    });

    test("reads responseBody fallback", () => {
        expect(extractErrorMessage({ responseBody: "413 payload too large" })).toBe(
            "413 payload too large",
        );
    });

    test("returns empty string for null / undefined", () => {
        expect(extractErrorMessage(null)).toBe("");
        expect(extractErrorMessage(undefined)).toBe("");
    });
});

describe("overflow-detection / detectOverflow", () => {
    // Each sample is a real-world error message from the provider listed.
    // These assertions lock in coverage across the full OpenCode pattern set so
    // future regex edits can't silently regress provider support.
    test.each<[string, string, number | undefined, ContextLimitProvenance | undefined]>([
        ["anthropic", "prompt is too long: 210000 tokens > 200000 maximum", 200000, "prompt_only"],
        ["bedrock", "Input is too long for requested model.", undefined, undefined],
        ["openai", "This model's maximum context length is 128000 tokens", 128000, "combined"],
        [
            "gemini",
            "Input token count 1234567 exceeds the maximum number of tokens allowed",
            undefined,
            undefined,
        ],
        [
            "gemini-parenthesized",
            "The input token count (123456) exceeds the maximum number of tokens allowed (100000).",
            100000,
            "prompt_only",
        ],
        [
            "xai",
            "the maximum prompt length is 256000 tokens but the prompt was 300000",
            256000,
            "prompt_only",
        ],
        ["groq", "Please reduce the length of the messages or completion", undefined, undefined],
        ["openrouter", "the maximum context length is 32768 tokens", 32768, "combined"],
        ["copilot", "Prompt exceeds the limit of 64000 tokens", 64000, "unknown"],
        ["llamacpp", "Prompt exceeds the available context size", undefined, undefined],
        ["lmstudio", "Prompt greater than the context length of the model", undefined, undefined],
        ["minimax", "context window exceeds limit", undefined, undefined],
        ["moonshot", "exceeded model token limit of 131072", undefined, undefined],
        ["generic", "context_length_exceeded", undefined, undefined],
        ["http413", "413 request entity too large", undefined, undefined],
        ["vllm", "context length is only 4096 tokens, prompt was 5000", 4096, "combined"],
        ["vllm-model", "maximum model length is 8192 tokens", 8192, "combined"],
        ["vllm2", "input length 10000 exceeds the context length of 8000", 8000, "combined"],
        ["ollama", "prompt too long; exceeded max context length", undefined, undefined],
        [
            "mistral",
            "Prompt too large for model with 32768 maximum context length",
            32768,
            "combined",
        ],
        ["zai", "model_context_window_exceeded", undefined, undefined],
        ["lemonade", "Context size has been exceeded", undefined, undefined],
        [
            "ninfer",
            "AI_APICallError: prepared prompt exceeds Engine max_context 262144",
            262144,
            "unknown",
        ],
    ])("%s pattern matches overflow", (_provider, message, expectedLimit, expectedProvenance) => {
        const detection = detectOverflow(message);
        expect(detection.isOverflow).toBe(true);
        expect(detection.reportedLimit).toBe(expectedLimit);
        expect(detection.reportedLimitProvenance).toBe(expectedProvenance);
    });

    test("returns not-overflow for unrelated errors", () => {
        expect(detectOverflow("Network error").isOverflow).toBe(false);
        expect(detectOverflow("Rate limit exceeded").isOverflow).toBe(false);
        expect(detectOverflow("Invalid API key").isOverflow).toBe(false);
        expect(detectOverflow("").isOverflow).toBe(false);
        expect(detectOverflow(null).isOverflow).toBe(false);
    });

    test("extracts limit through Error + nested SDK shapes end-to-end", () => {
        const nested = new Error("");
        (nested as Error & { error?: unknown }).error = {
            message: "This model's maximum context length is 128000 tokens",
        };
        const detection = detectOverflow(nested);
        expect(detection.isOverflow).toBe(true);
        expect(detection.reportedLimit).toBe(128000);
        expect(detection.reportedLimitProvenance).toBe("combined");
    });

    test("extracts provider-reported input mass separately from the accepted limit", () => {
        expect(detectOverflow("prompt is too long: 1091002").reportedInputTokens).toBe(1_091_002);
        expect(
            detectOverflow("prompt is too long: 1091002 tokens > 1048576 maximum"),
        ).toMatchObject({
            reportedInputTokens: 1_091_002,
            reportedLimit: 1_048_576,
        });
        expect(
            detectOverflow("input length 1091002 exceeds the context length of 1048576"),
        ).toMatchObject({
            reportedInputTokens: 1_091_002,
            reportedLimit: 1_048_576,
        });
    });

    test("returns matchedPattern for diagnostics", () => {
        const detection = detectOverflow("prompt is too long: 210000 > 200000");
        expect(detection.isOverflow).toBe(true);
        expect(detection.matchedPattern).toBeDefined();
    });
});

describe("overflow-detection / detectThinkingBindingMismatch", () => {
    test("matches the documented 400 shape", () => {
        const detection = detectThinkingBindingMismatch({
            status: 400,
            error: {
                type: "invalid_request_error",
                message:
                    'messages.4.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
            },
        });

        expect(detection).toEqual({
            isBindingMismatch: true,
            matchedPattern: "bound to a different conversation",
            failingBlockPath: "messages.4.content.0",
        });
    });

    // Captured on 2026-09-26; the body was byte-identical for Claude Fable 5.1
    // and Claude Opus 5.5 (docs/reports/anthropic-thinking-binding.md section 2).
    // It carries no message id of any kind, only lowered wire-array paths.
    const LIVE_BINDING_400_BODY = {
        type: "error",
        error: {
            type: "invalid_request_error",
            message:
                'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content before this block differs from when it was created, first at `messages.0.content.0`.',
        },
        request_id: "req_011CfSakFxfwQ2vmA7q6iK45",
    };

    test("reads only the wire paths from the live 400 body, never a host message id", () => {
        expect(detectThinkingBindingMismatch({ status: 400, ...LIVE_BINDING_400_BODY })).toEqual({
            isBindingMismatch: true,
            matchedPattern: "bound to a different conversation",
            failingBlockPath: "messages.1.content.0",
            firstChangedPath: "messages.0.content.0",
        });
        // A message_id field is not part of the API contract; it must not leak
        // into the detection as a recovery target.
        const withForeignId = detectThinkingBindingMismatch({
            ...LIVE_BINDING_400_BODY,
            error: { ...LIVE_BINDING_400_BODY.error, message_id: "assistant-x" },
        }) as Record<string, unknown>;
        expect(withForeignId.messageId).toBeUndefined();
        expect(withForeignId.isBindingMismatch).toBe(true);
    });

    test("does not treat the missing-beta block_binding 400 as a binding mismatch", () => {
        expect(
            detectThinkingBindingMismatch({
                status: 400,
                error: {
                    type: "invalid_request_error",
                    message: "thinking.adaptive.block_binding: Extra inputs are not permitted",
                },
            }).isBindingMismatch,
        ).toBe(false);
    });

    test("tolerates provider prefix and suffix drift but rejects unrelated 400s", () => {
        expect(
            detectThinkingBindingMismatch(
                "invalid_request_error: thinking block is BOUND TO A DIFFERENT CONVERSATION; retry without it",
            ).isBindingMismatch,
        ).toBe(true);
        expect(
            detectThinkingBindingMismatch({
                status: 400,
                message: "thinking block signature is invalid",
            }).isBindingMismatch,
        ).toBe(false);
        expect(
            detectThinkingBindingMismatch({
                status: 500,
                message: "The block is bound to a different conversation",
            }).isBindingMismatch,
        ).toBe(false);
    });
});

describe("overflow-detection / isPrefixBoundThinkingModel", () => {
    test("matches prefix-bound families and route variants independently of provider", () => {
        for (const providerID of [
            "anthropic",
            "ANTHROPIC",
            "amazon-bedrock",
            "google-vertex-anthropic",
            "vertex-eu-anthropic",
            "custom-route",
            "openrouter",
            undefined,
            null,
            "",
        ]) {
            for (const modelID of [
                "claude-fable-5-1",
                "fable-5-1-20260831",
                "claude-fable-5.1-latest",
                "claude-opus-5-5",
                "claude-opus-5.5",
                "claude-opus-5-5-20260901",
                "claude-sonnet-5-5",
                "SONNET_5_5_latest",
                "claude-sonnet-5.5-20260930",
                "anthropic.claude-opus-5-5-v1:0",
                "us.anthropic.claude-sonnet-5-5-v1:0",
                "anthropic.claude-fable-5-1-v1:0",
                "claude-sonnet-5-5@20260930",
                "claude-haiku-5-5",
                "claude-haiku-5.5-20261001",
                "us.anthropic.claude-haiku-5-5-v1:0",
                "claude-haiku-5-5@20261001",
            ]) {
                expect(isPrefixBoundThinkingModel(providerID, modelID)).toBe(true);
            }
            for (const modelID of [
                "fable-5-0",
                "claude-fable-5-5",
                "claude-opus-5",
                "claude-opus-5-4",
                "claude-opus-4-5",
                "claude-sonnet-5-4",
                "claude-sonnet-5-50",
                "claude-sonnet-15-5",
                "notsonnet-5-5",
                "claude-haiku-5",
                "claude-haiku-4-5",
                "claude-haiku-5-50",
                "gpt-6-astra",
                "",
                null,
                undefined,
            ]) {
                expect(isPrefixBoundThinkingModel(providerID, modelID)).toBe(false);
            }
        }
    });
});

describe("overflow-detection / parseReportedLimit", () => {
    test("extracts from 'maximum prompt length' (xAI)", () => {
        expect(
            parseReportedLimit(
                "The input token count (123456) exceeds the maximum number of tokens allowed (100000).",
            ),
        ).toEqual({ value: 100000, provenance: "prompt_only" });
        expect(
            parseReportedInputTokens(
                "The input token count (123456) exceeds the maximum number of tokens allowed (100000).",
            ),
        ).toBe(123456);
        expect(parseReportedInputTokens("Input token count 1234567 exceeds the maximum")).toBe(
            1234567,
        );
        expect(parseReportedLimit("the maximum prompt length is 256000 tokens")).toEqual({
            value: 256000,
            provenance: "prompt_only",
        });
    });

    test("extracts from 'maximum context length' (OpenRouter/DeepSeek)", () => {
        expect(parseReportedLimit("maximum context length is 32768 tokens")).toEqual({
            value: 32768,
            provenance: "combined",
        });
    });

    test("extracts from 'context length is only' (vLLM)", () => {
        expect(parseReportedLimit("context length is only 4096 tokens")).toEqual({
            value: 4096,
            provenance: "combined",
        });
    });

    test("extracts from 'exceeds the limit of' (Copilot)", () => {
        expect(parseReportedLimit("Prompt exceeds the limit of 64000 tokens")).toEqual({
            value: 64000,
            provenance: "unknown",
        });
    });

    test("extracts Anthropic-style '> N maximum|max|limit' caps", () => {
        for (const suffix of ["maximum", "max", "limit"]) {
            expect(
                parseReportedLimit(`prompt is too long: 210000 tokens > 200000 ${suffix}`),
            ).toEqual({ value: 200000, provenance: "prompt_only" });
        }
    });

    test("extracts from 'too large for model with' (Mistral)", () => {
        expect(parseReportedLimit("Too large for model with 32768 maximum context length")).toEqual(
            { value: 32768, provenance: "combined" },
        );
    });

    test("rejects implausibly small numbers (< 1024)", () => {
        // Error codes like "413" should not be mistaken for context limits
        expect(parseReportedLimit("maximum context length is 100 tokens")).toBeUndefined();
    });

    test("rejects implausibly large numbers (> 10M)", () => {
        expect(parseReportedLimit("maximum context length is 999999999 tokens")).toBeUndefined();
    });

    test("returns undefined when no pattern matches", () => {
        expect(parseReportedLimit("Random error message")).toBeUndefined();
        expect(parseReportedLimit("")).toBeUndefined();
    });

    test("returns first plausible match when multiple numbers present", () => {
        // Prefer 'maximum context length is N' over the fallback 'max.*context.*N' pattern
        const msg = "maximum context length is 128000 tokens (limit 999)";
        expect(parseReportedLimit(msg)).toEqual({ value: 128000, provenance: "combined" });
    });
});

describe("llama.cpp context-size limit extraction", () => {
    // The old greedy pattern (/context size.*(\d+)/) backtracked to a
    // single-digit capture that the plausibility clamp discarded, so these
    // messages detected overflow but silently lost the limit value.
    test("extracts the limit from llama.cpp-style messages", () => {
        expect(
            parseReportedLimit(
                "context size has been exceeded: limit 200000 tokens, you sent 214311",
            ),
        ).toMatchObject({ value: 200000, provenance: "combined" });
        expect(parseReportedLimit("context size exceeded: 128000 tokens maximum")).toMatchObject({
            value: 128000,
            provenance: "combined",
        });
    });

    test("does not capture a number more than 40 chars past the phrase", () => {
        // Guards the anchor: distant numbers (e.g. request ids) must not bind.
        expect(
            parseReportedLimit(
                "context size problem occurred while handling the request submitted at position 99999999 tokens",
            ),
        ).toBeUndefined();
    });
});
