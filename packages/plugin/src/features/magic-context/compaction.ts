import type { Database } from "../../shared/sqlite";
import { updateSessionMeta } from "./storage";

interface CompactionHandlerOptions {
    /**
     * Keep tag statuses and queued drops. Set when Magic Context's compartments stay
     * the session's history and every row after them stays on the wire (the rows the
     * compaction hid are restored from the store), so their drops must keep replaying.
     */
    keepTagState?: boolean;
}

interface CompactionHandler {
    onCompacted(sessionId: string, db: Database, options?: CompactionHandlerOptions): void;
}

export function createCompactionHandler(): CompactionHandler {
    return {
        onCompacted(sessionId: string, db: Database, options?: CompactionHandlerOptions): void {
            db.transaction(() => {
                if (!options?.keepTagState) {
                    db.prepare(
                        "UPDATE tags SET status = 'compacted' WHERE session_id = ? AND status IN ('active', 'dropped')",
                    ).run(sessionId);
                    db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
                }
                updateSessionMeta(db, sessionId, { lastNudgeBand: null });
            }).immediate();
        },
    };
}
