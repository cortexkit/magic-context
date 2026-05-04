import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker";
import { removeSystemReminders } from "../../shared/system-directive";
import { getRawSessionMessageCountFromDb, withReadOnlySessionDb } from "./read-session-db";
import {
    type ChunkBlock,
    compactRole,
    compactTextForSummary,
    estimateTokens,
    extractTexts,
    extractToolCallSummaries,
    formatBlock,
    hasMeaningfulUserText,
    mergeCommitHashes,
    normalizeText,
    type SessionChunkLine,
} from "./read-session-formatting";
import { type RawMessage, readRawSessionMessagesFromDb } from "./read-session-raw";
import { isFilePart, isTextPart, isToolPartWithOutput } from "./tag-part-guards";

export { extractTexts, hasMeaningfulUserText } from "./read-session-formatting";

let activeRawMessageCache: Map<string, RawMessage[]> | null = null;

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
    /** Optional fast count path; falls back to readMessages().length. */
    getMessageCount?: () => number;
}

const sessionProviders = new Map<string, RawMessageProvider>();

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

/**
 * Run `fn` with a temporary per-session provider override. Cleans up
 * on return regardless of throw — preferred over manual
 * `setRawMessageProvider` / `cleanup()` pairs.
 */
export function withRawMessageProvider<T>(
    sessionId: string,
    provider: RawMessageProvider,
    fn: () => T,
): T {
    const cleanup = setRawMessageProvider(sessionId, provider);
    try {
        return fn();
    } finally {
        cleanup();
    }
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
    hasMore: boolean;
    text: string;
    lines: SessionChunkLine[];
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
}

export function withRawSessionMessageCache<T>(fn: () => T): T {
    const outerCache = activeRawMessageCache;
    if (!outerCache) {
        activeRawMessageCache = new Map();
    }

    try {
        return fn();
    } finally {
        if (!outerCache) {
            activeRawMessageCache = null;
        }
    }
}

export function readRawSessionMessages(sessionId: string): RawMessage[] {
    if (activeRawMessageCache) {
        const cached = activeRawMessageCache.get(sessionId);
        if (cached) {
            return cached;
        }

        const messages = readRawSessionMessagesFromSource(sessionId);
        activeRawMessageCache.set(sessionId, messages);
        return messages;
    }

    return readRawSessionMessagesFromSource(sessionId);
}

function readRawSessionMessagesFromSource(sessionId: string): RawMessage[] {
    const provider = sessionProviders.get(sessionId);
    if (provider) return provider.readMessages();
    return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}

export function getRawSessionMessageCount(sessionId: string): number {
    const provider = sessionProviders.get(sessionId);
    if (provider) {
        if (provider.getMessageCount) return provider.getMessageCount();
        return provider.readMessages().length;
    }
    return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}

export function getRawSessionTagKeysThrough(sessionId: string, upToMessageIndex: number): string[] {
    const messages = readRawSessionMessages(sessionId);
    const keys: string[] = [];

    for (const message of messages) {
        if (message.ordinal > upToMessageIndex) break;

        for (const [partIndex, part] of message.parts.entries()) {
            if (isTextPart(part)) {
                keys.push(`${message.id}:p${partIndex}`);
            }
            if (isFilePart(part)) {
                keys.push(`${message.id}:file${partIndex}`);
            }
            if (isToolPartWithOutput(part)) {
                keys.push(part.callID);
            }
        }
    }

    return keys;
}

const PROTECTED_TAIL_USER_TURNS = 5;

export function getProtectedTailStartOrdinal(sessionId: string): number {
    // This function is called lazily (only during emergency/recovery when historian failureCount > 0).
    // On normal transform passes, hasEligibleCompartmentHistory is not computed so this is never called.
    const messages = readRawSessionMessages(sessionId);
    const userOrdinals = messages
        .filter((m) => m.role === "user" && hasMeaningfulUserText(m.parts))
        .map((m) => m.ordinal);
    if (userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
        return 1;
    }
    return userOrdinals[userOrdinals.length - PROTECTED_TAIL_USER_TURNS];
}

