import { isRecord } from "../../shared/record-type-guard";
import { isInActiveAnthropicTurn } from "./active-anthropic-turn";
import { removeReasoningParts } from "./reasoning-removal";
import { isAnthropicFamilyRoute } from "./sentinel";
import {
    stripClearedReasoning,
    stripReasoningFromAssistantIds,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import type { MessageLike, TagTarget } from "./tag-messages";

const THINKING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

function role(message: unknown): unknown {
    if (!isRecord(message)) return undefined;
    return isRecord(message.info) ? message.info.role : message.role;
}

function content(message: unknown): unknown {
    if (!isRecord(message)) return undefined;
    return Array.isArray(message.parts) ? message.parts : message.content;
}

/**
 * First index of the active Anthropic turn: everything after the last real user
 * request. Tool-result carriers and synthesized context messages do not end the
 * turn. The boundary itself comes from `isInActiveAnthropicTurn`, the single
 * definition shared with reasoning retention, so both lanes always agree on
 * which messages belong to the current turn. With no real user request the
 * active turn is empty.
 */
export function latestAssistantTurnStart(messages: readonly unknown[]): number {
    // Membership is monotonic (index > last real user), so binary search finds
    // the first member without a quadratic scan over long tool loops.
    let lo = 0;
    let hi = messages.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (isInActiveAnthropicTurn(messages, mid, true)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

/** Signed blocks are frozen for the whole tool loop, not just its newest step. */
export function latestAssistantTurnMessages<T>(messages: readonly T[]): Set<T> {
    return new Set(messages.slice(latestAssistantTurnStart(messages)));
}

export function hasActiveAnthropicThinkingTurn(
    messages: readonly unknown[],
    provider?: string,
    model?: string,
): boolean {
    const familyRoute = isAnthropicFamilyRoute(provider, model);
    for (const message of messages.slice(latestAssistantTurnStart(messages))) {
        if (role(message) !== "assistant") continue;
        const parts = content(message);
        if (!Array.isArray(parts)) continue;
        if (
            parts.some(
                (part) =>
                    isRecord(part) &&
                    THINKING_TYPES.has(String(part.type ?? part.kind)) &&
                    (familyRoute || (isRecord(part.metadata) && isRecord(part.metadata.anthropic))),
            )
        )
            return true;
    }
    return false;
}

/** First-application safety view. Never use this map for already-frozen replay. */
export function protectNewTagMutations(
    messages: MessageLike[],
    targets: Map<number, TagTarget>,
    protectedParts: ReadonlySet<unknown>,
    prefixBound: boolean,
): Map<number, TagTarget> {
    if (protectedParts.size === 0) return targets;
    const positions = new Map<unknown, number>();
    let ordinal = 0;
    for (const message of messages)
        for (const part of message.parts) positions.set(part, ordinal++);
    let lastProtected = -1;
    for (const part of protectedParts)
        lastProtected = Math.max(lastProtected, positions.get(part) ?? -1);
    const result = new Map<number, TagTarget>();
    for (const [tag, target] of targets) {
        const coordinates =
            target.mutationParts ??
            (target.message
                ? target.message.parts.map((part) => ({ message: target.message!, part }))
                : []);
        const prefixEdit =
            prefixBound &&
            coordinates.some(({ part }) => (positions.get(part) ?? Infinity) < lastProtected);
        const dropsThinking =
            target.dropReasoningParts?.some((part) => protectedParts.has(part)) === true;
        if (!prefixEdit && !dropsThinking) {
            result.set(tag, target);
            continue;
        }
        result.set(tag, {
            ...target,
            thinkingDropProtected: true,
            thinkingRewriteProtected: prefixEdit,
            canDrop: () => false,
            drop: () => "incomplete",
            truncate: () => "incomplete",
            skeletonReal: () => "incomplete",
            skeletonStripped: () => "incomplete",
            editMarker: () => "incomplete",
            editMarkerStripped: () => "incomplete",
            setContent: (content, options) =>
                prefixEdit || options?.keepReasoning !== true
                    ? false
                    : target.setContent(content, options),
        });
    }
    return result;
}

/** Discover retained active thinking after reproducing only persisted decisions. */
export function retainedActiveThinkingParts(args: {
    messages: MessageLike[];
    providerID?: string;
    modelID?: string;
    mergedIds: ReadonlySet<string>;
    bindingIds: ReadonlySet<string>;
    removedIds?: ReadonlySet<string>;
}): Set<unknown> {
    if (!hasActiveAnthropicThinkingTurn(args.messages, args.providerID, args.modelID))
        return new Set();
    const copies = args.messages.map((message) => ({
        info: message.info,
        parts: message.parts.map((part) => {
            if (
                !isRecord(part) ||
                THINKING_TYPES.has(String(part.type)) ||
                !isRecord(part.metadata)
            )
                return part;
            return {
                ...part,
                metadata: {
                    ...part.metadata,
                    ...(isRecord(part.metadata.openrouter)
                        ? { openrouter: { ...part.metadata.openrouter } }
                        : {}),
                },
            };
        }),
    }));
    stripClearedReasoning(copies);
    stripReasoningFromAssistantIds(copies, args.providerID, args.bindingIds);
    stripReasoningFromMergedAssistants(copies, args.providerID, {
        frozenMessageIds: args.mergedIds,
    });
    if (args.removedIds?.size) removeReasoningParts(copies, args.removedIds, args.providerID);
    const retained = new Set<unknown>();
    for (let i = latestAssistantTurnStart(args.messages); i < copies.length; i++) {
        for (const part of copies[i].parts) {
            if (isRecord(part) && THINKING_TYPES.has(String(part.type))) retained.add(part);
        }
    }
    return retained;
}
