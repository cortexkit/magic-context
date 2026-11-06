import {
    type ReplayDocument,
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { sessionLog } from "../../shared/logger";
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

function readKeepIds(document: ReplayDocument): Set<string> | undefined {
    const value = document.structuralSentinelUpgrade;
    if (value === undefined) return undefined;
    if (
        !isRecord(value) ||
        !Array.isArray(value.keep) ||
        value.keep.some((id) => typeof id !== "string" || !id)
    )
        throw new Error("Invalid structural-sentinel upgrade");
    return new Set(value.keep);
}

/** Capture the fixed upgrade keep set before tagging or reasoning replay changes replies. */
export function prepareStructuralSentinelChoices(args: {
    db: Database;
    sessionId: string;
    messages: readonly MessageLike[];
}): ReplayDocument {
    const document = readReplayEnvelope(args.db, args.sessionId);
    if (readKeepIds(document)) return document;

    // An existing replay document, tag or saved slot is evidence that Magic
    // Context already served this session. Capture it before this pass writes
    // any of those records; last-good request contents are never a membership
    // proof because a snapshot ending at a user message can omit replies that
    // were already served after it.
    const prior = !!args.db
        .prepare(
            `SELECT 1 WHERE
                    EXISTS (SELECT 1 FROM session_meta WHERE session_id = ? AND trailing_blank_decisions <> '')
                    OR EXISTS (SELECT 1 FROM session_replay_decisions WHERE session_id = ?)
                    OR EXISTS (SELECT 1 FROM tags WHERE session_id = ?)
                    OR EXISTS (SELECT 1 FROM lkg_slots WHERE session_id = ?)`,
        )
        .get(args.sessionId, args.sessionId, args.sessionId, args.sessionId);
    try {
        const persisted = updateReplayDocument(args.db, args.sessionId, (current) => {
            if (readKeepIds(current)) return false;
            // Replay the upgrade keep set, with persisted omissions taking
            // precedence. An already-managed session keeps all signed replies
            // present at upgrade, even a possibly new one. A fresh session keeps
            // none: OpenCode's native step-start was never our empty-text sentinel.
            // This durable marker, even with an empty keep set, makes every later
            // reply omit by default across restarts. The set never grows, so new
            // signed replies do not rewrite the replay document on every pass.
            current.version = 2;
            current.structuralSentinelUpgrade = {
                keep: prior
                    ? args.messages.flatMap((message) =>
                          message.info.id && hasSignedReasoning(message) ? [message.info.id] : [],
                      )
                    : [],
            };
            return true;
        });
        if (!persisted) throw new Error("Cannot persist structural-sentinel upgrade");
    } catch (error) {
        // Keep new sentinels for this pass and do not retry the upgrade later in
        // the same pass. Existing omissions still replay. This pass can continue
        // writing tags; on the next successful upgrade those tags prove prior
        // service, so replies served with sentinels are conservatively kept.
        sessionLog(args.sessionId, `structural-sentinel upgrade deferred: ${String(error)}`);
        return document;
    }
    return readReplayEnvelope(args.db, args.sessionId);
}

/**
 * Remove only our structural placeholders after all operations that address
 * message parts by index have finished.
 * OpenCode 1 renders empty text beside signed reasoning as a space that the
 * provider never streamed. Freeze the upgrade keep set before serving; existing
 * history keeps its old shape until an independent rebuild pays for the edit.
 */
export function projectStructuralSentinels(args: {
    db: Database;
    sessionId: string;
    messages: MessageLike[];
    rebuilding: boolean;
    deferUpgrade?: boolean;
    readPreviouslyServed?: () => readonly unknown[] | null;
}): number {
    const structuralMessages = args.messages.filter((message) =>
        message.parts.some(isStructuralNoiseSentinel),
    );
    if (structuralMessages.length === 0) return 0;
    const document = args.deferUpgrade
        ? readReplayEnvelope(args.db, args.sessionId)
        : prepareStructuralSentinelChoices(args);
    const keepIds = args.deferUpgrade ? undefined : readKeepIds(document);
    let omittedIds = readOmissions(document.structuralSentinelOmissions);
    // OpenCode v1.19.4 expands empty text to " " only beside signed reasoning.
    // Otherwise ai@6.0.168 drops our metadata-free placeholders: its text filter
    // is `part.text !== '' || part.providerOptions != null`. Leave unsigned
    // replies, including cleared reasoning and structural-only shells, untouched.
    const candidates = structuralMessages.filter(
        (message) =>
            typeof message.info.id === "string" &&
            message.info.id !== "" &&
            hasSignedReasoning(message),
    );
    const selected =
        keepIds && args.rebuilding
            ? candidates.filter(
                  (message) =>
                      keepIds.has(message.info.id ?? "") && !omittedIds.has(message.info.id ?? ""),
              )
            : [];
    if (selected.length) {
        if (
            !updateReplayDocument(args.db, args.sessionId, (document) => {
                const ids = readOmissions(document.structuralSentinelOmissions);
                for (const message of selected) {
                    ids.add(message.info.id as string);
                }
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
    for (const message of candidates) {
        if (
            !omittedIds.has(message.info.id ?? "") &&
            (!keepIds || keepIds.has(message.info.id ?? ""))
        )
            continue;
        // Native empty text is deliberately not one of our sentinels.
        const parts = message.parts.filter((part) => !isStructuralNoiseSentinel(part));
        removed += message.parts.length - parts.length;
        message.parts = parts;
    }
    return removed;
}
