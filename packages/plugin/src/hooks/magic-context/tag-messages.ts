import type { ContextDatabase } from "../../features/magic-context/storage";
import { getSourceContents, saveSourceContent } from "../../features/magic-context/storage";
import {
    adoptNullOwnerToolTag,
    getCandidateToolOwners,
    getNullOwnerToolTag,
    pickNearestPriorOwner,
} from "../../features/magic-context/storage-tags";
import { makeToolCompositeKey, type Tagger } from "../../features/magic-context/tagger";
import { isRecord } from "../../shared/record-type-guard";
import { isReduceToolPart } from "./drop-stale-reduce-calls";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { byteSize, isThinkingPart, prependTag } from "./tag-content-primitives";
import { createExistingTagResolver } from "./tag-id-fallback";
import {
    buildFileSourceContent,
    isFilePart,
    isTextPart,
    isToolPartWithOutput,
    stripTagPrefix,
} from "./tag-part-guards";
import {
    createToolDropTarget,
    extractToolCallObservation,
    type ToolCallIndex,
    type ToolDropResult,
    ToolMutationBatch,
} from "./tool-drop-target";

/**
 * v3.3.1 Layer C: derive `tool_owner_message_id` for a tool observation.
 *
 * - invocation parts: owner = current message id (the assistant message
 *   hosting the invocation)
 * - result parts: pop the FIFO queue for this callId; if empty, attempt
 *   the persisted-nearest-prior fallback (covers result-only windows
 *   where the invocation has been compacted away); if that fails too,
 *   fall back to the result's own message id (last-resort: ensures owner
 *   is always non-null and tag identity stays stable).
 *
 * The FIFO queue is keyed by callId so two invocations of the same callId
 * across two assistant messages produce two distinct owner ids — that's
 * the whole point of composite identity.
 */
function deriveToolOwnerMessageId(
    sessionId: string,
    db: ContextDatabase,
    message: MessageLike,
    obs: { callId: string; kind: "invocation" | "result" },
    unpaired: Map<string, string[]>,
): string {
    const messageId = typeof message.info.id === "string" ? message.info.id : "";

    if (obs.kind === "invocation") {
        if (messageId) {
            const queue = unpaired.get(obs.callId) ?? [];
            queue.push(messageId);
            unpaired.set(obs.callId, queue);
            return messageId;
        }
        // Synthetic message id missing — degrade gracefully. Use the
        // callId itself as owner so the composite key is unique. This
        // is rare (transcripts where assistant message has no id at
        // all); the alternative is to drop the tool entirely, which
        // would break aggregation.
        return obs.callId;
    }

    // Result part — pop FIFO
    const queue = unpaired.get(obs.callId);
    if (queue && queue.length > 0) {
        const popped = queue.shift();
        if (queue.length === 0) unpaired.delete(obs.callId);
        if (popped !== undefined) return popped;
    }

    // Result-only window: invocation was compacted away. Look up the
    // persisted nearest-prior owner whose time_created precedes the
    // current result's message.
    //
    // Two-phase lookup that splits the MC and OC reads:
    //   1. `getCandidateToolOwners` queries the MC tags table for every
    //      tag with a non-NULL owner under (sessionId, callId).
    //   2. `getMessageTimesFromOpenCodeDb` resolves wall-clock times for
    //      the candidates and the current message via the shared OC
    //      read-only handle. Returns an empty map when the OC DB can't
    //      be opened (Pi-only install, missing file).
    //   3. `pickNearestPriorOwner` selects the most recent candidate
    //      strictly preceding `messageId` in OC time.
    //
    // All three steps are fail-soft: any of them returning empty/null
    // collapses to the `messageId` fallback below, which keeps the
    // composite key stable even when the OC DB is unavailable.
    if (messageId) {
        const candidates = getCandidateToolOwners(db, sessionId, obs.callId);
        if (candidates.length > 0) {
            const ids = [...candidates, messageId];
            const times = getMessageTimesFromOpenCodeDb(sessionId, ids);
            const persisted = pickNearestPriorOwner(candidates, messageId, times);
            if (persisted !== null) return persisted;
        }
        return messageId;
    }
    return obs.callId;
}

export type MessageInfo = { id?: string; role?: string; sessionID?: string };

export interface ThinkingLikePart {
    type: string;
    thinking?: string;
    text?: string;
}

export type MessageLike = { info: MessageInfo; parts: unknown[] };

export type TagTarget = {
    setContent: (content: string) => boolean;
    getContent?: () => string | null;
    drop?: () => ToolDropResult;
    truncate?: () => ToolDropResult;
    message?: MessageLike;
};