export function readSessionChunk(
    sessionId: string,
    tokenBudget: number,
    offset: number = 1,
    eligibleEndOrdinal?: number,
): SessionChunk {
    const messages = readRawSessionMessages(sessionId);
    const startOrdinal = Math.max(1, offset);
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
    let lastMessageId = "";
    let firstMessageId = "";
    let currentBlock: ChunkBlock | null = null;
    let pendingNoiseMeta: SessionChunkLine[] = [];
    let commitClusters = 0;
    let lastFlushedRole = "";

    function flushCurrentBlock(): boolean {
        if (!currentBlock) return true;
        const blockText = formatBlock(currentBlock);
        const blockTokens = estimateTokens(blockText);
        if (totalTokens + blockTokens > tokenBudget && totalTokens > 0) {
            return false;
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
        lastMessageId = currentBlock.meta[currentBlock.meta.length - 1]?.messageId ?? "";
        messagesProcessed += currentBlock.meta.length;
        lines.push(blockText);
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
        return true;
    }

    for (const msg of messages) {
        if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal) break;
        if (msg.ordinal < startOrdinal) continue;

        const meta = { ordinal: msg.ordinal, messageId: msg.id };

        // Skip user messages that are pure system notifications (background task
        // completions, internal initiator markers, system directives). These carry
        // zero signal for compartment summaries — unless they contain tool results
        // with extractable descriptions.
        if (msg.role === "user" && !hasMeaningfulUserText(msg.parts)) {
            const tcSummaries = extractToolCallSummaries(msg.parts);
            if (tcSummaries.length === 0) {
                pendingNoiseMeta.push(meta);
                continue;
            }
            // Tool-result-only user messages: merge TC summaries into the
            // preceding assistant block (same "A" role since tool results follow
            // assistant tool-use messages in the compacted flow).
            const tcText = tcSummaries.join(" / ");
            if (currentBlock && currentBlock.role === "A") {
                currentBlock.endOrdinal = msg.ordinal;
                currentBlock.parts.push(tcText);
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
                    meta: [...pendingNoiseMeta, meta],
                    commitHashes: [],
                    // Pure TC-only block — no narrative from text parts.
                    isToolOnly: true,
                };
                pendingNoiseMeta = [];
            }
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
            pendingNoiseMeta.push(meta);
            continue;
        }

        // Narrative is present iff this message contributed at least one real text part.
        // Tool summaries alone count as tool-only. User-role messages here always carry
        // meaningful text (the no-text user branch returned above).
        const msgHasNarrative = textParts.length > 0;

        if (currentBlock && currentBlock.role === role) {
            currentBlock.endOrdinal = msg.ordinal;
            currentBlock.parts.push(text);
            currentBlock.meta.push(...pendingNoiseMeta, meta);
            currentBlock.commitHashes = mergeCommitHashes(
                currentBlock.commitHashes,
                compacted.commitHashes,
            );
            // Once any message in the merged block contributes narrative, the block is
            // no longer tool-only.
            if (msgHasNarrative) currentBlock.isToolOnly = false;
            pendingNoiseMeta = [];
            continue;
        }

        if (!flushCurrentBlock()) break;

        currentBlock = {
            role,
            startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
            endOrdinal: msg.ordinal,
            parts: [text],
            meta: [...pendingNoiseMeta, meta],
            commitHashes: [...compacted.commitHashes],
            isToolOnly: !msgHasNarrative,
        };
        pendingNoiseMeta = [];
    }

    flushCurrentBlock();

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

    return {
        startIndex: startOrdinal,
        endIndex: lastOrdinal,
        startMessageId: firstMessageId,
        endMessageId: lastMessageId,
        messageCount: messagesProcessed,
        tokenEstimate: totalTokens,
        hasMore:
            lastOrdinal <
            (eligibleEndOrdinal !== undefined
                ? Math.min(eligibleEndOrdinal - 1, messages.length)
                : messages.length),
        text: lines.join("\n"),
        lines: lineMeta,
        commitClusterCount: commitClusters,
        toolOnlyRanges,
    };
}

export function getRawSessionMessageIdsThrough(sessionId: string, endOrdinal: number): string[] {
    if (endOrdinal < 1) return [];
    return readRawSessionMessages(sessionId)
        .filter((message) => message.ordinal <= endOrdinal)
        .map((message) => message.id);
}
