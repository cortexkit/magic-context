import {
    applyStrippedPlaceholderDelta,
    getNoteNudgeAnchors,
    getPersistedNoteNudge,
    getPersistedReasoningWatermark,
    getStrippedPlaceholderIds,
    pruneAutoSearchHintDecisions,
    pruneNoteNudgeAnchors,
    setPersistedReasoningWatermark,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getMaxTagNumberBySession,
    getTagsBySession,
} from "../../features/magic-context/storage-tags";
import { clearNoteNudgeTriggerOnly } from "../../hooks/magic-context/note-nudger";
import { forgetUnpublishedAutoSearchNoHint } from "../../shared/auto-search-lifecycle";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import type { V2RevertSuffix, V2StoreReader } from "../store-reader";

const MAX_STAGED_REVERTS = 32;
const MAX_STAGED_SUFFIX_ROWS = 10_000;

type StagedRevert =
    | { cutoff: string; host: string; suffix: V2RevertSuffix }
    | { cutoff: string; unavailable: string };

export class V2RevertMessageCleanup {
    private readonly staged = new BoundedSessionMap<StagedRevert>(MAX_STAGED_REVERTS);

    constructor(private readonly openStoreReader: () => V2StoreReader) {}

    captureStageProof(sessionID: string, cutoff: unknown): void {
        this.discardStageProof(sessionID);
        if (typeof cutoff !== "string" || cutoff.length === 0) return;
        try {
            const reader = this.openStoreReader();
            try {
                const suffix = reader.revertSuffix(sessionID, cutoff, MAX_STAGED_SUFFIX_ROWS);
                this.staged.set(
                    sessionID,
                    suffix
                        ? { cutoff, host: reader.hostIdentity(), suffix }
                        : {
                              cutoff,
                              unavailable:
                                  "stage did not prove a bounded suffix and retained predecessor",
                          },
                );
            } finally {
                reader.close();
            }
        } catch {
            this.staged.set(sessionID, { cutoff, unavailable: "host store read failed at stage" });
        }
    }

    discardStageProof(sessionID: string): void {
        this.staged.delete(sessionID);
    }

    discardAllStageProofs(): void {
        this.staged.clear();
    }

    pruneOnCommit(db: Database, sessionID: string, to: unknown): boolean {
        const staged = this.staged.peek(sessionID);
        this.discardStageProof(sessionID);
        const noteSkippedCleanup = (reason: string): false => {
            sessionLog(sessionID, `committed revert tag cleanup skipped: ${reason}`);
            return false;
        };
        if (!staged) return noteSkippedCleanup("no staged proof");
        if (staged.cutoff !== to)
            return noteSkippedCleanup("commit cutoff differs from staged cutoff");
        if ("unavailable" in staged) return noteSkippedCleanup(staged.unavailable);

        let removed: Set<string> | undefined;
        try {
            const reader = this.openStoreReader();
            try {
                if (reader.hostIdentity() !== staged.host)
                    return noteSkippedCleanup("host database changed");
                removed = reader.removedRevertMessages(sessionID, staged.suffix);
            } finally {
                reader.close();
            }
        } catch {
            return noteSkippedCleanup("host store read failed at commit");
        }
        if (!removed) return noteSkippedCleanup("retained predecessor is not visible at commit");
        if (!removed.size) return noteSkippedCleanup("all staged rows still exist");
        pruneMessages(db, sessionID, removed);
        return true;
    }
}

function pruneMessages(db: Database, sessionID: string, removed: ReadonlySet<string>): void {
    db.transaction(() => {
        // Match exact host owners, never the call ID of an ownerless tool.
        // Scan the session's tags once even when the removed suffix is large.
        const tagNumbers = getTagsBySession(db, sessionID).flatMap((tag) => {
            const owner =
                tag.type === "tool"
                    ? tag.toolOwnerMessageId
                    : contentTagOwnerMessageId(tag.messageId);
            return owner && removed.has(owner) ? [tag.tagNumber] : [];
        });
        if (tagNumbers.length) {
            db.prepare(
                "DELETE FROM tags WHERE session_id = ? AND tag_number IN (SELECT value FROM json_each(?))",
            ).run(sessionID, JSON.stringify(tagNumbers));
        }
        db.prepare(
            "DELETE FROM temporal_decisions WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))",
        ).run(sessionID, JSON.stringify([...removed]));
        const placeholders = [...getStrippedPlaceholderIds(db, sessionID)].filter((id) =>
            removed.has(id),
        );
        if (placeholders.length)
            applyStrippedPlaceholderDelta(db, sessionID, { remove: placeholders });
        const anchors = getNoteNudgeAnchors(db, sessionID);
        if (anchors.some(({ messageId }) => removed.has(messageId)))
            pruneNoteNudgeAnchors(
                db,
                sessionID,
                new Set(anchors.map(({ messageId }) => messageId).filter((id) => !removed.has(id))),
            );
        const trigger = getPersistedNoteNudge(db, sessionID).triggerMessageId;
        if (trigger && removed.has(trigger)) clearNoteNudgeTriggerOnly(db, sessionID);
        pruneAutoSearchHintDecisions(db, sessionID, removed);

        // The watermark describes retained reasoning. The allocation counter is
        // separate and never changes here: a removed tag number stays spent.
        if (tagNumbers.length > 0) {
            const watermark = getPersistedReasoningWatermark(db, sessionID);
            const maxRetained = getMaxTagNumberBySession(db, sessionID);
            if (watermark > maxRetained) setPersistedReasoningWatermark(db, sessionID, maxRetained);
        }
    }).immediate();
    for (const id of removed) forgetUnpublishedAutoSearchNoHint(sessionID, id);
}
