import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";

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
    /maximum model length is \d+/i, // vLLM
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
interface LimitExtractionPattern {
    pattern: RegExp;
    provenance: ContextLimitProvenance;
}

const LIMIT_EXTRACTION_PATTERNS: ReadonlyArray<LimitExtractionPattern> = [
    { pattern: /maximum prompt length is (\d+)/i, provenance: "prompt_only" }, // xAI
    {
        pattern: /maximum context length is (\d+) tokens?/i,
        provenance: "combined",
    }, // OpenAI / OpenRouter / DeepSeek / vLLM
    { pattern: /maximum model length is (\d+)/i, provenance: "combined" }, // vLLM
    { pattern: /context length is only (\d+) tokens?/i, provenance: "combined" }, // vLLM
    { pattern: /exceeds the limit of (\d+)/i, provenance: "unknown" }, // GitHub Copilot
    {
        pattern: /too large for model with (\d+) maximum context length/i,
        provenance: "combined",
    }, // Mistral
    // Non-greedy digit gap: a greedy `.*` here backtracks to a single-digit
    // capture ("limit 200000 tokens" → "0"), which the plausibility clamp then
    // discards — so the limit was silently never extracted for llama.cpp-style
    // messages. Anchor the capture to the first ≥4-digit number after the phrase.
    { pattern: /context size[^0-9]{0,40}(\d{4,})\s*tokens?/i, provenance: "combined" }, // llama.cpp variants
    // "input length N exceeds the context length of M" — we want M (the limit),
    // NOT N (the actual prompt size). Explicit pattern keeps the fallback below
    // from greedily matching N.
    { pattern: /exceeds? the context length of (\d+)/i, provenance: "combined" }, // vLLM overflow
    {
        pattern: />\s*(\d+)\s*(?:tokens?\s*)?(?:maximum|max|limit)\b/i,
        provenance: "prompt_only",
    }, // Anthropic reports the accepted input ceiling, not input plus output.
    { pattern: /max(?:imum)?.*context.*?(\d+)/i, provenance: "unknown" }, // generic fallback
];

/** Minimum plausible context limit. Anything smaller is probably a match
 *  against an unrelated number in the error (e.g., error code). Kept at 1024
 *  (NOT the [20k,3M] trusted-limit band): overflow detection honors a provider
 *  EXPLICITLY stating its limit, and real small-context models exist (4096/8192
 *  local llama.cpp) — raising this floor would discard a legitimate signal. */
const MIN_PLAUSIBLE_LIMIT = 1024;
/** Maximum plausible context limit. Anything larger is very likely a false
 *  match against a token-count field rather than a limit. */
const MAX_PLAUSIBLE_LIMIT = 10_000_000;

export interface ReportedContextLimit {
    value: number;
    provenance: ContextLimitProvenance;
}

export interface ThinkingBindingMismatchDetection {
    isBindingMismatch: boolean;
    /** Stable provider message substring used for diagnostics. */
    matchedPattern?: string;
    /**
     * Diagnostics only: the provider's path to the first rejected thinking block
     * (for example `messages.1.content.0`). It indexes the provider request array
     * after the host lowered it, not host message ids, so recovery never uses it
     * to pick a message.
     */
    failingBlockPath?: string;
    /** Diagnostics only: the provider's path to the first changed prefix position. */
    firstChangedPath?: string;
}

const THINKING_BINDING_MISMATCH_PATTERN = /bound to a different conversation/i;
const THINKING_BINDING_FAILING_PATH_PATTERN = /^\s*(messages\.\d+\.content\.\d+):/;
const THINKING_BINDING_FIRST_CHANGED_PATTERN = /first at `?(messages\.\d+\.content\.\d+)`?/;

export interface OverflowDetection {
    /** True if the error message matches a known overflow pattern. */
    isOverflow: boolean;
    /** Provider-reported token count for the rejected input, when present. */
    reportedInputTokens?: number;
    /** Reported context limit in tokens, if extractable from the message. */
    reportedLimit?: number;
    /** Whether the number is a prompt-only ceiling or a combined context window. */
    reportedLimitProvenance?: ContextLimitProvenance;
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

function extractExplicitHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const seen = new Set<object>();
    const queue: object[] = [error];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        const record = current as Record<string, unknown>;
        for (const key of ["status", "statusCode", "status_code"]) {
            const value = record[key];
            if (typeof value === "number") return value;
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === "object") queue.push(value);
        }
    }
    return undefined;
}

