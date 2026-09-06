import {
    MERGED_REASONING_PARTS_PREFIX,
    readFrozenMergedReasoningParts,
} from "../../features/magic-context/merged-reasoning-decisions";
import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel, makeWholeMessageSentinel } from "./sentinel";
import { stripWellFormedLeadingTagPrefix } from "./tag-content-primitives";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

const DROPPED_PLACEHOLDER_PATTERN = /^\[dropped §\d+§\]$/;
const TAG_PREFIX_PATTERN = /^§\d+§\s*/;

// Patterns that identify system-injected messages (notifications, reminders, etc.)
// These should never reach the LLM — they're internal plumbing.
const SYSTEM_INJECTION_PATTERNS = [
    /^<!-- OMO_INTERNAL_INITIATOR -->$/,
    /^<system-reminder>[\s\S]*<\/system-reminder>$/,
    /^\[SYSTEM DIRECTIVE:/,
    /^\[Category\+Skill Reminder\]/,
    /^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/,
    /^\[task CALL FAILED/,
    /^\[EMERGENCY CONTEXT WINDOW WARNING\]/,
];

function isSystemInjectedText(text: string): boolean {
    // Remove §N§ tag prefix that our tagger adds
    const stripped = text.trim().replace(TAG_PREFIX_PATTERN, "").trim();
    if (stripped.length === 0) return false;
    return SYSTEM_INJECTION_PATTERNS.some((pattern) => pattern.test(stripped));
}

/**
 * Neutralize system-injected messages (notifications, reminders, internal markers).
 * These are internal plumbing messages that should never reach the LLM.
 * Only neutralizes messages BEFORE `protectedTailStart` — recent messages in the
 * protected tail may contain actionable info (e.g., background task completion
 * notifications with task IDs the agent needs for background_output).
 *
 * Returns both the count of neutralized messages and the set of their IDs so
 * callers can persist-and-replay the decision across defer passes (cache-safe
 * — OpenCode rebuilds messages from its DB every turn, so the sentinel needs
 * to be re-applied each transform).
 *
 * Cache safety: replaces each matched message's parts with a single empty-text
 * sentinel instead of splicing the message out of the array. Preserves array
 * length so proxy providers that hash message-array structure see a stable
 * prefix. For Anthropic/Bedrock, the provider's upstream filter drops
 * empty-content messages on the wire anyway — same effective behavior, no
 * mid-pipeline array mutation.
 */
export function stripSystemInjectedMessages(
    messages: MessageLike[],
    protectedTailStart: number,
    providerID?: string,
): { stripped: number; sentineledIds: string[] } {
    let stripped = 0;
    const sentineledIds: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        // Don't neutralize messages in the protected tail — they may contain
        // actionable info like background task IDs
        if (i >= protectedTailStart) continue;

        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        // Never neutralize user-role messages — they anchor turn boundaries
        // that AI SDK depends on to avoid merging consecutive assistants.
        if (msg.info.role === "user") continue;

        // Skip messages already reduced to a lone sentinel — idempotent on replay
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;

        let hasContentPart = false;
        let allContentIsSystemInjection = true;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            // Skip metadata parts
            if (METADATA_PART_TYPES.has(partType)) continue;

            // Check for ignored flag (set by sendIgnoredMessage)
            if (part.ignored === true) continue;

            // Tool parts are real content
            if (partType === "tool") {
                allContentIsSystemInjection = false;
                break;
            }

            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                if (!isSystemInjectedText(part.text)) {
                    allContentIsSystemInjection = false;
                    break;
                }
                continue;
            }

            // Any other content type — keep the message
            allContentIsSystemInjection = false;
            break;
        }

        if (hasContentPart && allContentIsSystemInjection) {
            msg.parts.length = 0;
            msg.parts.push(makeWholeMessageSentinel(providerID));
            stripped++;
            if (typeof msg.info.id === "string") sentineledIds.push(msg.info.id);
        }
    }
    return { stripped, sentineledIds };
}

// OpenCode messages can have metadata parts alongside content parts.
// Only text/reasoning/tool/file parts carry content to the model — metadata
// parts are invisible to the LLM. We skip these when deciding if a message
// is nothing but dropped placeholders.
//
// NOTE: `file` is NOT in this set because file parts carry real content
// (pasted images, attached documents, etc.) that reaches the model via a
// provider-specific content block. Treating a file part as metadata would
// risk stripping an image-bearing message if its text part became a dropped
// placeholder, silently destroying the user's visual context.
const METADATA_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

