import {
    cachedHeadCoversPendingCompactionMarker,
    getSessionsWithPendingMarker,
} from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";

/**
 * Restores, after a restart, the in-memory refresh signals that a pending
 * compaction-marker move needs. A summary published just before the process
 * exited may not have reached the history head yet, so its session gets its
 * deferred history refresh and materialization back.
 *
 * When the cached m[0]/m[1] pair already renders that summary, the history was
 * served before the exit and only the marker move is outstanding. The transform
 * finds the persisted pending marker by itself and moves it on the next pass
 * that has rewrite permission. Restoring the history refresh in that case would
 * make the next execute pass rebuild the same history: that pass would count as
 * a rebuild (holding back queued drops and granting a system-date refresh)
 * while serving identical bytes.
 */
export function rearmPendingCompactionMarkerSignals(
    db: Database,
    deferredHistoryRefreshSessions: Set<string>,
    deferredMaterializationSessions: Set<string>,
): { historyRearmed: number; markerOnly: number } {
    let historyRearmed = 0;
    let markerOnly = 0;
    for (const sessionId of getSessionsWithPendingMarker(db)) {
        if (cachedHeadCoversPendingCompactionMarker(db, sessionId)) {
            markerOnly++;
            continue;
        }
        deferredHistoryRefreshSessions.add(sessionId);
        deferredMaterializationSessions.add(sessionId);
        historyRearmed++;
    }
    return { historyRearmed, markerOnly };
}
