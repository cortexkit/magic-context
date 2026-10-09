// Budget-selected removal of whole reasoning parts for providers other than
// canonical Anthropic.
//
// Canonical Anthropic keeps its older lane (clearOldReasoning writes
// "[cleared]", stripClearedReasoning swaps in an empty sentinel that OpenCode's
// Anthropic adapter drops). Other adapters would send "[cleared]" or an empty
// block as content, and on OpenAI Responses the encrypted reasoning payload
// lives in the part's provider metadata, so rewriting text would not shrink
// the request at all. This lane removes the whole part instead, together with
// any provider metadata it carries.
//
// Cache contract: new message ids are selected only on a pass that already
// rebuilds the provider cache and are persisted before any byte changes. Every
// pass, defer passes included, splices exactly the persisted set at final
// representation, after the lanes that address parts by index have run.
//
// The lane must never change bytes without taking content off the wire. A
// message whose reasoning payload would stay on the wire through some other
// part (see `reasoningPayloadLeavesWithParts`) is never selected.

import { isRecord } from "../../shared/record-type-guard";
import {
    isNeutralizedReasoningPart,
    makeWholeMessageSentinel,
    restoreNeutralizedReasoningPart,
} from "./sentinel";
import { findLatestAssistantReasoningMutationExemptMessage } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const REMOVABLE_REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

function isReasoningPart(part: unknown): boolean {
    return isRecord(part) && REMOVABLE_REASONING_TYPES.has(String(part.type));
}

/** A reasoning part, or one a drop neutralized on this pass (see sentinel.ts). */
function isReasoningOrNeutralized(part: unknown): boolean {
    return isReasoningPart(part) || isNeutralizedReasoningPart(part);
}

/**
 * True when the message keeps something the model provider will receive after
 * its reasoning is gone: non-empty visible text, a tool call, or a file.
 * Without that, removal would leave an empty assistant message, which some
 * adapters send as-is.
 */
function hasWireContentBesideReasoning(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (!isRecord(part) || part.ignored === true) return false;
        if (part.type === "tool" || part.type === "file") return true;
        return part.type === "text" && typeof part.text === "string" && part.text.trim() !== "";
    });
}

function newestAssistant(messages: MessageLike[]): MessageLike | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === "assistant") return messages[index];
    }
    return undefined;
}

/** `metadata.openrouter.reasoning_details` of a part, when present. */
function openRouterReasoningDetails(part: unknown): unknown[] | undefined {
    if (!isRecord(part) || !isRecord(part.metadata)) return undefined;
    const openrouter = part.metadata.openrouter;
    if (!isRecord(openrouter) || !Array.isArray(openrouter.reasoning_details)) return undefined;
    return openrouter.reasoning_details;
}

/**
 * Gemini's thought signatures ride OpenRouter's `reasoning_details` on the
 * tool call they sign, and Gemini needs them back for every function call of
 * the current turn. They are never removed. `format` is optional in the
 * adapter's schema, so a detail without one cannot be told apart from a Gemini
 * signature and is protected the same way.
 */
function isProtectedReasoningDetail(detail: unknown): boolean {
    if (!isRecord(detail)) return true;
    if (typeof detail.format !== "string") return true;
    return detail.format.startsWith("google-gemini");
}

/**
 * True when removing the message's reasoning parts takes its reasoning payload
 * off the wire. `@openrouter/ai-sdk-provider` stores its provider metadata
 * under `openrouter` and sends the message's `reasoning_details` taken first
 * from the tool-call parts, and only then from the reasoning part, so a removal
 * must strip the tool-call copies too. The adapter is recognized by that
 * metadata, not by the provider id, which a user may choose freely. When a copy
 * holds a Gemini signature (or a detail without a format), which must stay, the
 * message is not removable at all.
 */
function reasoningPayloadLeavesWithParts(message: MessageLike): boolean {
    for (const part of message.parts) {
        const details = openRouterReasoningDetails(part);
        if (details?.some(isProtectedReasoningDetail)) return false;
    }
    return true;
}

/** Remove OpenRouter `reasoning_details` copies from the message's other parts. */
function stripOpenRouterReasoningDetails(message: MessageLike): number {
    let stripped = 0;
    for (const part of message.parts) {
        if (!openRouterReasoningDetails(part)) continue;
        const metadata = (part as { metadata: Record<string, unknown> }).metadata;
        const { reasoning_details: _removed, ...rest } = metadata.openrouter as Record<
            string,
            unknown
        >;
        metadata.openrouter = rest;
        stripped += 1;
    }
    return stripped;
}

