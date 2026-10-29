/**
 * Historian scoring of agent memories (`ctx_memory` saves) in turn two.
 *
 * A save enqueues a classification item keyed by (memory id, saved revision) with a
 * monotonic `enqueue_sequence`. Turn two persists a sequence watermark with its stage
 * record and scores only items at or below it, so an item enqueued while a send is
 * in flight is never attributed to that send, initially or after recovery.
 * Timestamps never select items.
 */
import type { Database } from "../../../shared/sqlite";
import { EXCERPT_AFTER, EXCERPT_BEFORE, MAX_STAGE2_ATTEMPTS } from "./lifecycle-constants";
import type { TurnTwoPromptItem, TurnTwoScore } from "./turn-two-envelope";

/** Reads ordinals `from..to` (inclusive) of a session's raw source. */
export type TurnTwoExcerptReader = (
    sessionId: string,
    from: number,
    to: number,
) => {
    text: string;
    /** Ordinals that were printed; any requested ordinal missing here was unreadable. */
    ordinals: number[];
} | null;

interface ItemRow {
    enqueue_sequence: number;
    memory_id: number;
    source_session_id: string;
    save_ordinal: number;
    excerpt: string | null;
}

/** The highest enqueue sequence of the project's items right now (0 when none). */
export function classificationWatermark(db: Database, projectPath: string): number {
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(enqueue_sequence),0) AS watermark FROM memory_classification_items WHERE project_path=?",
        )
        .get(projectPath) as { watermark: number };
    return row.watermark;
}

/** How far a session has been published: the last ordinal its compartments cover. */
function publishedThrough(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(end_message),0) AS through FROM compartments WHERE session_id=?",
        )
        .get(sessionId) as { through: number } | null;
    return row?.through ?? 0;
}

/**
 * Store the excerpt of every pending item whose save session has been published
 * through S+`EXCERPT_AFTER`, where S is the item's save ordinal (the message
 * ordinal of the `ctx_memory` save), so the item becomes due. The excerpt covers
 * S-`EXCERPT_BEFORE` through S+`EXCERPT_AFTER` across chunk boundaries, clipped
 * only at the session start and at unreadable ordinals (recorded in
 * `clipping_json`). An item whose save ordinal itself cannot be read stays pending.
 * A stored excerpt is kept for every later run, so a run on another chunk can still
 * score the item after a failure.
 */
export function storeDueExcerpts(
    db: Database,
    projectPath: string,
    readExcerpt: TurnTwoExcerptReader | undefined,
): void {
    const rows = db
        .prepare(
            "SELECT enqueue_sequence,memory_id,source_session_id,save_ordinal,excerpt FROM memory_classification_items WHERE project_path=? AND state='pending' AND excerpt IS NULL ORDER BY enqueue_sequence",
        )
        .all(projectPath) as ItemRow[];
    for (const row of rows) {
        const last = row.save_ordinal + EXCERPT_AFTER;
        if (!readExcerpt || publishedThrough(db, row.source_session_id) < last) continue;
        const first = Math.max(1, row.save_ordinal - EXCERPT_BEFORE);
        const read = readExcerpt(row.source_session_id, first, last);
        if (!read || !read.text || !read.ordinals.includes(row.save_ordinal)) continue;
        const clipping: Record<string, unknown> = {};
        if (row.save_ordinal - EXCERPT_BEFORE < 1) clipping.sessionStart = first;
        const unreadable: number[] = [];
        for (let ordinal = first; ordinal <= last; ordinal++)
            if (!read.ordinals.includes(ordinal)) unreadable.push(ordinal);
        if (unreadable.length) clipping.unreadable = unreadable;
        // `excerpt IS NULL`: when another run stored an excerpt first, that one stays.
        db.prepare(
            "UPDATE memory_classification_items SET excerpt=?,clipping_json=? WHERE enqueue_sequence=? AND excerpt IS NULL",
        ).run(
            read.text,
            JSON.stringify({ from: first, to: last, ...clipping }),
            row.enqueue_sequence,
        );
    }
}

/**
 * How many turn-two sends carried each item: an item has no attempt column, so its
 * attempts are the stage records whose request lists it.
 */
