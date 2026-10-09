import { isRecord } from "../../shared/record-type-guard";
import { estimateTokens } from "./read-session-formatting";
import { reasoningStepCost, reasoningTextAndOpaque } from "./reasoning-budget";
import { findLatestAssistantReasoningMutationExemptMessage } from "./strip-content";
import type { MessageLike } from "./tag-messages";

export interface ReasoningBudgetStatus {
    kept: number;
    budget: number;
    estimated: boolean;
    overrun?: "newest step" | "signed prefix" | "awaiting rebuild";
}

// Status is evaluated only when requested, never as a selector on a defer pass.
// Bound retained wire sources just as host diagnostic snapshots are bounded.
const sources = new Map<
    string,
    {
        messages: MessageLike[];
        budget: number;
        prefixBound: boolean;
        proseRatio: number;
        status?: ReasoningBudgetStatus;
    }
>();

/** Capture only wire facts, never an adapter's transform dependencies or tool handlers.
 * Retaining a pass closure would keep an undisposed host adapter alive through status.
 */
export function captureOpencodeReasoningBudgetStatus(
    sessionId: string,
    messages: MessageLike[],
    budget: number,
    prefixBound: boolean,
    proseRatio = 1,
): void {
    if (
        messages.some(
            (message) =>
                !isRecord(message) ||
                !isRecord(message.info) ||
                typeof message.info.role !== "string" ||
                !Array.isArray(message.parts),
        )
    ) {
        // An unsupported native dialect is not evidence of zero reasoning. Diagnostics
        // must never refuse an otherwise validated module response or retain stale totals.
        sources.delete(sessionId);
        return;
    }
    const compact = messages
        .filter((message) => message.info.role === "assistant")
        .map((message) => {
            const info = message.info as unknown as Record<string, unknown>;
            const visible = reasoningTextAndOpaque(message.parts);
            const parts = message.parts.filter(isRecord).map((part) => ({
                type: typeof part.type === "string" ? part.type : "",
                text:
                    typeof part.text === "string" &&
                    part.type !== "redacted_thinking" &&
                    part.redacted !== true
                        ? part.text
                        : undefined,
                thinking:
                    typeof part.thinking === "string" && part.redacted !== true
                        ? part.thinking
                        : undefined,
                ignored: part.ignored === true,
                redacted: part.redacted === true,
                metadata: part.metadata === undefined ? undefined : {},
                signature: part.signature === undefined ? undefined : true,
                thinkingSignature: part.thinkingSignature === undefined ? undefined : true,
            }));
            if (visible.hasReasoning && !reasoningTextAndOpaque(parts).hasReasoning)
                parts.push({
                    type: "reasoning",
                    text: visible.text,
                    thinking: undefined,
                    ignored: false,
                    redacted: false,
                    metadata: visible.opaque ? {} : undefined,
                    signature: undefined,
                    thinkingSignature: undefined,
                });
            return {
                info: {
                    role: info.role,
                    tokens:
                        isRecord(info.tokens) && typeof info.tokens.reasoning === "number"
                            ? { reasoning: info.tokens.reasoning }
                            : undefined,
                },
                parts,
            } as unknown as MessageLike;
        });
    sources.delete(sessionId);
    sources.set(sessionId, { messages: compact, budget, prefixBound, proseRatio });
    if (sources.size > 32) sources.delete(sources.keys().next().value as string);
}
export function reasoningBudgetStatusLine(sessionId: string): string | undefined {
    try {
        const source = sources.get(sessionId);
        if (!source) return undefined;
        source.status ??= opencodeReasoningBudgetStatus(
            source.messages,
            source.budget,
            source.prefixBound,
            source.proseRatio,
        );
        return formatReasoningBudgetStatus(source.status);
    } catch {
        return undefined;
    }
}
export function formatReasoningBudgetStatus(status: ReasoningBudgetStatus): string {
    const count = (tokens: number) =>
        tokens >= 1000 ? `${Number((tokens / 1000).toFixed(1))}k` : String(Math.round(tokens));
    return `Reasoning kept: ${count(status.kept)} of ${count(status.budget)} (${status.estimated ? "estimated" : "reported"})${status.overrun ? ` (over budget: ${status.overrun})` : ""}`;
}
export function opencodeReasoningBudgetStatus(
    messages: MessageLike[],
    budget: number,
    prefixBound: boolean,
    proseRatio = 1,
): ReasoningBudgetStatus {
    const assistants = messages.filter((message) => message.info.role === "assistant");
    const newest = assistants.at(-1);
    const exempt = findLatestAssistantReasoningMutationExemptMessage(messages);
    let kept = 0;
    let exemptCost = 0;
    let estimated = false;
    for (const message of assistants) {
        const visible = reasoningTextAndOpaque(message.parts);
        const info = message.info as unknown as Record<string, unknown>;
        const reported =
            isRecord(info.tokens) && typeof info.tokens.reasoning === "number"
                ? info.tokens.reasoning
                : undefined;
        const cost =
            (visible.hasReasoning
                ? reported !== undefined && Number.isFinite(reported) && reported > 0
                    ? reported
                    : reasoningStepCost(
                          reported,
                          estimateTokens(visible.text) * proseRatio,
                          visible.opaque,
                      )
                : 0) + Math.ceil(estimateTokens(visible.inlineText) * proseRatio);
        kept += cost;
        if (message === newest || message === exempt) exemptCost += cost;
        if (
            cost > 0 &&
            (!(reported && Number.isFinite(reported) && reported > 0) || visible.inlineText !== "")
        )
            estimated = true;
    }
    return {
        kept,
        budget,
        estimated,
        overrun:
            kept > budget
                ? exemptCost > budget
                    ? "newest step"
                    : prefixBound
                      ? "signed prefix"
                      : "awaiting rebuild"
                : undefined,
    };
}
