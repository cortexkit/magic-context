import {
    getCandidateToolOwners,
    pickNearestPriorOwner,
} from "../../features/magic-context/storage-tags";
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker";
import type { Database } from "../../shared/sqlite";
import { removeSystemReminders } from "../../shared/system-directive";
import { isHostUnservedRow, markHostUnservedRow } from "./host-served-rows";
import {
    getMessageTimesFromOpenCodeDb,
    getRawSessionMessageCountFromDb,
    openCodeDbExists,
    withReadOnlySessionDb,
} from "./read-session-db";
import {
    type ChunkBlock,
    compactRole,
    compactTextForSummary,
    estimateTokens,
    extractTexts,
    extractToolCallSummaries,
    extractToolResultBodyTokens,
    formatBlock,
    hasMeaningfulUserText,
    mergeCommitHashes,
    normalizeText,
    type SessionChunkLine,
} from "./read-session-formatting";
import {
    countRawSessionMessageOrdinalsFromDb,
    countStoredRawSessionMessagesFromDb,
    type RawMessage,
    type RawMessageOrdinalAnchor,
    type RawMessageOrdinalEntry,
    type RawMessageParts,
    readRawSeedTailFromDb,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageIdOrdinalsFromDb,
    readRawSessionMessageOrdinalAnchorRankFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessageOrdinalPageFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagePartsByIdFromDb,
    readRawSessionMessagesFromDb,
    readRawSessionTailFromDb,
} from "./read-session-raw";
import { buildToolArcs } from "./read-session-true-raw-tokens";
import { isFilePart, isTextPart } from "./tag-part-guards";
import { extractToolCallObservation } from "./tool-drop-target";

export { extractTexts, hasMeaningfulUserText } from "./read-session-formatting";

/**
 * Block-tokenization memo.
 *
 * `readSessionChunk` re-tokenizes the TC-chunked eligible tail on every
 * compartment-trigger pass (every `message.updated`). The eligible window is
 * anchored at `lastCompartmentEnd + 1` and built forward, so every block BEHIND
 * the growing tail produces a byte-identical `formatBlock` string pass after
 * pass — re-running the BPE tokenizer on them is pure waste (≈100ms on a large
 * tool-heavy session). This memo is CONTENT-ADDRESSED on the exact block text,
 * so the token count is identical to a fresh `estimateTokens` call (no
 * semantic/threshold change) — only NEW or changed blocks (the tail edge) reach
 * the tokenizer. The cached value cannot substitute the per-tag token store:
 * that store counts FULL content, this counts the TC-chunked form (tool outputs
 * collapsed to one-line summaries), a deliberately different quantity.
 *
 * Bounded LRU so it can't grow without limit across sessions; full-string keys
 * (no hashing) keep it exact with zero collision risk. A budget-capped chunk is
 * a few dozen blocks, so a few active sessions sit far under the cap.
 */
const BLOCK_TOKEN_MEMO_MAX = 2048;
const blockTokenMemo = new Map<string, number>();
function estimateBlockTokens(blockText: string): number {
    const cached = blockTokenMemo.get(blockText);
    if (cached !== undefined) {
        // Refresh recency (Map preserves insertion order → re-insert = most-recent).
        blockTokenMemo.delete(blockText);
        blockTokenMemo.set(blockText, cached);
        return cached;
    }
    const count = estimateTokens(blockText);
    if (blockTokenMemo.size >= BLOCK_TOKEN_MEMO_MAX) {
        const oldest = blockTokenMemo.keys().next().value;
        if (oldest !== undefined) blockTokenMemo.delete(oldest);
    }
    blockTokenMemo.set(blockText, count);
    return count;
}

interface RawMessageCacheEntry {
    messages: RawMessage[];
    coveredFromOrdinal: number;
    /** Inclusive coverage end; null means the whole session snapshot was read. */
    coveredToOrdinal: number | null;
}

let activeRawMessageCache: Map<string, RawMessageCacheEntry> | null = null;
// Parallel to activeRawMessageCache, lifecycle-bound to the same scope. Holds the
// ABSOLUTE session message count when the cached array is a TAIL-ONLY slice (so
// `.length` would undercount). Consumers that need the true total read it via
// getCachedAbsoluteMessageCount; null means "no tail slice active → use the
// array length".
let activeAbsoluteCountCache: Map<string, number> | null = null;

/**
 * Per-session source override for raw message reading.
 *
 * The default implementation of `readRawSessionMessages(sessionId)` reads
 * from OpenCode's session DB via `withReadOnlySessionDb`. Other harnesses
 * (e.g. Pi) provide their session data through a different surface
 * (`pi.sessionManager.getBranch()`), so they register a per-session
 * provider here BEFORE invoking any code path that calls the shared
 * `readRawSessionMessages` / `getRawSessionMessageCount` /
 * `getProtectedTailStartOrdinal` / `readSessionChunk` helpers.
 *
 * The registry is lookup-by-sessionId: a registered provider takes
 * precedence over the OpenCode-DB default. Sessions never registered
 * here continue to read from OpenCode's DB (existing behavior).
 *
 * Lifecycle: providers should be registered for the duration of one
 * historian/trigger evaluation and unregistered afterward to avoid
 * leaking session state across unrelated plugin instances. The
 * `withSessionMessageProvider` helper enforces this by wrapping a
 * scope.
 */
