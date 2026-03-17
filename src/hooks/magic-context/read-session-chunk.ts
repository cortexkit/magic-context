import { getRawSessionMessageCountFromDb, withReadOnlySessionDb } from "./read-session-db";
import {
    type ChunkBlock,
    compactRole,
    compactTextForSummary,
    estimateTokens,
    extractTexts,
    formatBlock,
    hasMeaningfulUserText,
    mergeCommitHashes,
    normalizeText,
    type SessionChunkLine,
} from "./read-session-formatting";
import { type RawMessage, readRawSessionMessagesFromDb } from "./read-session-raw";
import { isFilePart, isTextPart, isToolPartWithOutput } from "./tag-part-guards";

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
}

function readRawSessionMessages(sessionId: string): RawMessage[] {
    return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}

export function getRawSessionMessageCount(sessionId: string): number {
    return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}

export function getRawSessionTagKeysThrough(sessionId: string, upToMessageIndex: number): string[] {
    return withReadOnlySessionDb((db) => {
        const messages = readRawSessionMessagesFromDb(db, sessionId);
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
    });
}

const PROTECTED_TAIL_USER_TURNS = 5;

export function getProtectedTailStartOrdinal(sessionId: string): number {
    return withReadOnlySessionDb((db) => {
        const messages = readRawSessionMessagesFromDb(db, sessionId);
        const userOrdinals = messages
            .filter((m) => m.role === "user" && hasMeaningfulUserText(m.parts))
            .map((m) => m.ordinal);
        if (userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
            return 1;
        }
        return userOrdinals[userOrdinals.length - PROTECTED_TAIL_USER_TURNS]!;
    });
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
        if (totalTokens + blockTokens > tokenBudget) {
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
        currentBlock = null;
        return true;
    }

    for (const msg of messages) {
        if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal) break;
        if (msg.ordinal < startOrdinal) continue;

        const meta = { ordinal: msg.ordinal, messageId: msg.id };
        const role = compactRole(msg.role);
        const compacted = compactTextForSummary(
            extractTexts(msg.parts)
                .map(normalizeText)
                .filter((value) => value.length > 0)
                .join(" / "),
            msg.role,
        );
        const text = compacted.text;

        if (!text) {
            pendingNoiseMeta.push(meta);
            continue;
        }

        if (currentBlock && currentBlock.role === role) {
            currentBlock.endOrdinal = msg.ordinal;
            currentBlock.parts.push(text);
            currentBlock.meta.push(...pendingNoiseMeta, meta);
            currentBlock.commitHashes = mergeCommitHashes(
                currentBlock.commitHashes,
                compacted.commitHashes,
            );
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
        };
        pendingNoiseMeta = [];
    }

    flushCurrentBlock();

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
    };
}

export function getRawSessionMessageIdsThrough(sessionId: string, endOrdinal: number): string[] {
    if (endOrdinal < 1) return [];
    return withReadOnlySessionDb((db) =>
        readRawSessionMessagesFromDb(db, sessionId)
            .filter((message) => message.ordinal <= endOrdinal)
            .map((message) => message.id),
    );
}
