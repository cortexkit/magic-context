import {
    applyStrippedPlaceholderDelta,
    getAutoSearchHintDecisions,
    getNoteNudgeAnchors,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    getStrippedPlaceholderIds,
    pruneAutoSearchHintDecisions,
    pruneNoteNudgeAnchors,
    setPersistedReasoningWatermark,
} from "../../features/magic-context/storage-meta-persisted";
import {
    deleteTagsByMessageId,
    getMaxTagNumberBySession,
    getTagsBySession,
} from "../../features/magic-context/storage-tags";
import {
    deleteTemporalDecision,
    getTemporalDecisions,
} from "../../features/magic-context/temporal-decisions";
import { clearNoteNudgeTriggerOnly } from "../../hooks/magic-context/note-nudger";
import { forgetUnpublishedAutoSearchNoHint } from "../../shared/auto-search-lifecycle";
import type { Database } from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import type { V2StoreReader } from "../store-reader";

/** Prune replay state only for messages the host database no longer holds after commit. */
export function pruneCommittedRevertMessages(
    db: Database,
    reader: Pick<V2StoreReader, "sessionExists" | "sequenceForId">,
    sessionID: string,
): Set<string> {
    // A session row distinguishes a revert that removed every message from a
    // reader opened on a database that never held this session.
    if (!reader.sessionExists(sessionID)) return new Set();
    const removed = db
        .transaction(() => {
            const anchors = getNoteNudgeAnchors(db, sessionID);
            const trigger = getPersistedNoteNudge(db, sessionID).triggerMessageId;
            const candidates = getStrippedPlaceholderIds(db, sessionID);
            if (trigger) candidates.add(trigger);
            for (const { messageId } of anchors) candidates.add(messageId);
            for (const { messageId } of getAutoSearchHintDecisions(db, sessionID))
                candidates.add(messageId);
            for (const id of getTemporalDecisions(db, sessionID).keys()) candidates.add(id);
            for (const tag of getTagsBySession(db, sessionID)) {
                const owner =
                    tag.type === "tool"
                        ? tag.toolOwnerMessageId
                        : contentTagOwnerMessageId(tag.messageId);
                if (owner) candidates.add(owner);
            }
            // The target named by the host can survive a partial revert, and a
            // provider request may omit rows that are still stored.
            const missing = new Set(
                [...candidates].filter((id) => reader.sequenceForId(sessionID, id) === undefined),
            );
            if (!missing.size) return missing;

            for (const id of missing) {
                deleteTagsByMessageId(db, sessionID, id);
                deleteTemporalDecision(db, sessionID, id);
            }
            applyStrippedPlaceholderDelta(db, sessionID, { remove: missing });
            pruneNoteNudgeAnchors(
                db,
                sessionID,
                new Set(anchors.map(({ messageId }) => messageId).filter((id) => !missing.has(id))),
            );
            if (trigger && missing.has(trigger)) clearNoteNudgeTriggerOnly(db, sessionID);
            pruneAutoSearchHintDecisions(db, sessionID, missing);

            // The watermark only describes reasoning from retained tags. The separate
            // allocation counter stays unchanged so a removed tag number stays spent.
            const watermark = getPersistedReasoningWatermark(db, sessionID);
            const maxRetained = getMaxTagNumberBySession(db, sessionID);
            if (watermark > maxRetained) setPersistedReasoningWatermark(db, sessionID, maxRetained);
            return missing;
        })
        .immediate();
    for (const id of removed) forgetUnpublishedAutoSearchNoHint(sessionID, id);
    return removed;
}
