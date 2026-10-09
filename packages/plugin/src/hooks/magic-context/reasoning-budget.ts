import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getMergedReasoningStrippedIds,
    THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
} from "../../features/magic-context/storage-meta-persisted";
import { getReasoningRemovalState } from "../../features/magic-context/storage-reasoning-removal";
import {
    getReasoningTokenEstimatesByMessage,
    getTagsBySession,
} from "../../features/magic-context/storage-tags";
import { resolveModelConfigValue } from "../../shared/prompt-surface";
import { isRecord } from "../../shared/record-type-guard";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { hasAnthropicReasoning, isInActiveAnthropicTurn } from "./active-anthropic-turn";
import { estimateTokens } from "./read-session-formatting";
import { neutralizedReasoningSource } from "./sentinel";
import {
    findLatestAssistantReasoningMutationExemptMessage,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import type { MessageLike } from "./tag-messages";

/** Read-only historian projection. DB-only/cold-start callers may use tag estimates instead. */
export function projectOpencodeReasoningBudgetCutoff(
    db: ContextDatabase,
    sessionId: string,
    messages: MessageLike[],
    budget: number,
    watermark: number,
    proseRatio: number,
): number {
    const maxTags = new Map<string, number>();
    for (const tag of getTagsBySession(db, sessionId)) {
        const id =
            tag.type === "tool" ? tag.toolOwnerMessageId : contentTagOwnerMessageId(tag.messageId);
        if (id) maxTags.set(id, Math.max(maxTags.get(id) ?? 0, tag.tagNumber));
    }
    const messageTags = new Map<MessageLike, number>();
    const gone = new Set(getReasoningRemovalState(db, sessionId).messageIds);
    for (const message of messages) {
        if (typeof message.info.id !== "string") continue;
        const tag = maxTags.get(message.info.id) ?? 0;
        messageTags.set(message, tag);
        if (tag > 0 && tag <= watermark) gone.add(message.info.id);
    }
    return opencodeReasoningBudgetCutoff({
        messages,
        messageTagNumbers: messageTags,
        budget,
        alreadyRemoved: gone,
        textEstimateByMessageId: getReasoningTokenEstimatesByMessage(db, sessionId, proseRatio),
        proseRatio,
        frozenMergedIds: getMergedReasoningStrippedIds(db, sessionId),
        alsoGone: new Set(
            [...getMergedReasoningStrippedIds(db, sessionId)]
                .filter((id) => id.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
                .map((id) => id.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)),
        ),
    });
}

export const DEFAULT_KEEP_REASONING_TOKENS = 10_000;
export const UNKNOWN_REASONING_STEP_TOKENS = 1_000;
export type KeepReasoningTokens = number | Record<string, number>;

export function resolveKeepReasoningTokens(
    config: KeepReasoningTokens | undefined,
    modelKey: string | undefined,
): number {
    // A model name such as "constructor" is not a configured prototype value.
    const values =
        config && typeof config === "object"
            ? Object.assign(Object.create(null) as Record<string, number>, config)
            : undefined;
    return typeof config === "number"
        ? config
        : (resolveModelConfigValue(values, modelKey)?.value ??
              values?.default ??
              DEFAULT_KEEP_REASONING_TOKENS);
}

export function reasoningStepCost(
    reported: number | undefined,
    textEstimate: number,
    opaque: boolean,
): number {
    if (reported !== undefined && Number.isFinite(reported) && reported > 0) return reported;
    if (textEstimate > 0) return Math.ceil(textEstimate);
    return opaque ? UNKNOWN_REASONING_STEP_TOKENS : 0;
}

export interface ReasoningBudgetStep {
    tag: number;
    cost: number | (() => number);
    exempt?: boolean;
    alreadyRemoved?: boolean;
}

/** Oldest-first input; only the newest fitting suffix is retained, never part of a step.
 * Exempt reasoning is charged first because it cannot leave the wire. Cost callbacks
 * bound fallback tokenization to the retained suffix plus its first non-fitting step.
 */
export function reasoningBudgetCutoff(
    steps: readonly ReasoningBudgetStep[],
    budget: number,
): number {
    const cost = (step: ReasoningBudgetStep) =>
        step.alreadyRemoved ? 0 : typeof step.cost === "function" ? step.cost() : step.cost;
    let kept = 0;
    let upperBound = Number.POSITIVE_INFINITY;
    for (const step of steps) {
        if (!step.exempt) continue;
        kept += cost(step);
        if (step.tag > 0) upperBound = Math.min(upperBound, step.tag - 1);
    }
    for (let index = steps.length - 1; index >= 0; index--) {
        const step = steps[index];
        if (step.exempt || step.alreadyRemoved) continue;
        const tokens = cost(step);
        if (kept + tokens <= budget) {
            kept += tokens;
            if (step.tag > 0) upperBound = Math.min(upperBound, step.tag - 1);
            continue;
        }
        let tag = step.tag;
        for (let older = index - 1; tag <= 0 && older >= 0; older--) tag = steps[older].tag;
        return Math.max(0, Math.min(tag, upperBound));
    }
    return 0;
}

/** Visible thinking only: signatures and encrypted transport are never tokenized. */
export function reasoningTextAndOpaque(parts: readonly unknown[]): {
    text: string;
    inlineText: string;
    opaque: boolean;
    hasReasoning: boolean;
} {
    let text = "";
    let inlineText = "";
    let opaque = false;
    let hasReasoning = false;
    const detailText = new Set<string>();
    for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.ignored === true) continue;
        if (isRecord(part.metadata)) {
            const router = part.metadata.openrouter;
            if (
                isRecord(router) &&
                Array.isArray(router.reasoning_details) &&
                router.reasoning_details.length > 0
            ) {
                hasReasoning = true;
                opaque = true;
                for (const detail of router.reasoning_details) {
                    if (!isRecord(detail)) continue;
                    if (detail.type === "reasoning.text" && typeof detail.text === "string")
                        detailText.add(detail.text);
                    if (detail.type === "reasoning.summary" && typeof detail.summary === "string")
                        detailText.add(detail.summary);
                }
            }
        }
        if (["reasoning", "thinking", "redacted_thinking"].includes(String(part.type))) {
            hasReasoning = true;
            const visible =
                part.type === "redacted_thinking" || part.redacted === true
                    ? ""
                    : typeof part.thinking === "string"
                      ? part.thinking
                      : typeof part.text === "string"
                        ? part.text
                        : "";
            if (visible !== "[cleared]") text += visible;
            // An empty reasoning part may contain only provider-specific encrypted metadata.
            opaque ||=
                part.type === "redacted_thinking" ||
                part.redacted === true ||
                (visible === "" &&
                    (part.metadata !== undefined ||
                        part.signature !== undefined ||
                        part.thinkingSignature !== undefined));
        } else if (part.type === "text" && typeof part.text === "string") {
            for (const match of part.text.matchAll(
                /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/gi,
            ))
                inlineText += match[1];
        }
    }
    return { text: text || [...detailText].join(""), inlineText, opaque, hasReasoning };
}

