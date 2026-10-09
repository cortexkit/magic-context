import type { ContextDatabase } from "../../features/magic-context/storage";
import { getSourceContents, saveSourceContent } from "../../features/magic-context/storage";
import {
    adoptNullOwnerToolTag,
    getCandidateToolOwners,
    getInertWhitespaceAssistantTags,
    getNullOwnerToolTag,
    getTagById,
    getTagNumberByMessageId,
    getToolTagNumberByOwner,
    markWhitespaceAssistantTagInert,
    pickNearestPriorOwner,
} from "../../features/magic-context/storage-tags";
import { makeToolCompositeKey, type Tagger } from "../../features/magic-context/tagger";
import { textMentionsRecentCommit } from "../../shared/commit-detection";
import { isRecord } from "../../shared/record-type-guard";
import { isReduceToolPart } from "./drop-stale-reduce-calls";
import {
    estimateImageTokensFromDataUrl,
    estimateToolAttachmentImageTokens,
} from "./image-token-estimate";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import { neutralizeDroppedReasoningPart } from "./sentinel";
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
    partHasCompletedResult,
    type ToolCallIndex,
    type ToolDropResult,
    ToolMutationBatch,
    type ToolSweepVariantResolver,
} from "./tool-drop-target";
import { logTransformTiming } from "./transform-stage-logger";

interface ToolOwnerDerivationCache {
    candidateOwnersByCallId: Map<string, string[]>;
    messageTimesById: Map<string, number | null>;
}

type ToolOwnerFallbackLookup =
    | { kind: "candidates"; callId: string }
    | { kind: "messageTimes"; messageIds: readonly string[] };

const TOOL_OWNER_CACHE_KEY_SEP = "\x00";

type InertWhitespaceTag = ReturnType<typeof getInertWhitespaceAssistantTags>[number];
const inertWhitespaceCache = new WeakMap<
    ContextDatabase,
    Map<string, { tagsVersion: number; ownersKey: string; tags: InertWhitespaceTag[] }>
>();

function getCachedInertWhitespaceAssistantTags(
    db: ContextDatabase,
    sessionId: string,
    tagger: Tagger,
    messages: readonly MessageLike[],
): InertWhitespaceTag[] {
    const messageIds = messages.flatMap((message) =>
        typeof message.info.id === "string" ? [message.info.id] : [],
    );
    const ownersKey = JSON.stringify(messageIds);
    const tagsVersion = tagger.getLoadedTagsVersion?.(sessionId, db);
    if (tagsVersion === undefined)
        return getInertWhitespaceAssistantTags(db, sessionId, messageIds);

    let bySession = inertWhitespaceCache.get(db);
    if (!bySession) {
        bySession = new Map();
        inertWhitespaceCache.set(db, bySession);
    }
    const cached = bySession.get(sessionId);
    if (cached?.tagsVersion === tagsVersion && cached.ownersKey === ownersKey) return cached.tags;

    const tags = getInertWhitespaceAssistantTags(db, sessionId, messageIds);
    bySession.set(sessionId, { tagsVersion, ownersKey, tags });
    return tags;
}

function makeToolOwnerCacheKey(sessionId: string, callId: string): string {
    return `${sessionId}${TOOL_OWNER_CACHE_KEY_SEP}${callId}`;
}

function getCachedCandidateToolOwners(
    db: ContextDatabase,
    sessionId: string,
    callId: string,
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): string[] {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined) return cached;

    onLookup?.({ kind: "candidates", callId });
    const candidates = getCandidateToolOwners(db, sessionId, callId);
    cache.candidateOwnersByCallId.set(key, candidates);
    return candidates;
}

function getCachedMessageTimesFromOpenCodeDb(
    sessionId: string,
    messageIds: readonly string[],
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): Map<string, number> {
    const uncached = [...new Set(messageIds)].filter((id) => !cache.messageTimesById.has(id));
    if (uncached.length > 0) {
        onLookup?.({ kind: "messageTimes", messageIds: uncached });
        const resolved = getMessageTimesFromOpenCodeDb(sessionId, uncached);
        for (const id of uncached) {
            cache.messageTimesById.set(id, resolved.get(id) ?? null);
        }
    }

    const times = new Map<string, number>();
    for (const id of messageIds) {
        const time = cache.messageTimesById.get(id);
        if (typeof time === "number") times.set(id, time);
    }
    return times;
}

