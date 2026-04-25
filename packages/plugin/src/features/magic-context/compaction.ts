import type { Database } from "../../shared/sqlite";
import { updateSessionMeta } from "./storage";

interface CompactionHandler {
    onCompacted(sessionId: string, db: Database): void;
}

export function createCompactionHandler(): CompactionHandler {
    return {
        onCompacted(sessionId: string, db: Database): void {
            db.transaction(() => {
                db.prepare(
                    "UPDATE tags SET status = 'compacted' WHERE session_id = ? AND status IN ('active', 'dropped')",
                ).run(sessionId);
                db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
                updateSessionMeta(db, sessionId, { lastNudgeBand: null });
            })();
        },
    };
}
