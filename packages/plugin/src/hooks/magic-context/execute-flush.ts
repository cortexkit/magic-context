import {
    clearPersistedStickyTurnReminder,
    getPendingOps,
    removePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export function executeFlush(db: Database, sessionId: string): string {
    try {
        const pendingOps = getPendingOps(db, sessionId);

        if (pendingOps.length === 0) {
            return "No pending operations to flush.";
        }

        let dropped = 0;

        db.transaction(() => {
            for (const op of pendingOps) {
                updateTagStatus(db, sessionId, op.tagId, "dropped");
                removePendingOp(db, sessionId, op.tagId);
                dropped++;
            }
        })();

        const parts: string[] = [];
        if (dropped > 0) parts.push(`${dropped} dropped`);

        if (dropped > 0) {
            clearPersistedStickyTurnReminder(db, sessionId);
        }

        return `Flushed: ${parts.join(", ")}. Changes take effect on next message.`;
    } catch (error) {
        sessionLog(sessionId, "ctx-flush failed:", error);
        return `Error: Failed to flush context operations. ${getErrorMessage(error)}`;
    }
}
