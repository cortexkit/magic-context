/**
 * Harness-agnostic tagging over the Transcript interface.
 *
 * This is a deliberately minimal alternative to the OpenCode-specific
 * `tag-messages.ts` that operates on `MessageLike[]`. The OpenCode flow
 * carries 380+ lines of accumulated complexity:
 *
 *   - source-content persistence (for cross-pass detag/restore behavior),
 *   - tool-call indexing across separate "tool" and "tool_result" parts,
 *   - reasoning-byte tracking for historian projection,
 *   - file-part stable IDs,
 *   - existing-tag resolver with content-id fallback.
 *
 * Most of that is OpenCode-specific (cache stability across multi-pass
 * transforms, AI SDK part-id semantics, file part shapes). Pi's
 * `pi.on("context", ...)` fires once per LLM call with a complete
 * `AgentMessage[]`, so we can use a simpler tagging contract:
 *
 *   1. Walk the transcript in order.
 *   2. For each tag-eligible part (text, tool_use, tool_result), assign
 *      a tag number via the shared `Tagger`.
 *   3. Inject `§N§ ` prefix into the visible text (unless skipped).
 *   4. Build a `TagTarget` so `applyPendingOperations` from
 *      `apply-operations.ts` can replace this part with a sentinel when
 *      a queued drop fires.
 *
 * Tool drops aggregate by call_id across both invocation and result
 * occurrences (mirrors OpenCode tag-messages.ts:196-220). When a drop
 * fires for a tool tag, BOTH the assistant `toolCall`/`tool_use` part
 * and the user `toolResult`/`tool_result` part are mutated together so
 * the LLM sees consistent dropped state. Without this aggregation:
 *
 *   - Tool tag byte_size reflects only the args (~58 bytes for a `read`)
 *     because the FIRST occurrence (invocation) is tagged first and
 *     `assignTag` short-circuits the SECOND occurrence (result, ~4KB)
 *     to the same tag without updating byte_size.
 *   - Drops touch only the second occurrence (last write wins on
 *     `targets.set`), leaving the first in original form.
 *
 * Reuses unchanged from the OpenCode path:
 *
 *   - `Tagger` (DB-backed counter + assignment store).
 *   - `applyPendingOperations` (operates on `Map<number, TagTarget>`).
 *   - `applyFlushedStatuses` (same).
 *   - Tag prefix primitives (`prependTag`, `stripTagPrefix`, `byteSize`).
 */

import { createHash } from "node:crypto";
import type { ContextDatabase } from "../features/magic-context/storage";
import { saveSourceContent } from "../features/magic-context/storage-source";
import {
    updateTagByteSize,
    updateTagInputByteSize,
    updateTagInputTokenCount,
    updateTagTokenCount,
} from "../features/magic-context/storage-tags";
import { makeToolCompositeKey, type Tagger } from "../features/magic-context/tagger";
import { droppedInputMarker } from "../hooks/magic-context/dropped-input-guard";
import { applyEditMarkerToInput } from "../hooks/magic-context/edit-marker";
import { estimateImageTokensFromDataUrl } from "../hooks/magic-context/image-token-estimate";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import {
    byteSize,
    prependTag,
    stripTagPrefix,
    stripWellFormedLeadingTagPrefix,
} from "../hooks/magic-context/tag-content-primitives";
import type { TagTarget } from "../hooks/magic-context/tag-messages";
import { toolInputStringBytes } from "../hooks/magic-context/tool-input-size";
import { TEXT_TAG_IDENTITY_MARKER } from "./tag-owner-id";
import type { Transcript, TranscriptMessage, TranscriptPart } from "./transcript";

// Re-exported so existing importers keep one source for the marker.
export { TEXT_TAG_IDENTITY_MARKER };

export interface TagTranscriptOptions {
    /**
     * When true, skip injecting `§N§` prefix into visible text. Tags
     * still get assigned in the DB so historian/drops can reference
     * them; the agent just doesn't see the markers. Used when the session's
     * tool surface has no `ctx_reduce` tool to act on the markers. Cache-safe
     * because the availability verdict is frozen per session.
     */
    skipPrefixInjection?: boolean;
    /**
     * Pi-only: map of messageId → raw-message fingerprint. When a NEW message
     * text tag is created, its fingerprint is persisted on the tag row so a
     * later pass can adopt the fallback-id tag onto the real SessionEntry id
     * (keeping tag_number/§N§ stable). OpenCode omits this → tags store NULL
     * → adoption never fires. Keyed by the bare messageId (not the `:pN`
     * contentId) since all parts of a message share one fingerprint.
     */
    entryFingerprintByMessageId?: ReadonlyMap<string, string>;
    /**
     * Stable Pi message ids observed on a prior pass. Their immutable parts may
     * reuse tag assignments while this pass still reapplies visible prefixes and
     * rebuilds the complete set of messages affected by each tag.
     */
    reuseMessageIds?: ReadonlySet<string>;
    /**
     * Pi message ids whose persisted text-part vector no longer matches the
     * current vector. Their parts use content-derived identities instead of
     * positional `:pN` keys, so sibling insertion/deletion cannot rebind an
     * older durable tag to different text.
     */
    textIdentityDriftMessageIds?: ReadonlySet<string>;
    /** Source-content cache shared with Pi's batched identity preflight. */
    textIdentitySourceCache?: Map<number, string>;
    /** Exact text/count pairs retained by Pi for safe lazy-token backfill reuse. */
    textTokenCache?: Map<string, { text: string; tokenCount: number }>;
    /** Exact tool-result text/count pairs retained under composite tag identity. */
    toolTokenCache?: Map<string, { text: string; tokenCount: number }>;
    /** Optional process-local benchmark callback; production callers omit it. */
    onTiming?: (
        phase: "identity" | "prefix" | "targets" | "tokenCounting",
        elapsedMs: number,
    ) => void;
}

export interface TagTranscriptResult {
    targets: Map<number, TagTarget>;
}