/**
 * Neutralize messages that consist entirely of [dropped §N§] placeholders.
 * These are leftover shells after ctx_reduce drops their content — keeping
 * their original text wastes tokens without providing any value since there
 * is no recall mechanism.
 *
 * User-role messages are NEVER neutralized, even if their only text is a
 * dropped placeholder. Removing (or emptying) a user message between two
 * assistants collapses the turn boundary, which causes the AI SDK's Anthropic
 * adapter to merge consecutive assistants into a single "latest assistant"
 * block containing signed thinking. The merged block's signature no longer
 * matches the original, triggering:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 *
 * For user messages whose content the agent wanted to drop, apply-operations
 * emits a `[truncated §N§]` preview instead of a full `[dropped §N§]`, which
 * keeps the shell visible and preserves the turn boundary.
 *
 * Cache safety: replaces matched messages' parts with a single empty-text
 * sentinel instead of splicing the messages out of the array. Preserves array
 * length so proxy providers that hash message-array structure see a stable
 * prefix. For Anthropic/Bedrock, OpenCode's upstream filter drops empty
 * content messages on the wire — same effective behavior, no mid-pipeline
 * array mutation.
 *
 * Returns both count and sentineled IDs so callers can persist-and-replay.
 */
export function stripDroppedPlaceholderMessages(
    messages: MessageLike[],
    providerID?: string,
): {
    stripped: number;
    sentineledIds: string[];
} {
    let stripped = 0;
    const sentineledIds: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.parts.length === 0) continue;

        // Never neutralize user-role messages — they anchor turn boundaries
        // that AI SDK depends on to avoid merging consecutive assistants.
        if (msg.info.role === "user") continue;

        // Skip messages already reduced to a lone sentinel — idempotent on replay
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;

        let hasContentPart = false;
        let hasNonDroppedContent = false;

        for (const part of msg.parts) {
            if (!isRecord(part)) continue;
            const partType = part.type as string;

            // Skip metadata parts — they don't reach the model
            if (METADATA_PART_TYPES.has(partType)) continue;

            // Tool parts carry content — don't strip messages with tool calls/results
            if (partType === "tool") {
                hasNonDroppedContent = true;
                break;
            }

            // Text parts: check if they're only dropped placeholders
            if (partType === "text" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                if (!trimmed.includes("[dropped §")) {
                    hasNonDroppedContent = true;
                    break;
                }
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            // Reasoning parts: check similarly
            if (partType === "reasoning" && typeof part.text === "string") {
                hasContentPart = true;
                const trimmed = part.text.trim();
                if (trimmed.length === 0) continue;
                if (!trimmed.includes("[dropped §")) {
                    hasNonDroppedContent = true;
                    break;
                }
                const allSegmentsDropped = trimmed
                    .split(/(?=\[dropped §)/)
                    .filter((s) => s.trim().length > 0)
                    .every((segment) => DROPPED_PLACEHOLDER_PATTERN.test(segment.trim()));
                if (!allSegmentsDropped) {
                    hasNonDroppedContent = true;
                    break;
                }
                continue;
            }

            // Unknown content-carrying part type — don't strip
            hasNonDroppedContent = true;
            break;
        }

        if (hasContentPart && !hasNonDroppedContent) {
            msg.parts.length = 0;
            msg.parts.push(makeWholeMessageSentinel(providerID));
            stripped++;
            if (typeof msg.info.id === "string") sentineledIds.push(msg.info.id);
        }
    }
    return { stripped, sentineledIds };
}

/**
 * Replay persisted reasoning clearing on every pass (including defer).
 * Clears reasoning for all messages with tag <= persistedWatermark.
 * This ensures clearing is sticky across passes even when OpenCode
 * rebuilds messages fresh from its own DB.
 */
export function replayClearedReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let cleared = 0;
    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }
    return cleared;
}

/**
 * Replay persisted inline thinking stripping on every pass (including defer).
 * Strips inline <thinking> tags for all messages with tag <= persistedWatermark.
 */
export function replayStrippedInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    persistedWatermark: number,
): number {
    if (persistedWatermark <= 0) return 0;

    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > persistedWatermark) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            // Both supported opening tags (`<think>` and `<thinking>`) share
            // this prefix, so one native scan can reject clean text before regex.
            if (!part.text.includes("<think")) continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