export interface TagMessagesResult {
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>;
    messageTagNumbers: Map<MessageLike, number>;
    toolCallIndex: ToolCallIndex;
    batch: ToolMutationBatch;
    hasRecentReduceCall: boolean;
    /** Whether recent assistant messages contain git commit hash patterns */
    hasRecentCommit: boolean;
}

function collectRelevantSourceTagIds(
    messages: MessageLike[],
    assignments: ReadonlyMap<string, number>,
): number[] {
    const currentMessageIds = new Set(
        messages.flatMap((message) =>
            typeof message.info.id === "string" ? [message.info.id] : [],
        ),
    );

    const relevantTagIds = new Set<number>();
    for (const [contentId, tagId] of assignments) {
        const match = /^(.*):(p|file)\d+$/.exec(contentId);
        if (!match) continue;
        if (!currentMessageIds.has(match[1])) continue;
        relevantTagIds.add(tagId);
    }

    return Array.from(relevantTagIds);
}

function getReasoningByteSize(parts: ThinkingLikePart[]): number {
    let reasoningBytes = 0;

    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            reasoningBytes += byteSize(content);
        }
    }

    return reasoningBytes;
}

function estimateInputByteSize(input: unknown): number {
    try {
        return JSON.stringify(input).length;
    } catch {
        return 0;
    }
}

function extractToolTagMetadata(part: unknown): { toolName: string | null; inputByteSize: number } {
    if (!isRecord(part)) {
        return { toolName: null, inputByteSize: 0 };
    }

    const toolName =
        typeof part.tool === "string"
            ? part.tool
            : typeof part.toolName === "string"
              ? part.toolName
              : typeof part.name === "string"
                ? part.name
                : null;
    const state = isRecord(part.state) ? part.state : null;
    const input = state?.input ?? part.args ?? part.input ?? {};

    return {
        toolName,
        inputByteSize: estimateInputByteSize(input),
    };
}

export interface TagMessagesOptions {
    /**
     * When true, skip injecting §N§ prefix into message text/tool output parts.
     * DB-level tag records are still created normally — this flag only affects
     * whether the agent-visible part content gets the tag prefix. Used when
     * `ctx_reduce_enabled: false` so agents don't see tag markers they can't
     * act on. Subagents also set this flag (they are always treated as
     * ctx_reduce_enabled=false). Cache-safe: skipping is consistent across
     * passes, so message shape stays stable.
     */
    skipPrefixInjection?: boolean;
}