/**
 * Tag eligible parts of a transcript and build TagTargets for them.
 *
 * "Eligible" means: parts that contribute meaningfully to the LLM input
 * and whose content can be replaced when dropped. Specifically:
 *
 *   - text parts (user or assistant): tagged as type "message", inject
 *     prefix into the visible text, target supports setContent.
 *   - thinking parts: NOT tagged. Reasoning content has provider-
 *     specific signed-content semantics (Anthropic redacted_thinking,
 *     etc.) and replacing them mid-conversation breaks signature
 *     verification. The historian's clear-reasoning pass handles them
 *     separately if needed.
 *   - tool_use parts (assistant tool invocations): tagged as type
 *     "tool", target supports drop/truncate via the tag-content
 *     primitives.
 *   - tool_result parts (folded into user messages by the Pi adapter):
 *     tagged as type "tool", paired with the corresponding invocation
 *     for full-pair drops.
 *   - image, file, structural, unknown: skipped.
 *
 * The contentId we pass to the tagger uses the part's stable id when
 * available, otherwise a synthetic locator. Pi's adapter exposes:
 *   - tool_use parts: id = ToolCall.id (from pi-ai)
 *   - tool_result parts: id = ToolResultMessage.toolCallId
 *   - text parts: id = undefined → we synthesize from message+ordinal
 */
/**
 * Per-callId aggregation of tool occurrences across the transcript.
 * Built up during the walk and used to:
 *   1. Assign one tag per call_id with byte_size = the tool_RESULT (output)
 *      size, and inputByteSize = the tool_use (args) size, tracked SEPARATELY
 *      (mirrors OpenCode tag-messages.ts). Reclaim accounting sums them
 *      (byteSize + inputByteSize + reasoning); folding args into byte_size too
 *      would double-count the args for a large-input/small-output tool.
 *   2. Build a single aggregate TagTarget that mutates BOTH the
 *      invocation and result occurrences atomically, so a queued drop
 *      replaces both halves with a sentinel instead of last-write-wins.
 */
interface ToolOccurrence {
    message: { info: { id?: string; role: string } };
    part: TranscriptPart;
    kind: "tool_use" | "tool_result";
    /**
     * The call's real input, captured the first time this pass overwrote it
     * with the legacy marker, so a later real-argument render in the same pass
     * can put it back.
     */
    originalInput?: Record<string, unknown>;
}

interface TagTranscriptTiming {
    identity: number;
    prefix: number;
    targets: number;
    tokenCounting: number;
}

interface ToolAggregate {
    callId: string;
    /** Every occurrence seen so far belongs to a previously tagged stable message. */
    identityReusable: boolean;
    occurrences: ToolOccurrence[];
    /** Largest byteSize seen across occurrences — used as the tag size. */
    maxByteSize: number;
    /** Token count paired with maxByteSize (the same output occurrence). */
    maxTokenCount: number;
    /** Tool name from the first occurrence we see one on. */
    toolName: string | null;
    /** Input byte size from the invocation occurrence (for storage projection). */
    inputByteSize: number;
    /** Persisted input-token count, or null for a legacy/unobserved invocation. */
    inputTokenCount: number | null;
    /** At least one assistant-side occurrence shares its message with native reasoning. */
    requiresToolArcSkeleton: boolean;
}

function textIdentityDigest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function buildContentDerivedTextIds(messageId: string, parts: readonly TranscriptPart[]): string[] {
    const sources = parts
        .filter((part) => part.kind === "text")
        .map((part) => stripTagPrefix(part.getText() ?? ""));
    const vectorFingerprint = textIdentityDigest(JSON.stringify(sources));
    const occurrences = new Map<string, number>();

    return sources.map((source) => {
        const contentFingerprint = textIdentityDigest(source);
        const occurrence = occurrences.get(contentFingerprint) ?? 0;
        occurrences.set(contentFingerprint, occurrence + 1);
        return `${messageId}${TEXT_TAG_IDENTITY_MARKER}${vectorFingerprint}:${contentFingerprint}:o${occurrence}`;
    });
}