export function clearOldReasoning(
    messages: MessageLike[],
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>,
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let cleared = 0;

    for (const message of messages) {
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        const parts = reasoningByMessage.get(message);
        if (!parts) continue;

        for (const tp of parts) {
            if (tp.thinking !== undefined && tp.thinking !== "[cleared]") {
                tp.thinking = "[cleared]";
                cleared++;
            }
            if (tp.text !== undefined && tp.text !== "[cleared]") {
                tp.text = "[cleared]";
                cleared++;
            }
        }
    }

    return cleared;
}

function findMaxTag(messageTagNumbers: Map<MessageLike, number>): number {
    let max = 0;
    for (const tag of messageTagNumbers.values()) {
        if (tag > max) max = tag;
    }
    return max;
}

const CLEARED_REASONING_TYPES = new Set(["thinking", "reasoning"]);

/**
 * Neutralize cleared reasoning parts (those with thinking or text set to
 * "[cleared]" by clearOldReasoning). Replaces them in place with empty-text
 * sentinels so message.parts length stays constant between passes.
 *
 * See strip-structural-noise.ts for the cache-safety rationale. Caller contract:
 * run only when `modelAcceptsEmptyContent(providerID)` is true. OpenCode's
 * canonical Anthropic adapter filters empty text sentinels before the wire;
 * other adapters can forward them as real content blocks.
 */
export function stripClearedReasoning(messages: MessageLike[]): number {
    let stripped = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (!isRecord(part)) continue;
            const partType = part.type as string;
            if (!CLEARED_REASONING_TYPES.has(partType)) continue;
            // Defense-in-depth: if neither `thinking` nor `text` is present on
            // the part, we cannot tell whether it's a cleared shell — keep it.
            // This protects edge-case thinking shapes (e.g., future providers
            // emitting parts with only a `data` or `signature` field) from
            // being wrongly dropped. Anthropic requires thinking-like blocks in
            // the latest assistant message to be replayed unchanged, and an
            // undefined-fields part cannot be known to be cleared, so it is
            // not safe to strip it.
            if (!("thinking" in part) && !("text" in part)) continue;
            const thinking = "thinking" in part ? (part.thinking as string | undefined) : undefined;
            const text = "text" in part ? (part.text as string | undefined) : undefined;
            const isCleared =
                (thinking === undefined || thinking === "[cleared]") &&
                (text === undefined || text === "[cleared]");
            if (!isCleared) continue;
            message.parts[i] = makeSentinel(part);
            stripped++;
        }
    }
    return stripped;
}

const INLINE_THINKING_PATTERN = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

export function stripInlineThinking(
    messages: MessageLike[],
    messageTagNumbers: Map<MessageLike, number>,
    clearReasoningAge: number,
): number {
    const maxTag = findMaxTag(messageTagNumbers);
    if (maxTag === 0) return 0;

    const ageCutoff = maxTag - clearReasoningAge;
    let stripped = 0;

    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const msgTag = messageTagNumbers.get(message) ?? 0;
        if (msgTag === 0 || msgTag > ageCutoff) continue;

        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
            const cleaned = (part.text as string).replace(INLINE_THINKING_PATTERN, "");
            if (cleaned !== part.text) {
                part.text = cleaned;
                stripped++;
            }
        }
    }
    return stripped;
}

// Parts that the AI SDK ignores when converting OpenCode messages to the
// Anthropic request body. Treating them as invisible when deciding whether
// a reasoning part lands at the start of the eventual assistant block.
const REASONING_IGNORED_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

// Every part type that becomes an Anthropic thinking/redacted_thinking block
// on the wire. OpenCode's internal "reasoning" gets converted by @ai-sdk
// into a thinking block, while "thinking" and "redacted_thinking" are the
// wire-format types (seen on opus-4.7 with interleaved thinking). All three
// must be considered when deciding which to keep/strip so the merged
// Anthropic block ends with thinking at position 0 and at most one present.
const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

function hasReasoningReplayContent(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (!isRecord(part) || part.ignored === true) return false;
        const type = typeof part.type === "string" ? part.type : "";
        if (REASONING_IGNORED_PART_TYPES.has(type)) return false;
        return type !== "text" || typeof part.text !== "string" || part.text.trim().length > 0;
    });
}

