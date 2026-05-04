import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STALE_TOOL_NAMES = new Set(["ctx_reduce"]);

export function isReduceToolPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    // OpenCode format: { type: "tool", tool: "ctx_reduce" }
    if (part.type === "tool" && typeof part.tool === "string" && STALE_TOOL_NAMES.has(part.tool))
        return true;
    // tool-invocation format: { type: "tool-invocation", toolName: "ctx_reduce" }
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        STALE_TOOL_NAMES.has(part.toolName)
    )
        return true;
    // tool_use format: { type: "tool_use", name: "ctx_reduce" }
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        STALE_TOOL_NAMES.has(part.name)
    )
        return true;
    return false;
}

function hasAnyMeaningfulPart(parts: unknown[]): boolean {
    for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
            return true;
        if (
            part.type === "thinking" ||
            part.type === "reasoning" ||
            part.type === "redacted_thinking"
        )
            continue;
        if (part.type === "meta" || part.type === "step-start" || part.type === "step-finish")
            continue;
        if (part.type !== "tool" || !isReduceToolPart(part)) return true;
    }
    return false;
}

export function dropStaleReduceCalls(messages: MessageLike[], protectedCount: number = 0): boolean {
    let didDrop = false;
    const protectedStart = messages.length - protectedCount;
    // Sentinel-based replacement (council Finding #1) — preserve message and
    // part array length so proxy providers that hash the serialized body see
    // a stable prefix. Each stripped ctx_reduce tool part becomes an empty-
    // text sentinel; messages left with no meaningful content become
    // single-sentinel-part shells.
    for (let i = 0; i < messages.length; i++) {
        if (i >= protectedStart) break;
        const message = messages[i];
        let touched = false;

        for (let j = 0; j < message.parts.length; j++) {
            const part = message.parts[j];
            if (isSentinel(part)) continue;
            if (isReduceToolPart(part)) {
                message.parts[j] = makeSentinel(part);
                touched = true;
            }
        }

        if (touched) {
            didDrop = true;
            if (!hasAnyMeaningfulPart(message.parts)) {
                // Whole message becomes a single-sentinel-part shell. Preserves
                // messages.length so proxy cache hashes stay stable.
                message.parts.length = 0;
                message.parts.push(makeSentinel(undefined));
            }
        }
    }
    return didDrop;
}