export function tagTranscript(
    sessionId: string,
    transcript: Transcript,
    tagger: Tagger,
    db: ContextDatabase,
    options: TagTranscriptOptions = {},
): TagTranscriptResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const targets = new Map<number, TagTarget>();
    const timing: TagTranscriptTiming | undefined = options.onTiming
        ? { identity: 0, prefix: 0, targets: 0, tokenCounting: 0 }
        : undefined;

    // Tool aggregation is keyed by the same owner+callId identity used by
    // assignToolTag. OpenCode/Pi callId counters can repeat across turns, so
    // a bare callId key can merge distinct invocations and replay drops/status
    // changes against the wrong tool pair.
    const toolAggregates = new Map<string, ToolAggregate & { tagId: number }>();
    const openToolAggregateKeysByCallId = new Map<string, string[]>();
    let activeToolResultRun: { callId: string; aggregateKey: string } | undefined;

    // v3.3.1 Layer C (plan v3.3.1 Finding #16): the previous outer
    // db.transaction() wrapper rolled back EVERY tag insert + savedSource
    // when a single UNIQUE collision fired late in the walk. Per-tag
    // SAVEPOINTs inside `assignToolTag` / `assignTag` already give us the
    // atomicity we need. Removing the wrapper matches OpenCode's
    // tag-messages.ts design — see the long comment there for the
    // rationale (cache-bust amplifier story).
    const conversationEnd = new ConversationEndGuard(transcript.messages);

    for (let msgIndex = 0; msgIndex < transcript.messages.length; msgIndex += 1) {
        const message = transcript.messages[msgIndex];
        if (message === undefined) continue;
        activeToolResultRun = undefined;
        const messageId = message.info.id;
        const reuseIdentity =
            messageId !== undefined && options.reuseMessageIds?.has(messageId) === true;

        let textOrdinal = 0;
        let toolResultOrdinal = 0;
        const parts = message.parts;
        const messageHasNativeReasoning =
            message.requiresToolArcSkeleton ??
            (message.info.role === "assistant" && parts.some((part) => part.kind === "thinking"));
        const contentDerivedTextIds =
            messageId !== undefined && options.textIdentityDriftMessageIds?.has(messageId) === true
                ? buildContentDerivedTextIds(messageId, parts)
                : undefined;

        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            if (part === undefined) continue;
            const resultBlockOrdinal =
                part.kind === "tool_result" ? toolResultOrdinal++ : undefined;

            if (part.kind !== "tool_result") {
                activeToolResultRun = undefined;
            }

            if (part.kind === "text") {
                // Synthetic message ids (Pi tail synthetic user with
                // no id) cannot be tagged — there's no stable handle
                // to bind a tag to across passes. Pass through
                // untagged; this is rare (only happens for the
                // dangling tool-result tail case in Pi).
                if (messageId === undefined) {
                    textOrdinal += 1;
                    continue;
                }
                tagTextPart({
                    sessionId,
                    message,
                    messageId,
                    contentId:
                        contentDerivedTextIds?.[textOrdinal] ?? `${messageId}:p${textOrdinal}`,
                    msgIndex,
                    textOrdinal,
                    part,
                    tagger,
                    db,
                    targets,
                    skipPrefixInjection,
                    entryFingerprint: options.entryFingerprintByMessageId?.get(messageId) ?? null,
                    reuseIdentity: reuseIdentity || contentDerivedTextIds !== undefined,
                    timing,
                    textIdentitySourceCache: options.textIdentitySourceCache,
                    textTokenCache: options.textTokenCache,
                });
                textOrdinal += 1;
                continue;
            }

            if (part.kind === "tool_use" || part.kind === "tool_result") {
                if (messageId === undefined) {
                    activeToolResultRun = undefined;
                    continue;
                }

                const identityStart = timing ? performance.now() : 0;
                const callId = part.id;
                if (typeof callId !== "string" || callId.length === 0) {
                    activeToolResultRun = undefined;
                    // No stable callId to aggregate on. Tag independently.
                    tagToolPart({
                        sessionId,
                        message,
                        messageId,
                        msgIndex,
                        partIndex,
                        part,
                        tagger,
                        db,
                        targets,
                        skipPrefixInjection,
                        reuseIdentity,
                        timing,
                    });
                    continue;
                }

                const pendingKeys = openToolAggregateKeysByCallId.get(callId) ?? [];
                let existingKey: string | undefined;
                if (part.kind === "tool_result") {
                    if (
                        activeToolResultRun !== undefined &&
                        activeToolResultRun.callId === callId
                    ) {
                        existingKey = activeToolResultRun.aggregateKey;
                    } else {
                        existingKey = findLastUnresolvedToolAggregateKey(
                            pendingKeys,
                            toolAggregates,
                        );
                    }
                }
                const aggregateKey: string = existingKey ?? makeToolCompositeKey(messageId, callId);
                // Keep block memoization separate from aggregate tag identity. The
                // ordinal comes from this message's stable result-part order, not cache writes.
                const tokenCacheKey =
                    resultBlockOrdinal === undefined
                        ? aggregateKey
                        : `${aggregateKey}\0result-part:${messageId}:${resultBlockOrdinal}`;
                const existing = toolAggregates.get(aggregateKey);
                if (existing) {
                    existing.occurrences.push({ message, part, kind: part.kind });
                    existing.requiresToolArcSkeleton ||= messageHasNativeReasoning;
                    const canReuseIdentity = reuseIdentity && existing.identityReusable;
                    let text = "";
                    if (canReuseIdentity) {
                        // Prefix replay always needs result text. Byte length is also
                        // cheap enough to guard the durable growth invariant; BPE and
                        // DB writes remain staged behind an actual persisted-size bump.
                        if (part.kind === "tool_result") {
                            text = part.getText() ?? "";
                            applyGrownToolResultAccounting({
                                db,
                                sessionId,
                                tagger,
                                aggregate: existing,
                                byteSize: getToolPartByteSize(part, text),
                                part,
                                text,
                                timing,
                                tokenCache: options.toolTokenCache,
                                tokenCacheKey,
                            });
                        }
                        if (timing) timing.identity += performance.now() - identityStart;
                    } else {
                        const accounting = readAggregateToolAccounting(
                            part,
                            timing,
                            options.toolTokenCache,
                            tokenCacheKey,
                        );
                        text = accounting.text;
                        if (part.kind === "tool_result") {
                            applyGrownToolResultAccounting({
                                db,
                                sessionId,
                                tagger,
                                aggregate: existing,
                                byteSize: accounting.byteSize,
                                part,
                                text,
                                timing,
                                knownTokenCount: accounting.tokenCount,
                            });
                        }
                        if (existing.toolName === null && accounting.toolName) {
                            existing.toolName = accounting.toolName;
                        }
                        if (
                            existing.inputByteSize === 0 &&
                            part.kind === "tool_use" &&
                            accounting.inputByteSize > 0
                        ) {
                            existing.inputByteSize = accounting.inputByteSize;
                            updateTagInputByteSize(
                                db,
                                sessionId,
                                existing.tagId,
                                accounting.inputByteSize,
                            );
                        }
                        if (
                            existing.inputTokenCount === null &&
                            part.kind === "tool_use" &&
                            accounting.inputTokenCount > 0
                        ) {
                            existing.inputTokenCount = accounting.inputTokenCount;
                            updateTagInputTokenCount(
                                db,
                                sessionId,
                                existing.tagId,
                                accounting.inputTokenCount,
                            );
                        }
                        syncToolAggregateAccounting(tagger, sessionId, existing);
                        if (timing) timing.identity += performance.now() - identityStart;
                    }
                    existing.identityReusable &&= reuseIdentity;
                    applyToolPrefixAndTarget({
                        skipPrefixInjection,
                        part,
                        text,
                        tagId: existing.tagId,
                        aggregate: existing,
                        targets,
                        timing,
                        conversationEnd,
                    });
                    if (part.kind === "tool_result") {
                        markToolAggregateResolved(
                            callId,
                            aggregateKey,
                            openToolAggregateKeysByCallId,
                        );
                        activeToolResultRun = { callId, aggregateKey };
                    }
                    continue;
                }

                const reusableTagId = reuseIdentity
                    ? tagger.getToolTag(sessionId, callId, messageId)
                    : undefined;
                const reusableAccounting = reuseIdentity
                    ? tagger.getToolTagAccounting(sessionId, callId, messageId)
                    : undefined;
                let aggregate: ToolAggregate & { tagId: number };
                let text = "";
                if (reusableTagId !== undefined && reusableAccounting !== undefined) {
                    aggregate = {
                        callId,
                        tagId: reusableTagId,
                        identityReusable: true,
                        occurrences: [{ message, part, kind: part.kind }],
                        // Stable identity does not imply stable payload size. Seed from
                        // the persisted row so unchanged results avoid BPE while a
                        // genuinely larger folded result can still bump accounting.
                        maxByteSize: reusableAccounting.byteSize,
                        maxTokenCount: reusableAccounting.tokenCount ?? 0,
                        toolName: null,
                        inputByteSize: reusableAccounting.inputByteSize,
                        inputTokenCount: reusableAccounting.inputTokenCount,
                        requiresToolArcSkeleton: messageHasNativeReasoning,
                    };
                    if (part.kind === "tool_result") {
                        text = part.getText() ?? "";
                        applyGrownToolResultAccounting({
                            db,
                            sessionId,
                            tagger,
                            aggregate,
                            byteSize: getToolPartByteSize(part, text),
                            part,
                            text,
                            timing,
                            tokenCache: options.toolTokenCache,
                            tokenCacheKey,
                        });
                    }
                    if (timing) timing.identity += performance.now() - identityStart;
                } else {
                    const accounting = readAggregateToolAccounting(
                        part,
                        timing,
                        options.toolTokenCache,
                        tokenCacheKey,
                    );
                    text = accounting.text;
                    const outputByteSize = part.kind === "tool_result" ? accounting.byteSize : 0;
                    const outputTokenCount =
                        part.kind === "tool_result" ? accounting.tokenCount : 0;
                    const firstInputTokenCount =
                        part.kind === "tool_use" ? accounting.inputTokenCount : 0;
                    const tagId = tagger.assignToolTag(
                        sessionId,
                        callId,
                        messageId,
                        outputByteSize,
                        db,
                        0,
                        accounting.toolName,
                        accounting.inputByteSize,
                        () => ({
                            tokenCount: outputTokenCount,
                            inputTokenCount: firstInputTokenCount,
                            reasoningTokenCount: null,
                        }),
                    );
                    const persistedAccounting = tagger.getToolTagAccounting(
                        sessionId,
                        callId,
                        messageId,
                    );
                    aggregate = {
                        callId,
                        tagId,
                        identityReusable: false,
                        occurrences: [{ message, part, kind: part.kind }],
                        maxByteSize: persistedAccounting?.byteSize ?? outputByteSize,
                        maxTokenCount: persistedAccounting?.tokenCount ?? outputTokenCount,
                        toolName: accounting.toolName,
                        inputByteSize:
                            persistedAccounting?.inputByteSize ??
                            (part.kind === "tool_use" ? accounting.inputByteSize : 0),
                        inputTokenCount:
                            persistedAccounting?.inputTokenCount ??
                            (part.kind === "tool_use" ? firstInputTokenCount : null),
                        requiresToolArcSkeleton: messageHasNativeReasoning,
                    };
                    if (part.kind === "tool_result") {
                        applyGrownToolResultAccounting({
                            db,
                            sessionId,
                            tagger,
                            aggregate,
                            byteSize: accounting.byteSize,
                            part,
                            text,
                            timing,
                            knownTokenCount: accounting.tokenCount,
                        });
                    }
                    syncToolAggregateAccounting(tagger, sessionId, aggregate);
                    if (timing) timing.identity += performance.now() - identityStart;
                }

                toolAggregates.set(aggregateKey, aggregate);
                if (part.kind === "tool_use") {
                    openToolAggregateKeysByCallId.set(callId, [...pendingKeys, aggregateKey]);
                }
                applyToolPrefixAndTarget({
                    skipPrefixInjection,
                    part,
                    text,
                    tagId: aggregate.tagId,
                    aggregate,
                    targets,
                    timing,
                    conversationEnd,
                });
                if (part.kind === "tool_result") {
                    markToolAggregateResolved(callId, aggregateKey, openToolAggregateKeysByCallId);
                    activeToolResultRun = { callId, aggregateKey };
                }
            }
            // thinking, image, file, structural, unknown → skip.
        }
    }

    if (timing && options.onTiming) {
        options.onTiming("identity", timing.identity);
        options.onTiming("prefix", timing.prefix);
        options.onTiming("targets", timing.targets);
        options.onTiming("tokenCounting", timing.tokenCounting);
    }
    return { targets };
}