/**
 * Return the newest assistant that is visible in the provider replay. OpenCode may append a
 * metadata-only request shell; the adapter drops that shell, so it cannot own the exemption for
 * the completed assistant whose signed reasoning is actually replayed last.
 */
export function findNewestReasoningBearingAssistantId(messages: MessageLike[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role !== "assistant") continue;
        if (
            !message.parts.some(
                (part) => isRecord(part) && REASONING_PART_TYPES.has(String(part.type)),
            )
        ) {
            continue;
        }
        const id = message.info.id;
        if (typeof id === "string" && id.length > 0) return id;
    }
    return undefined;
}

export function assistantHasReasoningPart(messages: MessageLike[], messageId: string): boolean {
    return messages.some(
        (message) =>
            message.info.role === "assistant" &&
            message.info.id === messageId &&
            message.parts.some(
                (part) => isRecord(part) && REASONING_PART_TYPES.has(String(part.type)),
            ),
    );
}

export function findLatestAssistantReasoningMutationExemptMessage(
    messages: MessageLike[],
): MessageLike | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role === "assistant" && hasReasoningReplayContent(message)) return message;
    }
    return undefined;
}

interface MergedReasoningStripPlan {
    message: MessageLike;
    stripIndices: number[];
}

function planMergedAssistantReasoningStrip(
    messages: MessageLike[],
    mutationExemptMessage?: MessageLike,
    frozenMessageIds?: ReadonlySet<string>,
): MergedReasoningStripPlan[] {
    const plan: MergedReasoningStripPlan[] = [];
    let prevRole: string | undefined;
    let keptReasoningInRun = false;

    for (const message of messages) {
        const role = message.info.role;

        if (role !== "assistant") {
            prevRole = role;
            keptReasoningInRun = false;
            continue;
        }

        const firstInRun = prevRole !== "assistant";
        if (firstInRun) keptReasoningInRun = false;

        if (message === mutationExemptMessage || frozenMessageIds?.has(message.info.id ?? "")) {
            prevRole = role;
            continue;
        }

        // Determine which reasoning/thinking part (if any) to KEEP for this
        // run. Only eligible: the first assistant in a run, no reasoning
        // kept yet, AND the first non-metadata content part is a
        // reasoning/thinking/redacted_thinking part.
        //
        // Sentinels (from stripStructuralNoise and other in-place strips) are
        // `{type:"text", text:""}` and occupy positions previously held by
        // structural-noise parts. They are invisible on the wire (OpenCode's
        // provider transform drops empty text) so the "first non-metadata" rule
        // must treat them as equivalent to the structural parts they replaced
        // — otherwise a reasoning part that would have been first-after-strip
        // is wrongly considered non-first and gets neutralized, stripping the
        // last thinking from a run that has one eligible to keep.
        let keepIndex = -1;
        if (firstInRun && !keptReasoningInRun) {
            for (let i = 0; i < message.parts.length; i++) {
                const part = message.parts[i];
                if (!isRecord(part)) continue;
                const partType = part.type as string;
                if (REASONING_IGNORED_PART_TYPES.has(partType)) continue;
                if (part.ignored === true) continue;
                if (isSentinel(part)) continue;
                // Anthropic has already accepted newest assistants with a leading
                // whitespace block before thinking. Treat that wire-invisible text
                // like a sentinel so losing newest status does not change the rule.
                if (
                    partType === "text" &&
                    typeof part.text === "string" &&
                    part.text.trim() === ""
                ) {
                    continue;
                }
                if (REASONING_PART_TYPES.has(partType)) {
                    keepIndex = i;
                }
                break;
            }
        }

        const stripIndices: number[] = [];
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (!isRecord(part)) continue;
            if (!REASONING_PART_TYPES.has(part.type as string)) continue;
            if (part.cache_control !== undefined) continue;
            if (i === keepIndex) {
                keptReasoningInRun = true;
                continue;
            }
            stripIndices.push(i);
        }
        if (stripIndices.length > 0) plan.push({ message, stripIndices });

        prevRole = role;
    }

    return plan;
}

export type TrailingBlankDecision = "keep" | `keep:${number}` | "strip";
export type TrailingBlankSourceDecisions = ReadonlyMap<string, TrailingBlankDecision>;

const MAX_FROZEN_TRAILING_BLANKS = 10_000;
const CANONICAL_BLANK_PART = { type: "text", text: "" } as const;

