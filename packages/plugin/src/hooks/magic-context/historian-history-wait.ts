import { escalationBands } from "../../shared/escalation-bands";
import type { ProtectedTailBoundarySnapshot } from "./protected-tail-boundary";
import {
    compareRawSessionMessageOrder,
    getRawSessionMessageOrdinalCount,
    readRawSessionMessageIdOrdinalsForRange,
} from "./read-session-chunk";

interface HistoryWait {
    newestMessageId: string;
    recoveryAttempted: boolean;
    floorLiftAttempted: boolean;
}

// A failed publication must not pay for the same model input on every transform.
// Keep this independent of failure counters, which pressure changes can reset.
const historyWaits = new Map<string, HistoryWait>();

function newestMessageId(snapshot: ProtectedTailBoundarySnapshot): string | null {
    try {
        const count = getRawSessionMessageOrdinalCount(snapshot.sessionId);
        const ids = readRawSessionMessageIdOrdinalsForRange(snapshot.sessionId, count, count);
        const newest = ids.keys().next().value;
        if (newest) return newest;
    } catch {
        // A cold ordinal index can defer exact reads. The trigger still supplies
        // the newest id it observed without moving the summarized boundary.
    }
    return snapshot.rawLastMessageIdAtTrigger;
}

function recoveryWindow(snapshot: ProtectedTailBoundarySnapshot, percentage: number): boolean {
    return (
        percentage >=
            escalationBands(snapshot.executeThresholdPercentage).forceMaterializationPercentage ||
        snapshot.emergencyTailScale !== undefined
    );
}

export function clearHistorianHistoryWait(sessionId: string): void {
    historyWaits.delete(sessionId);
}

export function recordHistorianNoProgress(
    snapshot: ProtectedTailBoundarySnapshot,
    emergency = false,
): void {
    const newest = newestMessageId(snapshot);
    if (!newest) return;
    const previous = historyWaits.get(snapshot.sessionId);
    const sameHistory = previous?.newestMessageId === newest;
    historyWaits.set(snapshot.sessionId, {
        newestMessageId: newest,
        recoveryAttempted:
            (sameHistory && previous.recoveryAttempted) ||
            emergency ||
            recoveryWindow(snapshot, snapshot.usagePercentage),
        floorLiftAttempted:
            (sameHistory && previous.floorLiftAttempted) || snapshot.liftLivePromptFloor === true,
    });
}

/** Preview at the trigger; claim exceptions only when the runner is ready to send. */
export function shouldWaitForNewHistorianHistory(
    snapshot: ProtectedTailBoundarySnapshot,
    options: { usagePercentage?: number; emergency?: boolean; claim?: boolean } = {},
): boolean {
    const wait = historyWaits.get(snapshot.sessionId);
    if (!wait) return false;
    const newest = newestMessageId(snapshot);
    if (newest && newest !== wait.newestMessageId) {
        try {
            const order = compareRawSessionMessageOrder(
                snapshot.sessionId,
                newest,
                wait.newestMessageId,
            );
            // Unknown anchors can follow a branch replacement/revert. Do not strand
            // that history behind an id the host can no longer resolve.
            if (order === null || order > 0) return false;
        } catch {
            // Exact ordering can defer while the OpenCode 1 index warms. Keep
            // waiting rather than treating an unreadable position as new history.
        }
    }

    const recovery =
        options.emergency ||
        recoveryWindow(snapshot, options.usagePercentage ?? snapshot.usagePercentage);
    const floorLift = snapshot.liftLivePromptFloor === true;
    if ((recovery && !wait.recoveryAttempted) || (floorLift && !wait.floorLiftAttempted)) {
        if (options.claim) {
            wait.recoveryAttempted ||= recovery;
            wait.floorLiftAttempted ||= floorLift;
        }
        return false;
    }
    return true;
}