export function tagMessages(
    sessionId: string,
    messages: MessageLike[],
    tagger: Tagger,
    db: ContextDatabase,
    options: TagMessagesOptions = {},
): TagMessagesResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const targets = new Map<number, TagTarget>();
    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>();
    const messageTagNumbers = new Map<MessageLike, number>();
    // v3.3.1 Layer C: keys are composite `<ownerMsgId>\x00<callId>`,
    // not bare callId. Two assistant turns reusing the same callId
    // produce distinct keys → distinct tags → distinct drops.
    const toolTagByCallId = new Map<string, number>();
    const toolThinkingByCallId = new Map<string, ThinkingLikePart[]>();
    const toolCallIndex: ToolCallIndex = new Map();
    // FIFO queue per callId of unpaired invocations. Result parts pop
    // from this to find their invocation owner. Cleared at the end of
    // each pass (function-scoped).
    const unpairedInvocations = new Map<string, string[]>();
    // Memo: for each part observed, what owner did we derive? Used by
    // the second tool-block (isToolPartWithOutput) so it doesn't re-run
    // FIFO logic and double-pop the queue. Parts are object references
    // (the same `unknown` instance walked twice in the loop).
    const ownerByPartKey = new Map<unknown, { ownerMsgId: string; callId: string }>();
    const batch = new ToolMutationBatch(messages);
    const assignments = tagger.getAssignments(sessionId);
    const resolver = createExistingTagResolver(sessionId, tagger, db);
    const sourceContents = getSourceContents(
        db,
        sessionId,
        collectRelevantSourceTagIds(messages, assignments),
    );
    let precedingThinkingParts: ThinkingLikePart[] = [];
    let lastReduceMessageIndex = -1;
    const RECENT_REDUCE_LOOKBACK = 10;
    const COMMIT_LOOKBACK = 5;
    const COMMIT_HASH_PATTERN = /\b[0-9a-f]{7,12}\b/;
    let commitDetected = false;

    // Intentional: we deliberately do NOT wrap this walk in db.transaction(...).
    // Each tagger.assignTag() owns its own atomic SAVEPOINT (insert + counter
    // upsert). Wrapping the whole walk in an outer transaction was an old
    // cache-bust amplifier — one UNIQUE collision near the end of the walk
    // would roll back EVERY tag insert + saveSourceContent in this pass,
    // leaving the in-memory message mutations and §N§ prefixes already
    // applied while the DB had no record of them. The transform's catch
    // block then fell through with `targets={}` (empty), and the pass
    // emitted a message[0] whose stripped/dropped/cavemaned replays were
    // all skipped, resurfacing ~110k tokens of bulky content.
    //
    // Per-call SAVEPOINTs already give us the atomicity we actually need:
    // each (tag insert, counter upsert, source_contents save) succeeds or
    // fails independently. A single tag failing no longer corrupts the
    // surrounding work in the same pass.
    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
        const messageId = typeof message.info.id === "string" ? message.info.id : null;

        if (message.info.role === "user") {
            precedingThinkingParts = [];
        }

        const messageThinkingParts = message.parts.filter(isThinkingPart);
        if (messageThinkingParts.length > 0) {
            reasoningByMessage.set(message, messageThinkingParts);
        }
        const messageHasTextPart = message.parts.some(isTextPart);
        let textOrdinal = 0;
        let fileOrdinal = 0;

        for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
            const part = message.parts[partIndex];

            if (isReduceToolPart(part)) {
                lastReduceMessageIndex = msgIndex;
            }

            const toolObservation = extractToolCallObservation(part);
            if (toolObservation) {
                // v3.3.1 Layer C: derive composite owner via FIFO pairing.
                // - invocation parts: ownerMsgId = message hosting the part.
                // - result parts: pop the FIFO queue for this callId; if
                //   empty, fall back to nearest-prior persisted owner;
                //   ultimate fallback: result's own message id.
                const ownerMsgId = deriveToolOwnerMessageId(
                    sessionId,
                    db,
                    message,
                    toolObservation,
                    unpairedInvocations,
                );
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolObservation.callId);
                const entry = toolCallIndex.get(compositeKey) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message, part, kind: toolObservation.kind });
                if (toolObservation.kind === "result") entry.hasResult = true;
                toolCallIndex.set(compositeKey, entry);

                let existingTagId = tagger.getToolTag(
                    sessionId,
                    toolObservation.callId,
                    ownerMsgId,
                );

                // v3.3.1 Layer C: legacy NULL-owner adoption for the
                // invocation-only path. The second tool block
                // (isToolPartWithOutput) calls assignToolTag which
                // adopts NULL-owner rows automatically — but invocation
                // observations don't pass through that block. Without
                // this lazy adoption, an invocation-only message with a
                // pre-existing NULL-owner tag would never bind into
                // `targets`, so a queued drop op against that tag could
                // not be detected as "incomplete" (no result) and would
                // fall through to the "absent" branch in
                // applyPendingOperations, marking the tag dropped
                // prematurely.
                if (existingTagId === undefined) {
                    const orphan = getNullOwnerToolTag(db, sessionId, toolObservation.callId);
                    if (orphan !== null) {
                        const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
                        if (claimed) {
                            tagger.bindToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                                orphan.tagNumber,
                            );
                            existingTagId = orphan.tagNumber;
                        } else {
                            // Race lost — re-check composite path.
                            existingTagId = tagger.getToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
                        }
                    }
                }

                if (existingTagId !== undefined) {
                    toolTagByCallId.set(compositeKey, existingTagId);
                    messageTagNumbers.set(
                        message,
                        Math.max(messageTagNumbers.get(message) ?? 0, existingTagId),
                    );
                    if (
                        message.info.role === "tool" &&
                        precedingThinkingParts.length > 0 &&
                        !toolThinkingByCallId.has(compositeKey)
                    ) {
                        toolThinkingByCallId.set(compositeKey, precedingThinkingParts);
                    }
                }
                ownerByPartKey.set(part, { ownerMsgId, callId: toolObservation.callId });
            }

            if (messageId && isTextPart(part)) {
                const textPart = part;
                const thinkingParts = messageThinkingParts;
                const contentId = `${messageId}:p${partIndex}`;
                // Resolver pre-warms any tag-id-fallback bindings (e.g. when
                // OpenCode re-assigns part IDs); the assigned tag below uses
                // those bindings if the resolver populated them.
                resolver.resolve(messageId, "message", contentId, textOrdinal);
                const reasoningBytes = textOrdinal === 0 ? getReasoningByteSize(thinkingParts) : 0;
                const tagId = tagger.assignTag(
                    sessionId,
                    contentId,
                    "message",
                    byteSize(textPart.text),
                    db,
                    reasoningBytes,
                );
                // Prefer persisted source_contents over the existingTagId
                // signal: even if we just allocated a fresh tag (because in-
                // memory state was lost), the DB may still have the original
                // pre-tag content from a previous pass. Restoring from source
                // is the only way to keep message content stable across passes
                // when assignTag's recovery rebound a different tag number
                // than what the resolver expected.
                const persistedSource = sourceContents.get(tagId);
                if (persistedSource !== undefined) {
                    textPart.text = persistedSource;
                } else {
                    const sourceContent = stripTagPrefix(textPart.text);
                    if (sourceContent.trim().length > 0) {
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    textPart.text = prependTag(tagId, textPart.text);
                }
                targets.set(tagId, {
                    message,
                    setContent: (content) => {
                        if (textPart.text === content) return false;
                        textPart.text = content;
                        for (const tp of thinkingParts) {
                            if (tp.thinking !== undefined) tp.thinking = "[cleared]";
                            if (tp.text !== undefined) tp.text = "[cleared]";
                        }
                        return true;
                    },
                    getContent: () => textPart.text,
                });
                textOrdinal += 1;
                continue;
            }

            if (isToolPartWithOutput(part)) {
                const toolPart = part;
                const thinkingParts = precedingThinkingParts;
                const reasoningBytes = getReasoningByteSize(thinkingParts);
                const { toolName, inputByteSize } = extractToolTagMetadata(toolPart);

                // v3.3.1 Layer C: derive owner from the FIFO memo set
                // earlier in this same loop iteration. The first tool
                // block (extractToolCallObservation) already paired this
                // part — reuse that owner so we don't double-pop the
                // queue (which would shift result-pairing for later
                // result parts of the same callId).
                const memo = ownerByPartKey.get(part);
                const ownerMsgId = memo?.ownerMsgId ?? messageId ?? toolPart.callID;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolPart.callID);

                const tagId = tagger.assignToolTag(
                    sessionId,
                    toolPart.callID,
                    ownerMsgId,
                    byteSize(toolPart.state.output),
                    db,
                    reasoningBytes,
                    toolName,
                    inputByteSize,
                );
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    toolPart.state.output = prependTag(tagId, toolPart.state.output);
                }
                toolTagByCallId.set(compositeKey, tagId);
                if (thinkingParts.length > 0 && !toolThinkingByCallId.has(compositeKey)) {
                    toolThinkingByCallId.set(compositeKey, thinkingParts);
                }
            }

            if (messageId && isFilePart(part)) {
                const filePart = part;
                const messageParts = message.parts;
                const contentId = `${messageId}:file${partIndex}`;
                const existingTagId = resolver.resolve(messageId, "file", contentId, fileOrdinal);
                const tagId = tagger.assignTag(
                    sessionId,
                    contentId,
                    "file",
                    byteSize(filePart.url),
                    db,
                );
                if (existingTagId === undefined) {
                    const sourceContent = buildFileSourceContent(message.parts);
                    if (sourceContent) {
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                targets.set(tagId, {
                    message,
                    setContent: (content) => {
                        const prev = messageParts[partIndex];
                        const prevText =
                            typeof prev === "object" && prev !== null && "text" in prev
                                ? (prev as { text: string }).text
                                : "";
                        if (prevText === content) return false;
                        messageParts[partIndex] = {
                            type: "text",
                            text: content,
                        } as MessageLike["parts"][number];
                        return true;
                    },
                });
                fileOrdinal += 1;
            }
        }

        if (message.info.role === "assistant" && !messageHasTextPart) {
            precedingThinkingParts = messageThinkingParts;
        }

        // Detect commit hashes in recent assistant text (last COMMIT_LOOKBACK messages)
        if (
            !commitDetected &&
            message.info.role === "assistant" &&
            messages.length - msgIndex <= COMMIT_LOOKBACK
        ) {
            for (const part of message.parts) {
                if (isTextPart(part)) {
                    const text = (part as { text: string }).text;
                    if (
                        COMMIT_HASH_PATTERN.test(text) &&
                        /\b(commit|committed|cherry-pick|merge|rebas)/i.test(text)
                    ) {
                        commitDetected = true;
                        break;
                    }
                }
            }
        }
    }

    for (const [compositeKey, tagId] of toolTagByCallId) {
        const thinkingParts = toolThinkingByCallId.get(compositeKey) ?? [];
        targets.set(tagId, createToolDropTarget(compositeKey, thinkingParts, toolCallIndex, batch));
    }

    const hasRecentReduceCall =
        lastReduceMessageIndex >= 0 &&
        messages.length - lastReduceMessageIndex <= RECENT_REDUCE_LOOKBACK;

    return {
        targets,
        reasoningByMessage,
        messageTagNumbers,
        toolCallIndex,
        batch,
        hasRecentReduceCall,
        hasRecentCommit: commitDetected,
    };
}
