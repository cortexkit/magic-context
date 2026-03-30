import { isRecord } from "../../shared/record-type-guard";
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
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (i >= protectedStart) continue;
        const message = messages[i];
        const originalLength = message.parts.length;

        for (let j = message.parts.length - 1; j >= 0; j -= 1) {
            if (isReduceToolPart(message.parts[j])) {
                message.parts.splice(j, 1);
            }
        }

        if (message.parts.length < originalLength) {
            didDrop = true;
            if (!hasAnyMeaningfulPart(message.parts)) {
                messages.splice(i, 1);
            }
        }
    }
    return didDrop;
}
