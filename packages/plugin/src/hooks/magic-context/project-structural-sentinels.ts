import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { isStructuralNoiseSentinel } from "./strip-structural-noise";
import type { MessageLike } from "./tag-messages";

function readOmissions(value: unknown): Set<string> {
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id))
        throw new Error("Invalid structural-sentinel replay decisions");
    return new Set(value);
}

function hasSignedReasoning(message: MessageLike): boolean {
    return (
        message.info.role === "assistant" &&
        message.parts.some((part) => {
            if (!isRecord(part) || part.type !== "reasoning" || !isRecord(part.metadata))
                return false;
            const anthropic = part.metadata.anthropic;
            return isRecord(anthropic) && typeof anthropic.signature === "string";
        })
    );
}

/**
 * Remove only our structural placeholders after all operations that address
 * message parts by index have finished.
 * OpenCode 1 renders empty text beside signed reasoning as a space that the
 * provider never streamed. Freeze each omission before serving it; existing
 * history keeps its old shape until an independent rebuild pays for the edit.
 */
export function projectStructuralSentinels(args: {
    db: Database;
    sessionId: string;
    messages: MessageLike[];
    rebuilding: boolean;
    readPreviouslyServed?: () => readonly unknown[] | null;
}): number {
    const structuralMessages = args.messages.filter((message) =>
        message.parts.some(isStructuralNoiseSentinel),
    );
    if (structuralMessages.length === 0) return 0;
    let omittedIds = readOmissions(
        readReplayEnvelope(args.db, args.sessionId).structuralSentinelOmissions,
    );
    const candidates = structuralMessages.filter(
        (message) =>
            typeof message.info.id === "string" &&
            !omittedIds.has(message.info.id) &&
            hasSignedReasoning(message),
    );
    let previousIds: Set<unknown> | undefined;
    if (!args.rebuilding && candidates.length) {
        const previous = args.readPreviouslyServed?.();
        if (Array.isArray(previous)) {
            previousIds = new Set(
                previous.flatMap((message) =>
                    isRecord(message) && isRecord(message.info) ? [message.info.id] : [],
                ),
            );
        }
    }
    const selected = candidates.filter(
        (message) => args.rebuilding || (previousIds && !previousIds.has(message.info.id)),
    );
    if (selected.length) {
        if (
            !updateReplayDocument(args.db, args.sessionId, (document) => {
                const ids = readOmissions(document.structuralSentinelOmissions);
                for (const message of selected) ids.add(message.info.id as string);
                document.version = 2;
                document.structuralSentinelOmissions = [...ids];
                return true;
            })
        )
            throw new Error("Cannot persist structural-sentinel omissions");
        omittedIds = readOmissions(
            readReplayEnvelope(args.db, args.sessionId).structuralSentinelOmissions,
        );
    }
    let removed = 0;
    for (const message of structuralMessages) {
        if (!omittedIds.has(message.info.id ?? "")) continue;
        // Replay the same choice even if a later reasoning strip removes the
        // signature. Native empty text is deliberately not one of our sentinels.
        const parts = message.parts.filter((part) => !isStructuralNoiseSentinel(part));
        removed += message.parts.length - parts.length;
        message.parts = parts;
    }
    return removed;
}
