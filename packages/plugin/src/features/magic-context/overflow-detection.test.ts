import { describe, expect, test } from "bun:test";
import { detectOverflow, extractErrorMessage, parseReportedLimit } from "./overflow-detection";

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
    test.each<[string, string, number | undefined]>([
        ["anthropic", "prompt is too long: 210000 tokens > 200000 maximum", undefined],
        ["bedrock", "Input is too long for requested model.", undefined],
        ["openai", "This model's maximum context length is 128000 tokens", 128000],
        [
            "gemini",
            "Input token count 1234567 exceeds the maximum number of tokens allowed",
            undefined,
        ],
        ["xai", "the maximum prompt length is 256000 tokens but the prompt was 300000", 256000],
        ["groq", "Please reduce the length of the messages or completion", undefined],
        ["openrouter", "the maximum context length is 32768 tokens", 32768],
        ["copilot", "Prompt exceeds the limit of 64000 tokens", 64000],
        ["llamacpp", "Prompt exceeds the available context size", undefined],
        ["lmstudio", "Prompt greater than the context length of the model", undefined],
        ["minimax", "context window exceeds limit", undefined],
        ["moonshot", "exceeded model token limit of 131072", undefined],
        ["generic", "context_length_exceeded", undefined],
        ["http413", "413 request entity too large", undefined],
        ["vllm", "context length is only 4096 tokens, prompt was 5000", 4096],
        ["vllm2", "input length 10000 exceeds the context length of 8000", 8000],
        ["ollama", "prompt too long; exceeded max context length", undefined],
        ["mistral", "Prompt too large for model with 32768 maximum context length", 32768],
        ["zai", "model_context_window_exceeded", undefined],
        ["lemonade", "Context size has been exceeded", undefined],
    ])("%s pattern matches overflow", (_provider, message, expectedLimit) => {
        const detection = detectOverflow(message);
        expect(detection.isOverflow).toBe(true);
        if (expectedLimit !== undefined) {
            expect(detection.reportedLimit).toBe(expectedLimit);
        }
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
    });

    test("returns matchedPattern for diagnostics", () => {
        const detection = detectOverflow("prompt is too long: 210000 > 200000");
        expect(detection.isOverflow).toBe(true);
        expect(detection.matchedPattern).toBeDefined();
    });
});

describe("overflow-detection / parseReportedLimit", () => {
    test("extracts from 'maximum prompt length' (xAI)", () => {
        expect(parseReportedLimit("the maximum prompt length is 256000 tokens")).toBe(256000);
    });

    test("extracts from 'maximum context length' (OpenRouter/DeepSeek)", () => {
        expect(parseReportedLimit("maximum context length is 32768 tokens")).toBe(32768);
    });

    test("extracts from 'context length is only' (vLLM)", () => {
        expect(parseReportedLimit("context length is only 4096 tokens")).toBe(4096);
    });

    test("extracts from 'exceeds the limit of' (Copilot)", () => {
        expect(parseReportedLimit("Prompt exceeds the limit of 64000 tokens")).toBe(64000);
    });

    test("extracts from 'too large for model with' (Mistral)", () => {
        expect(parseReportedLimit("Too large for model with 32768 maximum context length")).toBe(
            32768,
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
        expect(parseReportedLimit(msg)).toBe(128000);
    });
});
