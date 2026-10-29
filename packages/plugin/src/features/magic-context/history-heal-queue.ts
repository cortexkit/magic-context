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

/** A failed or interrupted recomp keeps its queue entry; only publication acknowledges it. */
export async function drainHistoryHealQueue(
    db: Database,
    sessionId: string,
    publish: (range: HistoryHealRecomp) => Promise<boolean>,
): Promise<boolean> {
    let queue = getHistoryHealQueue(db, sessionId);
    while (queue.length) {
        if (!(await publish(queue[0]))) return false;
        queue = queue.slice(1);
        setHistoryHealQueue(db, sessionId, queue);
    }
    return true;
}
