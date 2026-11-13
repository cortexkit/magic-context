import { isRecord } from "../../shared/record-type-guard";
import {
    estimateImageTokensFromDataUrl,
    estimateToolAttachmentImageTokens,
} from "./image-token-estimate";
import { opaqueThinkingCost } from "./opaque-thinking";
import type { MessageLike } from "./transform-operations";

export interface MessageTokenEstimate {
    conversation: number;
    toolCall: number;
}

/**
 * What OpenCode 2 sends for a reasoning part besides its text. OpenCode 2's
 * parts carry the signature in `encrypted` or under `providerMetadata` (keyed
 * by the route, `anthropic` on the Anthropic API), never under `metadata` as
 * OpenCode 1's do. Its Anthropic Messages encoder (OpenCode v2.2.7,
 * `packages/ai/src/protocols/anthropic-messages.ts`, the reasoning branch of
 * the assistant message encoder, with `signatureFromMetadata` and
 * `redactedDataFromMetadata`) sends a part with a non-blank signature as a
 * `thinking` block even when its text is empty, and a part with redacted data
 * and no signature as `redacted_thinking`; a part with neither and no text is
 * skipped. "signature" or "redacted" names which block the part becomes;
 * undefined means it adds nothing beyond its text.
 */
export function openCode2ThinkingPayload(part: unknown): "signature" | "redacted" | undefined {
    if (!isRecord(part)) return undefined;
    const records = isRecord(part.providerMetadata)
        ? Object.values(part.providerMetadata).filter(isRecord)
        : [];
    const signature =
        typeof part.encrypted === "string"
            ? part.encrypted
            : records
                  .map((record) => record.signature)
                  .find((value): value is string => typeof value === "string");
    if (signature === undefined)
        return records.some((record) => typeof record.redactedData === "string")
            ? "redacted"
            : undefined;
    return signature.trim().length > 0 ? "signature" : undefined;
}

export function serializedWireText(value: unknown): string {
    if (value === undefined) return "";
    return (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
}

/** Price native image parts and tool attachments identically for wire and distance accounting. */
export function estimatePartImageTokens(raw: unknown): number {
    if (!raw || typeof raw !== "object") return 0;
    const part = raw as {
        type?: string;
        ignored?: boolean;
        mime?: string;
        url?: unknown;
        state?: unknown;
    };
    if (part.ignored) return 0;
    if (part.type === "file" && part.mime?.startsWith("image/")) {
        return typeof part.url === "string" && part.url.startsWith("data:")
            ? estimateImageTokensFromDataUrl(part.url)
            : 1200;
    }
    return part.type === "tool" ? estimateToolAttachmentImageTokens(part.state) : 0;
}

/**
 * Visit every field of a message that reaches the provider request: `text` with
 * the field's value (a string, or a value the request carries serialized), and
 * `image` with the token count of an image the request carries. Fields OpenCode
 * keeps only for itself, such as tool metadata, are not visited. Token estimates
 * and fit byte bounds both walk this. Encrypted thinking signatures and redacted
 * payloads remain in exact request identity for authentication and replay, but
 * their ciphertext is not conversation text to tokenize.
 */
export function visitWireContent(
    message: MessageLike,
    visit: {
        text: (bucket: keyof MessageTokenEstimate, value: unknown) => void;
        image: (bucket: keyof MessageTokenEstimate, tokens: number) => void;
    },
): void {
    let opaqueCounted = false;
    const opaque = () => {
        if (opaqueCounted) return;
        opaqueCounted = true;
        const usage = (
            message.info as unknown as
                | { tokens?: { reasoning?: number; output?: number } }
                | undefined
        )?.tokens;
        visit.image("conversation", opaqueThinkingCost(usage?.reasoning, usage?.output).tokens);
    };
    for (const part of message.parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            ignored?: boolean;
            redacted?: boolean;
            state?: { input?: unknown; output?: unknown; content?: unknown; error?: unknown };
            args?: unknown;
            input?: unknown;
            content?: unknown;
            output?: unknown;
            result?: unknown;
            mime?: string;
            url?: unknown;
            metadata?: { anthropic?: { signature?: string; redactedData?: string } };
        };
        if (p.ignored) continue;
        const text = (value: unknown) => {
            if (typeof value === "string") visit.text("conversation", value);
        };
        const tool = (value: unknown) => visit.text("toolCall", value);
        switch (p.type) {
            case "text":
                text(p.text);
                break;
            case "reasoning": {
                const opencode2 = openCode2ThinkingPayload(part);
                if (p.redacted || p.metadata?.anthropic?.redactedData || opencode2 === "redacted")
                    opaque();
                else {
                    text(p.text);
                    if (!p.text && (p.metadata?.anthropic?.signature || opencode2 === "signature"))
                        opaque();
                }
                break;
            }
            case "thinking":
                if (p.redacted) opaque();
                else {
                    text(p.thinking);
                    if (!p.thinking && p.signature) opaque();
                }
                break;
            case "redacted_thinking":
                // Encrypted thinking/signatures are not input prose. Preserve
                // their bytes for replay and prefix matching, not tokenization.
                opaque();
                break;
            case "file":
                visit.image("conversation", estimatePartImageTokens(part));
                break;
            case "tool":
                tool(p.state?.input ?? p.input ?? p.args);
                tool(p.state?.output ?? p.state?.content ?? p.output ?? p.result ?? p.content);
                tool(p.state?.error);
                // Legacy skeletons may still carry media. Count what the wire
                // actually contains, not what its output marker implies.
                visit.image("toolCall", estimatePartImageTokens(part));
                break;
            case "tool-call":
                tool(p.input ?? p.args);
                break;
            case "tool-invocation":
                tool(p.args ?? p.input);
                tool(p.result ?? p.output ?? p.state?.output);
                tool(p.state?.error);
                break;
            case "tool-result":
                tool(p.result ?? p.content ?? p.output);
                break;
            case "tool_use":
                tool(p.input ?? p.args);
                break;
            case "tool_result":
                tool(p.content ?? p.result ?? p.output);
                break;
        }
    }
}

