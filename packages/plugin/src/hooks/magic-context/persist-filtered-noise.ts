import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { hasRawSessionMessageById, type SessionChunk } from "./read-session-chunk";

/** Persist only a positively scanned, contiguous, entirely excluded head; missing rows are not noise. */
export function persistFilteredNoise(
    db: Database,
    sessionId: string,
    chunk: SessionChunk,
    eligibleEnd: number,
): boolean {
    const rows = chunk.filteredNoiseLines ?? [];
    const start = chunk.startIndex;
    if (
        chunk.text ||
        chunk.messageCount !== 0 ||
        eligibleEnd <= start ||
        rows.length !== eligibleEnd - start ||
        rows.some((row, index) => row.ordinal !== start + index || !row.messageId)
    )
        return false;
    // The marker's end becomes the history boundary, so it must still be in the
    // host store. The rows chunk filters exclude are the ones a host is most
    // likely to drop after the chunk was read (an empty or aborted assistant
    // step of an interrupted turn), and a marker ending on a dropped row names a
    // boundary no request can contain. Looked up before the write transaction,
    // as the historian's own publish does, so no host read runs under the lock.
    const endId = rows[rows.length - 1].messageId;
    if (!hasRawSessionMessageById(sessionId, endId)) {
        sessionLog(
            sessionId,
            `historian skipped a filtered-noise marker for ordinals ${start}-${eligibleEnd - 1}: its end row ${endId} is no longer in the host store`,
        );
        return false;
    }
    const saved = db
        .transaction(() => {
            const prior = getCompartments(db, sessionId);
            const last = prior.at(-1);
            if ((last?.endMessage ?? 0) + 1 !== start) return false;
            appendCompartments(db, sessionId, [
                {
                    sequence: (last?.sequence ?? -1) + 1,
                    startMessage: start,
                    endMessage: eligibleEnd - 1,
                    startMessageId: rows[0].messageId,
                    endMessageId: rows[rows.length - 1].messageId,
                    title: "",
                    content: "",
                    p1: "",
                    p2: "",
                    p3: "",
                    p4: "",
                    episodeType: "filtered-noise",
                    importance: 1,
                },
            ]);
            return true;
        })
        .immediate();
    if (saved)
        sessionLog(
            sessionId,
            `historian skipped ordinals ${start}-${eligibleEnd - 1}: all ${rows.length} raw rows excluded by chunk filters (no-content boundary marker)`,
        );
    return saved;
}