export interface RawMessageProvider {
    readMessages(): RawMessage[];
    readMessagePage?: (afterOrdinal: number, limit: number, finalWatermark: number) => RawMessage[];
    readMessageById?: (messageId: string) => RawMessage | null;
    readMessagePartsById?: (messageId: string) => RawMessageParts | null;
    hasMessageById?: (messageId: string) => boolean;
    readMessageOrdinalById?: (messageId: string) => number | null;
    readMessageIdOrdinals?: () => Map<string, number>;
    readMessageIdOrdinalsForRange?: (fromOrdinal: number, toOrdinal: number) => Map<string, number>;
    readMessageOrdinalPage?: (
        after: RawMessageOrdinalAnchor | null,
        limit: number,
    ) => RawMessageOrdinalEntry[];
    /** Optional fast count path; falls back to readMessages().length. */
    getMessageCount?: () => number;
    /** Stored row count including compaction summaries, used for ordinal drift detection. */
    getStoredMessageCount?: () => number;
    /**
     * Stored rows ordered at or before `anchor` (compaction summaries included), or null
     * when no row with the anchor's id and creation time exists. Lets a persisted ordinal
     * checkpoint be validated without walking the session; a provider without it simply
     * never restores from persisted checkpoints.
     */
    readMessageOrdinalAnchorRank?: (anchor: RawMessageOrdinalAnchor) => number | null;
    /**
     * Id of the row a request carries in place of a stored compartment boundary.
     * Only hosts that store rows they never serve by id implement it; null means
     * keep the stored id.
     */
    readServedBoundaryId?: (messageId: string) => string | null;
}

/**
 * Provider contract for OpenCode 2 context passes. Every operation is SQL-bounded;
 * the all-history conversion read is intentionally absent from this interface.
 */
export interface BoundedRawMessageProvider {
    readMessagePage(afterOrdinal: number, limit: number, finalWatermark: number): RawMessage[];
    readMessageById(messageId: string): RawMessage | null;
    readMessagePartsById(messageId: string): RawMessageParts | null;
    hasMessageById(messageId: string): boolean;
    readMessageOrdinalById(messageId: string): number | null;
    readMessageIdOrdinalsForRange(fromOrdinal: number, toOrdinal: number): Map<string, number>;
    readMessageOrdinalPage(
        after: RawMessageOrdinalAnchor | null,
        limit: number,
    ): RawMessageOrdinalEntry[];
    getMessageCount(): number;
    getStoredMessageCount(): number;
    readServedBoundaryId?: (messageId: string) => string | null;
}

const sessionProviders = new Map<string, RawMessageProvider>();

/**
 * Map a stored compartment boundary id to the message id a request actually
 * carries for it. Identity for every host whose raw rows are all served by id.
 */
export function resolveHostServedBoundaryId(sessionId: string, messageId: string): string {
    if (messageId.length === 0) return messageId;
    return sessionProviders.get(sessionId)?.readServedBoundaryId?.(messageId) ?? messageId;
}

/** Whether this session has an explicit non-OpenCode raw-history source. */
export function hasRawMessageProvider(sessionId: string): boolean {
    return sessionProviders.has(sessionId);
}

/**
 * Register a per-session source for raw message reading. Returns an
 * unregister function. Pass-through harnesses (OpenCode) never call
 * this; only Pi/future harnesses install themselves before triggering
 * historian.
 */
export function setRawMessageProvider(sessionId: string, provider: RawMessageProvider): () => void {
    sessionProviders.set(sessionId, provider);
    return () => {
        const current = sessionProviders.get(sessionId);
        if (current === provider) sessionProviders.delete(sessionId);
    };
}

export function setBoundedRawMessageProvider(
    sessionId: string,
    provider: BoundedRawMessageProvider,
): () => void {
    return setRawMessageProvider(sessionId, {
        ...provider,
        readMessages: () => {
            throw new Error(
                "Bounded raw-message providers cannot read complete history; full reads are reserved for store-generation conversion",
            );
        },
    });
}

/**
 * Run `fn` with a temporary per-session provider override. Cleans up
 * on return regardless of throw — preferred over manual
 * `setRawMessageProvider` / `cleanup()` pairs.
 *
 * ASYNC-SAFE: if `fn` returns a promise, cleanup is deferred until that promise
 * settles, so the provider stays registered for the WHOLE async scope. A bare
 * synchronous `finally` would unregister at `fn`'s FIRST `await` (the function
 * returns a pending promise immediately), leaving later awaited reads —
 * e.g. Pi's awaited publication drop-queue traversal — with no
 * provider, so they fall through to OpenCode's session DB. For a Pi session
 * that DB is the wrong source (empty), and on a Pi-only install it does not
 * exist at all, throwing `unable to open database file`.
 */
export function withRawMessageProvider<T>(
    sessionId: string,
    provider: RawMessageProvider,
    fn: () => T,
): T {
    const cleanup = setRawMessageProvider(sessionId, provider);
    let result: T;
    try {
        result = fn();
    } catch (error) {
        cleanup();
        throw error;
    }
    if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
    ) {
        return (result as unknown as Promise<unknown>).finally(cleanup) as unknown as T;
    }
    cleanup();
    return result;
}