/**
 * Classify Anthropic's thinking-prefix binding rejection (Claude Fable 5.1 and
 * Claude Opus 5.5). Only the stable phrase is matched; the surrounding prose
 * and SDK wrappers vary. The live 400 (captured in
 * docs/reports/anthropic-thinking-binding.md) carries no message id, only
 * provider request-array paths, so the result never names a host message.
 * Source: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
export function detectThinkingBindingMismatch(error: unknown): ThinkingBindingMismatchDetection {
    const message = extractErrorMessage(error);
    const explicitStatus = extractExplicitHttpStatus(error);
    if (
        (explicitStatus !== undefined && explicitStatus !== 400) ||
        !THINKING_BINDING_MISMATCH_PATTERN.test(message)
    ) {
        return { isBindingMismatch: false };
    }
    const failingBlockPath = THINKING_BINDING_FAILING_PATH_PATTERN.exec(message)?.[1];
    const firstChangedPath = THINKING_BINDING_FIRST_CHANGED_PATTERN.exec(message)?.[1];
    return {
        isBindingMismatch: true,
        matchedPattern: "bound to a different conversation",
        ...(failingBlockPath ? { failingBlockPath } : {}),
        ...(firstChangedPath ? { firstChangedPath } : {}),
    };
}

/**
 * True for the models whose signed thinking blocks Anthropic binds to the
 * request prefix: Claude Fable 5.1 and Claude Opus 5.5. Accounts created on or
 * after 2026-08-31 get a 400 on these models when anything before a replayed
 * thinking block changed. Only the first-party `anthropic` provider is covered;
 * Bedrock and Vertex enforce the same rule but are not handled here.
 */
export function isPrefixBoundThinkingModel(
    providerID: string | null | undefined,
    modelID: string | null | undefined,
): boolean {
    if (providerID?.toLowerCase() !== "anthropic" || !modelID) return false;
    return (
        isFable51ThinkingBindingModel(providerID, modelID) ||
        /(?:^|[-_.])opus[-_.]?5[-_.]5(?:$|[-_.])/i.test(modelID)
    );
}

/**
 * True only for canonical Anthropic Fable 5.1 model identifiers. Binding
 * recovery uses isPrefixBoundThinkingModel instead, which also covers Opus 5.5.
 */
export function isFable51ThinkingBindingModel(
    providerID: string | null | undefined,
    modelID: string | null | undefined,
): boolean {
    if (providerID?.toLowerCase() !== "anthropic" || !modelID) return false;
    return /(?:^|[-_.])fable[-_.]?5[-_.]1(?:$|[-_.])/i.test(modelID);
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
    const reportedInputTokens = parseReportedInputTokens(message);

    return {
        isOverflow: true,
        reportedInputTokens,
        reportedLimit: reportedLimit?.value,
        reportedLimitProvenance: reportedLimit?.provenance,
        matchedPattern: matched?.source,
    };
}

/**
 * Extract the reported context-limit (in tokens) from an error message if one
 * of the known patterns matches. Returns undefined when no plausible number
 * can be extracted. Guards against false matches via plausibility clamp.
 */
export function parseReportedInputTokens(message: string): number | undefined {
    if (!message) return undefined;
    const patterns = [
        /prompt is too long:\s*(\d+)/i,
        /input token count\s*(\d+)/i,
        /input length\s*(\d+)/i,
        /prompt was\s*(\d+)/i,
        /messages resulted in\s*(\d+)\s*tokens?/i,
    ];
    for (const pattern of patterns) {
        const raw = message.match(pattern)?.[1];
        if (!raw) continue;
        const value = Number.parseInt(raw, 10);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
}

export function parseReportedLimit(message: string): ReportedContextLimit | undefined {
    if (!message) return undefined;
    for (const { pattern, provenance } of LIMIT_EXTRACTION_PATTERNS) {
        const match = message.match(pattern);
        if (!match) continue;
        const raw = match[1];
        if (!raw) continue;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) continue;
        if (value < MIN_PLAUSIBLE_LIMIT || value > MAX_PLAUSIBLE_LIMIT) continue;
        return { value, provenance };
    }
    return undefined;
}
