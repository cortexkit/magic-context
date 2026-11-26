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

// Capture the whole number, including malformed grouping, so it cannot be read
// as a shorter integer. A dot can group digits only before an explicit token unit.
const TOKEN_COUNT = String.raw`(?<![\d+_-])(?:\d+(?:[,_ .\u202f]+\d+)*(?=\s*tokens?\b)|\d+(?:[,_ \u202f]+\d+)*)(?!\w|[,_\s.]+\d)`;
const ESTIMATED_REQUEST = String.raw`\bthis request has an estimated\b`;

function overflowPattern(strings: TemplateStringsArray, ...fragments: string[]): RegExp {
    return new RegExp(String.raw(strings, ...fragments), "i");
}

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
    overflowPattern`maximum context length is ${TOKEN_COUNT} tokens?\b`, // OpenRouter, DeepSeek, vLLM
    /maximum model length is \d+/i, // vLLM
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
    /request entity too large/i, // HTTP 413
    overflowPattern`context length is only ${TOKEN_COUNT} tokens?\b`, // vLLM
    /input length.*exceeds.*context length/i, // vLLM
    /\bContextWindowExceededError\b/i, // LiteLLM
    overflowPattern`\binput \(${TOKEN_COUNT} tokens?\) is longer than the model's context length \(${TOKEN_COUNT} tokens?\)`, // LiteLLM
    /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow
    overflowPattern`too large for model with ${TOKEN_COUNT} maximum context length`, // Mistral
    /model_context_window_exceeded/i, // z.ai non-standard finish_reason
    /context size has been exceeded/i, // Lemonade / llama-cpp wrappers
    /prepared prompt exceeds engine max_context/i, // Matches local-engine errors phrased as “prepared prompt exceeds engine max_context”.
    /prompt exceeds (?:the )?.{0,32}\bmax_context\b/i, // Other local engines
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
    {
        pattern: overflowPattern`maximum prompt length is (${TOKEN_COUNT})`,
        provenance: "prompt_only",
    }, // xAI
    {
        pattern: overflowPattern`maximum context length is (${TOKEN_COUNT}) tokens?\b`,
        provenance: "combined",
    }, // OpenAI / OpenRouter / DeepSeek / vLLM
    { pattern: overflowPattern`maximum model length is (${TOKEN_COUNT})`, provenance: "combined" }, // vLLM
    {
        pattern: overflowPattern`context length is only (${TOKEN_COUNT}) tokens?\b`,
        provenance: "combined",
    }, // vLLM
    { pattern: overflowPattern`exceeds the limit of (${TOKEN_COUNT})`, provenance: "unknown" }, // GitHub Copilot
    {
        pattern: overflowPattern`too large for model with (${TOKEN_COUNT}) maximum context length`,
        provenance: "combined",
    }, // Mistral
    // Stop at the first number rather than backtracking into it or skipping to
    // an unrelated number later in the message.
    {
        pattern: overflowPattern`context size[^0-9]{0,40}(${TOKEN_COUNT})\s*tokens?\b`,
        provenance: "combined",
    }, // llama.cpp variants
    // "input length N exceeds the context length of M" — we want M (the limit),
    // NOT N (the actual prompt size). Explicit pattern keeps the fallback below
    // from greedily matching N.
    {
        pattern: overflowPattern`exceeds? the context length of (${TOKEN_COUNT})`,
        provenance: "combined",
    }, // vLLM overflow
    {
        pattern: overflowPattern`\binput \(${TOKEN_COUNT} tokens?\) is longer than the model's context length \((${TOKEN_COUNT})(?: tokens?)?\)`,
        provenance: "combined",
    }, // LiteLLM
    {
        pattern: overflowPattern`>\s*(${TOKEN_COUNT})\s*(?:tokens?\s*)?(?:maximum|max|limit)\b`,
        provenance: "prompt_only",
    }, // Anthropic reports the accepted input ceiling, not input plus output.
    // Gemini puts both numbers in parentheses: "input token count (N) exceeds the
    // maximum number of tokens allowed (M)". M is the input ceiling.
    {
        pattern: overflowPattern`maximum number of tokens allowed\s*\(?\s*(${TOKEN_COUNT})`,
        provenance: "prompt_only",
    }, // Google Gemini
    {
        pattern: overflowPattern`prepared prompt exceeds engine max_context\s+(${TOKEN_COUNT})`,
        provenance: "unknown",
    }, // Engine max_context limit
    {
        pattern: overflowPattern`prompt exceeds (?:the )?.{0,32}\bmax_context\s+(${TOKEN_COUNT})`,
        provenance: "unknown",
    }, // Other local engines
    {
        pattern: overflowPattern`\ballows a context of up to (${TOKEN_COUNT}) tokens?\b`,
        provenance: "combined",
    },
    {
        pattern: overflowPattern`(?<!${ESTIMATED_REQUEST}\s+)\bup to (${TOKEN_COUNT}) tokens?\b`,
        provenance: "unknown",
    },
    // An overflow marker may precede the estimate of the rejected request. The
    // fallback must not follow that clause to find a number that is not a limit.
    {
        pattern: overflowPattern`max(?:imum)?.*context(?:(?!${ESTIMATED_REQUEST})[^\d\r\n])*(${TOKEN_COUNT})`,
        provenance: "unknown",
    },
];