/** Strip system-reminder blocks and OMO markers from user text for chunk compaction. */
export function cleanUserText(text: string): string {
    return removeSystemReminders(text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
}

export interface SessionChunk {
    startIndex: number;
    endIndex: number;
    startMessageId: string;
    endMessageId: string;
    messageCount: number;
    tokenEstimate: number;
    /** The formatted chunk exceeds its budget and contains completed tool arcs; do not clip its text afterward. */
    oversizeAtomicUnit?: boolean;
    hasMore: boolean;
    text: string;
    lines: SessionChunkLine[];
    /** Raw rows positively excluded by the reader when the entire chunk has no content. */
    filteredNoiseLines?: SessionChunkLine[];
    /** Number of distinct commit clusters — assistant blocks with commits separated by meaningful user turns */
    commitClusterCount: number;
    /**
     * Contiguous ranges of raw message ordinals whose visible chunk content was
     * tool-only (TC: lines, no narrative text). Historian frequently skips such
     * ranges entirely — that's safe, so validation absorbs gaps that fall fully
     * within these ranges regardless of size. Gaps outside these ranges still
     * fail validation and trigger a repair retry.
     */
    toolOnlyRanges: Array<{ start: number; end: number }>;
    /** Completed call/result ranges visible in the raw snapshot, including results past this chunk. */
    completedToolArcs: Array<{ start: number; end: number }>;
    /** Character boundaries for omitted tool-result bodies, used only by pathological window fitting. */
    toolResultBoundaries?: Array<{
        ordinal: number;
        sourceOffset: number;
        bodyTokens: number;
    }>;
}

export function withRawSessionMessageCache<T>(fn: () => T): T {
    const outerCache = activeRawMessageCache;
    if (!outerCache) {
        activeRawMessageCache = new Map();
        activeAbsoluteCountCache = new Map();
    }

    try {
        return fn();
    } finally {
        if (!outerCache) {
            activeRawMessageCache = null;
            activeAbsoluteCountCache = null;
        }
    }
}

export function readRawSessionMessages(sessionId: string): RawMessage[] {
    if (activeRawMessageCache) {
        const cached = activeRawMessageCache.get(sessionId);
        if (cached?.coveredFromOrdinal === 1 && cached.coveredToOrdinal === null) {
            return cached.messages;
        }

        const messages = readRawSessionMessagesFromSource(sessionId);
        if (!cached) {
            activeRawMessageCache.set(sessionId, {
                messages,
                coveredFromOrdinal: 1,
                coveredToOrdinal: null,
            });
        }
        return messages;
    }

    return readRawSessionMessagesFromSource(sessionId);
}

export function readRawSessionMessagePage(
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark: number,
): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessagePage) {
        return provider.readMessagePage(afterOrdinal, limit, finalWatermark);
    }
    if (provider) {
        return provider
            .readMessages()
            .filter(
                (message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark,
            )
            .slice(0, limit);
    }
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) =>
        readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark),
    );
}

export function getRawSessionMessageOrdinalCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (provider.getMessageCount) return provider.getMessageCount();
        const messages = provider.readMessages();
        return messages.reduce(
            (maximum, message) => Math.max(maximum, message.ordinal),
            messages.length,
        );
    }
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => countRawSessionMessageOrdinalsFromDb(db, sessionId));
}

const RAW_MESSAGE_RANGE_PAGE_SIZE = 100;

function readRawSessionMessageRangeFromSource(
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider && !provider.readMessagePage) {
        return provider
            .readMessages()
            .filter((message) => message.ordinal >= fromOrdinal && message.ordinal <= toOrdinal);
    }
    if (!provider && !openCodeDbExists()) return [];

    const messages: RawMessage[] = [];
    let afterOrdinal = fromOrdinal - 1;
    while (afterOrdinal < toOrdinal) {
        const limit = Math.min(RAW_MESSAGE_RANGE_PAGE_SIZE, toOrdinal - afterOrdinal);
        const page = provider?.readMessagePage
            ? provider.readMessagePage(afterOrdinal, limit, toOrdinal)
            : withReadOnlySessionDb((db) =>
                  readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, toOrdinal),
              );
        if (page.length === 0) break;
        let nextOrdinal = afterOrdinal;
        for (const message of page) {
            if (message.ordinal < fromOrdinal || message.ordinal > toOrdinal) continue;
            messages.push(message);
            nextOrdinal = Math.max(nextOrdinal, message.ordinal);
        }
        if (nextOrdinal <= afterOrdinal) break;
        afterOrdinal = nextOrdinal;
    }
    return messages;
}

/** Read the requested absolute-ordinal interval from cache and source as needed. */
export function readRawSessionMessageRange(
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
): RawMessage[] {
    const from = Math.max(1, Math.floor(fromOrdinal));
    const to = Math.floor(toOrdinal);
    if (to < from) return [];

    const cached = activeRawMessageCache?.get(sessionId);
    if (!cached) return readRawSessionMessageRangeFromSource(sessionId, from, to);

    const coveredTo = cached.coveredToOrdinal ?? Number.POSITIVE_INFINITY;
    const overlapFrom = Math.max(from, cached.coveredFromOrdinal);
    const overlapTo = Math.min(to, coveredTo);
    if (overlapTo < overlapFrom) {
        return readRawSessionMessageRangeFromSource(sessionId, from, to);
    }

    const messages: RawMessage[] = [];
    if (from < overlapFrom) {
        messages.push(...readRawSessionMessageRangeFromSource(sessionId, from, overlapFrom - 1));
    }
    messages.push(
        ...cached.messages.filter(
            (message) => message.ordinal >= overlapFrom && message.ordinal <= overlapTo,
        ),
    );
    if (overlapTo < to) {
        messages.push(...readRawSessionMessageRangeFromSource(sessionId, overlapTo + 1, to));
    }
    return messages;
}

readRawSessionMessages.readPage = readRawSessionMessagePage;
readRawSessionMessages.getCount = getRawSessionMessageOrdinalCount;

/**
 * Prime the active raw-message cache with a TAIL-ONLY read (only messages
 * at/after the last compartment boundary), so subsequent bounded reads inside
 * that interval reuse it instead of reading the whole session.
 *
 * This is the O(tail) path: the compartment-trigger boundary resolution is
 * offset-forward only (its candidate / suffix / range / head-cap / chunk-scan
 * reads never cross below `baseOrdinal+1`), and the absolute message count it
 * needs is recovered from the tail reader (`baseOrdinal + tail`), NOT from
 * counting pre-boundary rows. On a months-long session the full read grows
 * O(session); this stays flat at the tail size.
 *
 * The cached array carries ABSOLUTE ordinals (`baseOrdinal+1 …`) so every
 * downstream absolute-ordinal computation matches the full read; the true total
 * is stashed in the parallel absolute-count cache for `.length`-style consumers.
 *
 * No-op (returns false) when the active provider cannot page and count, no
 * OpenCode DB exists, the cache is already populated, or no usable boundary
 * anchor exists (e.g. no compartments, or the anchor message was deleted) — in
 * which case the caller falls through to the source read.
 */