function invalidateCachedCandidateToolOwnersIfNewOwner(
    cache: ToolOwnerDerivationCache,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): void {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined && !cached.includes(ownerMsgId)) {
        cache.candidateOwnersByCallId.delete(key);
    }
}

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
    cache: ToolOwnerDerivationCache,
    onFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void,
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
        const candidates = getCachedCandidateToolOwners(
            db,
            sessionId,
            obs.callId,
            cache,
            onFallbackLookup,
        );
        if (candidates.length > 0) {
            const ids = [...candidates, messageId];
            const times = getCachedMessageTimesFromOpenCodeDb(
                sessionId,
                ids,
                cache,
                onFallbackLookup,
            );
            const persisted = pickNearestPriorOwner(candidates, messageId, times);
            if (persisted !== null) return persisted;
        }
        return messageId;
    }
    return obs.callId;
}

export type MessageInfo = {
    id?: string;
    role?: string;
    sessionID?: string;
    summary?: boolean;
    /** Marks one of the two m[0]/m[1] messages prepended by compartment injection. */
    syntheticHead?: boolean;
    finish?: string;
    error?: unknown;
};

export interface ThinkingLikePart {
    type: string;
    thinking?: string;
    text?: string;
}

export type MessageLike = { info: MessageInfo; parts: unknown[] };

export interface TagNormalizationTarget {
    tagNumber: number;
    message: MessageLike;
    part: unknown;
    field: "text" | "tool_state_output" | "tool_result_content";
}

export type TagTarget = {
    /** Parts a drop neutralizes, distinct from a meaning-preserving text rewrite. */
    dropReasoningParts?: readonly unknown[];
    /** Original coordinates of the content this target edits. */
    mutationParts?: readonly { message: MessageLike; part: unknown }[];
    /** New drops are withheld; persisted replay uses the original target map. */
    thinkingDropProtected?: boolean;
    /** A rewrite here would invalidate a later protected signed block. */
    thinkingRewriteProtected?: boolean;
    /** Non-mutating count of current and replacement token-bearing fields for a planned drop. */
    measureReclaim?: (skeleton: boolean) => {
        beforeTools: number;
        afterTools: number;
        beforeProse: number;
        afterProse: number;
    };
    /**
     * Replace the part's text. A text target treats this as a drop by default
     * and also takes the reasoning of its message off the wire, since that
     * reasoning answered the text that left. `keepReasoning` marks an in-place
     * rewrite that keeps the text's meaning (caveman compression, a partial
     * system-injection strip): the reasoning stays, because removing it would
     * leave a gap in the middle of the history that prefix-bound models reject
     * for every later thinking block.
     */
    setContent: (content: string, options?: { keepReasoning?: boolean }) => boolean;
    getContent?: () => string | null;
    /**
     * Text targets: the `§N§ ` prefix this pass puts in front of the text, or
     * "" when prefixes are not injected. A rewrite computed from the stored
     * source (which never carries the prefix) puts it back with this.
     */
    textPrefix?: string;
    drop?: () => ToolDropResult;
    /** Legacy skeleton: arguments replaced by the `{"dropped": …}` marker.
     * Replay-only, for `drop_mode = 'truncated'` tags not yet converted. */
    truncate?: () => ToolDropResult;
    /** Real-argument skeleton: the call keeps the arguments the host gave it,
     * only the output becomes `[dropped §N§]` (`drop_mode = 'skeleton_real'`). */
    skeletonReal?: () => ToolDropResult;
    /** New attachment-bearing skeletons omit media; legacy skeletons retain it. */
    skeletonStripped?: () => ToolDropResult;
    hasAttachments?: () => boolean;
    /** Total UTF-8 bytes of the string values in the call's input (see
     * tool-input-size.ts); null when the call is not on this pass's wire. */
    inputStringBytes?: () => number | null;
    /** Non-mutating: would removing this call leave the request ending on an
     * assistant turn (given what this pass already removed)? */
    wouldStrandConversationEnd?: () => boolean;
    /** Non-mutating: the host adapter cannot remove this call structurally, so
     * drop() would keep a paired shell instead. A new drop then keeps the real
     * arguments (skeletonReal) rather than any placeholder. */
    cannotRemove?: () => boolean;
    /** Edit-marker compression for an edit/write superseded by a later edit to
     * the same file: keep the call + filePath + a region hint of the diff,
     * output → [dropped §N§]. Used by smart-drops. */
    editMarker?: () => ToolDropResult;
    editMarkerStripped?: () => ToolDropResult;
    /** Non-mutating: would drop()/truncate() actually reclaim bytes? Tool
     * targets only; absent on message/file targets. */
    canDrop?: () => boolean;
    /** A full arc removal would strand or merge native reasoning, so keep a paired skeleton. */
    requiresToolArcSkeleton?: boolean;
    /** Non-mutating read of the tool invocation's input object (e.g. to read
     * `ctx_note`'s action or an edit's filePath for supersession selection).
     * Tool targets only; null when no invocation part is present. */
    readInput?: () => Record<string, unknown> | null;
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
    /** Exact part references that received a Magic Context tag prefix while tagMessages processed them. */
    normalizationTargets: TagNormalizationTarget[];
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

/**
 * Real-tokenizer mirror of {@link getReasoningByteSize}. Computed once per tag
 * (lazy thunk on fresh insert) and stored on the tag row so token-budget
 * consumers SUM stored counts instead of re-tokenizing raw history every pass.
 */
function getReasoningTokenCount(parts: ThinkingLikePart[]): number {
    let tokens = 0;
    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            tokens += estimateTokens(content);
        }
    }
    return tokens;
}

