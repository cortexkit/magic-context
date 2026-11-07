import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type BodyProvider = "anthropic" | "openai" | "gemini";

type Json = Record<string, unknown>;

export interface NormalizedPart {
    type: string;
    length: number;
    /** Printable start of the part's text; always empty for reasoning parts. */
    textPrefix: string;
    /**
     * The same 120 characters for every part, reasoning included. Used only to
     * check whether a shortened part still starts like its earlier version;
     * never print it.
     */
    comparePrefix: string;
}

export interface NormalizedMessage {
    role: string;
    parts: NormalizedPart[];
    hash: string;
    bytes: number;
    breakpoint: boolean;
    /** Exact normalized JSON; the hash and divergence detection use it. Never print it. */
    canonical: string;
    /** The canonical JSON with reasoning content redacted; safe to print in diffs. */
    display: string;
}

export interface NormalizedRequestBody {
    provider: BodyProvider;
    messages: NormalizedMessage[];
}

export interface PiBodySnapshot {
    /** The number in the `<n>-req.json` file name, counted by the capture extension. */
    sequence: number;
    path: string;
    /**
     * When the capture extension last wrote the body file. The extension numbers
     * its files with its own per-process counter, which is not Magic Context's
     * ledger sequence and restarts with every Pi process, so the write time is
     * what ties a body to the context pass that produced it.
     */
    writtenAtMs: number;
    wireModel?: string;
    messages: NormalizedMessage[];
}

export interface BodyPairDivergence {
    index: number;
    description: string;
    previousText: string;
    currentText: string;
}

function asJson(value: unknown): Json | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Json)
        : undefined;
}

function sha(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

/**
 * Values the caller rotates on every request even when the prompt is byte-stable.
 * The Anthropic auth plugin prepends a billing-header block to `system` whose
 * `cch`, `cc_prev_req`, and `cc_prompt_id` change per request; the provider meter
 * reports a full cache read straight across those rotations, so a comparison that
 * counts them reports a divergence on every single request and buries the real
 * ones. The whole header line is replaced rather than each field, so a field
 * added to it later cannot quietly reintroduce the noise.
 */
export function stripRotatingRequestFields(text: string): string {
    return text
        .replace(/^[ \t]*x-anthropic-billing-header:.*$/gim, "x-anthropic-billing-header: <rotating>")
        .replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    const object = asJson(value);
    if (!object) {
        return typeof value === "string" ? stripRotatingRequestFields(value) : value;
    }
    const normalized: Json = {};
    for (const [key, child] of Object.entries(object)) {
        if (key !== "cache_control") normalized[key] = stripCacheControl(child);
    }
    return normalized;
}

function hasCacheControl(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasCacheControl);
    const object = asJson(value);
    if (!object) return false;
    if (object.cache_control !== undefined) return true;
    return Object.values(object).some(hasCacheControl);
}

function textForPart(value: unknown): string {
    if (typeof value === "string") return value;
    const object = asJson(value);
    if (!object) return JSON.stringify(stripCacheControl(value)) ?? String(value);
    for (const key of ["text", "thinking", "output", "arguments", "input"] as const) {
        const candidate = object[key];
        if (typeof candidate === "string") return candidate;
        if (candidate !== undefined) return JSON.stringify(stripCacheControl(candidate)) ?? "";
    }
    return JSON.stringify(stripCacheControl(object)) ?? "";
}

function partType(value: unknown, fallback: string): string {
    const object = asJson(value);
    return typeof object?.type === "string" ? object.type : fallback;
}

/**
 * Part and item types that carry model reasoning: Anthropic thinking blocks,
 * OpenAI Responses reasoning items and their text and summary parts.
 */
const REASONING_TYPES = new Set([
    "thinking",
    "redacted_thinking",
    "reasoning",
    "reasoning_text",
    "summary_text",
    "thought",
]);

/** Keys whose values are opaque encrypted reasoning, on any object. */
const OPAQUE_REASONING_KEYS = new Set(["signature", "thoughtSignature", "encrypted_content"]);