function isSentinelInvisibleTextPart(part: unknown): boolean {
    return (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        stripWellFormedLeadingTagPrefix(part.text).trim() === ""
    );
}

function isCanonicalBlankPart(part: unknown): boolean {
    return (
        isRecord(part) && Object.keys(part).length === 2 && part.type === "text" && part.text === ""
    );
}

function trailingBlankKeepCount(decision: TrailingBlankDecision): number | undefined {
    if (decision === "keep") return 1;
    if (!decision.startsWith("keep:")) return undefined;
    const countText = decision.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return undefined;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 0 && count <= MAX_FROZEN_TRAILING_BLANKS
        ? count
        : undefined;
}

function trailingBlankDecisionForMessage(
    message: MessageLike,
): readonly [string, TrailingBlankDecision] | undefined {
    const id = message.info.id;
    if (message.info.role !== "assistant" || typeof id !== "string" || id.length === 0) {
        return undefined;
    }
    let trailingCount = 0;
    while (
        trailingCount < message.parts.length &&
        isSentinelInvisibleTextPart(message.parts[message.parts.length - trailingCount - 1])
    ) {
        trailingCount += 1;
    }
    if (trailingCount > MAX_FROZEN_TRAILING_BLANKS && trailingCount < message.parts.length) {
        return undefined;
    }
    const decision: TrailingBlankDecision =
        message.parts.length === 0 || trailingCount === message.parts.length
            ? "keep"
            : trailingCount === 0
              ? "strip"
              : trailingCount === 1
                ? "keep"
                : `keep:${trailingCount}`;
    return [id, decision];
}

/** Capture trailing-blank shapes before Magic Context can insert synthetic parts. */
export function snapshotTrailingBlankSourceDecisions(
    messages: readonly MessageLike[],
): Map<string, TrailingBlankDecision> {
    const decisions = new Map<string, TrailingBlankDecision>();
    for (const message of messages) {
        const observed = trailingBlankDecisionForMessage(message);
        if (observed) decisions.set(...observed);
    }
    return decisions;
}

/**
 * Capture the representation served for each assistant before a provider can append
 * a late blank. A newest keep may refresh to another keep count or demote to strip,
 * but an established strip is absorbing. A harness blank that arrives after the first
 * serve is therefore stripped forever, keeping the suffix monotonic from streaming
 * through completion and historical replay. Once a later assistant appears, the last
 * served choice is immutable.
 *
 * Production callers supply sourceDecisions captured from the unmodified harness
 * input. That prevents sentinels, canonical blanks, and synthetic messages added by
 * Magic Context from becoming self-replaying observations.
 */
export function findTrailingBlankDecisionCandidates(
    messages: MessageLike[],
    frozenDecisions: ReadonlyMap<string, TrailingBlankDecision>,
    options?: {
        refreshMessageId?: string;
        sourceDecisions?: TrailingBlankSourceDecisions;
    },
): Array<readonly [string, TrailingBlankDecision]> {
    const observedDecisions =
        options?.sourceDecisions ?? snapshotTrailingBlankSourceDecisions(messages);
    const visibleIds = new Set(
        messages.flatMap((message) =>
            typeof message.info.id === "string" ? [message.info.id] : [],
        ),
    );
    const decisions: Array<readonly [string, TrailingBlankDecision]> = [];
    for (const [id, decision] of observedDecisions) {
        if (!visibleIds.has(id)) continue;
        const frozen = frozenDecisions.get(id);
        if (
            frozen !== undefined &&
            (id !== options?.refreshMessageId || frozen === decision || frozen === "strip")
        ) {
            continue;
        }
        decisions.push([id, decision]);
    }
    return decisions;
}

/**
 * Replay persisted choices after all other message mutations. Keep decisions
 * preserve the canonical blank suffix first served for that message; strip decisions
 * remove a blank suffix unless that would expose terminal reasoning. Applying strip
 * while the assistant is newest keeps its suffix unchanged from streaming, which has
 * no step-finish sentinel, through completion and later historical replays.
 */
