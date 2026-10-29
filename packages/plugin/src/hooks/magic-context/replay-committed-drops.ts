import type { ContextDatabase } from "../../features/magic-context/storage";
import { getTagsBySession } from "../../features/magic-context/storage";
import { makeToolCompositeKey } from "../../features/magic-context/tagger";
import { recoveryReasoningPrefixes } from "../../shared/recovery-reasoning-prefix";
import { applyFlushedStatuses, renderDroppedText } from "./apply-operations";
import { isThinkingPart } from "./tag-content-primitives";
import type { MessageLike, TagTarget, ThinkingLikePart } from "./tag-messages";
import { isTextPart } from "./tag-part-guards";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";

/**
 * Apply stored dropped-tag decisions without new writes. Return false, leaving
 * messages untouched, if the edits would change bytes covered by kept reasoning
 * or remove reasoning without a persisted whole-turn omission decision.
 */
export function replayCommittedDrops(
    db: ContextDatabase,
    sessionId: string,
    messages: MessageLike[],
): boolean {
    const original = messages;
    const reasoningPrefixes = recoveryReasoningPrefixes(messages, "parts");
    if (reasoningPrefixes.length) messages = structuredClone(messages);
    const tags = getTagsBySession(db, sessionId).filter((tag) => tag.status === "dropped");
    const toolTags = new Map(
        tags
            .filter((tag) => tag.type === "tool")
            .map((tag) => [makeToolCompositeKey(tag.toolOwnerMessageId ?? "", tag.messageId), tag]),
    );
    const textTags = new Map(
        tags.filter((tag) => tag.type !== "tool").map((tag) => [tag.messageId, tag]),
    );
    const byNumber = new Map(tags.map((tag) => [tag.tagNumber, tag]));
    const index: ToolCallIndex = new Map();
    const owners = new Map<string, string[]>();
    // A result can span several messages. Retain its resolved invocation until
    // a new invocation of that call ID starts, rather than consuming ownership
    // with the first segment and treating the rest as independent arcs.
    const resolvedOwners = new Map<string, string>();
    const ambiguousCalls = new Set<string>();
    const targets = new Map<number, TagTarget>();
    let precedingThinking: ThinkingLikePart[] = [];
    const toolThinking = new Map<string, ThinkingLikePart[]>();
    const batch = new ToolMutationBatch(messages);
    for (const message of messages) {
        if (message.info.syntheticHead === true) continue;
        if (message.info.role === "user") precedingThinking = [];
        const thinking = message.parts.filter(isThinkingPart);
        for (let p = 0; p < message.parts.length; p++) {
            const part = message.parts[p];
            const observation = extractToolCallObservation(part);
            if (observation) {
                const { callId, kind } = observation;
                const pending = owners.get(callId) ?? [];
                if (pending.length > 1) ambiguousCalls.add(callId);
                const hostingKey = makeToolCompositeKey(message.info.id ?? "", callId);
                const owner =
                    kind === "invocation" ||
                    (part as { type: string }).type === "tool" ||
                    toolTags.has(hostingKey)
                        ? (message.info.id ?? "")
                        : (pending.shift() ?? resolvedOwners.get(callId) ?? message.info.id ?? "");
                if (kind === "invocation") pending.push(owner);
                else resolvedOwners.set(callId, owner);
                owners.set(callId, pending);
                const key = makeToolCompositeKey(owner, callId);
                if (message.info.role === "tool" && !toolThinking.has(key))
                    toolThinking.set(key, precedingThinking);
                const entry = index.get(key) ?? { occurrences: [], hasResult: false };
                entry.occurrences.push({ message, part, kind });
                entry.hasResult ||= kind === "result" && partHasCompletedResult(part);
                index.set(key, entry);
            } else {
                const prefix = isTextPart(part) ? /^§(\d+)§\s/.exec(part.text) : null;
                const tag =
                    (prefix ? byNumber.get(Number(prefix[1])) : undefined) ??
                    textTags.get(`${message.info.id}:p${p}`) ??
                    textTags.get(`${message.info.id}:file${p}`);
                if (tag && tag.type !== "tool")
                    targets.set(tag.tagNumber, {
                        message,
                        // Reduce source text even when marked synthetic, as the normal
                        // early drop phase does. Injected syntheticHead messages are
                        // excluded above. The normal late sweep skips synthetic parts
                        // that history preparation may repurpose; recovery instead
                        // reconciles a captured request with newly committed drops,
                        // preserving each part's captured annotation suffix.
                        setContent(content) {
                            if (isTextPart(part)) {
                                const rendered = renderDroppedText(tag.tagNumber, part.text);
                                if (part.text === rendered) return false;
                                part.text = rendered;
                            } else message.parts[p] = { type: "text", text: content };
                            return true;
                        },
                    });
            }
        }
        if (message.info.role === "assistant" && !message.parts.some(isTextPart))
            precedingThinking = thinking;
    }
    const arcsByCall = new Map<string, number>();
    for (const entry of index.values()) {
        const callId = extractToolCallObservation(entry.occurrences[0]?.part)?.callId ?? "";
        arcsByCall.set(callId, (arcsByCall.get(callId) ?? 0) + 1);
    }
    for (const [key, entry] of index) {
        const callId = extractToolCallObservation(entry.occurrences[0]?.part)?.callId ?? "";
        if (ambiguousCalls.has(callId)) continue;
        // A legacy row lacks the invoking message's ID. It can identify the
        // tool only when exactly one invocation/result group has its call ID.
        const tag =
            toolTags.get(key) ??
            (arcsByCall.get(callId) === 1
                ? toolTags.get(makeToolCompositeKey("", callId))
                : undefined);
        if (tag)
            targets.set(
                tag.tagNumber,
                createToolDropTarget(key, toolThinking.get(key) ?? [], index, batch, tag.tagNumber),
            );
    }
    applyFlushedStatuses(sessionId, db, targets, tags);
    batch.finalize();
    if (
        JSON.stringify(recoveryReasoningPrefixes(messages, "parts")) !==
        JSON.stringify(reasoningPrefixes)
    )
        return false;
    if (messages !== original) original.splice(0, original.length, ...messages);
    return true;
}