/**
 * Reasoning must never be printed: replaying it into an agent's context is
 * refused as reasoning extraction. Gemini marks thought parts with
 * `thought: true` and no type.
 */
function isReasoningShaped(value: unknown): boolean {
    const object = asJson(value);
    if (!object) return false;
    return (
        (typeof object.type === "string" && REASONING_TYPES.has(object.type)) ||
        object.thought === true
    );
}

function redactedString(text: string): string {
    return `‹redacted ${text.length} chars ${sha(text)}›`;
}

/**
 * A printable copy of a request value. Inside a reasoning-shaped object every
 * string except `type` becomes a length-and-digest marker, so a diff still shows
 * that a reasoning block changed without showing what it said. Opaque signature
 * values are replaced on any object.
 */
function redactReasoning(value: unknown, insideReasoning = false): unknown {
    if (typeof value === "string") return insideReasoning ? redactedString(value) : value;
    if (Array.isArray(value)) return value.map((item) => redactReasoning(item, insideReasoning));
    const object = asJson(value);
    if (!object) return value;
    const reasoning = insideReasoning || isReasoningShaped(object);
    const redacted: Json = {};
    for (const [key, child] of Object.entries(object)) {
        if (key === "type" && typeof child === "string") {
            redacted[key] = child;
        } else if (OPAQUE_REASONING_KEYS.has(key) && typeof child === "string") {
            redacted[key] = redactedString(child);
        } else {
            redacted[key] = redactReasoning(child, reasoning);
        }
    }
    return redacted;
}

function normalizePart(value: unknown, fallbackType: string): NormalizedPart {
    // Normalize before measuring: the part length and text prefix both feed the
    // message identity the analyzer diffs on, so an un-normalized length or
    // prefix would diverge on a rotation the hash already forgives.
    const text = stripRotatingRequestFields(textForPart(value));
    const oneLine = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, 120);
    // A part with no text key prints as its JSON, which can carry a reasoning
    // signature (Gemini's thoughtSignature on a function call), so the printed
    // prefix comes from the redacted copy.
    const printable = isReasoningShaped(value)
        ? ""
        : oneLine(stripRotatingRequestFields(textForPart(redactReasoning(value))));
    return {
        type: partType(value, fallbackType),
        length: text.length,
        textPrefix: printable,
        comparePrefix: oneLine(text),
    };
}

function contentParts(content: unknown, fallbackType: string): NormalizedPart[] {
    if (Array.isArray(content)) {
        return content.map((part) => normalizePart(part, fallbackType));
    }
    return [normalizePart(content, fallbackType)];
}

function normalizedMessage(
    role: string,
    content: unknown,
    original: unknown,
    fallbackType: string,
): NormalizedMessage {
    const stripped = stripCacheControl(content);
    const canonical = JSON.stringify({ role, content: stripped });
    return {
        role,
        parts: contentParts(content, fallbackType),
        hash: sha(canonical),
        bytes: Buffer.byteLength(JSON.stringify(original)),
        breakpoint: hasCacheControl(original),
        canonical,
        display: JSON.stringify({ role, content: redactReasoning(stripped) }),
    };
}

function openAiRole(item: Json): string {
    if (typeof item.role === "string") return item.role;
    switch (item.type) {
        case "function_call":
        case "reasoning":
            return "assistant";
        case "function_call_output":
            return "tool";
        default:
            return typeof item.type === "string" ? item.type : "unknown";
    }
}

function normalizeAnthropicBody(body: Json): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    if (body.system !== undefined) {
        const system = Array.isArray(body.system) ? body.system : [body.system];
        messages.push(normalizedMessage("system", system, system, "text"));
    }
    if (!Array.isArray(body.messages)) return messages;
    for (const value of body.messages) {
        const message = asJson(value);
        if (!message) continue;
        const role = typeof message.role === "string" ? message.role : "unknown";
        messages.push(normalizedMessage(role, message.content, message, "text"));
    }
    return messages;
}

