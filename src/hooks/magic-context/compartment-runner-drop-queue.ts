import type { Database } from "bun:sqlite";
import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { log } from "../../shared/logger";
import { getRawSessionTagKeysThrough } from "./read-session-chunk";

export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
): void {
    const tags = getTagsBySession(db, sessionId);
    const rawTagKeys = new Set(getRawSessionTagKeysThrough(sessionId, upToMessageIndex));
    let dropsQueued = 0;

    for (const tag of tags) {
        if (tag.status !== "active") continue;
        if (rawTagKeys.has(tag.messageId)) {
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
        }
    }

    log(
        `[magic-context] compartment agent: queued ${dropsQueued} drops for messages 0-${upToMessageIndex}`,
    );
}
