import type { Database } from "../../../shared/sqlite";
import { isLeaseActive } from "./lease";

export interface DreamQueueEntry {
    id: number;
    /** Project identity (e.g. "git:<sha>"), NOT a filesystem path */
    projectIdentity: string;
    reason: string;
    enqueuedAt: number;
    startedAt: number | null;
}

export function ensureDreamQueueTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS dream_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            reason TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            started_at INTEGER,
            retry_count INTEGER DEFAULT 0
        )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_dream_queue_project ON dream_queue(project_path)");
    db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_dream_queue_pending ON dream_queue(started_at, enqueued_at)",
    ).run();
}

function hasActiveDreamLease(db: Database): boolean {
    try {
        return isLeaseActive(db);
    } catch (error) {
        if (String(error).includes("no such table: dream_state")) {
            return false;
        }
        throw error;
    }
}

/** Enqueue a project for dreaming. Skips if the same project already has any queue entry (queued or running).
 *
 * @param force - When true (e.g. manual /ctx-dream), uses the lease TTL (2 min) as the stale threshold
 *   instead of the full 2-hour max-runtime window. This lets users re-trigger dreaming after a crash or
 *   restart even when the previous queue entry was started only seconds ago.
 */
export function enqueueDream(
    db: Database,
    projectIdentity: string,
    reason: string,
    force = false,
): DreamQueueEntry | null {
    const now = Date.now();
    return db.transaction(() => {
        // Clean stale started entries before checking — prevents post-crash permanent "already queued".
        // Age alone is not enough: a healthy long-running dream can exceed the manual 2m force
        // threshold while still renewing its lease. Only recover stale rows when no live lease exists.
        if (!hasActiveDreamLease(db)) {
            // Scheduled runs use 2h (max dream runtime) so we don't interrupt a legitimately running dream.
            // Manual /ctx-dream uses the lease TTL (2 min) so a crashed/killed runner doesn't permanently
            // block the user from re-triggering.
            const staleThresholdMs = force
                ? 2 * 60 * 1000 // lease TTL — matches runner's own crash-recovery window
                : 120 * 60 * 1000; // 2 hours — safe for scheduled long-running dreams
            db.prepare(
                "DELETE FROM dream_queue WHERE project_path = ? AND started_at IS NOT NULL AND started_at < ?",
            ).run([projectIdentity, now - staleThresholdMs]);
        }

        const existing = db
            .prepare<[string], { id: number }>("SELECT id FROM dream_queue WHERE project_path = ?")
            .get(projectIdentity);

        if (existing) {
            return null; // already queued (fresh entry)
        }

        const result = db
            .prepare("INSERT INTO dream_queue (project_path, reason, enqueued_at) VALUES (?, ?, ?)")
            .run(projectIdentity, reason, now);

        return {
            id: Number(result.lastInsertRowid),
            projectIdentity,
            reason,
            enqueuedAt: now,
            startedAt: null,
        };
    })();
}

/** Peek at the next unstarted entry without claiming it.
 *
 * @param projectIdentity - When provided, only matches entries for this project.
 *   This is critical for cross-process coexistence: each running OpenCode/Pi
 *   process registers exactly one project, so it must only drain entries that
 *   belong to it. Without this filter, Pi (running in project A) would dequeue
 *   queue entries for project B and try to dream B with Pi's runner — which
 *   either spawns `pi` in a directory that doesn't exist (the `git:<sha>`
 *   identity string) or, even if it succeeded, runs the wrong harness for that
 *   project.
 */
export function peekQueue(db: Database, projectIdentity?: string): DreamQueueEntry | null {
    const row = projectIdentity
        ? db
              .prepare<
                  [string],
                  { id: number; project_path: string; reason: string; enqueued_at: number }
              >(
                  "SELECT id, project_path, reason, enqueued_at FROM dream_queue WHERE started_at IS NULL AND project_path = ? ORDER BY enqueued_at ASC LIMIT 1",
              )
              .get(projectIdentity)
        : db
              .prepare<
                  [],
                  { id: number; project_path: string; reason: string; enqueued_at: number }
              >(
                  "SELECT id, project_path, reason, enqueued_at FROM dream_queue WHERE started_at IS NULL ORDER BY enqueued_at ASC LIMIT 1",
              )
              .get();

    if (!row) return null;

    return {
        id: row.id,
        projectIdentity: row.project_path,
        reason: row.reason,
        enqueuedAt: row.enqueued_at,
        startedAt: null,
    };
}

/** Claim the next unstarted entry atomically by marking started_at. Returns null if queue is empty.
 *
 * @param projectIdentity - When provided, only dequeues entries for this project.
 *   See `peekQueue` for the cross-process coexistence rationale.
 */
export function dequeueNext(db: Database, projectIdentity?: string): DreamQueueEntry | null {
    const now = Date.now();
    return db.transaction(() => {
        const entry = peekQueue(db, projectIdentity);
        if (!entry) return null;

        const result = db
            .prepare("UPDATE dream_queue SET started_at = ? WHERE id = ? AND started_at IS NULL")
            .run(now, entry.id);
        if (result.changes === 0) return null; // already claimed by another caller

        return { ...entry, startedAt: now };
    })();
}

/** Remove a completed or failed entry from the queue. */
export function removeDreamEntry(db: Database, id: number): void {
    db.prepare("DELETE FROM dream_queue WHERE id = ?").run(id);
}

/** Reset a dequeued entry so it can be retried (e.g., after lease failure). Increments retry_count. */
export function resetDreamEntry(db: Database, id: number): void {
    db.prepare(
        "UPDATE dream_queue SET started_at = NULL, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?",
    ).run(id);
}

/** Get the retry count for a queue entry. */
export function getEntryRetryCount(db: Database, id: number): number {
    const row = db
        .prepare<[number], { retry_count: number | null }>(
            "SELECT retry_count FROM dream_queue WHERE id = ?",
        )
        .get(id);
    return row?.retry_count ?? 0;
}

/** Clear stale started entries (stuck for more than maxAgeMs). */
export function clearStaleEntries(db: Database, maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = db
        .prepare("DELETE FROM dream_queue WHERE started_at IS NOT NULL AND started_at < ?")
        .run(cutoff);
    return result.changes;
}
