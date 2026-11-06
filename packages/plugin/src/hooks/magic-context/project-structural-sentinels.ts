import {
    type ReplayDocument,
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

type SentinelChoice = "keep" | "omit";

function readChoices(document: ReplayDocument): Map<string, SentinelChoice> | undefined {
    const value = document.structuralSentinelChoices;
    if (value === undefined) return undefined;
    if (
        !isRecord(value) ||
        Object.entries(value).some(
            ([id, choice]) => !id || (choice !== "keep" && choice !== "omit"),
        )
    )
        throw new Error("Invalid structural-sentinel replay choices");
    return new Map(Object.entries(value) as Array<[string, SentinelChoice]>);
}

/** Capture first-seen signed replies before tagging or reasoning replay changes them. */
export function prepareStructuralSentinelChoices(args: {
    db: Database;
    sessionId: string;
    messages: readonly MessageLike[];
}): void {
    const document = readReplayEnvelope(args.db, args.sessionId);
    const choices = readChoices(document);
    const signedIds = args.messages.flatMap((message) =>
        message.info.id && hasSignedReasoning(message) ? [message.info.id] : [],
    );
    if (choices && signedIds.every((id) => choices.has(id))) return;

    // An existing replay document, tag or saved slot is evidence that Magic
    // Context already served this session. Capture it before this pass writes
    // any of those records; last-good request contents are never a membership
    // proof because a snapshot ending at a user message can omit replies that
    // were already served after it.
    const prior = choices
        ? false
        : !!args.db
              .prepare(
                  `SELECT 1 WHERE
                    EXISTS (SELECT 1 FROM session_meta WHERE session_id = ? AND trailing_blank_decisions <> '')
                    OR EXISTS (SELECT 1 FROM session_replay_decisions WHERE session_id = ?)
                    OR EXISTS (SELECT 1 FROM tags WHERE session_id = ?)
                    OR EXISTS (SELECT 1 FROM lkg_slots WHERE session_id = ?)`,
              )
              .get(args.sessionId, args.sessionId, args.sessionId, args.sessionId);
    if (
        !updateReplayDocument(args.db, args.sessionId, (current) => {
            const recorded = readChoices(current);
            const next = recorded ?? new Map<string, SentinelChoice>();
            for (const id of readOmissions(current.structuralSentinelOmissions))
                next.set(id, "omit");
            // Replay recorded choices. On upgrade, existing served sessions
            // adopt "keep" for every signed reply present, even a possibly new
            // one. A session with no prior Magic Context state adopts "omit":
            // OpenCode's native step-start was never our empty-text sentinel.
            // The durable map (including an empty map) marks that upgrade point;
            // later unseen replies adopt "omit", also after a process restart.
            for (const id of signedIds) {
                if (!next.has(id)) next.set(id, !recorded && prior ? "keep" : "omit");
            }
            current.version = 2;
            current.structuralSentinelChoices = Object.fromEntries(next);
            current.structuralSentinelOmissions = [...next]
                .filter(([, choice]) => choice === "omit")
                .map(([id]) => id);
            return true;
        })
    )
        throw new Error("Cannot persist structural-sentinel choices");
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
    prepareStructuralSentinelChoices(args);
    let omittedIds = readOmissions(
        readReplayEnvelope(args.db, args.sessionId).structuralSentinelOmissions,
    );
    const candidates = structuralMessages.filter(
        (message) =>
            typeof message.info.id === "string" &&
            !omittedIds.has(message.info.id) &&
            hasSignedReasoning(message),
    );
    const selected = args.rebuilding ? candidates : [];
    if (selected.length) {
        if (
            !updateReplayDocument(args.db, args.sessionId, (document) => {
                const ids = readOmissions(document.structuralSentinelOmissions);
                const choices = readChoices(document);
                if (!choices) throw new Error("Missing structural-sentinel replay choices");
                for (const message of selected) {
                    ids.add(message.info.id as string);
                    choices.set(message.info.id as string, "omit");
                }
                document.version = 2;
                document.structuralSentinelChoices = Object.fromEntries(choices);
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