export function applyFrozenTrailingBlankDecisions(
    messages: MessageLike[],
    frozenDecisions: ReadonlyMap<string, TrailingBlankDecision>,
): number {
    let mutations = 0;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        let message = messages[messageIndex];
        const id = message.info.id;
        if (message.info.role !== "assistant" || typeof id !== "string") continue;
        const decision = frozenDecisions.get(id);
        if (!decision) continue;

        let lastMeaningfulIndex = message.parts.length - 1;
        while (
            lastMeaningfulIndex >= 0 &&
            isSentinelInvisibleTextPart(message.parts[lastMeaningfulIndex])
        ) {
            lastMeaningfulIndex -= 1;
        }

        const replaceParts = (start: number, deleteCount: number, insertBlankCount: number) => {
            // OpenCode owns the hook's message objects. Copy the message and parts
            // array before a length-changing splice so normalization cannot delete
            // parts from another observer of the live request object graph.
            message = { ...message, parts: [...message.parts] };
            messages[messageIndex] = message;
            message.parts.splice(
                start,
                deleteCount,
                ...Array.from({ length: insertBlankCount }, () => ({ ...CANONICAL_BLANK_PART })),
            );
        };

        if (lastMeaningfulIndex < 0) {
            if (message.parts.length === 0) continue;
            if (message.parts.length !== 1 || !isCanonicalBlankPart(message.parts[0])) {
                mutations += Math.max(1, message.parts.length);
                replaceParts(0, message.parts.length, 1);
            }
            continue;
        }

        const trailingCount = message.parts.length - lastMeaningfulIndex - 1;
        const keepCount = trailingBlankKeepCount(decision);
        if (keepCount !== undefined) {
            // A keep decision may stabilize a blank suffix that the harness supplied,
            // but it must never recreate missing bytes. If a formerly present blank is
            // absent now, accepting this pass's cache bust prevents an insert-observe-
            // keep loop from manufacturing that blank forever.
            if (trailingCount === 0) continue;
            const blankIndex = lastMeaningfulIndex + 1;
            const suffixIsCanonical =
                trailingCount === keepCount &&
                message.parts.slice(blankIndex).every(isCanonicalBlankPart);
            if (!suffixIsCanonical) {
                mutations += Math.max(1, trailingCount, keepCount);
                replaceParts(blankIndex, trailingCount, keepCount);
            }
            continue;
        }

        if (trailingCount === 0) continue;
        const lastMeaningfulPart = message.parts[lastMeaningfulIndex];
        if (
            isRecord(lastMeaningfulPart) &&
            REASONING_PART_TYPES.has(lastMeaningfulPart.type as string)
        ) {
            const blankIndex = lastMeaningfulIndex + 1;
            if (trailingCount !== 1 || !isCanonicalBlankPart(message.parts[blankIndex])) {
                mutations += Math.max(1, trailingCount);
                replaceParts(blankIndex, trailingCount, 1);
            }
            continue;
        }
        mutations += trailingCount;
        replaceParts(lastMeaningfulIndex + 1, trailingCount, 0);
    }
    return mutations;
}

/**
 * Find the stable assistant message ids whose reasoning the current merge rule
 * would neutralize. The caller freezes these ids only on a cache-busting pass;
 * replay uses the persisted set instead of rerunning membership detection.
 */
export function findMergedReasoningStripCandidateIds(
    messages: MessageLike[],
    providerID?: string,
    options?: { mutationExemptMessage?: MessageLike },
): string[] {
    if (providerID !== "anthropic") return [];

    const ids = new Set<string>();
    for (const entry of planMergedAssistantReasoningStrip(
        messages,
        options?.mutationExemptMessage,
    )) {
        const id = entry.message.info.id;
        if (typeof id === "string" && id.length > 0) ids.add(id);
    }
    return [...ids];
}

