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

/**
 * Whether the host puts this assistant row on the wire. A row the host drops
 * is not part of any turn the provider sees. OpenCode 1 drops a row carrying
 * an error unless the error is an abort and the row holds more than step
 * markers and reasoning. Pi drops rows that stopped on an error or an abort.
 * OpenCode 2 hands a failed row over with no content. A row with no content
 * sends nothing on any host.
 */
export function isSentAssistantMessage(message: unknown): boolean {
    if (!isRecord(message) || role(message) !== "assistant") return false;
    const parts = content(message);
    if (!Array.isArray(parts) || parts.length === 0) return false;
    if (message.stopReason === "error" || message.stopReason === "aborted") return false;
    const error = isRecord(message.info) ? message.info.error : undefined;
    if (error === undefined || error === null) return true;
    return (
        isRecord(error) &&
        error.name === "MessageAbortedError" &&
        parts.some(
            (part) => isRecord(part) && part.type !== "step-start" && part.type !== "reasoning",
        )
    );
}

/**
 * Message roles Pi and oh-my-pi put on the wire as a user message (their
 * `convertToLlm`, and oh-my-pi's Anthropic adapter, which sends `developer`
 * as a user message). Pi drops a `bashExecution` or `pythonExecution` marked
 * `excludeFromContext`.
 */
const PI_USER_ON_WIRE_ROLES = new Set([
    "user",
    "developer",
    "custom",
    "hookMessage",
    "bashExecution",
    "pythonExecution",
    "fileMention",
    "branchSummary",
    "compactionSummary",
]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "toolResult", "tool-result"]);

/**
 * Whether the host sends this message to the provider as a user message with
 * content other than tool results, which is what ends an assistant turn for
 * the provider. Unlike `isRealUserRequest`, a message the host or a plugin
 * wrote counts: OpenCode sends synthetic text parts (it leaves out only
 * `ignored` and empty ones), and Pi sends extension, bash and summary messages
 * as user messages.
 */
export function isUserMessageOnWire(message: unknown): boolean {
    if (!isRecord(message)) return false;
    if (isRecord(message.info)) {
        if (message.info.role !== "user" || !Array.isArray(message.parts)) return false;
        return message.parts.some(
            (part) =>
                isRecord(part) &&
                part.ignored !== true &&
                !TOOL_RESULT_TYPES.has(String(part.type)) &&
                !(part.type === "text" && part.text === ""),
        );
    }
    if (!PI_USER_ON_WIRE_ROLES.has(String(message.role))) return false;
    if (message.excludeFromContext === true) return false;
    if (message.role !== "user") return true;
    if (typeof message.content === "string") return message.content.length > 0;
    return (
        Array.isArray(message.content) &&
        message.content.some(
            (block) => !isRecord(block) || !TOOL_RESULT_TYPES.has(String(block.type)),
        )
    );
}

/** Where the provider's latest assistant turn lies in a request array. */
export interface ProviderLatestTurn {
    /** First message after the real user request that opened the turn (0 with none). */
    start: number;
    /** The turn's first assistant message the host sends. */
    first: number;
    /** The turn's last assistant message the host sends. */
    last: number;
    /** Exclusive end: the next real user request after the turn, or the array length. */
    end: number;
}

/**
 * The assistant turn Anthropic checks when it requires the latest assistant
 * turn's thinking to stay exactly as it was produced: the last run of assistant
 * messages and tool-result carriers in the request, opened by a user message
 * on the wire (see `isUserMessageOnWire`). Real user messages after that run
 * do not end the check: a request ending in a new user message is still
 * checked against the assistant turn before it. This differs from
 * `latestAssistantTurnStart`, which is the open turn (everything after the last
 * real user request, not counting messages the host or a plugin wrote) and is
 * empty once a new user message arrives. Assistant rows the host does not send
 * (see `isSentAssistantMessage`) never open or extend a turn. Undefined when the
 * request has no assistant message the host sends.
 */
export function providerLatestTurn(messages: readonly unknown[]): ProviderLatestTurn | undefined {
    let last = messages.length - 1;
    while (last >= 0 && !isSentAssistantMessage(messages[last])) last -= 1;
    if (last < 0) return undefined;
    let start = last;
    while (start > 0 && !isUserMessageOnWire(messages[start - 1])) start -= 1;
    let first = start;
    while (first < last && !isSentAssistantMessage(messages[first])) first += 1;
    let end = last + 1;
    while (end < messages.length && !isUserMessageOnWire(messages[end])) end += 1;
    return { start, first, last, end };
}

/**
 * True for a part the route serves as Anthropic thinking: any reasoning,
 * thinking or redacted-thinking part on an Anthropic-family route (the
 * Anthropic API, Bedrock, Vertex, Copilot), whatever metadata key the host
 * stores its signature under, and on any other route one that carries
 * Anthropic metadata.
 */
export function isAnthropicThinkingPart(
    part: unknown,
    familyRoute: boolean,
): part is Record<string, unknown> {
    return (
        isRecord(part) &&
        THINKING_TYPES.has(String(part.type ?? part.kind)) &&
        (familyRoute || (isRecord(part.metadata) && isRecord(part.metadata.anthropic)))
    );
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
        if (parts.some((part) => isAnthropicThinkingPart(part, familyRoute))) return true;
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