interface AggregateToolAccounting {
    text: string;
    byteSize: number;
    tokenCount: number;
    toolName: string | null;
    inputByteSize: number;
    inputTokenCount: number;
}

interface GrownToolResultAccountingArgs {
    db: ContextDatabase;
    sessionId: string;
    tagger: Tagger;
    aggregate: ToolAggregate & { tagId: number };
    byteSize: number;
    part: TranscriptPart;
    text: string;
    timing: TagTranscriptTiming | undefined;
    tokenCache?: Map<string, { text: string; tokenCount: number }>;
    tokenCacheKey?: string;
    knownTokenCount?: number;
}

function syncToolAggregateAccounting(
    tagger: Tagger,
    sessionId: string,
    aggregate: ToolAggregate & { tagId: number },
): void {
    tagger.setToolTagAccounting(sessionId, aggregate.tagId, {
        byteSize: aggregate.maxByteSize,
        tokenCount: aggregate.maxTokenCount,
        inputByteSize: aggregate.inputByteSize,
        inputTokenCount: aggregate.inputTokenCount,
    });
}

function applyGrownToolResultAccounting(args: GrownToolResultAccountingArgs): void {
    if (args.byteSize <= args.aggregate.maxByteSize) return;

    let tokenCount = args.knownTokenCount;
    if (tokenCount !== undefined && args.tokenCacheKey) {
        args.tokenCache?.set(args.tokenCacheKey, { text: args.text, tokenCount });
    }
    if (tokenCount === undefined) {
        const tokenStart = args.timing ? performance.now() : 0;
        tokenCount = getCachedToolPartTokenCount(
            args.part,
            args.text,
            args.tokenCache,
            args.tokenCacheKey,
        );
        if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
    }
    args.aggregate.maxByteSize = args.byteSize;
    args.aggregate.maxTokenCount = tokenCount;
    updateTagByteSize(args.db, args.sessionId, args.aggregate.tagId, args.byteSize);
    updateTagTokenCount(args.db, args.sessionId, args.aggregate.tagId, tokenCount);
    syncToolAggregateAccounting(args.tagger, args.sessionId, args.aggregate);
}

function readAggregateToolAccounting(
    part: TranscriptPart,
    timing: TagTranscriptTiming | undefined,
    tokenCache?: Map<string, { text: string; tokenCount: number }>,
    tokenCacheKey?: string,
): AggregateToolAccounting {
    const text = part.getText() ?? "";
    const byteSize = getToolPartByteSize(part, text);
    const metadata = part.getToolMetadata();
    let tokenCount = 0;
    if (part.kind === "tool_result") {
        const tokenStart = timing ? performance.now() : 0;
        tokenCount = getCachedToolPartTokenCount(part, text, tokenCache, tokenCacheKey);
        if (timing) timing.tokenCounting += performance.now() - tokenStart;
    }
    return {
        text,
        byteSize,
        tokenCount,
        toolName: metadata.toolName ?? null,
        inputByteSize: metadata.inputByteSize,
        inputTokenCount: metadata.inputTokenCount,
    };
}