export function primeTailRawMessageCache(args: {
    sessionId: string;
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): boolean {
    const { sessionId, lastCompartmentEnd, anchorMessageId } = args;
    if (!activeRawMessageCache) return false;
    if (activeRawMessageCache.has(sessionId)) return false;
    // Need a real boundary + anchor to read the tail; otherwise fall through to
    // the full read (correct for the no-compartment / #132 case).
    if (lastCompartmentEnd < 1 || !anchorMessageId) return false;

    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (!provider.readMessagePage || !provider.getMessageCount) return false;
        const absoluteMessageCount = provider.getMessageCount();
        const messages = readRawSessionMessageRange(
            sessionId,
            lastCompartmentEnd,
            absoluteMessageCount,
        );
        if (
            messages.find((message) => message.ordinal === lastCompartmentEnd)?.id !==
            anchorMessageId
        )
            return false;
        activeRawMessageCache.set(sessionId, {
            messages,
            coveredFromOrdinal: lastCompartmentEnd,
            coveredToOrdinal: lastCompartmentEnd === 1 ? null : absoluteMessageCount,
        });
        activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
        return true;
    }

    if (!openCodeDbExists()) return false;
    const result = withReadOnlySessionDb((db) =>
        readRawSessionTailFromDb(db, sessionId, lastCompartmentEnd, anchorMessageId),
    );
    if (!result) return false; // anchor not found → caller uses full read
    activeRawMessageCache.set(sessionId, {
        messages: result.messages,
        coveredFromOrdinal: lastCompartmentEnd,
        coveredToOrdinal: lastCompartmentEnd === 1 ? null : result.absoluteMessageCount,
    });
    activeAbsoluteCountCache?.set(sessionId, result.absoluteMessageCount);
    return true;
}

/**
 * Absolute session message count for the active scope. Returns the tail-prime's
 * stashed absolute count when a tail slice is cached; otherwise null, signalling
 * callers to use `readRawSessionMessages(sessionId).length` (whole-session
 * array) as before.
 */
export function getCachedAbsoluteMessageCount(sessionId: string): number | null {
    return activeAbsoluteCountCache?.get(sessionId) ?? null;
}

/**
 * Prime the active raw-message cache with an IN-MEMORY tail built from the
 * transform's `args.messages` — no opencode.db read at all. This is the hot-path
 * goal: the transform already receives the post-marker tail (the eligible
 * window) as parsed objects, so the boundary resolver can consume it directly.
 *
 * The caller supplies the already-converted absolute-ordinal `RawMessage[]` (via
 * `buildInMemoryTailRawMessages`) plus its absolute count. Same scope/lifecycle
 * rules as the other prime helpers: only inside a `withRawSessionMessageCache`
 * scope and a no-op if the cache is already populated for the session. The supplied
 * transform tail is authoritative even when the OpenCode 2 adapter has registered a
 * bounded provider; Pi callers do not supply this OpenCode-specific tail shape.
 *
 * Returns true when it primed the cache.
 */
export function primeInMemoryTailRawMessageCache(args: {
    sessionId: string;
    messages: RawMessage[];
    absoluteMessageCount: number;
}): boolean {
    const { sessionId, messages, absoluteMessageCount } = args;
    if (!activeRawMessageCache) return false;
    if (activeRawMessageCache.has(sessionId)) return false;
    const coveredFromOrdinal = messages[0]?.ordinal ?? absoluteMessageCount + 1;
    activeRawMessageCache.set(sessionId, {
        messages,
        coveredFromOrdinal,
        coveredToOrdinal: coveredFromOrdinal === 1 ? null : absoluteMessageCount,
    });
    activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
    return true;
}

export function readRawSessionMessageOrdinalPage(
    sessionId: string,
    after: RawMessageOrdinalAnchor | null,
    limit: number,
): RawMessageOrdinalEntry[] {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageOrdinalPage) return provider.readMessageOrdinalPage(after, limit);
    if (provider) {
        const rows = provider
            .readMessages()
            .map((message) => ({
                id: message.id,
                timeCreated: message.createdAt ?? message.ordinal,
                contributesOrdinal: true,
                hasValidInfo: true,
            }))
            .filter(
                (row) =>
                    !after ||
                    row.timeCreated > after.timeCreated ||
                    (row.timeCreated === after.timeCreated && row.id > after.id),
            )
            .sort(
                (left, right) =>
                    left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
            );
        return rows.slice(0, Math.max(1, Math.floor(limit)));
    }
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) =>
        readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit),
    );
}

/**
 * Position of an ordinal anchor in the stored-row walk: how many stored rows sort at or
 * before it, null when the anchor row is gone, or undefined when this store cannot
 * answer without reading every row (a provider that lacks the lookup).
 */
export function readRawSessionMessageOrdinalAnchorRank(
    sessionId: string,
    anchor: RawMessageOrdinalAnchor,
): number | null | undefined {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageOrdinalAnchorRank)
        return provider.readMessageOrdinalAnchorRank(anchor);
    if (provider) return undefined;
    if (!openCodeDbExists()) return undefined;
    return withReadOnlySessionDb((db) =>
        readRawSessionMessageOrdinalAnchorRankFromDb(db, sessionId, anchor),
    );
}

export function getRawSessionStoredMessageCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider?.getStoredMessageCount) return provider.getStoredMessageCount();
    if (provider) return provider.readMessages().length;
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => countStoredRawSessionMessagesFromDb(db, sessionId));
}

export function readRawSessionMessageIdOrdinalsForRange(
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
): Map<string, number> {
    const from = Math.max(1, Math.floor(fromOrdinal));
    const to = Math.floor(toOrdinal);
    if (to < from) return new Map();
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageIdOrdinalsForRange) {
        return provider.readMessageIdOrdinalsForRange(from, to);
    }
    const all = provider?.readMessageIdOrdinals
        ? provider.readMessageIdOrdinals()
        : provider
          ? new Map(provider.readMessages().map((message) => [message.id, message.ordinal]))
          : !openCodeDbExists()
            ? new Map<string, number>()
            : withReadOnlySessionDb((db) => readRawSessionMessageIdOrdinalsFromDb(db, sessionId));
    return new Map([...all].filter(([, ordinal]) => ordinal >= from && ordinal <= to));
}