/**
 * Work around @ai-sdk/anthropic's groupIntoBlocks behavior plus opus-4.7's
 * strict thinking-block position validation.
 *
 * Two structural sources of invalid payloads exist, both triggering:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified. These blocks must remain as they were in the
 *    original response."
 *
 * (1) ACROSS assistants: @ai-sdk/anthropic's groupIntoBlocks merges
 *     consecutive OpenCode assistant messages into one Anthropic assistant
 *     block. Each source assistant's signed reasoning gets emitted as its
 *     own thinking block — the merged block ends up with thinking
 *     INTERLEAVED between text/tool_use.
 *
 * (2) WITHIN ONE assistant: opus-4.7 with interleaved thinking produces
 *     multiple reasoning parts in a single OpenCode assistant message
 *     (observed: up to 12 reasoning parts per message). AI SDK passes each
 *     through verbatim, again producing interleaved thinking.
 *
 * Both cases can coexist. The only layout opus-4.7 reliably accepts is:
 *   [thinking at index 0 (optional)] followed by text/tool_use only,
 * i.e. AT MOST ONE thinking block per consecutive assistant run, and that
 * thinking block must be the very first non-metadata part.
 *
 * Rule enforced here:
 *   - For each consecutive assistant run, keep AT MOST ONE reasoning part.
 *   - That reasoning part must be the first non-metadata content part of
 *     the first assistant in the run. Otherwise strip all reasoning from
 *     the run.
 *   - Leave a supplied mutation-exempt assistant byte-identical. OpenCode
 *     uses this for the newest assistant because Anthropic requires its signed
 *     thinking and redacted-thinking blocks to be replayed unchanged.
 *   - When frozenMessageIds is supplied, mutate only those persisted ids. An
 *     empty set therefore performs replay without first-applying new candidates.
 *
 * Trade-off: the model loses visibility into its own intermediate-step
 * reasoning for multi-step turns. The first step's reasoning is preserved
 * when possible, which carries enough cache continuity for Anthropic.
 *
 * Upstream bug (track with smart note #38, remove this workaround when
 * fixed): @ai-sdk/anthropic's groupIntoBlocks +
 * convert-to-anthropic-messages-prompt.ts (case 'assistant'). Same class
 * fixed for Bedrock in vercel/ai#13583/#13972.
 */
export function stripReasoningFromAssistantIds(
    messages: MessageLike[],
    providerID: string | undefined,
    messageIds: ReadonlySet<string>,
): number {
    if (providerID !== "anthropic" || messageIds.size === 0) return 0;
    let stripped = 0;
    for (const message of messages) {
        const id = message.info.id;
        if (typeof id !== "string" || !messageIds.has(id)) continue;
        for (let index = 0; index < message.parts.length; index += 1) {
            const part = message.parts[index];
            if (!isRecord(part) || !REASONING_PART_TYPES.has(String(part.type))) continue;
            message.parts[index] = makeSentinel(part);
            stripped += 1;
        }
    }
    return stripped;
}

/**
 * Record which reasoning parts to remove before first application. Also retain
 * the plain message id for older readers that do not understand part selections.
 */
export function findMergedReasoningStripDecisions(
    messages: MessageLike[],
    providerID: string | undefined,
    frozenIds: ReadonlySet<string>,
    options?: { mutationExemptMessage?: MessageLike },
): string[] {
    if (providerID !== "anthropic") return [];
    const frozenParts = readFrozenMergedReasoningParts(frozenIds);
    const decisions: string[] = [];
    for (const entry of planMergedAssistantReasoningStrip(
        messages,
        options?.mutationExemptMessage,
        new Set(frozenParts.keys()),
    )) {
        const id = entry.message.info.id;
        if (typeof id !== "string" || id.length === 0 || frozenParts.has(id)) continue;
        const parts = entry.stripIndices.map((index) => {
            const part = entry.message.parts[index];
            return isRecord(part) && typeof part.id === "string" ? part.id : index;
        });
        decisions.push(id, MERGED_REASONING_PARTS_PREFIX + JSON.stringify([id, parts]));
    }
    return decisions;
}

