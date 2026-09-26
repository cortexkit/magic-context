import {
    deleteIndexedMessage,
    deleteTagsByMessageId,
    getMaxTagNumberBySession,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    removeAutoSearchHintDecisionByMessageId,
    removeNoteNudgeAnchorByMessageId,
    removeStrippedPlaceholderId,
    setPersistedReasoningWatermark,
} from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { clearNoteNudgeTriggerOnly } from "./note-nudger";

export interface MessageRemovedCleanupResult {
    clearedNoteNudge: boolean;
}

/**
 * Remove Magic Context's per-message state for a message the host deleted: its
 * tags, stripped-placeholder entry, note-nudge and auto-search anchors, the
 * reasoning watermark above the remaining tags, and its search-index rows.
 */
export function cleanupRemovedMessageState(
    db: Database,
    sessionId: string,
    messageId: string,
): MessageRemovedCleanupResult {
    return db
        .transaction(() => {
            const removedTagNumbers = deleteTagsByMessageId(db, sessionId, messageId);
            sessionLog(
                sessionId,
                `event message.removed: deleted ${removedTagNumbers.length} tag(s) for message ${messageId}`,
            );

            const strippedPlaceholderRemoved = removeStrippedPlaceholderId(
                db,
                sessionId,
                messageId,
            );
            sessionLog(
                sessionId,
                strippedPlaceholderRemoved
                    ? `event message.removed: removed ${messageId} from stripped placeholder ids`
                    : `event message.removed: stripped placeholder ids unchanged for ${messageId}`,
            );

            const removedNoteNudgeAnchor = removeNoteNudgeAnchorByMessageId(
                db,
                sessionId,
                messageId,
            );
            const removedAutoSearchDecision = removeAutoSearchHintDecisionByMessageId(
                db,
                sessionId,
                messageId,
            );
            const persistedNoteNudge = getPersistedNoteNudge(db, sessionId);
            const clearedNoteNudgeTrigger = persistedNoteNudge.triggerMessageId === messageId;
            if (clearedNoteNudgeTrigger) {
                clearNoteNudgeTriggerOnly(db, sessionId);
            }
            const clearedNoteNudge = removedNoteNudgeAnchor || clearedNoteNudgeTrigger;
            sessionLog(
                sessionId,
                clearedNoteNudge
                    ? `event message.removed: pruned note nudge state for ${messageId}`
                    : `event message.removed: note nudge state unchanged for ${messageId}`,
            );
            sessionLog(
                sessionId,
                removedAutoSearchDecision
                    ? `event message.removed: pruned auto-search decision for ${messageId}`
                    : `event message.removed: auto-search decision unchanged for ${messageId}`,
            );

            const currentWatermark = getPersistedReasoningWatermark(db, sessionId);
            const maxRemainingTag = getMaxTagNumberBySession(db, sessionId);
            if (currentWatermark > maxRemainingTag) {
                setPersistedReasoningWatermark(db, sessionId, maxRemainingTag);
                sessionLog(
                    sessionId,
                    `event message.removed: reset reasoning watermark ${currentWatermark}→${maxRemainingTag}`,
                );
            } else {
                sessionLog(
                    sessionId,
                    `event message.removed: reasoning watermark unchanged at ${currentWatermark} (max tag ${maxRemainingTag})`,
                );
            }

            const removedIndexedMessages = deleteIndexedMessage(db, sessionId, messageId);
            sessionLog(
                sessionId,
                `event message.removed: deleted ${removedIndexedMessages} indexed message row(s) for ${messageId}`,
            );

            return { clearedNoteNudge };
        })
        .immediate();
}