export function readRawSessionMessageIdOrdinals(sessionId: string): Map<string, number> {
    const count = getRawSessionMessageOrdinalCount(sessionId);
    return readRawSessionMessageIdOrdinalsForRange(sessionId, 1, count);
}

export function readRawSessionMessagePartsById(
    sessionId: string,
    messageId: string,
    onQuery?: () => void,
): RawMessageParts | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessagePartsById) return provider.readMessagePartsById(messageId);
    if (provider?.readMessageById) return provider.readMessageById(messageId);
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId) ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) =>
        readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId, onQuery),
    );
}

export function hasRawSessionMessageById(sessionId: string, messageId: string): boolean {
    const provider = sessionProviders.get(sessionId);
    if (provider?.hasMessageById) return provider.hasMessageById(messageId);
    return readRawSessionMessageById(sessionId, messageId) !== null;
}

export function readRawSessionMessageOrdinalById(
    sessionId: string,
    messageId: string,
): number | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageOrdinalById) {
        return provider.readMessageOrdinalById(messageId);
    }
    if (provider?.readMessageIdOrdinals) {
        return provider.readMessageIdOrdinals().get(messageId) ?? null;
    }
    if (provider?.readMessageOrdinalPage) {
        let after: RawMessageOrdinalAnchor | null = null;
        let ordinal = 0;
        while (true) {
            const page = provider.readMessageOrdinalPage(after, 500);
            if (page.length === 0) return null;
            for (const entry of page) {
                if (entry.contributesOrdinal) ordinal += 1;
                if (entry.id === messageId) return entry.contributesOrdinal ? ordinal : null;
            }
            const last = page.at(-1);
            if (!last || page.length < 500) return null;
            after = { timeCreated: last.timeCreated, id: last.id };
        }
    }
    if (provider?.readMessageById) {
        return provider.readMessageById(messageId)?.ordinal ?? null;
    }
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId)?.ordinal ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) =>
        readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId),
    );
}

export function readRawSessionMessageById(sessionId: string, messageId: string): RawMessage | null {
    const provider = sessionProviders.get(sessionId);
    if (provider?.readMessageById) {
        return provider.readMessageById(messageId);
    }
    if (provider) {
        return provider.readMessages().find((message) => message.id === messageId) ?? null;
    }
    if (!openCodeDbExists()) return null;
    return withReadOnlySessionDb((db) => readRawSessionMessageByIdFromDb(db, sessionId, messageId));
}

function readRawSessionMessagesFromSource(sessionId: string): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider) return provider.readMessages();
    // No provider: fall back to OpenCode's session DB — but only if it exists.
    // A Pi-only install has no opencode.db, and a Pi transform whose provider
    // was unregistered out-of-band (e.g. session cleared while an async
    // historian is mid-flight) must not crash the post-commit drop-queue with
    // `unable to open database file`. No source → no raw messages.
    if (!openCodeDbExists()) return [];
    return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}

export function getRawSessionMessageCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (provider.getMessageCount) return provider.getMessageCount();
        const messages = provider.readMessages();
        return messages.reduce(
            (maximum, message) => Math.max(maximum, message.ordinal),
            messages.length,
        );
    }
    if (!openCodeDbExists()) return 0;
    return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}

/**
 * Raw-session keys observed through a compartment boundary. Message and file
 * content IDs are session-unique. Tool observations retain both call ID and the
 * FIFO-paired invocation owner so reused call IDs remain distinct.
 */
export interface RawSessionTagKeys {
    messageFileKeys: Set<string>;
    toolObservations: Map<string, Set<string>>;
}

export interface RawSessionTagKeyReadOptions {
    db?: Database;
    pageSize?: number;
    /** First raw ordinal whose tags can become newly compartmentalized. */
    fromMessageIndex?: number;
    yieldToEventLoop?: () => Promise<void>;
}

export const RAW_SESSION_TAG_KEY_PAGE_SIZE = 32;

function yieldRawSessionTagKeyPage(): Promise<void> {
    return new Promise((resolve) => {
        const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
            .setImmediate;
        if (typeof immediate === "function") {
            immediate(resolve);
            return;
        }
        setTimeout(resolve, 0);
    });
}

