import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
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
): { stripped: number; sentineledIds: string[] } {
    let stripped = 0;
    const sentineledIds: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        // Don't neutralize messages in the protected tail — they may contain
        // actionable info like background task IDs
        if (i >= protectedTailStart) continue;

        const msg = messages[i];
        if (msg.parts.length === 0) continue;

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
            msg.parts.push(makeSentinel(undefined));
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
export function stripDroppedPlaceholderMessages(messages: MessageLike[]): {
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
            msg.parts.push(makeSentinel(undefined));
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
    skipTypedReasoningCleanup = false,
): number {
    if (skipTypedReasoningCleanup) return 0;
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
    skipTypedReasoningCleanup = false,
): number {
    if (skipTypedReasoningCleanup) return 0;
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
 * See strip-structural-noise.ts for the cache-safety rationale. For
 * Anthropic/Bedrock, OpenCode's provider/transform.ts:65 drops empty text
 * parts before the wire, so the sentinel never reaches the provider — same
 * effective wire shape as the previous filter-based behavior but no
 * mid-pipeline array mutation.
 *
 * Gate: `skipTypedReasoningCleanup=true` short-circuits for providers whose
 * capability.interleaved.field requires typed reasoning_content on the wire
 * (Moonshot/Kimi).
 */
export function stripClearedReasoning(
    messages: MessageLike[],
    skipTypedReasoningCleanup = false,
): number {
    if (skipTypedReasoningCleanup) return 0;
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

export function truncateErroredTools(
    messages: MessageLike[],
    watermark: number,
    messageTagNumbers: Map<MessageLike, number>,
): number {
    let truncated = 0;
    for (let i = 0; i < messages.length; i++) {
        const maxTag = messageTagNumbers.get(messages[i]) ?? 0;
        if (maxTag > watermark) {
            continue;
        }

        for (const part of messages[i].parts) {
            if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) {
                continue;
            }
            if (part.state.status !== "error") {
                continue;
            }
            if (typeof part.state.error === "string" && part.state.error.length > 100) {
                part.state.error = `${part.state.error.slice(0, 100)}... [truncated]`;
                truncated++;
            }
        }
    }
    return truncated;
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
export function stripReasoningFromMergedAssistants(messages: MessageLike[]): number {
    let stripped = 0;
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
                // Skip sentinels — see comment above.
                if (isSentinel(part)) continue;
                // First non-metadata part found — is it reasoning-like?
                if (REASONING_PART_TYPES.has(partType)) {
                    keepIndex = i;
                }
                break;
            }
        }

        // Forward pass: neutralize all reasoning/thinking/redacted_thinking
        // parts except the one we decided to keep (if any). Replace in place
        // with empty-text sentinels so message.parts length stays constant
        // across passes — preserving cache-prefix stability for proxy
        // providers that hash the message array. For Anthropic, OpenCode's
        // provider/transform.ts:65 drops empty text parts before the wire,
        // so the "thinking-block must be at index 0" rule the AI SDK cares
        // about is still satisfied (the kept reasoning part is the only
        // non-empty content at its position, empty sentinels vanish).
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (!isRecord(part)) continue;
            if (!REASONING_PART_TYPES.has(part.type as string)) continue;
            if (i === keepIndex) {
                keptReasoningInRun = true;
                continue;
            }
            message.parts[i] = makeSentinel(part);
            stripped++;
        }

        prevRole = role;
    }

    return stripped;
}

/**
 * Neutralize large image-data-URL file parts on already-processed user
 * messages. Replaces them in place with empty-text sentinels so message
 * parts length stays constant between passes — cache-prefix stability on
 * proxy providers, unchanged wire shape on Anthropic/Bedrock where
 * OpenCode's upstream filter drops empty text parts.
 */
export function stripProcessedImages(
    messages: MessageLike[],
    watermark: number,
    messageTagNumbers: Map<MessageLike, number>,
): number {
    let stripped = 0;
    let hasAssistantResponse = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant") {
            hasAssistantResponse = true;
            continue;
        }
        if (msg.info.role !== "user" || !hasAssistantResponse) {
            continue;
        }

        const maxTag = messageTagNumbers.get(msg) ?? 0;
        if (maxTag > watermark) {
            continue;
        }

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
            }
        }
    }

    return stripped;
}