const ITEM_SENDS = `(SELECT COUNT(*) FROM memory_stage_attempts s, json_each(s.request_json,'$.items') j
    WHERE s.project_path=i.project_path AND s.stage='turn_two' AND j.value=i.enqueue_sequence)`;

/**
 * Pending items with a stored excerpt at or below the stage's watermark that have
 * been sent fewer than `MAX_STAGE2_ATTEMPTS` times. An item the historian never
 * scores validly stops being sent after that and stays pending on the review list.
 */
export function dueItemSequences(db: Database, projectPath: string, watermark: number): number[] {
    return (
        db
            .prepare(
                `SELECT i.enqueue_sequence FROM memory_classification_items i
                 WHERE i.project_path=? AND i.state='pending' AND i.excerpt IS NOT NULL AND i.enqueue_sequence<=?
                   AND ${ITEM_SENDS} < ?
                 ORDER BY i.enqueue_sequence`,
            )
            .all(projectPath, watermark, MAX_STAGE2_ATTEMPTS) as Array<{ enqueue_sequence: number }>
    ).map((row) => row.enqueue_sequence);
}

/**
 * Memory ids whose classification item is still open: pending and not yet out of
 * attempts. Dreamer classify leaves these to the historian; a scored item's memory
 * is stamped classified when the score is recorded, and an item out of attempts
 * gives its memory back to dreamer classify.
 */
export function memoriesWithOpenClassificationItems(db: Database): Set<number> {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_classification_items'").get())
        return new Set();
    return new Set(
        (
            db
                .prepare(
                    `SELECT DISTINCT i.memory_id FROM memory_classification_items i WHERE i.state='pending' AND ${ITEM_SENDS} < ?`,
                )
                .all(MAX_STAGE2_ATTEMPTS) as Array<{ memory_id: number }>
        ).map((row) => row.memory_id),
    );
}

/** The prompt view of the given items; items scored or gone meanwhile are omitted. */
export function promptItems(db: Database, sequences: readonly number[]): TurnTwoPromptItem[] {
    return sequences.flatMap((sequence) => {
        const row = db
            .prepare(
                "SELECT i.enqueue_sequence AS item,i.memory_id AS memoryId,m.content AS content,i.excerpt AS excerpt FROM memory_classification_items i JOIN memories m ON m.id=i.memory_id WHERE i.enqueue_sequence=? AND i.state='pending' AND i.excerpt IS NOT NULL",
            )
            .get(sequence) as TurnTwoPromptItem | null;
        return row ? [row] : [];
    });
}

/**
 * Record a turn-two reply's scores, only for items whose sequence is in
 * `sentSequences` (the items that send carried). Recording is a
 * compare-and-swap on the item's state: a score for an item another run already
 * scored is discarded. A recorded score puts importance and the proposed class on
 * the item and copies only the importance onto the memory row. That copy writes no
 * mutation-log row: like every automated change it reaches a prompt at the next
 * HARD fold. The class stays a proposal on the item.
 */
export function recordItemScores(
    db: Database,
    sentSequences: readonly number[],
    scores: readonly TurnTwoScore[],
): number {
    let recorded = 0;
    db.transaction(() => {
        for (const score of scores) {
            if (!sentSequences.includes(score.item)) continue;
            const won = db
                .prepare(
                    "UPDATE memory_classification_items SET state='scored',importance=?,proposed_class=?,scored_at=? WHERE enqueue_sequence=? AND state='pending'",
                )
                .run(score.importance, score.proposedClass, Date.now(), score.item);
            if (won.changes !== 1) continue;
            // Historian scoring assesses importance, not safety. Classify can still
            // assess a NULL safety flag without replacing this score.
            db.prepare(
                "UPDATE memories SET importance=CASE WHEN safety_critical=1 THEN MAX(80,?) ELSE ? END,classified_at=? WHERE id=(SELECT memory_id FROM memory_classification_items WHERE enqueue_sequence=?) AND status!='archived'",
            ).run(score.importance, score.importance, Date.now(), score.item);
            recorded += 1;
        }
    }).immediate();
    return recorded;
}