export async function getRawSessionTagKeysThrough(
    sessionId: string,
    upToMessageIndex: number,
    options: RawSessionTagKeyReadOptions = {},
): Promise<RawSessionTagKeys> {
    const messageFileKeys = new Set<string>();
    const toolObservations = new Map<string, Set<string>>();
    const unpairedInvocations = new Map<string, string[]>();
    const candidateOwnersByCallId = new Map<string, string[]>();
    const messageTimesById = new Map<string, number | null>();
    const finalWatermark = Number.isFinite(upToMessageIndex)
        ? Math.max(0, Math.floor(upToMessageIndex))
        : getRawSessionMessageOrdinalCount(sessionId);
    const pageSize = Number.isFinite(options.pageSize)
        ? Math.max(1, Math.floor(options.pageSize ?? RAW_SESSION_TAG_KEY_PAGE_SIZE))
        : RAW_SESSION_TAG_KEY_PAGE_SIZE;
    const yieldToEventLoop = options.yieldToEventLoop ?? yieldRawSessionTagKeyPage;

    const nearestPersistedOwner = (callId: string, currentMessageId: string): string | null => {
        if (!options.db) return null;
        let candidates = candidateOwnersByCallId.get(callId);
        if (!candidates) {
            candidates = getCandidateToolOwners(options.db, sessionId, callId);
            candidateOwnersByCallId.set(callId, candidates);
        }
        if (candidates.length === 0) return null;

        const ids = [...candidates, currentMessageId];
        const unresolved = ids.filter((id) => !messageTimesById.has(id));
        if (unresolved.length > 0) {
            const resolved = getMessageTimesFromOpenCodeDb(sessionId, unresolved);
            for (const id of unresolved) {
                messageTimesById.set(id, resolved.get(id) ?? null);
            }
        }
        const times = new Map<string, number>();
        for (const id of ids) {
            const time = messageTimesById.get(id);
            if (typeof time === "number") times.set(id, time);
        }
        return pickNearestPriorOwner(candidates, currentMessageId, times);
    };

    const firstOrdinal = Number.isFinite(options.fromMessageIndex)
        ? Math.max(1, Math.floor(options.fromMessageIndex ?? 1))
        : 1;
    let afterOrdinal = firstOrdinal - 1;
    while (afterOrdinal < finalWatermark) {
        const messages = readRawSessionMessages.readPage(
            sessionId,
            afterOrdinal,
            pageSize,
            finalWatermark,
        );
        if (messages.length === 0) break;

        let nextOrdinal = afterOrdinal;
        for (const message of messages) {
            if (message.ordinal <= afterOrdinal || message.ordinal > finalWatermark) continue;
            nextOrdinal = Math.max(nextOrdinal, message.ordinal);
            messageTimesById.set(
                message.id,
                typeof message.createdAt === "number" ? message.createdAt : null,
            );

            for (const [partIndex, part] of message.parts.entries()) {
                if (isTextPart(part)) {
                    messageFileKeys.add(`${message.id}:p${partIndex}`);
                    continue;
                }
                if (isFilePart(part)) {
                    messageFileKeys.add(`${message.id}:file${partIndex}`);
                    continue;
                }

                const observation = extractToolCallObservation(part);
                if (!observation) continue;

                let ownerMessageId: string;
                if (observation.kind === "invocation") {
                    ownerMessageId = message.id;
                    const queue = unpairedInvocations.get(observation.callId) ?? [];
                    queue.push(message.id);
                    unpairedInvocations.set(observation.callId, queue);
                } else {
                    const queue = unpairedInvocations.get(observation.callId);
                    const pairedOwner = queue?.shift();
                    if (queue?.length === 0) unpairedInvocations.delete(observation.callId);
                    ownerMessageId =
                        pairedOwner ??
                        nearestPersistedOwner(observation.callId, message.id) ??
                        message.id;
                }
                const owners = toolObservations.get(observation.callId) ?? new Set<string>();
                owners.add(ownerMessageId);
                toolObservations.set(observation.callId, owners);
            }
        }

        if (nextOrdinal <= afterOrdinal) break;
        afterOrdinal = nextOrdinal;
        if (afterOrdinal < finalWatermark) await yieldToEventLoop();
    }

    return { messageFileKeys, toolObservations };
}

const PROTECTED_TAIL_USER_TURNS = 5;

export function getLegacyProtectedTailStartOrdinal(sessionId: string): number {
    const count = getRawSessionMessageOrdinalCount(sessionId);
    const userOrdinals: number[] = [];
    let toOrdinal = count;
    while (toOrdinal >= 1 && userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
        const fromOrdinal = Math.max(1, toOrdinal - RAW_MESSAGE_RANGE_PAGE_SIZE + 1);
        const messages = readRawSessionMessageRange(sessionId, fromOrdinal, toOrdinal);
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message?.role === "user" && hasMeaningfulUserText(message.parts)) {
                userOrdinals.push(message.ordinal);
                if (userOrdinals.length === PROTECTED_TAIL_USER_TURNS) break;
            }
        }
        toOrdinal = fromOrdinal - 1;
    }
    return userOrdinals.length < PROTECTED_TAIL_USER_TURNS
        ? 1
        : (userOrdinals[PROTECTED_TAIL_USER_TURNS - 1] ?? 1);
}

export function getProtectedTailStartOrdinal(sessionId: string): number {
    return getLegacyProtectedTailStartOrdinal(sessionId);
}

