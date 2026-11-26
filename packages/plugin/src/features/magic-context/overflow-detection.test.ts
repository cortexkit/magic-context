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

    test("extracts the provider plan cap and rejected input from the reported error", () => {
        const message =
            "Your plan allows a context of up to 500,000 tokens, this request has an estimated 502,574\n" +
            "(maximum context length exceeded). Shorten the history or start a new session.";
        expect(detectOverflow(message)).toMatchObject({
            isOverflow: true,
            reportedLimit: 500_000,
            reportedInputTokens: 502_574,
        });
    });

    test("keeps the cap separate when the input estimate comes first", () => {
        expect(
            detectOverflow(
                "Maximum context length exceeded: this request has an estimated 502,574. Up to 500,000 tokens are allowed.",
            ),
        ).toMatchObject({ isOverflow: true, reportedLimit: 500_000, reportedInputTokens: 502_574 });
    });

    test("does not learn a cap from the rejected input estimate alone", () => {
        expect(
            detectOverflow(
                "Maximum context length exceeded: this request has an estimated 502,574",
            ),
        ).toMatchObject({
            isOverflow: true,
            reportedLimit: undefined,
            reportedInputTokens: 502_574,
        });
        expect(
            detectOverflow(
                "Maximum context length exceeded: this request has an estimated up to 502,574 tokens",
            ),
        ).toMatchObject({ isOverflow: true, reportedLimit: undefined });
    });

    test.each([
        ["1,048,576", "1,260,773", 1_048_576, 1_260_773],
        ["500_000", "502_574", 500_000, 502_574],
        ["500 000", "502 574", 500_000, 502_574],
        ["500\u202f000", "502\u202f574", 500_000, 502_574],
        ["500.000", "502.574", 500_000, 502_574],
    ])("parses the grouped limit %s and input %s in explicit token counts", (cap, input, limit, tokens) => {
        expect(
            detectOverflow(
                `Maximum context length is ${cap} tokens. Messages resulted in ${input} tokens.`,
            ),
        ).toMatchObject({ isOverflow: true, reportedLimit: limit, reportedInputTokens: tokens });
    });

    test.each([
        "1.5",
        "128000.5",
        "500,00",
        "1_048,576",
        "500,,000",
        "500  000",
        "500_000_",
    ])("rejects malformed counts without reading their prefix: %s", (count) => {
        expect(parseReportedInputTokens(`prompt is too long: ${count} tokens`)).toBeUndefined();
        expect(parseReportedLimit(`maximum prompt length is ${count} tokens`)).toBeUndefined();
    });

    test("does not treat a dot as grouping without an explicit token unit", () => {
        expect(parseReportedInputTokens("this request has an estimated 500.000")).toBeUndefined();
        expect(parseReportedLimit("maximum prompt length is 500.000")).toBeUndefined();
    });

    test("extracts grouped LiteLLM counts without an overflow class name", () => {
        expect(
            detectOverflow(
                "The input (626,827 tokens) is longer than the model's context length (262,144 tokens).",
            ),
        ).toMatchObject({ isOverflow: true, reportedLimit: 262_144, reportedInputTokens: 626_827 });
    });

    test("detects LiteLLM HTTP 400 overflow and separates input from the combined limit", () => {
        const message =
            "litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: OpenAIException - The input (626827 tokens) is longer than the model's context length (262144 tokens).\n" +
            "Set 'context_window_fallback' - https://docs.litellm.ai/docs/routing#fallbacks. Received Model Group=qwen3.8-flash-next\n" +
            "Available Model Group Fallbacks=None";
        expect(detectOverflow({ status: 400, message })).toMatchObject({
            isOverflow: true,
            reportedInputTokens: 626827,
            reportedLimit: 262144,
            reportedLimitProvenance: "combined",
        });
    });

    test("detects LiteLLM overflow class and input-length wording independently", () => {
        expect(
            detectOverflow("litellm.ContextWindowExceededError: request rejected"),
        ).toMatchObject({
            isOverflow: true,
            reportedInputTokens: undefined,
            reportedLimit: undefined,
        });
        expect(
            detectOverflow(
                "The input (626827 tokens) is longer than the model's context length (262144 tokens).",
            ),
        ).toMatchObject({
            isOverflow: true,
            reportedInputTokens: 626827,
            reportedLimit: 262144,
            reportedLimitProvenance: "combined",
        });
    });

    test.each([
        // Issue 860: the text LiteLLM returned to the reporter, quoted from the issue.
        "input (485974 tokens) is longer than the model's context length (262144)",
        // The same wording inside LiteLLM's HTTP 400 message, without the class name.
        "litellm.BadRequestError: OpenAIException - The input (485974 tokens) is longer than the model's context length (262144).",
    ])("detects LiteLLM overflow without the limit's unit and parses both counts: %s", (message) => {
        expect(detectOverflow({ status: 400, message })).toMatchObject({
            isOverflow: true,
            reportedInputTokens: 485_974,
            reportedLimit: 262_144,
            reportedLimitProvenance: "combined",
        });
        expect(parseReportedInputTokens(message)).toBe(485_974);
        expect(parseReportedLimit(message)?.value).toBe(262_144);
    });

    test.each([
        1_260_773, 1_260_808,
    ])("extracts DeepSeek rejected input %d without counting completion tokens", (input) => {
        const message =
            "This model's maximum context length is 1048576 tokens.\n" +
            `However, you requested ${input + 131072} tokens\n` +
            `(${input} in the messages, 131072 in the completion).\n` +
            "Please reduce the length of the messages or completion.";
        expect(detectOverflow(message)).toMatchObject({
            isOverflow: true,
            reportedInputTokens: input,
            reportedLimit: 1048576,
            reportedLimitProvenance: "combined",
        });
        expect(parseReportedInputTokens(message)).toBe(input);
    });

    test.each([
        "litellm.BadRequestError: Invalid API key",
        "litellm.ContextWindowExceededErrorHandler: failed to configure fallback",
        "litellm.NotContextWindowExceededError: upstream unavailable",
        "The input (626827 tokens) could not be sent: connection reset",
        "Invalid API key; model's context length (262144 tokens)",
        "The input (626827 tokens) is longer than the configured log limit (262144 tokens)",
        "The input (626827 tokens) is longer than the configured log limit (262144)",
        "input (485974 tokens) is longer than expected; model's context length (262144)",
        "BadRequestError: expected an image in the messages, not text in the completion",
        "BadRequestError: invalid schema (1260773 in the messages, 131072 in the completion)",
    ])("does not classify ordinary provider errors as overflow: %s", (message) => {
        expect(detectOverflow({ status: 400, message })).toEqual({ isOverflow: false });
    });

    test("the unitless LiteLLM wording needs an input larger than the limit", () => {
        // Counts that contradict an overflow are not one, even in the exact wording.
        expect(
            detectOverflow({
                status: 400,
                message: "input (19 tokens) is longer than the model's context length (262144)",
            }),
        ).toEqual({ isOverflow: false });
    });

    test("the unitless LiteLLM wording quoted by an authentication failure is not an overflow", () => {
        const message =
            "Invalid API key; rejected example body: input (485974 tokens) is longer than the model's context length (262144)";
        expect(detectOverflow({ status: 401, message })).toEqual({ isOverflow: false });
        // The failure's own words decide when the status is not given.
        expect(detectOverflow({ message })).toEqual({ isOverflow: false });
    });

    // Probes of the unitless wording inside other errors. The status is read
    // from status fields at every nesting level, never from the text.
    const BARE = "input (485974 tokens) is longer than the model's context length (262144)";
    test.each<[string, unknown, boolean]>([
        [
            "an authentication status nested under an outer 400",
            { status: 400, error: { status: 401, message: BARE } },
            false,
        ],
        [
            "a permission status nested under an outer 400",
            { statusCode: 400, data: { error: { statusCode: 403, message: BARE } } },
            false,
        ],
        [
            "an authentication message without an authentication status",
            { status: 400, message: `Incorrect API key provided; example: ${BARE}` },
            false,
        ],
        [
            "an authentication error type with no status",
            { type: "authentication_error", message: BARE },
            false,
        ],
        [
            "a permission error type nested in the body",
            { status: 400, error: { type: "permission_error", message: BARE } },
            false,
        ],
        [
            "a schema error quoting the sentence (422)",
            { status: 422, message: `Unexpected examples[0] string: ${BARE}` },
            false,
        ],
        [
            "a quota error quoting the sentence (429)",
            { status: 429, message: `quota exceeded: ${BARE}` },
            false,
        ],
        [
            "an input equal to the limit",
            { status: 400, message: BARE.replace("485974", "262144") },
            false,
        ],
        [
            "a grouped input count that starts with 401",
            { status: 400, message: BARE.replace("485974", "401,974") },
            true,
        ],
        [
            "a grouped input count that starts with 403",
            { status: 400, message: BARE.replace("485974", "403 974") },
            true,
        ],
        ["the bare sentence in an outer 400", { status: 400, message: BARE }, true],
        [
            "the bare sentence nested under an outer 400",
            { statusCode: 400, data: { message: BARE } },
            true,
        ],
    ])("unitless LiteLLM wording: %s", (_name, error, isOverflow) => {
        expect(detectOverflow(error).isOverflow).toBe(isOverflow);
    });

    test.each<[string, unknown, boolean]>([
        // These match the release's older patterns before the unitless check
        // runs; the authentication guard covers only the unitless wording.
        [
            "an authentication status quoting the LiteLLM class name",
            { status: 401, message: `ContextWindowExceededError: ${BARE}` },
            true,
        ],
        [
            "an authentication status quoting the wording with its unit",
            { status: 401, message: BARE.replace("262144)", "262144 tokens)") },
            true,
        ],
        // Wordings no provider has been seen to send; not recognised.
        [
            "another wording of the same refusal",
            {
                status: 400,
                message:
                    "Model has a context window of 262144 tokens, but received 485974 input tokens.",
            },
            false,
        ],
        [
            "the wording with a typographic apostrophe",
            { status: 400, message: BARE.replace("model's", "model\u2019s") },
            false,
        ],
        // Still recognised, as in the release.
        [
            "the OpenAI wording",
            {
                status: 400,
                message:
                    "This model maximum context length is 262144 tokens. However, your messages resulted in 485974 tokens.",
            },
            true,
        ],
    ])("pin, as in the release: %s", (_name, error, isOverflow) => {
        expect(detectOverflow(error).isOverflow).toBe(isOverflow);
    });

    test("a grouped input count is parsed whole", () => {
        expect(
            detectOverflow({ status: 400, message: BARE.replace("485974", "401,974") }),
        ).toMatchObject({
            isOverflow: true,
            reportedInputTokens: 401_974,
            reportedLimit: 262_144,
        });
    });

    test("does not extract LiteLLM counts from ordinary errors or incomplete DeepSeek fields", () => {
        expect(
            parseReportedLimit("Invalid API key; model's context length (262144 tokens)"),
        ).toBeUndefined();
        expect(
            parseReportedInputTokens(
                "The input (626827 tokens) could not be sent: connection reset",
            ),
        ).toBeUndefined();
        expect(parseReportedInputTokens("131072 in the completion")).toBeUndefined();
        expect(
            parseReportedInputTokens("1260773 in the messages field is invalid"),
        ).toBeUndefined();
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
    // and Claude Opus 5.5.
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
                // Claude Fable 5.2 and Claude Mythos 5.1/5.2 on the Claude API,
                // Vertex `@date`, Bedrock and OpenRouter-style ids.
                "claude-fable-5-2",
                "claude-fable-5-2@20261109",
                "anthropic.claude-fable-5-2",
                "us.anthropic.claude-fable-5-2-v1:0",
                "anthropic/claude-fable-5.2",
                "claude-mythos-5-1",
                "claude-mythos-5-1@20261001",
                "us.anthropic.claude-mythos-5-1-v1:0",
                "anthropic/claude-mythos-5.1",
                "claude-mythos-5-2",
                "claude-mythos-5-2@20261109",
                "us.anthropic.claude-mythos-5-2-v1:0",
                "anthropic/claude-mythos-5.2",
            ]) {
                expect(isPrefixBoundThinkingModel(providerID, modelID)).toBe(true);
            }
            for (const modelID of [
                "fable-5-0",
                "claude-fable-5-5",
                "claude-fable-5-20",
                "claude-mythos-5",
                "claude-mythos-5-0",
                "claude-mythos-5-21",
                "notmythos-5-2",
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