/**
 * Pick assistant message ids whose reasoning should be removed on this
 * rebuilding pass. Pure; the caller persists the result before applying it.
 *
 * A message qualifies when its tag is at most the frozen budget cutoff, it
 * carries a reasoning part (or one a drop neutralized), it is not the newest
 * assistant (nor the newest one with replayable content), it keeps wire
 * content after removal, and removal actually takes its reasoning payload off
 * the wire on this route.
 *
 * Prefix-bound models (`prefixBound`: Fable 5.1, Opus 5.5, Sonnet 5.5, on any
 * route) select only a contiguous oldest prefix. Anthropic's preserved-thinking
 * page ("What counts as an edit") lists "Remove `thinking` blocks from the
 * start of the history, from the end, or all of them" as valid, but "Remove a
 * `thinking` block from the middle of the history and keep later ones" as
 * invalid for every later thinking block. The walk therefore goes oldest
 * first, passes over messages whose reasoning is already gone (`alreadyRemoved`
 * or `alsoGone`), and stops at the first reasoning-bearing message it may not
 * remove, so the removed set never has a gap.
 */
export function selectReasoningRemovals(args: {
    messages: MessageLike[];
    messageTagNumbers: Map<MessageLike, number>;
    cutoff: number;
    alreadyRemoved: ReadonlySet<string>;
    prefixBound: boolean;
    /**
     * Assistants whose reasoning another lane already took off the wire for
     * good (the binding-mismatch strip set). Only the prefix walk reads it.
     */
    alsoGone?: ReadonlySet<string>;
    protectedMessages?: ReadonlySet<MessageLike>;
}): string[] {
    const cutoff = args.cutoff;
    if (cutoff <= 0) return [];

    const newest = newestAssistant(args.messages);
    const exempt = findLatestAssistantReasoningMutationExemptMessage(args.messages);
    const selected: string[] = [];
    for (const message of args.messages) {
        if (message.info.role !== "assistant") continue;
        if (!message.parts.some(isReasoningOrNeutralized)) continue;
        const id =
            typeof message.info.id === "string" && message.info.id.length > 0
                ? message.info.id
                : undefined;
        if (
            id !== undefined &&
            (args.alreadyRemoved.has(id) || (args.prefixBound && args.alsoGone?.has(id)))
        )
            continue;
        const tag = args.messageTagNumbers.get(message) ?? 0;
        const removable =
            !args.protectedMessages?.has(message) &&
            id !== undefined &&
            message !== newest &&
            message !== exempt &&
            tag > 0 &&
            tag <= cutoff &&
            hasWireContentBesideReasoning(message) &&
            reasoningPayloadLeavesWithParts(message);
        if (removable && id !== undefined) selected.push(id);
        // On a prefix-bound model a block left in place here would sit before
        // every block removed after it: a removal from the middle.
        else if (args.prefixBound) break;
    }
    return selected;
}

/**
 * Splice every reasoning part (including drop-neutralized ones) out of the
 * assistant messages named in `ids`, on every pass. First selection protects
 * active thinking, but replay must not restore a saved removal when a host
 * subset makes that assistant newest or active again. On OpenRouter the message's
 * `reasoning_details` copies leave with it. When an earlier drop has already
 * emptied a message, a whole-message placeholder keeps it from being sent
 * empty.
 */
export function removeReasoningParts(
    messages: MessageLike[],
    ids: ReadonlySet<string>,
    providerID: string | undefined,
): number {
    if (ids.size === 0) return 0;
    let removed = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const id = message.info.id;
        if (typeof id !== "string" || !ids.has(id)) continue;
        if (!reasoningPayloadLeavesWithParts(message)) continue;
        const before = message.parts.length;
        const kept = message.parts.filter((part) => !isReasoningOrNeutralized(part));
        if (kept.length === before) continue;
        removed += before - kept.length;
        message.parts.length = 0;
        message.parts.push(...kept);
        stripOpenRouterReasoningDetails(message);
        if (!hasWireContentBesideReasoning(message)) {
            message.parts.push(makeWholeMessageSentinel(providerID));
        }
    }
    return removed;
}

/**
 * How reasoning neutralized by a drop is served on a route other than
 * canonical Anthropic (which keeps the empty sentinel its adapter drops):
 *
 * - `restore`: put the original part back. A drop leaves reasoning to the age
 *   lane, as Pi and Rust do. The tag lane links a tool to the reasoning of
 *   the step before it, so removing that reasoning would take an unrelated
 *   block off the wire.
 * - `legacy`: put the original part back with `[cleared]` written into its
 *   text, exactly the bytes served before this lane existed. Used only until a
 *   session's first rebuilding pass after upgrade, and when the provider is
 *   unresolved, so the change first lands on a pass that already rebuilds.
 */
export type DroppedReasoningMode = "restore" | "legacy";

export function settleDroppedReasoningParts(
    messages: MessageLike[],
    mode: DroppedReasoningMode,
): number {
    let settled = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (const part of message.parts) {
            if (!isNeutralizedReasoningPart(part)) continue;
            if (restoreNeutralizedReasoningPart(part, mode === "legacy")) settled += 1;
        }
    }
    return settled;
}