function normalizeOpenAiBody(body: Json): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    if (body.instructions !== undefined) {
        messages.push(
            normalizedMessage("system", body.instructions, body.instructions, "instructions"),
        );
    }
    if (!Array.isArray(body.input)) return messages;
    for (const value of body.input) {
        const item = asJson(value);
        if (!item) {
            messages.push(normalizedMessage("user", value, value, "input_text"));
            continue;
        }
        const content = item.content ?? item;
        messages.push(normalizedMessage(openAiRole(item), content, item, partType(item, "input")));
    }
    return messages;
}

/** Gemini parts carry no `type`; the payload key (text, functionCall, ...) names the part. */
function geminiPartType(value: unknown): string {
    const object = asJson(value);
    if (!object) return "text";
    for (const key of [
        "functionCall",
        "functionResponse",
        "inlineData",
        "fileData",
        "executableCode",
        "codeExecutionResult",
    ] as const) {
        if (object[key] !== undefined) return key;
    }
    if (object.text !== undefined) return object.thought === true ? "thought" : "text";
    return "part";
}

function geminiMessage(role: string, parts: unknown, original: unknown): NormalizedMessage {
    const message = normalizedMessage(role, parts, original, "text");
    return {
        ...message,
        parts: Array.isArray(parts)
            ? parts.map((part) => normalizePart(part, geminiPartType(part)))
            : message.parts,
    };
}

/**
 * Gemini `generateContent` bodies: `systemInstruction` + `tools` + `contents[]`.
 * Google Code Assist (Antigravity) wraps the same request in a
 * `{model, project, request: {...}}` envelope, so the inner request is read when
 * present. Tool declarations are kept as their own message because they sit in the
 * provider's cached prefix: a changed tool list is a real prefix rewrite.
 */
function normalizeGeminiBody(body: Json): NormalizedMessage[] {
    const request = asJson(body.request) ?? body;
    const messages: NormalizedMessage[] = [];
    if (request.systemInstruction !== undefined) {
        const system = asJson(request.systemInstruction);
        messages.push(geminiMessage("system", system?.parts ?? request.systemInstruction, system));
    }
    if (request.tools !== undefined) {
        messages.push(normalizedMessage("tools", request.tools, request.tools, "tools"));
    }
    if (!Array.isArray(request.contents)) return messages;
    for (const value of request.contents) {
        const content = asJson(value);
        if (!content) continue;
        const role = typeof content.role === "string" ? content.role : "unknown";
        messages.push(geminiMessage(role, content.parts, content));
    }
    return messages;
}

/** Convert Anthropic `messages[]`, Responses `input[]`, and Gemini `contents[]` into the same diagnostic shape. */
export function normalizeRequestBody(body: Json, provider?: BodyProvider): NormalizedRequestBody {
    const resolvedProvider = provider ?? (Array.isArray(body.input) ? "openai" : "anthropic");
    return {
        provider: resolvedProvider,
        messages:
            resolvedProvider === "openai"
                ? normalizeOpenAiBody(body)
                : resolvedProvider === "gemini"
                  ? normalizeGeminiBody(body)
                  : normalizeAnthropicBody(body),
    };
}

export function firstNormalizedDivergence(
    previous: readonly NormalizedMessage[],
    current: readonly NormalizedMessage[],
): number {
    const shared = Math.min(previous.length, current.length);
    for (let index = 0; index < shared; index += 1) {
        if (previous[index].hash !== current[index].hash) return index;
    }
    return previous.length === current.length ? -1 : shared;
}

export function describeNormalizedMessage(message: NormalizedMessage): string {
    const parts = message.parts.map((part) => `${part.type}(${part.length})`).join(",");
    const prefix = message.parts.find((part) => part.textPrefix)?.textPrefix ?? "";
    return `role=${message.role} parts=[${parts || "none"}] text=${JSON.stringify(prefix)}`;
}