export function readSessionChunk(
    sessionId: string,
    tokenBudget: number,
    offset: number = 1,
    eligibleEndOrdinal?: number,
): SessionChunk {
    // When a tail-only slice is primed, its length is not the absolute count.
    // Otherwise use the provider's SQL count and read only the chunk's eligible range.
    const totalMessageCount =
        getCachedAbsoluteMessageCount(sessionId) ?? getRawSessionMessageOrdinalCount(sessionId);
    const startOrdinal = Math.max(1, offset);
    const finalOrdinal =
        eligibleEndOrdinal === undefined
            ? totalMessageCount
            : Math.min(totalMessageCount, eligibleEndOrdinal - 1);
    // Include one predecessor so a tool invocation immediately before the start can
    // still be paired with a result inside the chunk.
    const messages = readRawSessionMessageRange(
        sessionId,
        Math.max(1, startOrdinal - 1),
        finalOrdinal,
    );
    const completedToolArcs = buildToolArcs(messages).flatMap((arc) =>
        arc.resOrdinal === null ? [] : [{ start: arc.invOrdinal, end: arc.resOrdinal }],
    );
    const completedToolComponents: Array<{ start: number; end: number }> = [];
    for (const arc of completedToolArcs) {
        const component = completedToolComponents[completedToolComponents.length - 1];
        if (component && arc.start <= component.end)
            component.end = Math.max(component.end, arc.end);
        else completedToolComponents.push({ ...arc });
    }
    const lines: string[] = [];
    const lineMeta: SessionChunkLine[] = [];
    /**
     * Tool-only block ranges captured at flush time. After the main loop finishes
     * we merge adjacent ranges into contiguous `toolOnlyRanges` for the validator.
     */
    const flushedToolOnlyBlocks: Array<{ start: number; end: number }> = [];
    let totalTokens = 0;
    let messagesProcessed = 0;
    let lastOrdinal = startOrdinal - 1;
    let highestScannedOrdinal = startOrdinal - 1;
    let lastMessageId = "";
    let firstMessageId = "";
    let currentBlock: ChunkBlock | null = null;
    let pendingNoiseMeta: SessionChunkLine[] = [];
    let commitClusters = 0;
    let lastFlushedRole = "";
    let admittedOversizeComponentEnd: number | null = null;
    let currentBlockApproxTokens = 0;
    let formattedBudgetCrossed = false;
    let sourceCharacters = 0;
    const toolResultBoundaries: NonNullable<SessionChunk["toolResultBoundaries"]> = [];

    function pinComponentWhenFormattedBudgetCrosses(ordinal: number, appendedText: string): void {
        if (admittedOversizeComponentEnd !== null || formattedBudgetCrossed || !currentBlock)
            return;
        currentBlockApproxTokens +=
            estimateTokens(appendedText) + (currentBlock.parts.length > 1 ? 1 : 0);
        // Exact tokenization of a growing merged block is quadratic. Stay additive
        // until the block is close enough for its short ordinal/role prefix to matter.
        if (totalTokens + currentBlockApproxTokens + 64 <= tokenBudget) return;
        const previewTokens = totalTokens + estimateTokens(formatBlock(currentBlock));
        if (previewTokens <= tokenBudget) return;
        formattedBudgetCrossed = true;
        const component = completedToolComponents.find(
            (candidate) => candidate.start <= ordinal && candidate.end >= ordinal,
        );
        if (component) admittedOversizeComponentEnd = component.end;
    }

    function recordFilteredNoise(meta: SessionChunkLine): void {
        pendingNoiseMeta.push(meta);
        if (!currentBlock) {
            highestScannedOrdinal = Math.max(highestScannedOrdinal, meta.ordinal);
        }
    }

    function flushCurrentBlock(): boolean {
        if (!currentBlock) return true;
        const blockText = formatBlock(currentBlock);
        const blockTokens = estimateBlockTokens(blockText);
        if (totalTokens + blockTokens > tokenBudget && totalTokens > 0) {
            // A user message can interrupt a parallel tool batch. If the emitted
            // prefix contains an invocation, include its matching result before
            // stopping between formatted blocks, even when that exceeds the budget.
            const splitsCompletedArc = completedToolArcs.some(
                (arc) => arc.start <= lastOrdinal && arc.end > lastOrdinal,
            );
            if (!splitsCompletedArc) return false;
        }

        // Count commit clusters: an A block with commits after a non-A block (or first block) is a new cluster
        if (
            currentBlock.role === "A" &&
            currentBlock.commitHashes.length > 0 &&
            lastFlushedRole !== "A"
        ) {
            commitClusters++;
        }
        lastFlushedRole = currentBlock.role;

        if (!firstMessageId) firstMessageId = currentBlock.meta[0]?.messageId ?? "";
        lastOrdinal =
            currentBlock.meta[currentBlock.meta.length - 1]?.ordinal ?? currentBlock.endOrdinal;
        highestScannedOrdinal = Math.max(highestScannedOrdinal, lastOrdinal);
        lastMessageId = currentBlock.meta[currentBlock.meta.length - 1]?.messageId ?? "";
        messagesProcessed += currentBlock.meta.length;
        const lineStart = sourceCharacters + (lines.length > 0 ? 1 : 0);
        const renderedParts = currentBlock.parts.join(" / ");
        let partOffset = lineStart + (blockText.length - renderedParts.length);
        for (let index = 0; index < currentBlock.parts.length; index++) {
            const part = currentBlock.parts[index] ?? "";
            const partMeta = currentBlock.partMeta[index];
            if (partMeta && partMeta.toolResultBodyTokens > 0) {
                toolResultBoundaries.push({
                    ordinal: partMeta.ordinal,
                    sourceOffset: partOffset,
                    bodyTokens: partMeta.toolResultBodyTokens,
                });
            }
            partOffset += part.length + (index + 1 < currentBlock.parts.length ? 3 : 0);
        }
        lines.push(blockText);
        sourceCharacters = lineStart + blockText.length;
        lineMeta.push(...currentBlock.meta);
        totalTokens += blockTokens;

        // Record the flushed block's range if it was pure tool-only content.
        // Validator uses these ranges to absorb gaps of any size where historian
        // legitimately skipped tool-only noise.
        if (currentBlock.isToolOnly) {
            flushedToolOnlyBlocks.push({
                start: currentBlock.startOrdinal,
                end: currentBlock.endOrdinal,
            });
        }

        currentBlock = null;
        currentBlockApproxTokens = 0;
        return true;
    }

    for (const msg of messages) {
        if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal) break;
        if (admittedOversizeComponentEnd !== null && msg.ordinal > admittedOversizeComponentEnd) {
            break;
        }
        if (msg.ordinal < startOrdinal) continue;

        const meta = { ordinal: msg.ordinal, messageId: msg.id };
        if (isHostUnservedRow(msg)) markHostUnservedRow(meta);

        // Skip user messages that are pure system notifications (background task
        // completions, internal initiator markers, system directives). These carry
        // zero signal for compartment summaries — unless they contain tool results
        // with extractable descriptions.
        if (msg.role === "user" && !hasMeaningfulUserText(msg.parts)) {
            const tcSummaries = extractToolCallSummaries(msg.parts);
            if (tcSummaries.length === 0) {
                recordFilteredNoise(meta);
                continue;
            }
            // Tool-result-only user messages: merge TC summaries into the
            // preceding assistant block (same "A" role since tool results follow
            // assistant tool-use messages in the compacted flow).
            const tcText = tcSummaries.join(" / ");
            if (currentBlock && currentBlock.role === "A") {
                currentBlock.endOrdinal = msg.ordinal;
                currentBlock.parts.push(tcText);
                currentBlock.partMeta.push({
                    ordinal: msg.ordinal,
                    toolResultBodyTokens: extractToolResultBodyTokens(msg.parts),
                });
                currentBlock.meta.push(...pendingNoiseMeta, meta);
                // Do NOT flip isToolOnly here — TC-only content merging into an
                // existing A block keeps that block's narrative/tool-only status.
                pendingNoiseMeta = [];
            } else {
                if (!flushCurrentBlock()) break;
                currentBlock = {
                    role: "A",
                    startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
                    endOrdinal: msg.ordinal,
                    parts: [tcText],
                    partMeta: [
                        {
                            ordinal: msg.ordinal,
                            toolResultBodyTokens: extractToolResultBodyTokens(msg.parts),
                        },
                    ],
                    meta: [...pendingNoiseMeta, meta],
                    commitHashes: [],
                    // Pure TC-only block — no narrative from text parts.
                    isToolOnly: true,
                };
                pendingNoiseMeta = [];
            }
            pinComponentWhenFormattedBudgetCrosses(msg.ordinal, tcText);
            continue;
        }

        const role = compactRole(msg.role);
        const textParts = extractTexts(msg.parts)
            .map((t) => (msg.role === "user" ? cleanUserText(t) : t))
            .map(normalizeText)
            .filter((value) => value.length > 0);

        // For messages with no text content, extract tool-call descriptions as
        // lightweight summaries so historian sees what actions were taken.
        const toolSummaries = textParts.length === 0 ? extractToolCallSummaries(msg.parts) : [];
        const allParts = [...textParts, ...toolSummaries];

        const compacted = compactTextForSummary(allParts.join(" / "), msg.role);
        const text = compacted.text;

        if (!text) {
            recordFilteredNoise(meta);
            continue;
        }

        // Narrative is present iff this message contributed at least one real text part.
        // Tool summaries alone count as tool-only. User-role messages here always carry
        // meaningful text (the no-text user branch returned above).
        const msgHasNarrative = textParts.length > 0;

        if (currentBlock && currentBlock.role === role) {
            currentBlock.endOrdinal = msg.ordinal;
            currentBlock.parts.push(text);
            currentBlock.partMeta.push({
                ordinal: msg.ordinal,
                toolResultBodyTokens: extractToolResultBodyTokens(msg.parts),
            });
            currentBlock.meta.push(...pendingNoiseMeta, meta);
            currentBlock.commitHashes = mergeCommitHashes(
                currentBlock.commitHashes,
                compacted.commitHashes,
            );
            // Once any message in the merged block contributes narrative, the block is
            // no longer tool-only.
            if (msgHasNarrative) currentBlock.isToolOnly = false;
            pendingNoiseMeta = [];
            pinComponentWhenFormattedBudgetCrosses(msg.ordinal, text);
            continue;
        }

        if (!flushCurrentBlock()) break;

        currentBlock = {
            role,
            startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
            endOrdinal: msg.ordinal,
            parts: [text],
            partMeta: [
                {
                    ordinal: msg.ordinal,
                    toolResultBodyTokens: extractToolResultBodyTokens(msg.parts),
                },
            ],
            meta: [...pendingNoiseMeta, meta],
            commitHashes: [...compacted.commitHashes],
            isToolOnly: !msgHasNarrative,
        };
        pendingNoiseMeta = [];
        pinComponentWhenFormattedBudgetCrosses(msg.ordinal, text);
    }

    if (flushCurrentBlock() && pendingNoiseMeta.length > 0) {
        highestScannedOrdinal = Math.max(
            highestScannedOrdinal,
            pendingNoiseMeta[pendingNoiseMeta.length - 1]?.ordinal ?? highestScannedOrdinal,
        );
    }

    // Merge adjacent tool-only block ranges into contiguous ranges. Adjacent
    // means `next.start === prev.end + 1` — a pure tool chain spread across
    // multiple successive flushed blocks becomes one merged range so validation
    // can absorb the full gap in a single heal check.
    const toolOnlyRanges: Array<{ start: number; end: number }> = [];
    for (const range of flushedToolOnlyBlocks) {
        const last = toolOnlyRanges[toolOnlyRanges.length - 1];
        if (last && range.start === last.end + 1) {
            last.end = range.end;
        } else {
            toolOnlyRanges.push({ start: range.start, end: range.end });
        }
    }

    const text = lines.join("\n");
    const oversizeAtomicUnit =
        estimateBlockTokens(text) > tokenBudget &&
        completedToolArcs.some((arc) => arc.start <= lastOrdinal && arc.end >= startOrdinal);

    return {
        startIndex: startOrdinal,
        endIndex: lastOrdinal,
        startMessageId: firstMessageId,
        endMessageId: lastMessageId,
        messageCount: messagesProcessed,
        tokenEstimate: totalTokens,
        ...(oversizeAtomicUnit ? { oversizeAtomicUnit: true } : {}),
        hasMore:
            Math.max(lastOrdinal, highestScannedOrdinal) <
            (eligibleEndOrdinal !== undefined
                ? Math.min(eligibleEndOrdinal - 1, totalMessageCount)
                : totalMessageCount),
        text,
        lines: lineMeta,
        ...(messagesProcessed === 0 && text.length === 0
            ? { filteredNoiseLines: pendingNoiseMeta }
            : {}),
        commitClusterCount: commitClusters,
        toolOnlyRanges,
        completedToolArcs,
        toolResultBoundaries,
    };
}

export function getRawSessionMessageIdsThrough(sessionId: string, endOrdinal: number): string[] {
    if (endOrdinal < 1) return [];
    return [...readRawSessionMessageIdOrdinalsForRange(sessionId, 1, endOrdinal).entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([id]) => id);
}

export function readRawSessionSeedTail(
    sessionId: string,
    boundaryId: string | null,
    onQuery?: () => void,
): Map<string, RawMessage> {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        const boundaryOrdinal =
            boundaryId === null ? 1 : readRawSessionMessageOrdinalById(sessionId, boundaryId);
        if (boundaryOrdinal === null)
            throw new Error("state_sync materialized boundary is missing from raw provider");
        const messages = readRawSessionMessageRange(
            sessionId,
            boundaryOrdinal,
            getRawSessionMessageOrdinalCount(sessionId),
        );
        return new Map(messages.map((message) => [message.id, message]));
    }
    if (!openCodeDbExists()) {
        if (boundaryId !== null)
            throw new Error("state_sync raw storage is unavailable for materialized boundary");
        return new Map();
    }
    return withReadOnlySessionDb((db) => {
        onQuery?.();
        return readRawSeedTailFromDb(db, sessionId, boundaryId);
    });
}