function parseTokenCount(raw: string | undefined): number | null {
    // Grouped counts use one consistent separator and exactly three digits per group.
    if (raw === undefined || !/^(?:\d+|\d{1,3}([,_ .\u202f])\d{3}(?:\1\d{3})*)$/.test(raw)) {
        return null;
    }
    const value = Number(raw.replace(/[,_ .\u202f]/g, ""));
    return Number.isSafeInteger(value) ? value : null;
}

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
 * and SDK wrappers vary. The provider's 400 carries no message id, only
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

/** Distinct from prefix binding: the provider rejected edits to its active turn. */
export function detectLatestTurnThinkingMismatch(error: unknown): boolean {
    const status = extractExplicitHttpStatus(error);
    return (
        (status === undefined || status === 400) &&
        /(?:thinking|redacted_thinking)[\s\S]*latest assistant (?:message|turn)[\s\S]*cannot be modified/i.test(
            extractErrorMessage(error),
        )
    );
}

/**
 * Claude models whose signed thinking blocks Anthropic binds to the request
 * prefix, as `[family, major, minor]`. The source of truth is Anthropic's
 * preserved-thinking page
 * (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking,
 * "Keeping the prefix unchanged": "On Claude 5.1 and later models, a thinking
 * block stays valid only while everything you sent before it is unchanged"),
 * plus each new model's own "What's new" page; add a row when a new Claude
 * model ships. Claude Fable 5.2 and Claude Mythos 5.2 enforce the check on
 * every account (https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2,
 * "Editing earlier turns invalidates thinking blocks on every account"), and
 * Claude Mythos 5.1 returns the 400 on every account on the Claude API.
 * Keep this list in sync with `is_prefix_bound_thinking_model` in
 * crates/mc-module/src/transform.rs.
 */
export const PREFIX_BOUND_THINKING_MODELS: ReadonlyArray<readonly [string, number, number]> = [
    ["fable", 5, 1],
    ["fable", 5, 2],
    ["mythos", 5, 1],
    ["mythos", 5, 2],
    ["opus", 5, 5],
    ["sonnet", 5, 5],
    ["haiku", 5, 5],
];

// One pattern built from the list: the family, then the version with `-`, `_`
// or `.` between parts, bounded so `sonnet-5-50` or `notsonnet-5-5` never match.
// The trailing boundary also accepts Vertex `@date` and Bedrock `:0` suffixes.
const PREFIX_BOUND_THINKING_PATTERN = new RegExp(
    `(?:^|[-_.:/])(?:${PREFIX_BOUND_THINKING_MODELS.map(
        ([family, major, minor]) => `${family}[-_.]?${major}[-_.]${minor}`,
    ).join("|")})(?:$|[-_.:/@])`,
    "i",
);

/**
 * True for a model in PREFIX_BOUND_THINKING_MODELS on any route. Accounts
 * created on or after 2026-08-31 enforce the binding on the Claude API, Vertex
 * and Bedrock, and Fable 5.2 and Mythos 5.2 enforce it on every account, so
 * neither the provider nor the account's age is considered. Proactive stripping
 * runs only when a pass already rebuilds the cached prefix: a false positive
 * costs reasoning on those passes, a false negative risks a binding 400.
 */
export function isPrefixBoundThinkingModel(
    _providerID: string | null | undefined,
    modelID: string | null | undefined,
): boolean {
    if (!modelID) return false;
    return PREFIX_BOUND_THINKING_PATTERN.test(modelID);
}

/**
 * True only for canonical Anthropic Fable 5.1 model identifiers. Binding
 * recovery uses isPrefixBoundThinkingModel instead, which covers every
 * prefix-bound model and cloud route. The variant-cache policy uses this
 * narrower check to recognize Fable 5.1, whose cached prefix was measured to
 * survive effort changes. That is a separate fact from its signed thinking
 * being bound to the bytes before it.
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

    matched ??= unitlessLiteLLMOverflow(error, message);

    if (!matched && !hasStatus413) {
        return { isOverflow: false };
    }
    return overflowDetection(message, matched);
}

/**
 * LiteLLM's refusal can give the model's limit without a unit: "input
 * (485974 tokens) is longer than the model's context length (262144)" (issue
 * 860). Without the unit the sentence is weaker evidence: other errors can
 * quote it (an authentication failure echoing a request, a schema error
 * echoing an example). So it counts only when
 * - its own numbers describe an overflow (the input is larger than the limit),
 * - every HTTP status the error carries, at any nesting level, is one a
 *   too-large request gets (400 or 413), and
 * - nothing in the error says it is an authentication or permission failure:
 *   no such error type or name at any level, and no such wording in the text.
 * Statuses are read from status fields only, never from the text, where a
 * grouped count such as "401,974 tokens" would read as a status.
 */
