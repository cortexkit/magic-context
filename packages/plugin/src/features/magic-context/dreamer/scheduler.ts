import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { enqueueDream } from "./queue";
import { getDreamState } from "./storage-dream-state";

export interface DreamScheduleConfig {
    /** Time range string like "02:00-06:00" */
    schedule: string;
}

/** Parse "HH:MM-HH:MM" into start/end minutes since midnight. */
export function parseScheduleWindow(
    schedule: string,
): { startMinutes: number; endMinutes: number } | null {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(schedule.trim());
    if (!match) return null;

    const startHour = Number(match[1]);
    const startMin = Number(match[2]);
    const endHour = Number(match[3]);
    const endMin = Number(match[4]);

    // Reject invalid hour/minute values (e.g. "0:99" or "25:00")
    if (startHour >= 24 || startMin >= 60 || endHour >= 24 || endMin >= 60) {
        return null;
    }

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    return { startMinutes, endMinutes };
}

/**
 * Check if a dream timestamp falls within today's schedule window.
 * Uses a simple heuristic: if the dream ran less than 12 hours ago,
 * it's considered "from the current window" and the project should not be re-enqueued.
 * This prevents the dreamer's own memory updates from triggering re-enqueuing.
 */
function isDreamFromCurrentWindow(lastDreamAtMs: number, now: Date): boolean {
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    return now.getTime() - lastDreamAtMs < twelveHoursMs;
}

/** Check if the current time is inside the schedule window. Handles overnight windows (e.g. 23:00-05:00). */
export function isInScheduleWindow(schedule: string, now: Date = new Date()): boolean {
    const window = parseScheduleWindow(schedule);
    if (!window) return false;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    if (window.startMinutes <= window.endMinutes) {
        // Same-day window: 02:00-06:00
        return currentMinutes >= window.startMinutes && currentMinutes < window.endMinutes;
    }
    // Overnight window: 23:00-05:00
    return currentMinutes >= window.startMinutes || currentMinutes < window.endMinutes;
}

/** Find projects that have memory updates or pending smart notes since their per-project last dream time. */
export function findProjectsNeedingDream(db: Database): string[] {
    // Get all active project paths from memories and smart notes
    const projectRows = db
        .prepare<[], { project_path: string }>(
            `SELECT DISTINCT project_path FROM memories WHERE status = 'active'
             UNION
             SELECT DISTINCT project_path FROM notes
             WHERE type = 'smart' AND status = 'pending' AND project_path IS NOT NULL
             ORDER BY project_path`,
        )
        .all();

    const projects: string[] = [];
    const now = new Date();
    for (const row of projectRows) {
        const lastDreamAtStr = getDreamState(db, `last_dream_at:${row.project_path}`);
        // Fall back to global key for migration from old single-key format
        const fallbackStr = !lastDreamAtStr ? getDreamState(db, "last_dream_at") : null;
        const lastDreamAt = Number(lastDreamAtStr ?? fallbackStr ?? "0") || 0;

        // Skip if a dream already ran in the current schedule window.
        // This prevents re-enqueuing because dreamer's own memory updates
        // (consolidate, verify, improve, archive) set updated_at > last_dream_at.
        if (lastDreamAt > 0 && isDreamFromCurrentWindow(lastDreamAt, now)) {
            continue;
        }

        const updatedMemories = db
            .prepare<[string, number], { cnt: number }>(
                `SELECT COUNT(*) as cnt FROM memories
                 WHERE project_path = ? AND status = 'active' AND updated_at > ?`,
            )
            .get(row.project_path, lastDreamAt);

        const pendingSmartNotes = db
            .prepare<[string], { cnt: number }>(
                `SELECT COUNT(*) as cnt FROM notes
                 WHERE project_path = ? AND type = 'smart' AND status = 'pending'`,
            )
            .get(row.project_path);

        if (
            (updatedMemories && updatedMemories.cnt > 0) ||
            (pendingSmartNotes && pendingSmartNotes.cnt > 0)
        ) {
            projects.push(row.project_path);
        }
    }

    return projects;
}

/**
 * Check schedule and enqueue eligible projects.
 * Called periodically from the hook layer (debounced to once per hour).
 * Returns the number of projects enqueued.
 */
export function checkScheduleAndEnqueue(db: Database, schedule: string): number {
    if (!isInScheduleWindow(schedule)) {
        return 0;
    }

    // Per-project dream gating is handled by findProjectsNeedingDream() which
    // checks per-project last_dream_at keys. No global gate needed — each project
    // is independently scheduled based on its own last dream time.

    const projects = findProjectsNeedingDream(db);
    if (projects.length === 0) {
        return 0;
    }

    let enqueued = 0;
    for (const projectIdentity of projects) {
        const entry = enqueueDream(db, projectIdentity, "scheduled");
        if (entry) {
            log(`[dreamer] enqueued project for scheduled dream: ${projectIdentity}`);
            enqueued++;
        }
    }

    return enqueued;
}