interface ApplyToolPrefixAndTargetArgs {
    skipPrefixInjection: boolean;
    part: TranscriptPart;
    text: string;
    tagId: number;
    aggregate: ToolAggregate;
    targets: Map<number, TagTarget>;
    timing: TagTranscriptTiming | undefined;
    conversationEnd: ConversationEndGuard;
}

function partHasContent(part: TranscriptPart): boolean {
    return part.kind !== "text" || (part.getText() ?? "").trim().length > 0;
}

/**
 * Keeps structural tool removal from ending the provider request on an
 * assistant turn, which models without assistant prefill support reject.
 *
 * The request ends with the newest message that has any content. Tool results
 * there are what close the conversation with a user turn, so removal may take
 * one only while that message keeps other content. Shared by every target one
 * tagging pass builds, so drops earlier in the same pass count as removed.
 */
class ConversationEndGuard {
    private readonly end: TranscriptMessage | undefined;
    private readonly removed = new Set<unknown>();

    constructor(messages: readonly TranscriptMessage[]) {
        for (let index = messages.length - 1; index >= 0 && !this.end; index -= 1) {
            const message = messages[index];
            if (message?.parts.some(partHasContent)) this.end = message;
        }
    }

    wouldStrand(occurrences: readonly ToolOccurrence[]): boolean {
        const end = this.end;
        if (!end || !occurrences.some((occ) => occ.message === end)) return false;
        const leaving = new Set(occurrences.map((occ) => partKey(occ.part)));
        const survives = (part: TranscriptPart) =>
            !leaving.has(partKey(part)) && !this.removed.has(partKey(part));
        return end.info.role === "assistant"
            ? !end.parts.some((part) => part.kind === "tool_result" && survives(part))
            : !end.parts.some((part) => partHasContent(part) && survives(part));
    }

    noteRemoved(occurrences: readonly ToolOccurrence[]): void {
        for (const occ of occurrences) this.removed.add(partKey(occ.part));
    }
}

/**
 * Adapters may hand out a fresh proxy object per read of `message.parts`, so
 * tool parts are matched by kind and tool-call id; parts without an id fall
 * back to object identity.
 */
function partKey(part: TranscriptPart): unknown {
    return part.id === undefined ? part : `${part.kind}\u0000${part.id}`;
}