export function stripReasoningFromMergedAssistants(
    messages: MessageLike[],
    providerID?: string,
    options?: {
        mutationExemptMessage?: MessageLike;
        frozenMessageIds?: ReadonlySet<string>;
    },
): number {
    // Anthropic-only workaround for @ai-sdk/anthropic's groupIntoBlocks
    // index-0-thinking rule. openai-compatible providers like Kimi/
    // Moonshot enforce the opposite invariant (every tool-call assistant
    // must have non-empty `reasoning_content`), so the strip would
    // trigger 400 "reasoning_content is missing" there. See call site
    // in transform.ts for the full rationale.
    if (providerID !== "anthropic") return 0;

    let stripped = 0;
    const frozenParts = readFrozenMergedReasoningParts(options?.frozenMessageIds ?? new Set());
    // Replay the exact persisted selection without reconsidering adjacency.
    // Dropping empty preceding assistants can make a stripped thinking part
    // look eligible to keep on the next request. Only legacy bare ids still
    // use that layout-dependent rule, preserving their pre-deployment bytes.
    for (const message of messages) {
        if (message === options?.mutationExemptMessage || message.info.role !== "assistant")
            continue;
        const parts = frozenParts.get(message.info.id ?? "");
        if (!parts) continue;
        for (let index = 0; index < message.parts.length; index += 1) {
            const part = message.parts[index];
            if (!isRecord(part) || !REASONING_PART_TYPES.has(String(part.type))) continue;
            if (!parts.includes(index) && !(typeof part.id === "string" && parts.includes(part.id)))
                continue;
            message.parts[index] = makeSentinel(part);
            stripped++;
        }
    }
    for (const entry of planMergedAssistantReasoningStrip(
        messages,
        options?.mutationExemptMessage,
        new Set(frozenParts.keys()),
    )) {
        if (options?.frozenMessageIds) {
            const id = entry.message.info.id;
            if (typeof id !== "string" || !options.frozenMessageIds.has(id)) continue;
        }
        // Replace in place with empty-text sentinels so message.parts length
        // stays stable. OpenCode filters these sentinels from Anthropic's wire.
        for (const index of entry.stripIndices) {
            entry.message.parts[index] = makeSentinel(entry.message.parts[index]);
            stripped++;
        }
    }

    return stripped;
}

export interface StripProcessedImagesResult {
    stripped: number;
    newlyStrippedIds: string[];
}

/**
 * Neutralize large image-data-URL file parts on already-processed user
 * messages, replacing them in place with empty-text sentinels (which the
 * Anthropic adapter then filters off the wire entirely).
 *
 * REPLAY/DETECT split — mirrors `dropStaleReduceCalls`, and for the same
 * reason. The empty sentinel is filtered for Anthropic, so the FIRST time a
 * message is sentinelized its image blocks VANISH from the wire — a real byte
 * change. The earlier "strip every pass when `maxTag <= watermark`" version
 * keyed that first-strip on the live watermark, which advances with tail
 * growth: a DEFER pass could newly cross an older image message and strip it
 * mid-prefix, busting the Anthropic cache on a pass that must replay
 * byte-identically (observed live — a processed-screenshot message lost its
 * images on a defer pass and collapsed the cached prefix). Freezing the id set
 * on cache-busting passes and replaying it everywhere removes the moving
 * boundary: DETECT (cache-busting passes only) finds newly-aged processed image
 * messages, strips them, and returns their ids to persist; REPLAY (every pass,
 * incl. defer) re-strips only already-frozen ids, byte-identical regardless of
 * how the live array grew.
 *
 * Caller contract: run only when `modelAcceptsEmptyContent(providerID)` is
 * true, because non-Anthropic adapters can forward the empty text replacement
 * to the wire.
 */
export function stripProcessedImages(
    messages: MessageLike[],
    frozenIds: Set<string>,
    options: {
        detect: boolean;
        watermark: number;
        messageTagNumbers: Map<MessageLike, number>;
    },
): StripProcessedImagesResult {
    const { detect, watermark, messageTagNumbers } = options;
    let stripped = 0;
    const newlyStrippedIds: string[] = [];
    let hasAssistantResponse = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant") {
            hasAssistantResponse = true;
            continue;
        }
        if (msg.info.role !== "user") {
            continue;
        }

        const id = typeof msg.info.id === "string" ? msg.info.id : undefined;
        const inFrozen = id !== undefined && frozenIds.has(id);
        // DETECT (cache-busting passes only): a processed (assistant-answered),
        // aged (maxTag <= watermark) user message not yet frozen.
        const maxTag = messageTagNumbers.get(msg) ?? 0;
        const isNewDetection =
            !inFrozen && detect && hasAssistantResponse && id !== undefined && maxTag <= watermark;

        if (!inFrozen && !isNewDetection) {
            continue;
        }

        let touchedThisMsg = false;
        for (let j = 0; j < msg.parts.length; j++) {
            const part = msg.parts[j];
            if (!isRecord(part) || part.type !== "file") {
                continue;
            }
            if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) {
                continue;
            }
            if (
                typeof part.url === "string" &&
                part.url.startsWith("data:") &&
                part.url.length > 200
            ) {
                msg.parts[j] = makeSentinel(part);
                stripped++;
                touchedThisMsg = true;
            }
        }
        if (touchedThisMsg && isNewDetection && id !== undefined) {
            newlyStrippedIds.push(id);
        }
    }

    return { stripped, newlyStrippedIds };
}
