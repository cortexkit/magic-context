import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "../../shared/sqlite";

export interface HistoryHealRecomp {
    start: number;
    end: number;
    sequence: number;
    gapStart: number;
    gapEnd: number;
}

const KEY = "history_heal_recomp_queue";

/** Session-scoped repair work survives restarts without impersonating active recomp staging. */
export function getHistoryHealQueue(db: Database, sessionId: string): HistoryHealRecomp[] {
    const row = db
        .prepare("SELECT value FROM session_render_cache WHERE session_id=? AND cache_key=?")
        .get(sessionId, KEY) as { value: string | Uint8Array } | undefined;
    if (!row) return [];
    const text =
        typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (
        !Array.isArray(value) ||
        value.some(
            (item) =>
                !item ||
                ![item.start, item.end, item.sequence, item.gapStart, item.gapEnd].every(
                    Number.isSafeInteger,
                ) ||
                item.start < 1 ||
                item.end < item.start ||
                item.gapStart < item.start ||
                item.gapEnd > item.end,
        )
    ) {
        throw new Error(`Invalid history heal recomp queue for ${sessionId}`);
    }
    return value as HistoryHealRecomp[];
}

export function setHistoryHealQueue(
    db: Database,
    sessionId: string,
    queue: HistoryHealRecomp[],
): void {
    if (!queue.length) {
        db.prepare("DELETE FROM session_render_cache WHERE session_id=? AND cache_key=?").run(
            sessionId,
            KEY,
        );
        return;
    }
    db.prepare(`INSERT INTO session_render_cache(session_id,cache_key,value) VALUES (?,?,?)
        ON CONFLICT(session_id,cache_key) DO UPDATE SET value=excluded.value`).run(
        sessionId,
        KEY,
        JSON.stringify(queue),
    );
}

interface HealPublication {
    db: Database;
    sessionId: string;
    work: HistoryHealRecomp;
    acknowledged: boolean;
    open: boolean;
}
const publications = new AsyncLocalStorage<HealPublication>();

/** Called inside the compartment publication transaction, so the queue and prose commit together. */
export function acknowledgeHistoryHealPublication(db: Database, sessionId: string): boolean {
    const active = publications.getStore();
    if (!active?.open || active.db !== db || active.sessionId !== sessionId) return false;
    if (!db.inTransaction) throw new Error("history_heal_ack_outside_publication");
    const queue = getHistoryHealQueue(db, sessionId),
        head = queue[0];
    if (
        !head ||
        ["start", "end", "sequence", "gapStart", "gapEnd"].some(
            (key) =>
                head[key as keyof HistoryHealRecomp] !==
                active.work[key as keyof HistoryHealRecomp],
        )
    )
        throw new Error("history_heal_queue_changed: publication no longer owns the queue head");
    setHistoryHealQueue(db, sessionId, queue.slice(1));
    active.acknowledged = true;
    return true;
}

/** Unpublished work remains queued; committed recomp publication already contains its acknowledgement. */
export async function drainHistoryHealQueue(
    db: Database,
    sessionId: string,
    publish: (range: HistoryHealRecomp) => Promise<boolean>,
): Promise<boolean> {
    let queue = getHistoryHealQueue(db, sessionId);
    while (queue.length) {
        const active: HealPublication = {
            db,
            sessionId,
            work: queue[0],
            acknowledged: false,
            open: true,
        };
        const changes = () =>
            (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
        const before = changes();
        try {
            if (!(await publications.run(active, () => publish(active.work)))) return false;
            if (!active.acknowledged) {
                // A no-database-work publisher can finish with a queue-only transaction. A real
                // publication must acknowledge inside its own transaction, never after its commit.
                if (changes() !== before)
                    throw new Error(
                        "history_heal_ack_missing: publication did not atomically acknowledge its work",
                    );
                publications.run(active, () =>
                    db
                        .transaction(() => acknowledgeHistoryHealPublication(db, sessionId))
                        .immediate(),
                );
            }
        } finally {
            // Detached async descendants must not keep publication authority after the drain returns.
            active.open = false;
        }
        queue = getHistoryHealQueue(db, sessionId);
    }
    return true;
}