function serializeToolInput(input: unknown): string | null {
    try {
        return JSON.stringify(input) ?? null;
    } catch {
        return null;
    }
}

function estimateInputByteSize(serializedInput: string | null): number {
    return serializedInput?.length ?? 0;
}

/** Real-tokenizer count for a tool input payload (string or JSON-serializable). */
function estimateInputTokenCount(input: unknown, serializedInput: string | null): number {
    if (input === undefined || input === null) return 0;
    const tokenText = typeof input === "string" ? input : serializedInput;
    return tokenText ? estimateTokens(tokenText) : 0;
}

/**
 * Real-tokenizer count for a text/file part's tag content. Images bill by
 * visual tokens (same heuristic as the sidebar breakdown); plain text tokenizes
 * directly. Mirrors the per-part logic so a tag's token_count matches what the
 * content actually costs on the wire.
 */
function estimateTextTagTokenCount(text: string): number {
    if (!text) return 0;
    if (text.startsWith("data:image/")) return estimateImageTokensFromDataUrl(text);
    return estimateTokens(text);
}

function extractToolTagMetadata(part: unknown): {
    toolName: string | null;
    inputByteSize: number;
    inputTokenCount: number;
} {
    if (!isRecord(part)) {
        return { toolName: null, inputByteSize: 0, inputTokenCount: 0 };
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
    const serializedInput = serializeToolInput(input);

    return {
        toolName,
        inputByteSize: estimateInputByteSize(serializedInput),
        inputTokenCount: estimateInputTokenCount(input, serializedInput),
    };
}

export interface TagMessagesOptions {
    /** Original part references in the provider's unfinished signed assistant turn. */
    protectedThinkingMessages?: ReadonlySet<MessageLike>;
    /**
     * When true, skip injecting §N§ prefix into message text/tool output parts.
     * DB-level tag records are still created normally — this flag only affects
     * whether the agent-visible part content gets the tag prefix. Used when
     * the session's tool allow-list denies ctx_reduce so agents don't see tag
     * markers they can't act on. Cache-safe: the availability verdict is frozen
     * per session, so message shape stays stable.
     */
    skipPrefixInjection?: boolean;
    /**
     * Prune only tool-drop owners; callers enable this after persisting
     * cache-safe session adoption. A resolver defers the choice to finalize
     * time, where both candidate arrays are known (see
     * `createPreAdoptionToolSweepResolver`).
     */
    scopedToolSweep?: boolean | ToolSweepVariantResolver;
    /**
     * The array that reaches the provider, when it is not `messages`. Passes
     * that trim a compaction prefix tag the pre-trim copy, and the sweep has to
     * remove its emptied rows from the served array as well.
     */
    servedMessages?: MessageLike[];
    /** @internal diagnostic hook used by cache-stability/perf tests. */
    onToolOwnerFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void;
}

const COMMIT_LOOKBACK = 5;

/**
 * Detect commit announcements in the same recent assistant window used by tagging.
 * Rust authority skips the host tag walk, so this pure scan lets both authorities
 * drive the shared durable note-nudge trigger without mirror-writing tag state.
 */
export function hasRecentAssistantCommit(messages: readonly MessageLike[]): boolean {
    const firstRecentIndex = Math.max(0, messages.length - COMMIT_LOOKBACK);
    for (let messageIndex = firstRecentIndex; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        if (message?.info.role !== "assistant") continue;
        for (const part of message.parts) {
            if (isTextPart(part) && textMentionsRecentCommit((part as { text: string }).text)) {
                return true;
            }
        }
    }
    return false;
}

export function tagMessages(
    sessionId: string,
    messages: MessageLike[],
    tagger: Tagger,
    db: ContextDatabase,
    options: TagMessagesOptions = {},
): TagMessagesResult {
    const protectedThinkingParts = new Set(
        [...(options.protectedThinkingMessages ?? [])].flatMap((message) => message.parts),
    );
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const onToolOwnerFallbackLookup = options.onToolOwnerFallbackLookup;
    const targets = new Map<number, TagTarget>();
    const normalizationTargets: TagNormalizationTarget[] = [];
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
    const ownerDerivationCache: ToolOwnerDerivationCache = {
        candidateOwnersByCallId: new Map(),
        messageTimesById: new Map(),
    };
    // Memo: for each part observed, what owner did we derive? Used by
    // the second tool-block (isToolPartWithOutput) so it doesn't re-run
    // FIFO logic and double-pop the queue. Parts are object references
    // (the same `unknown` instance walked twice in the loop).
    const ownerByPartKey = new Map<unknown, { ownerMsgId: string; callId: string }>();
    const batch = new ToolMutationBatch(messages, options.scopedToolSweep, options.servedMessages);
    // Inert whitespace rows are replayed by (message, whitespace rank), not by
    // session-wide number membership: after a part-id remap the ordinal fallback
    // offers whichever inert row sits at the current ordinal, and two inert parts
    // in one message would otherwise swap their `§N§` digits on the wire.
    const tInertWhitespace = performance.now();
    const inertWhitespaceTagNumbers = new Set<number>();
    const inertWhitespaceTagsByMessage = new Map<
        string,
        Array<{ partIndex: number; tagNumber: number }>
    >();
    for (const tag of getCachedInertWhitespaceAssistantTags(db, sessionId, tagger, messages)) {
        inertWhitespaceTagNumbers.add(tag.tagNumber);
        tagger.bindTag(sessionId, tag.contentId, tag.tagNumber);
        const scoped = /^(.*):p(\d+)$/.exec(tag.contentId);
        if (!scoped) continue;
        const list = inertWhitespaceTagsByMessage.get(scoped[1]) ?? [];
        list.push({ partIndex: Number(scoped[2]), tagNumber: tag.tagNumber });
        inertWhitespaceTagsByMessage.set(scoped[1], list);
    }
    for (const list of inertWhitespaceTagsByMessage.values()) {
        list.sort((left, right) => left.partIndex - right.partIndex);
    }
    logTransformTiming(sessionId, "tag.inertWhitespace", tInertWhitespace);
    const assignments = tagger.getAssignments(sessionId);
    const resolver = createExistingTagResolver(sessionId, tagger, db);
    const tGetSourceContents = performance.now();
    const sourceContents = getSourceContents(
        db,
        sessionId,
        collectRelevantSourceTagIds(messages, assignments),
    );
    logTransformTiming(sessionId, "tag.getSourceContents", tGetSourceContents);
    // Partial compartment ends (a compartment that stops inside a message at
    // end_block_index), read once per pass on first use. Every text and file
    // target's setContent needs this, and a per-call query on a large session
    // costs hundreds of milliseconds per pass. When several partial compartments
    // end in the same message, text and file targets keep the first row and tool
    // targets the last, which is what their former per-target queries returned.
    let partialEndsCache: { first: Map<string, number>; last: Map<string, number> } | undefined;
    const loadPartialEnds = (): { first: Map<string, number>; last: Map<string, number> } => {
        if (partialEndsCache) return partialEndsCache;
        const first = new Map<string, number>();
        const last = new Map<string, number>();
        const rows = db
            .prepare(
                "SELECT end_message_id, end_block_index FROM compartments WHERE session_id=? AND end_block_index IS NOT NULL ORDER BY rowid",
            )
            .all(sessionId) as Array<{ end_message_id: string; end_block_index: number }>;
        for (const row of rows) {
            if (!first.has(row.end_message_id)) first.set(row.end_message_id, row.end_block_index);
            last.set(row.end_message_id, row.end_block_index);
        }
        partialEndsCache = { first, last };
        return partialEndsCache;
    };
    const getPartialEnds = (): Map<string, number> => loadPartialEnds().first;
    let precedingThinkingParts: ThinkingLikePart[] = [];
    let lastReduceMessageIndex = -1;
    const RECENT_REDUCE_LOOKBACK = 10;
    const commitDetected = hasRecentAssistantCommit(messages);

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
    // Diagnostic accumulators (summed across the whole walk, logged once below).
    let accDerive = 0;
    let accGetToolTag = 0;
    let accAssignTag = 0;
    let accAssignToolTag = 0;
    let accSaveSource = 0;
    const tLoop = performance.now();
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
        let whitespaceRank = 0;

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
                const _tDerive = performance.now();
                // A completed OpenCode tool part is hosted by its invocation message.
                // Reuse that already-loaded composite binding before attempting the
                // result-only fallback, which otherwise performs two database probes
                // for every historical tool part on every replay pass.
                const boundToHostingMessage =
                    toolObservation.kind === "result" && messageId
                        ? tagger.getToolTag(sessionId, toolObservation.callId, messageId)
                        : undefined;
                const ownerMsgId =
                    boundToHostingMessage !== undefined && messageId
                        ? messageId
                        : deriveToolOwnerMessageId(
                              sessionId,
                              db,
                              message,
                              toolObservation,
                              unpairedInvocations,
                              ownerDerivationCache,
                              onToolOwnerFallbackLookup,
                          );
                accDerive += performance.now() - _tDerive;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolObservation.callId);
                const entry = toolCallIndex.get(compositeKey) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message, part, kind: toolObservation.kind });
                // An OpenCode `{ type: "tool" }` part is observed as a "result" by
                // its TYPE even while the call is still pending/running, so gate
                // hasResult on an ACTUAL completed result (state.output present).
                // This keeps open arcs out of every drop/clamp selector — a live
                // task part's input must never become a reclaim target.
                if (toolObservation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                toolCallIndex.set(compositeKey, entry);

                const _tGetTool = performance.now();
                let existingTagId = tagger.getToolTag(
                    sessionId,
                    toolObservation.callId,
                    ownerMsgId,
                );
                accGetToolTag += performance.now() - _tGetTool;

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
                            invalidateCachedCandidateToolOwnersIfNewOwner(
                                ownerDerivationCache,
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
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

                // Scoped-load self-heal for the invocation-only path: a tool tag
                // can exist in the DB under its exact composite (owner, callId)
                // key yet be absent from the in-memory map when the tagger load
                // was scoped to the live-wire floor and this tag's number is below
                // it (a tool RESULT in the wire whose invocation was compacted away
                // resolves to a persisted owner below the floor — tag-messages
                // pickNearestPriorOwner). The output-bearing path (assignToolTag)
                // already does this composite DB lookup; the invocation/native
                // tool_result observation path did not. Without it, the existing
                // tag would be missed and a queued drop mis-detected. Rebind the
                // EXACT persisted number so §N§ stays byte-identical.
                if (existingTagId === undefined) {
                    const persisted = getToolTagNumberByOwner(
                        db,
                        sessionId,
                        toolObservation.callId,
                        ownerMsgId,
                    );
                    if (persisted !== null) {
                        tagger.bindToolTag(
                            sessionId,
                            toolObservation.callId,
                            ownerMsgId,
                            persisted,
                        );
                        existingTagId = persisted;
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
                const whitespaceOnlyAssistant =
                    message.info.role === "assistant" &&
                    stripTagPrefix(textPart.text).trim().length === 0;
                // New whitespace-only assistant parts are provider framing, not reclaimable
                // content. A pre-deploy row is different: replay its existing prefix forever
                // so deployment never changes signed-adjacent bytes, but retire the row from
                // active accounting because ctx_reduce cannot reclaim provider framing.
                let existingTagId: number | undefined;
                if (whitespaceOnlyAssistant) {
                    const persistedWhitespaceTag = getTagNumberByMessageId(
                        db,
                        sessionId,
                        contentId,
                    );
                    const rankedInertTag =
                        inertWhitespaceTagsByMessage.get(messageId)?.[whitespaceRank];
                    // Reuse a retired whitespace tag only at its original part index or
                    // next to a thinking part, where whitespace is provider framing. A
                    // blank added after a completed step must remain untagged instead of
                    // inheriting an older prefix.
                    const canReplayRankedTag =
                        rankedInertTag?.partIndex === partIndex ||
                        isThinkingPart(message.parts[partIndex - 1]) ||
                        isThinkingPart(message.parts[partIndex + 1]);
                    const inertForThisPart = canReplayRankedTag
                        ? rankedInertTag?.tagNumber
                        : undefined;
                    whitespaceRank += 1;
                    if (inertForThisPart !== undefined) {
                        // Bind by rank, bypassing the ordinal fallback: after a remap the
                        // fallback offers whichever row sits at the current text ordinal,
                        // which is the wrong inert row whenever a real text part moved.
                        tagger.bindTag(sessionId, contentId, inertForThisPart);
                        existingTagId = inertForThisPart;
                    } else {
                        existingTagId = resolver.resolve(
                            messageId,
                            "message",
                            contentId,
                            textOrdinal,
                            { accept: (tagNumber) => tagNumber === persistedWhitespaceTag },
                        );
                    }
                    if (existingTagId === undefined) {
                        const persisted = getTagNumberByMessageId(db, sessionId, contentId);
                        if (
                            persisted !== null &&
                            !getSourceContents(db, sessionId, [persisted]).has(persisted)
                        ) {
                            tagger.bindTag(sessionId, contentId, persisted);
                            existingTagId = persisted;
                        }
                    }
                    if (existingTagId === undefined) {
                        // Preserve text ordinals even when framing is not tagged. Otherwise an
                        // old whitespace row can be rebound to a later real text part by the
                        // part-id fallback on the next pass.
                        textOrdinal += 1;
                        continue;
                    }
                    const existingTag = getTagById(db, sessionId, existingTagId);
                    if (existingTag?.type !== "message") {
                        tagger.unbindTag(sessionId, contentId);
                        textOrdinal += 1;
                        continue;
                    }
                    if (existingTag.status === "active") {
                        markWhitespaceAssistantTagInert(db, sessionId, existingTagId, contentId);
                        inertWhitespaceTagNumbers.add(existingTagId);
                    }
                } else {
                    // Resolver pre-warms any tag-id-fallback bindings (e.g. when OpenCode
                    // re-assigns part IDs); the assigned tag below uses those bindings. Inert
                    // whitespace rows are replay-only and must never migrate onto real text.
                    existingTagId = resolver.resolve(messageId, "message", contentId, textOrdinal, {
                        accept: (tagNumber) => !inertWhitespaceTagNumbers.has(tagNumber),
                    });
                    if (
                        existingTagId === undefined &&
                        inertWhitespaceTagNumbers.has(
                            tagger.getTag(sessionId, contentId, "message") ?? -1,
                        )
                    ) {
                        tagger.unbindTag(sessionId, contentId);
                    }
                }
                const _tAssignText = performance.now();
                const tagId =
                    existingTagId ??
                    tagger.assignTag(
                        sessionId,
                        contentId,
                        "message",
                        byteSize(textPart.text),
                        db,
                        textOrdinal === 0 ? getReasoningByteSize(thinkingParts) : 0,
                        null,
                        0,
                        null,
                        // Lazy: only fires on fresh insert. textPart.text is still the
                        // pre-prefix source here (prependTag runs after assign).
                        () => ({
                            tokenCount: estimateTextTagTokenCount(stripTagPrefix(textPart.text)),
                            inputTokenCount: null,
                            reasoningTokenCount:
                                textOrdinal === 0 ? getReasoningTokenCount(thinkingParts) : 0,
                        }),
                    );
                accAssignTag += performance.now() - _tAssignText;
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
                        const _tSaveText = performance.now();
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                        accSaveSource += performance.now() - _tSaveText;
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    textPart.text = prependTag(tagId, textPart.text);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: textPart,
                        field: "text",
                    });
                }
                targets.set(tagId, {
                    message,
                    dropReasoningParts: thinkingParts,
                    mutationParts: [{ message, part: textPart }],
                    textPrefix: skipPrefixInjection ? "" : prependTag(tagId, ""),
                    setContent: (content, options) => {
                        if (textPart.text === content) return false;
                        const partialEnd = messageId ? getPartialEnds().get(messageId) : undefined;
                        if (partialEnd !== undefined && partIndex > partialEnd) return false;
                        textPart.text = content;
                        if (options?.keepReasoning === true) return true;
                        for (const tp of thinkingParts) {
                            if (protectedThinkingParts.has(tp)) continue;
                            if (partialEnd !== undefined && message.parts.indexOf(tp) > partialEnd)
                                continue;
                            neutralizeDroppedReasoningPart(tp);
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

                // v3.3.1 Layer C: derive owner from the FIFO memo set
                // earlier in this same loop iteration. The first tool
                // block (extractToolCallObservation) already paired this
                // part — reuse that owner so we don't double-pop the
                // queue (which would shift result-pairing for later
                // result parts of the same callId).
                const memo = ownerByPartKey.get(part);
                const ownerMsgId = memo?.ownerMsgId ?? messageId ?? toolPart.callID;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolPart.callID);

                const _tAssignTool = performance.now();
                // No growth-bump on the existing-tag path here (unlike Pi's
                // tag-transcript, which bumps byte_size/token_count when a later
                // occurrence is larger). The asymmetry is structural: OpenCode
                // only tags once `state.output` is a string — i.e. after the tool
                // completed — and OpenCode writes tool output exactly once, so a
                // tagged output never grows afterwards. Pi tags the INVOCATION
                // occurrence first (byte_size=0) and must bump when the result
                // lands. Verified empirically: 100,670 tool tags across the two
                // largest live sessions show zero byte_size drift vs the current
                // opencode.db output. Adding a per-part size compare here would
                // cost every hot pass to defend an unreachable case.
                const existingToolTag = tagger.getToolTag(sessionId, toolPart.callID, ownerMsgId);
                let tagId = existingToolTag;
                if (tagId === undefined) {
                    const reasoningBytes = getReasoningByteSize(thinkingParts);
                    const { toolName, inputByteSize, inputTokenCount } =
                        extractToolTagMetadata(toolPart);
                    tagId = tagger.assignToolTag(
                        sessionId,
                        toolPart.callID,
                        ownerMsgId,
                        byteSize(toolPart.state.output),
                        db,
                        reasoningBytes,
                        toolName,
                        inputByteSize,
                        // Lazy: fires only on fresh insert. token_count = output tokens
                        // (mirrors byte_size=output); input/reasoning stored separately.
                        () => ({
                            tokenCount:
                                estimateTextTagTokenCount(stripTagPrefix(toolPart.state.output)) +
                                estimateToolAttachmentImageTokens(toolPart.state),
                            inputTokenCount,
                            reasoningTokenCount: getReasoningTokenCount(thinkingParts),
                        }),
                    );
                }
                invalidateCachedCandidateToolOwnersIfNewOwner(
                    ownerDerivationCache,
                    sessionId,
                    toolPart.callID,
                    ownerMsgId,
                );
                accAssignToolTag += performance.now() - _tAssignTool;
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    toolPart.state.output = prependTag(tagId, toolPart.state.output);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: toolPart,
                        field: "tool_state_output",
                    });
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
                const _tAssignFile = performance.now();
                const tagId =
                    existingTagId ??
                    tagger.assignTag(
                        sessionId,
                        contentId,
                        "file",
                        byteSize(filePart.url),
                        db,
                        0,
                        null,
                        0,
                        null,
                        () => ({
                            tokenCount: estimateTextTagTokenCount(filePart.url),
                            inputTokenCount: null,
                            reasoningTokenCount: null,
                        }),
                    );
                accAssignTag += performance.now() - _tAssignFile;
                if (existingTagId === undefined) {
                    const sourceContent = buildFileSourceContent(message.parts);
                    if (sourceContent) {
                        const _tSaveFile = performance.now();
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                        accSaveSource += performance.now() - _tSaveFile;
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                targets.set(tagId, {
                    message,
                    mutationParts: [{ message, part: filePart }],
                    setContent: (content) => {
                        // File edits do not clear reasoning; their position can
                        // still invalidate a later prefix-bound signature.
                        const prev = messageParts[partIndex];
                        const prevText =
                            typeof prev === "object" && prev !== null && "text" in prev
                                ? (prev as { text: string }).text
                                : "";
                        if (prevText === content) return false;
                        if (messageId) {
                            const partialEnd = getPartialEnds().get(messageId);
                            if (partialEnd !== undefined && partIndex > partialEnd) return false;
                        }
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
    }

    logTransformTiming(sessionId, "tag.loop", tLoop);
    logTransformTiming(sessionId, "tag.deriveOwner", performance.now() - accDerive);
    logTransformTiming(sessionId, "tag.getToolTag", performance.now() - accGetToolTag);
    logTransformTiming(sessionId, "tag.assignTag", performance.now() - accAssignTag);
    logTransformTiming(sessionId, "tag.assignToolTag", performance.now() - accAssignToolTag);
    logTransformTiming(sessionId, "tag.saveSource", performance.now() - accSaveSource);

    const partialEnds =
        toolTagByCallId.size > 0 ? loadPartialEnds().last : new Map<string, number>();
    for (const [compositeKey, tagId] of toolTagByCallId) {
        const occurrences = toolCallIndex.get(compositeKey)?.occurrences ?? [];
        const touchesUncoveredPart = occurrences.some(({ message, part }) => {
            const messageId = message.info.id;
            if (typeof messageId !== "string") return false;
            const partialEnd = partialEnds.get(messageId);
            return partialEnd !== undefined && message.parts.indexOf(part) > partialEnd;
        });
        if (touchesUncoveredPart) continue;
        const thinkingParts = toolThinkingByCallId.get(compositeKey) ?? [];
        targets.set(
            tagId,
            createToolDropTarget(
                compositeKey,
                thinkingParts.filter((part) => !protectedThinkingParts.has(part)),
                toolCallIndex,
                batch,
                tagId,
            ),
        );
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
        normalizationTargets,
    };
}