/** A UTF-8 byte per text token is the estimator's conservative bounded-count mode. */
export function estimateByteBoundedMessageTokens(message: MessageLike): MessageTokenEstimate {
    const total: MessageTokenEstimate = { conversation: 0, toolCall: 0 };
    visitWireContent(message, {
        text: (bucket, value) => {
            total[bucket] += Buffer.byteLength(serializedWireText(value));
        },
        image: (bucket, tokens) => {
            total[bucket] += tokens;
        },
    });
    return total;
}

export function wireContentBytes(
    messages: readonly MessageLike[],
    abortAboveBytes: number,
    bytesPerToken: number,
): { bytes: number; aborted: boolean } | null {
    let bytes = 0;
    try {
        for (const message of messages) {
            visitWireContent(message, {
                text: (_bucket, value) => {
                    bytes += Buffer.byteLength(serializedWireText(value));
                },
                image: (_bucket, tokens) => {
                    bytes += tokens * bytesPerToken;
                },
            });
            if (bytes > abortAboveBytes) return { bytes, aborted: true };
        }
    } catch {
        return null;
    }
    return { bytes, aborted: false };
}

export function hasCountableParts(message: MessageLike): boolean {
    return message.parts.every((part) => {
        if (!part || typeof part !== "object") return false;
        const p = part as unknown as Record<string, unknown>;
        if (p.ignored === true) return true;
        switch (p.type) {
            case "text":
            case "reasoning":
                return typeof p.text === "string";
            case "thinking":
                return typeof p.thinking === "string";
            case "redacted_thinking":
                return typeof p.data === "string";
            case "tool": {
                const state =
                    p.state !== null && typeof p.state === "object"
                        ? (p.state as Record<string, unknown>)
                        : undefined;
                const hasInput =
                    state?.input !== undefined || p.input !== undefined || p.args !== undefined;
                const hasResult =
                    state?.output !== undefined ||
                    state?.content !== undefined ||
                    state?.error !== undefined ||
                    p.output !== undefined ||
                    p.result !== undefined ||
                    p.content !== undefined;
                return hasInput && hasResult;
            }
            case "tool-call":
                return p.input !== undefined || p.args !== undefined;
            case "tool-invocation":
                return (
                    (p.args !== undefined || p.input !== undefined) &&
                    (p.result !== undefined ||
                        p.output !== undefined ||
                        (p.state !== null && typeof p.state === "object"))
                );
            case "tool-result":
                return p.result !== undefined || p.content !== undefined || p.output !== undefined;
            case "tool_use":
                return p.input !== undefined || p.args !== undefined;
            case "tool_result":
                return p.content !== undefined || p.result !== undefined || p.output !== undefined;
            case "step-start":
            case "step-finish":
                return true;
            // Inline images use the shared dimension-based estimate; other attachments have no bound.
            case "file":
                return typeof p.url === "string" && p.url.startsWith("data:image/");
            default:
                return false;
        }
    });
}