export function opencodeReasoningBudgetCutoff(args: {
    messages: MessageLike[];
    messageTagNumbers: ReadonlyMap<MessageLike, number>;
    budget: number;
    alreadyRemoved?: ReadonlySet<string>;
    alsoGone?: ReadonlySet<string>;
    textEstimateByMessageId?: ReadonlyMap<string, number>;
    proseRatio?: number;
    countNeutralized?: boolean;
    anthropic?: boolean;
    frozenMergedIds?: ReadonlySet<string>;
}): number {
    const assistants = args.messages.filter((message) => message.info.role === "assistant");
    const newest = assistants.at(-1);
    const exempt = findLatestAssistantReasoningMutationExemptMessage(args.messages);
    return reasoningBudgetCutoff(
        assistants.map((message) => ({
            tag: args.messageTagNumbers.get(message) ?? 0,
            exempt:
                message === newest ||
                message === exempt ||
                isInActiveAnthropicTurn(
                    args.messages,
                    args.messages.indexOf(message),
                    args.anthropic ?? hasAnthropicReasoning(args.messages),
                ),
            cost: () => {
                const costMessage = { ...message, parts: [...message.parts] };
                if (args.frozenMergedIds)
                    stripReasoningFromMergedAssistants([costMessage], "anthropic", {
                        frozenMessageIds: args.frozenMergedIds,
                    });
                const visible = reasoningTextAndOpaque(
                    args.countNeutralized
                        ? costMessage.parts.map(neutralizedReasoningSource)
                        : costMessage.parts,
                );
                if (!visible.hasReasoning && !visible.inlineText) return 0;
                const info = message.info as unknown as Record<string, unknown>;
                const tokens = isRecord(info.tokens) ? info.tokens.reasoning : undefined;
                const typedGone =
                    typeof message.info.id === "string" &&
                    (args.alreadyRemoved?.has(message.info.id) === true ||
                        args.alsoGone?.has(message.info.id) === true);
                return (
                    (visible.hasReasoning && !typedGone
                        ? reasoningStepCost(
                              typeof tokens === "number" ? tokens : undefined,
                              estimateTokens(visible.text) * (args.proseRatio ?? 1),
                              visible.opaque,
                          )
                        : 0) +
                    Math.ceil(estimateTokens(visible.inlineText) * (args.proseRatio ?? 1))
                );
            },
        })),
        args.budget,
    );
}