const LITELLM_UNITLESS_OVERFLOW = overflowPattern`\binput \((${TOKEN_COUNT}) tokens?\) is longer than the model's context length \((${TOKEN_COUNT})\)`;
const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([400, 413]);
const AUTH_FAILURE_TYPE = /auth|permission|forbidden|unauthori[sz]ed|api[_ ]?key/i;
const AUTH_FAILURE_TEXT =
    /unauthori[sz]ed|forbidden|(?:invalid|incorrect) api key|authentication|permission denied|access denied/i;

/** Every status, type, code and name field of an error and the objects nested in it. */
function errorFields(error: unknown): { statuses: number[]; kinds: string[] } {
    const statuses: number[] = [];
    const kinds: string[] = [];
    if (!error || typeof error !== "object") return { statuses, kinds };
    const seen = new Set<object>();
    const queue: object[] = [error];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        const record = current as Record<string, unknown>;
        for (const key of ["status", "statusCode", "status_code"]) {
            const value = record[key];
            if (typeof value === "number") statuses.push(value);
            else if (typeof value === "string" && /^\d{3}$/.test(value))
                statuses.push(Number(value));
        }
        for (const key of ["type", "code", "name"]) {
            const value = record[key];
            if (typeof value === "string") kinds.push(value);
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === "object") queue.push(value);
        }
    }
    return { statuses, kinds };
}

function unitlessLiteLLMOverflow(error: unknown, message: string): RegExp | undefined {
    const match = LITELLM_UNITLESS_OVERFLOW.exec(message);
    if (!match) return undefined;
    const input = parseTokenCount(match[1]);
    const limit = parseTokenCount(match[2]);
    if (input === null || limit === null || input <= limit) return undefined;
    const { statuses, kinds } = errorFields(error);
    if (statuses.some((status) => !OVERFLOW_STATUSES.has(status))) return undefined;
    if (kinds.some((kind) => AUTH_FAILURE_TYPE.test(kind))) return undefined;
    if (AUTH_FAILURE_TEXT.test(message)) return undefined;
    return LITELLM_UNITLESS_OVERFLOW;
}

function overflowDetection(message: string, matched: RegExp | undefined): OverflowDetection {
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

const INPUT_EXTRACTION_PATTERNS = [
    overflowPattern`prompt is too long:\s*(${TOKEN_COUNT})`,
    overflowPattern`input token count\s*\(?\s*(${TOKEN_COUNT})`,
    overflowPattern`input length\s*(${TOKEN_COUNT})`,
    overflowPattern`prompt was\s*(${TOKEN_COUNT})`,
    overflowPattern`messages resulted in\s*(${TOKEN_COUNT})\s*tokens?\b`,
    overflowPattern`\binput \((${TOKEN_COUNT}) tokens?\) is longer than the model's context length \(${TOKEN_COUNT}(?: tokens?)?\)`,
    overflowPattern`\(\s*(${TOKEN_COUNT})\s+in the messages,\s*${TOKEN_COUNT}\s+in the completion\s*\)`,
    overflowPattern`${ESTIMATED_REQUEST}\s+(${TOKEN_COUNT})`,
];

/**
 * Extract the rejected input count (in tokens) from an error message if one
 * of the known patterns matches. Returns undefined when no plausible number
 * can be extracted. Completion tokens are not part of the input count.
 */
export function parseReportedInputTokens(message: string): number | undefined {
    if (!message) return undefined;
    for (const pattern of INPUT_EXTRACTION_PATTERNS) {
        const value = parseTokenCount(message.match(pattern)?.[1]);
        if (value !== null && value > 0) return value;
    }
    return undefined;
}

export function parseReportedLimit(message: string): ReportedContextLimit | undefined {
    if (!message) return undefined;
    for (const { pattern, provenance } of LIMIT_EXTRACTION_PATTERNS) {
        const value = parseTokenCount(message.match(pattern)?.[1]);
        if (value === null || value < MIN_PLAUSIBLE_LIMIT || value > MAX_PLAUSIBLE_LIMIT) continue;
        return { value, provenance };
    }
    return undefined;
}