function applyToolPrefixAndTarget(args: ApplyToolPrefixAndTargetArgs): void {
    if (!args.skipPrefixInjection && args.part.kind === "tool_result") {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(args.tagId, args.text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }
    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(
        args.tagId,
        buildAggregateTarget(
            args.tagId,
            args.aggregate.occurrences,
            args.aggregate.requiresToolArcSkeleton,
            args.conversationEnd,
        ),
    );
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

function findLastUnresolvedToolAggregateKey(
    pendingKeys: string[],
    toolAggregates: Map<string, ToolAggregate & { tagId: number }>,
): string | undefined {
    for (let i = pendingKeys.length - 1; i >= 0; i -= 1) {
        const key = pendingKeys[i];
        if (key === undefined) continue;
        const aggregate = toolAggregates.get(key);
        if (aggregate === undefined) continue;
        if (!aggregate.occurrences.some((occ) => occ.kind === "tool_result")) {
            return key;
        }
    }
    return undefined;
}

function markToolAggregateResolved(
    callId: string,
    aggregateKey: string,
    openToolAggregateKeysByCallId: Map<string, string[]>,
): void {
    const pendingKeys = openToolAggregateKeysByCallId.get(callId);
    if (pendingKeys === undefined) return;
    const nextPendingKeys = pendingKeys.filter((key) => key !== aggregateKey);
    if (nextPendingKeys.length === 0) {
        openToolAggregateKeysByCallId.delete(callId);
        return;
    }
    openToolAggregateKeysByCallId.set(callId, nextPendingKeys);
}

/** Real-tokenizer count for tagged text (images bill by visual tokens). */
function estimateTagTextTokens(text: string): number {
    if (!text) return 0;
    if (text.startsWith("data:image/")) return estimateImageTokensFromDataUrl(text);
    return estimateTokens(text);
}

function getToolPartByteSize(part: TranscriptPart, text: string): number {
    const textByteSize = byteSize(text);
    if (textByteSize > 0 || part.kind !== "tool_result") return textByteSize;
    return getNonTextToolResultByteSize(part);
}

/**
 * Real-tokenizer mirror of {@link getToolPartByteSize}: token count of a tool
 * part's output text (falling back to the raw payload for non-text results,
 * matching the byte path so token_count stays consistent with byte_size).
 */
function getToolPartTokenCount(part: TranscriptPart, text: string): number {
    if (text.length > 0 || part.kind !== "tool_result") return estimateTokens(text);
    const raw = part.rawByteSize?.();
    if (typeof raw === "number" && raw > 0) {
        const record = isRecord(part) ? part : undefined;
        const content =
            record?.content ??
            record?.rawContent ??
            record?.rawPart ??
            record?.part ??
            record?.data ??
            record?.image ??
            record?.source;
        const serialized = safeJsonStringify(content ?? part);
        return serialized === undefined ? 0 : estimateTokens(serialized);
    }
    return 0;
}

function getCachedToolPartTokenCount(
    part: TranscriptPart,
    text: string,
    cache?: Map<string, { text: string; tokenCount: number }>,
    cacheKey?: string,
): number {
    const cached = cacheKey ? cache?.get(cacheKey) : undefined;
    if (cached?.text === text) return cached.tokenCount;
    const tokenCount = getToolPartTokenCount(part, text);
    if (cacheKey) cache?.set(cacheKey, { text, tokenCount });
    return tokenCount;
}

function getNonTextToolResultByteSize(part: TranscriptPart): number {
    // Prefer the adapter's exact raw-payload size when available (Pi's
    // tool_result proxy can serialize the real content array, incl. images).
    const raw = part.rawByteSize?.();
    if (typeof raw === "number" && raw > 0) return raw;
    const record = isRecord(part) ? part : undefined;
    const content =
        record?.content ??
        record?.rawContent ??
        record?.rawPart ??
        record?.part ??
        record?.data ??
        record?.image ??
        record?.source;
    const serialized = safeJsonStringify(content ?? part);
    return serialized === undefined ? 0 : byteSize(serialized);
}

function safeJsonStringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

interface TagTextPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    contentId: string;
    msgIndex: number;
    textOrdinal: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
    entryFingerprint: string | null;
    reuseIdentity: boolean;
    timing?: TagTranscriptTiming;
    textIdentitySourceCache?: Map<number, string>;
    textTokenCache?: Map<string, { text: string; tokenCount: number }>;
}

function tagTextPart(args: TagTextPartArgs): void {
    const identityStart = args.timing ? performance.now() : 0;
    const text = args.part.getText() ?? "";
    // Pi and OMP can expose provider framing as assistant text blocks. Treat a
    // previously prefixed blank as blank too, so MC never turns inert framing
    // into a tag-bearing part that later strip logic could mistake for content.
    if (
        args.message.info.role === "assistant" &&
        stripWellFormedLeadingTagPrefix(text).trim().length === 0
    ) {
        if (args.timing) args.timing.identity += performance.now() - identityStart;
        return;
    }
    const contentId = args.contentId;
    const reusableTagId = args.reuseIdentity
        ? args.tagger.getTag(args.sessionId, contentId, "message")
        : undefined;
    if (reusableTagId !== undefined) {
        if (args.timing) args.timing.identity += performance.now() - identityStart;
        applyTextPrefixAndTarget(args, reusableTagId, text);
        return;
    }
    const tagId = args.tagger.assignTag(
        args.sessionId,
        contentId,
        "message",
        byteSize(text),
        args.db,
        0,
        null,
        0,
        args.entryFingerprint,
        // Lazy: fires only on fresh insert. Strip any §N§ prefix so a re-tag
        // from already-prefixed text still tokenizes the pristine content.
        () => {
            const tokenStart = args.timing ? performance.now() : 0;
            const cached = args.textTokenCache?.get(contentId);
            const tokenCount =
                cached?.text === text
                    ? cached.tokenCount
                    : estimateTagTextTokens(stripTagPrefix(text));
            if (cached?.text !== text) {
                args.textTokenCache?.set(contentId, { text, tokenCount });
            }
            const counts = {
                tokenCount,
                inputTokenCount: null,
                reasoningTokenCount: null,
            };
            if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
            return counts;
        },
    );

    // Persist the original (pre-tagged) source content so caveman
    // compression and other "compress from original" heuristics have
    // pristine text to read on later passes. saveSourceContent uses
    // INSERT OR IGNORE — first write wins; later passes that re-tag
    // the same (sessionId, tagId) pair from already-prefixed text won't
    // overwrite the original. Cache-stable.
    //
    // We strip any existing §N§ prefix before saving in case a previous
    // pass already injected one and the persisted source got lost
    // (e.g. legacy session created before this code shipped). For new
    // sessions stripTagPrefix is a no-op on the very first pass.
    const sourceContent = stripTagPrefix(text);
    if (sourceContent.trim().length > 0) {
        saveSourceContent(args.db, args.sessionId, tagId, sourceContent);
        args.textIdentitySourceCache?.set(tagId, sourceContent);
    }
    if (args.timing) args.timing.identity += performance.now() - identityStart;
    applyTextPrefixAndTarget(args, tagId, text);
}

function applyTextPrefixAndTarget(args: TagTextPartArgs, tagId: number, text: string): void {
    if (!args.skipPrefixInjection) {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(tagId, text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }

    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(
        tagId,
        buildTextTarget(
            args.part,
            args.message,
            args.skipPrefixInjection ? "" : prependTag(tagId, ""),
        ),
    );
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

interface TagToolPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    msgIndex: number;
    partIndex: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
    reuseIdentity: boolean;
    timing?: TagTranscriptTiming;
}

function tagToolPart(args: TagToolPartArgs): void {
    const identityStart = args.timing ? performance.now() : 0;
    // Prefer the part's stable id (tool call id from Pi/OpenCode); fall
    // back to a synthetic locator. Tool calls and their results MAY
    // share an id (Pi sets toolCallId on ToolResultMessage to match the
    // originating ToolCall.id); when that happens, both tag operations
    // resolve to the same tag number — desired behavior, since drops
    // target the call-id pair as a unit.
    const stableId = args.part.id;
    const contentId = stableId ?? `${args.messageId}:t${args.partIndex}`;
    const reusableTagId = args.reuseIdentity
        ? args.tagger.getToolTag(args.sessionId, contentId, contentId)
        : undefined;
    if (reusableTagId !== undefined) {
        const text = args.part.kind === "tool_result" ? (args.part.getText() ?? "") : "";
        if (args.timing) args.timing.identity += performance.now() - identityStart;
        applySingleToolPrefixAndTarget(args, reusableTagId, text);
        return;
    }
    const text = args.part.getText() ?? "";
    const toolByteSize = getToolPartByteSize(args.part, text);
    const meta = args.part.getToolMetadata();
    const tokenStart = args.timing ? performance.now() : 0;
    const toolTokenCount = getToolPartTokenCount(args.part, text);
    if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
    // v3.3.1 Layer C: synthetic ownership for the no-callId Pi
    // fallback. Owner == callId == contentId. The composite key
    // collapses to a unique synthetic identifier per part, preserving
    // the legacy "each part gets its own tag" behavior while
    // satisfying the composite-identity contract (TagEntry.tool_owner_message_id
    // is non-null, lazy-adoption path is correctly bypassed).
    const tagId = args.tagger.assignToolTag(
        args.sessionId,
        contentId,
        contentId,
        toolByteSize,
        args.db,
        0,
        meta.toolName ?? null,
        meta.inputByteSize,
        () => {
            const tokenStart = args.timing ? performance.now() : 0;
            const counts = {
                tokenCount: toolTokenCount,
                inputTokenCount: meta.inputTokenCount,
                reasoningTokenCount: null,
            };
            if (args.timing) args.timing.tokenCounting += performance.now() - tokenStart;
            return counts;
        },
    );
    if (args.timing) args.timing.identity += performance.now() - identityStart;
    applySingleToolPrefixAndTarget(args, tagId, text);
}

function applySingleToolPrefixAndTarget(args: TagToolPartArgs, tagId: number, text: string): void {
    // For tool parts, the visible payload is the tool result text. We
    // can inject the tag prefix into it for in-text references; this
    // matches the OpenCode behavior of tagging tool outputs.
    if (!args.skipPrefixInjection && args.part.kind === "tool_result") {
        const prefixStart = args.timing ? performance.now() : 0;
        args.part.setText(prependTag(tagId, text));
        if (args.timing) args.timing.prefix += performance.now() - prefixStart;
    }

    const targetStart = args.timing ? performance.now() : 0;
    args.targets.set(tagId, buildToolTarget(args.part, args.message, tagId));
    if (args.timing) args.timing.targets += performance.now() - targetStart;
}

function setToolContentOrText(part: TranscriptPart, content: string): boolean {
    try {
        if (part.setToolOutput(content)) return true;
    } catch {
        // Pi assistant tool_use parts deliberately assert if callers try
        // to write a nonexistent output slot. Truncated-mode drops still
        // need to shrink the invocation, so fall back to visible text/args
        // replacement while preserving the adapter-level invariant.
    }
    return part.setText(content);
}

/**
 * Build a TagTarget that walks ALL occurrences of a tool call (invocation
 * + result) when mutating. This is the per-callId aggregate target used
 * by `tagTranscript` so a single drop replaces both halves.
 *
 * The closures hold a reference to the same `occurrences` array stored
 * on the aggregate, so when the array gets mutated (a second occurrence
 * is pushed mid-walk), the next call to setContent/drop/truncate sees
 * all occurrences automatically. Callers MUST rebuild the target after
 * pushing a new occurrence so the targets map points to a fresh closure
 * over the updated array — otherwise consumers that captured the target
 * before the push won't see the new occurrence.
 *
 * Mirrors OpenCode's createToolDropTarget semantics in tool-drop-target.ts.
 */
function buildAggregateTarget(
    tagId: number,
    occurrences: ToolOccurrence[],
    requiresToolArcSkeleton: boolean,
    conversationEnd?: ConversationEndGuard,
): TagTarget {
    const role = occurrences[0]?.message.info.role ?? "user";
    const messageId = occurrences[0]?.message.info.id;

    const truncate = (): "truncated" | "absent" => {
        // Keep the tool call and its result, but replace the call arguments with
        // a non-executable marker and the result content with the dropped marker.
        // Legacy render, replayed only for `drop_mode = 'truncated'` tags until a
        // HARD fold converts them; new drops use skeletonReal().
        const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
        let any = false;
        for (const occ of occurrences) {
            if (occ.kind === "tool_use" && occ.part.setToolInput) {
                occ.originalInput ??= occ.part.getToolInput?.() ?? undefined;
                if (occ.part.setToolInput(droppedInputMarker(tagId))) any = true;
            } else if (setToolContentOrText(occ.part, sentinel)) {
                any = true;
            }
        }
        return any ? "truncated" : "absent";
    };

    const complete = (): boolean =>
        occurrences.some((occ) => occ.kind === "tool_use") &&
        occurrences.some((occ) => occ.kind === "tool_result");

    const skeletonReal = (): "truncated" | "absent" | "incomplete" => {
        // Keep the tool call with the arguments the host gave it and replace
        // only the result content with the dropped marker. Nothing is written
        // into the argument position unless an earlier render this pass did,
        // in which case the real input goes back.
        if (!complete()) return "incomplete";
        const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
        let any = false;
        for (const occ of occurrences) {
            if (occ.kind === "tool_use") {
                if (occ.originalInput && occ.part.setToolInput?.(occ.originalInput)) any = true;
            } else if (setToolContentOrText(occ.part, sentinel)) {
                any = true;
            }
        }
        return any ? "truncated" : "absent";
    };

    // Adapters without structural removal (or arcs that must keep their pair
    // beside native reasoning) cannot remove the call; drop() would keep it.
    const cannotRemove = (): boolean => {
        if (requiresToolArcSkeleton) return true;
        const authorization = occurrences.map((occ) => occ.part.canRemove?.());
        return !occurrences.every(
            (occ, index) => occ.part.remove && authorization[index] !== false,
        );
    };

    return {
        mutationParts: occurrences.map((occ) => ({
            message: { info: occ.message.info, parts: [] },
            part: occ.part,
        })),
        measureReclaim(skeleton) {
            let beforeTools = 0;
            let afterTools = 0;
            const authorization = occurrences.map((occ) => occ.part.canRemove?.());
            const removable =
                !requiresToolArcSkeleton &&
                occurrences.every(
                    (occ, index) =>
                        occ.part.remove &&
                        authorization[index] !== false &&
                        authorization[index] !== "defer",
                );
            for (const occ of occurrences) {
                const before =
                    occ.kind === "tool_use"
                        ? JSON.stringify(occ.part.getToolInput?.() ?? {})
                        : (occ.part.getText() ?? "");
                beforeTools += estimateTokens(before);
                if (skeleton || !removable) {
                    // A kept call keeps its real arguments; only the result shrinks.
                    const after = occ.kind === "tool_use" ? before : `[dropped §${tagId}§]`;
                    afterTools += estimateTokens(after);
                }
            }
            return {
                beforeTools,
                afterTools: !skeleton && authorization.includes("defer") ? beforeTools : afterTools,
                beforeProse: 0,
                afterProse: 0,
            };
        },
        setContent(content: string): boolean {
            // Walk all occurrences; mutate every one. Return true if at
            // least one occurrence's content actually changed (used to
            // gate sentinel-replay re-writes).
            let changed = false;
            for (const occ of occurrences) {
                // Try setToolOutput first (works on tool_result-shaped parts);
                // fall back to setText so tool_use parts also get sentinelized.
                if (setToolContentOrText(occ.part, content)) {
                    changed = true;
                }
            }
            return changed;
        },
        getContent(): string | null {
            // Prefer the result occurrence's content (the bulky payload).
            for (const occ of occurrences) {
                if (occ.kind === "tool_result") {
                    return occ.part.getText() ?? null;
                }
            }
            return occurrences[0]?.part.getText() ?? null;
        },
        drop(): "removed" | "truncated" | "absent" | "incomplete" {
            if (!complete()) return "incomplete";
            if (!requiresToolArcSkeleton) {
                const authorization = occurrences.map((occ) => occ.part.canRemove?.());
                // A failed durable marker is not permission to substitute a new
                // skeleton. Keep both halves unchanged and leave the drop queued.
                if (authorization.includes("defer")) return "incomplete";
                if (
                    occurrences.every(
                        (occ, index) => occ.part.remove && authorization[index] !== false,
                    )
                ) {
                    // If removing this call's result would leave the provider
                    // request ending on an assistant turn, keep the call with its
                    // REAL arguments plus the placeholder result instead.
                    // "truncated" tells callers to persist that mode
                    // (`skeleton_real`), so later passes serve the same bytes.
                    // (The sentinel fallback below keeps call and result in place,
                    // so it needs no exception.)
                    if (conversationEnd?.wouldStrand(occurrences)) return skeletonReal();
                    let removed = false;
                    for (const occ of occurrences) removed = occ.part.remove?.() || removed;
                    if (removed) conversationEnd?.noteRemoved(occurrences);
                    return removed ? "removed" : "absent";
                }
            }
            // Adapters without structural removal retain paired sentinels. This
            // writes a marker into the call's arguments, so only replays of
            // existing `full` tags reach it: new drops check cannotRemove() and
            // use skeletonReal(), and a HARD fold converts the existing ones.
            const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
            let any = false;
            for (const occ of occurrences) {
                if (occ.part.replaceWithSentinel(sentinel)) any = true;
            }
            return any ? "removed" : "absent";
        },
        truncate,
        skeletonReal,
        cannotRemove,
        inputStringBytes(): number | null {
            for (const occ of occurrences) {
                if (occ.kind !== "tool_use") continue;
                return toolInputStringBytes(occ.originalInput ?? occ.part.getToolInput?.() ?? null);
            }
            return null;
        },
        wouldStrandConversationEnd(): boolean {
            return conversationEnd?.wouldStrand(occurrences) ?? false;
        },
        editMarker(): "truncated" | "absent" {
            // Edit-marker: preserve the tool_use input's filePath + a region
            // hint of the diff, sentinelize the result half. Separate from
            // truncate() so the existing skeleton bytes are never touched.
            // Deterministic + idempotent (re-derived from source each pass; the
            // region-hint clamp self-guards via ...[truncated]).
            const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
            let any = false;
            for (const occ of occurrences) {
                if (occ.kind === "tool_use") {
                    const input = occ.part.getToolInput?.();
                    if (input) {
                        const next = { ...input };
                        applyEditMarkerToInput(next);
                        if (occ.part.setToolInput?.(next)) any = true;
                    }
                } else if (setToolContentOrText(occ.part, sentinel)) {
                    any = true;
                }
            }
            return any ? "truncated" : "absent";
        },
        // Open invocations still belong to the current turn; only complete arcs reclaim.
        canDrop: () => complete() && !occurrences.some((occ) => occ.part.hasUserAnswer?.()),
        requiresToolArcSkeleton,
        // Non-mutating read of the invocation input (the tool_use occurrence
        // carries the arguments). Used by smart-drops supersession selection.
        readInput(): Record<string, unknown> | null {
            for (const occ of occurrences) {
                const input = occ.part.getToolInput?.();
                if (input) return input;
            }
            return null;
        },
        message: {
            info: { id: messageId, role },
            parts: [],
        },
    };
}

/**
 * TagTarget for a tag-eligible text part. The shared
 * `applyPendingOperations` flow calls `setContent` to swap in a
 * sentinel like `[dropped §N§]` when a queued drop fires; `getContent`
 * returns the current visible text so the truncated-preview path can
 * compute its before/after.
 *
 * The `message.info.role` is used by `buildReplacementContent` in
 * `apply-operations.ts` to differentiate user-message drops (which
 * preserve a truncated preview) from assistant drops (full sentinel).
 */
function buildTextTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
    textPrefix: string,
): TagTarget {
    return {
        mutationParts: [{ message: { info: message.info, parts: [] }, part }],
        textPrefix,
        setContent(content: string): boolean {
            return part.setText(content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        // `message` is typed as MessageLike, which has parts: unknown[].
        // We don't carry parts here (the apply-operations flow only
        // reads `info.role` on this field), so a minimal stub is
        // sufficient.
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}

/**
 * TagTarget for a tag-eligible tool part. Tool parts get full-drop or
 * skeleton-drop treatment from `applyFlushedStatuses` based on the stored
 * `drop_mode` column. Both render the SAME canonical `[dropped §N§]`
 * placeholder — full-drop replaces the whole pair, while skeleton-drop keeps
 * the tool_use call with only a dropped-input marker. Marker bytes are
 * byte-identical across passes and across harnesses.
 */
function buildToolTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
    tagId: number,
): TagTarget {
    return {
        mutationParts: [{ message: { info: message.info, parts: [] }, part }],
        setContent(content: string): boolean {
            return setToolContentOrText(part, content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        drop(): "removed" | "absent" {
            // Replace the tool part's visible content with a "[dropped]"
            // shell. We can't physically remove the part because Pi
            // requires tool_use ↔ tool_result pairing for the LLM call
            // to validate; instead we shrink the content to a sentinel.
            // For Pi the current Transcript contract treats both
            // invocation and result parts symmetrically — both expose
            // setText / setToolOutput.
            const replaced = part.replaceWithSentinel(`[dropped \u00a7${tagId}\u00a7]`);
            return replaced ? "removed" : "absent";
        },
        truncate(): "truncated" | "absent" {
            // Legacy render, replayed only for unconverted `truncated` tags.
            const changed = part.setToolInput
                ? part.setToolInput(droppedInputMarker(tagId))
                : setToolContentOrText(part, `[dropped \u00a7${tagId}\u00a7]`);
            return changed ? "truncated" : "absent";
        },
        skeletonReal(): "truncated" | "absent" {
            // An invocation part keeps its real arguments untouched; a result
            // part's content becomes the dropped marker.
            if (part.setToolInput) return "truncated";
            return setToolContentOrText(part, `[dropped \u00a7${tagId}\u00a7]`)
                ? "truncated"
                : "absent";
        },
        // drop() replaces an invocation part's arguments with a marker, so a
        // new drop of one keeps its real arguments instead.
        cannotRemove: () => part.setToolInput !== undefined,
        // Without a paired tool call, an answer marker can forbid automatic dropping,
        // but must not make ordinary results newly eligible for automatic reclaim.
        ...(part.hasUserAnswer?.() ? { canDrop: () => false } : {}),
        inputStringBytes(): number | null {
            return part.setToolInput ? toolInputStringBytes(part.getToolInput?.() ?? null) : 0;
        },
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}