export function describeBodyPair(
    previous: readonly NormalizedMessage[],
    current: readonly NormalizedMessage[],
): BodyPairDivergence | undefined {
    const index = firstNormalizedDivergence(previous, current);
    if (index < 0) return undefined;
    const message = current[index] ?? previous[index];
    return {
        index,
        description: `message[${index}] ${describeNormalizedMessage(message)}`,
        previousText: previous[index]?.display ?? "(message absent)",
        currentText: current[index]?.display ?? "(message absent)",
    };
}

function clippedVersion(text: string, start: number, end: number): string {
    const before = text.slice(Math.max(0, start - 120), start);
    const changed = text.slice(start, Math.min(end, start + 240));
    const after = text.slice(end, end + 120);
    return `${start > 120 ? "…" : ""}${before}[${changed}${end - start > 240 ? "…" : ""}]${after}${end + 120 < text.length ? "…" : ""}`;
}

export function clippedBodyPairVersions(divergence: BodyPairDivergence): {
    character: number;
    previous: string;
    current: string;
} {
    const previous = divergence.previousText;
    const current = divergence.currentText;
    let start = 0;
    while (
        start < previous.length &&
        start < current.length &&
        previous[start] === current[start]
    ) {
        start += 1;
    }
    let previousEnd = previous.length;
    let currentEnd = current.length;
    while (
        previousEnd > start &&
        currentEnd > start &&
        previous[previousEnd - 1] === current[currentEnd - 1]
    ) {
        previousEnd -= 1;
        currentEnd -= 1;
    }
    return {
        character: start,
        previous: clippedVersion(previous, start, previousEnd),
        current: clippedVersion(current, start, currentEnd),
    };
}

function sessionCwdFromJsonl(sessionPath: string): string | undefined {
    try {
        for (const raw of readFileSync(sessionPath, "utf8").split("\n")) {
            if (!raw.trim()) continue;
            const entry = asJson(JSON.parse(raw));
            if (entry?.type === "session" && typeof entry.cwd === "string") return entry.cwd;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function cwdFromEncodedSessionDirectory(sessionPath: string): string | undefined {
    const encoded = basename(dirname(sessionPath));
    if (!encoded.startsWith("--") || !encoded.endsWith("--")) return undefined;
    const inner = encoded.slice(2, -2);
    return inner ? `/${inner.replaceAll("-", "/")}` : undefined;
}

export function resolvePiBodiesDirectory(
    sessionId: string,
    sessionPath: string,
    override?: string,
): string | undefined {
    if (override) {
        const nested = join(override, sessionId);
        if (existsSync(nested)) return nested;
        return existsSync(override) ? override : undefined;
    }
    const cwd = sessionCwdFromJsonl(sessionPath) ?? cwdFromEncodedSessionDirectory(sessionPath);
    if (!cwd) return undefined;
    const candidate = join(cwd, ".pi", "pi-llm-debugging", sessionId);
    return existsSync(candidate) ? candidate : undefined;
}

export function loadPiBodySnapshots(directory: string | undefined): Map<number, PiBodySnapshot> {
    const snapshots = new Map<number, PiBodySnapshot>();
    if (!directory || !existsSync(directory)) return snapshots;
    for (const file of readdirSync(directory)) {
        const match = /^(\d+)-req\.json$/.exec(file);
        if (!match) continue;
        const path = join(directory, file);
        try {
            const body = JSON.parse(readFileSync(path, "utf8")) as Json;
            snapshots.set(Number.parseInt(match[1], 10), {
                sequence: Number.parseInt(match[1], 10),
                path,
                writtenAtMs: statSync(path).mtimeMs,
                wireModel:
                    typeof body.model === "string" && body.model.length > 0 ? body.model : undefined,
                messages: normalizeRequestBody(body, "openai").messages,
            });
        } catch {
            // A partial diagnostic write must not hide the other complete bodies.
        }
    }
    return snapshots;
}
