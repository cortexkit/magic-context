import type { Database } from "bun:sqlite";
import { log } from "../../../shared/logger";
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

/** Find projects that have memory updates since their per-project last dream time. */
export function findProjectsNeedingDream(db: Database): string[] {
    // Get all active project paths
    const projectRows = db
        .query<{ project_path: string }, []>(
            `SELECT DISTINCT project_path FROM memories WHERE status = 'active' ORDER BY project_path`,
        )
        .all();

    const projects: string[] = [];
    for (const row of projectRows) {
        const lastDreamAtStr = getDreamState(db, `last_dream_at:${row.project_path}`);
        // Fall back to global key for migration from old single-key format
        const fallbackStr = !lastDreamAtStr ? getDreamState(db, "last_dream_at") : null;
        const lastDreamAt = Number(lastDreamAtStr ?? fallbackStr ?? "0") || 0;

        const updated = db
            .query<{ cnt: number }, [string, number]>(
                `SELECT COUNT(*) as cnt FROM memories
                 WHERE project_path = ? AND status = 'active' AND updated_at > ?`,
            )
            .get(row.project_path, lastDreamAt);

        if (updated && updated.cnt > 0) {
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
