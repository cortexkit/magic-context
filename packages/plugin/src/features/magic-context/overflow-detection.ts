/**
 * Provider-agnostic context-overflow error detection.
 *
 * When a provider rejects a request because the prompt exceeds its context
 * window, we want to react:
 *   1. Trigger emergency recovery (historian + aggressive drops) so the next
 *      turn fits.
 *   2. If the error message reveals the real context limit, persist it as a
 *      session-specific override so pressure math is accurate going forward.
 *
 * Pattern list adapted from OpenCode's `packages/opencode/src/provider/error.ts`
 * (BSD-licensed). We keep our own copy rather than importing OpenCode internals
 * so the plugin stays decoupled from OpenCode versioning.
 *
 * References:
 *   - OpenCode overflow detection (origin of patterns):
 *     https://github.com/sst/opencode/blob/main/packages/opencode/src/provider/error.ts
 *   - Adapted originally from:
 *     https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
 */

/**
 * Regexes that match provider-reported context-overflow errors. Keep in sync
 * with upstream OpenCode patterns — new providers can be added here as they
 * emerge.
 */
export const OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [
    /prompt is too long/i, // Anthropic
    /input is too long for requested model/i, // Amazon Bedrock
    /exceeds the context window/i, // OpenAI (Completions + Responses API)
    /input token count.*exceeds the maximum/i, // Google Gemini
    /maximum prompt length is \d+/i, // xAI (Grok)
    /reduce the length of the messages/i, // Groq
    /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
    /request entity too large/i, // HTTP 413
    /context length is only \d+ tokens/i, // vLLM
    /input length.*exceeds.*context length/i, // vLLM
    /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
    /too large for model with \d+ maximum context length/i, // Mistral
    /model_context_window_exceeded/i, // z.ai non-standard finish_reason
    /context size has been exceeded/i, // Lemonade / llama-cpp wrappers
];

/**
 * Regex set for extracting the reported context limit from error messages.
 * Each pattern's first capture group is the numeric token limit.
 *
 * Not every provider reports a number. When we cannot extract one, the caller
 * still benefits from the overflow signal even without the limit.
 */
const LIMIT_EXTRACTION_PATTERNS: ReadonlyArray<RegExp> = [
    /maximum prompt length is (\d+)/i, // xAI
    /maximum context length is (\d+) tokens?/i, // OpenRouter / DeepSeek / vLLM
    /context length is only (\d+) tokens?/i, // vLLM
    /exceeds the limit of (\d+)/i, // GitHub Copilot
    /too large for model with (\d+) maximum context length/i, // Mistral
    /context size.*(\d+) tokens?/i, // llama.cpp variants
    // "input length N exceeds the context length of M" — we want M (the limit),
    // NOT N (the actual prompt size). Explicit pattern keeps the fallback below
    // from greedily matching N.
    /exceeds? the context length of (\d+)/i, // vLLM overflow
    /max(?:imum)?.*context.*?(\d+)/i, // generic fallback — lowest priority
];

/** Minimum plausible context limit. Anything smaller is probably a match
 *  against an unrelated number in the error (e.g., error code). */
const MIN_PLAUSIBLE_LIMIT = 1024;
/** Maximum plausible context limit. Anything larger is very likely a false
 *  match against a token-count field rather than a limit. */
const MAX_PLAUSIBLE_LIMIT = 10_000_000;

export interface OverflowDetection {
    /** True if the error message matches a known overflow pattern. */
    isOverflow: boolean;
    /** Reported context limit in tokens, if extractable from the message. */
    reportedLimit?: number;
    /** The pattern that matched, useful for logging/diagnostics. */
    matchedPattern?: string;
}

/**
 * Extract an error message from any reasonable shape. Events from OpenCode can
 * deliver errors as strings, Error instances, or plain objects with `message`.
 */
export function extractErrorMessage(error: unknown): string {
    if (!error) return "";
    if (typeof error === "string") return error;
    // Check for nested provider-SDK shape BEFORE handling Error instances.
    // Some SDKs throw an Error subclass but ALSO attach the real error on
    // `error.error.message` (e.g., Anthropic SDK APIError). If we returned
    // `error.message` first we'd miss the real overflow message entirely.
    if (typeof error === "object") {
        const obj = error as Record<string, unknown>;
        const nested = obj.error as Record<string, unknown> | undefined;
        if (nested && typeof nested.message === "string" && nested.message.length > 0) {
            return nested.message;
        }
    }
    if (error instanceof Error) return error.message;
    if (typeof error === "object") {
        const obj = error as Record<string, unknown>;
        if (typeof obj.message === "string") return obj.message;
        // responseBody as fallback — providers sometimes put the real error
        // inside a JSON-stringified HTTP body.
        if (typeof obj.responseBody === "string") return obj.responseBody;
        // Try toString() as a last resort (captures error.name in most SDKs).
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
    return String(error);
}

/**
 * Detect whether an error represents a provider-side context-overflow
 * rejection, and optionally extract the reported limit.
 */
export function detectOverflow(error: unknown): OverflowDetection {
    const message = extractErrorMessage(error);
    if (!message) {
        return { isOverflow: false };
    }

    // Also treat HTTP 413 status code as overflow (Cerebras, Mistral sometimes
    // send this without a body).
    const hasStatus413 =
        /\b413\b/.test(message) && /(entity|payload|context|prompt)/i.test(message);

    let matched: RegExp | undefined;
    for (const pattern of OVERFLOW_PATTERNS) {
        if (pattern.test(message)) {
            matched = pattern;
            break;
        }
    }

    if (!matched && !hasStatus413) {
        return { isOverflow: false };
    }

    const reportedLimit = parseReportedLimit(message);

    return {
        isOverflow: true,
        reportedLimit,
        matchedPattern: matched?.source,
    };
}

/**
 * Extract the reported context-limit (in tokens) from an error message if one
 * of the known patterns matches. Returns undefined when no plausible number
 * can be extracted. Guards against false matches via plausibility clamp.
 */
export function parseReportedLimit(message: string): number | undefined {
    if (!message) return undefined;
    for (const pattern of LIMIT_EXTRACTION_PATTERNS) {
        const match = message.match(pattern);
        if (!match) continue;
        const raw = match[1];
        if (!raw) continue;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) continue;
        if (value < MIN_PLAUSIBLE_LIMIT || value > MAX_PLAUSIBLE_LIMIT) continue;
        return value;
    }
    return undefined;
}
