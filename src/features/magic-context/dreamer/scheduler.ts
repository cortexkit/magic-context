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

    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);

    if (startMinutes < 0 || startMinutes >= 1440 || endMinutes < 0 || endMinutes >= 1440) {
        return null;
    }

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

/** Find projects that have session activity since their last dream. Scopes by project_path in session_meta. */
export function findProjectsNeedingDream(db: Database): string[] {
    const lastDreamAtStr = getDreamState(db, "last_dream_at");
    const lastDreamAt = lastDreamAtStr ? Number(lastDreamAtStr) || 0 : 0;

    // Find distinct project paths from memories that have been updated since last dream
    const rows = db
        .query<{ project_path: string }, [number]>(
            `SELECT DISTINCT project_path FROM memories
             WHERE status = 'active' AND updated_at > ?
             ORDER BY project_path`,
        )
        .all(lastDreamAt);

    return rows.map((row) => row.project_path);
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

    // Don't enqueue if a dream already ran during this window today
    const lastDreamAtStr = getDreamState(db, "last_dream_at");
    if (lastDreamAtStr) {
        const lastDreamAt = Number(lastDreamAtStr) || 0;
        const window = parseScheduleWindow(schedule);
        if (window) {
            const now = new Date();
            const todayWindowStart = new Date(now);
            todayWindowStart.setHours(
                Math.floor(window.startMinutes / 60),
                window.startMinutes % 60,
                0,
                0,
            );

            // If window is overnight and we're before midnight, window started yesterday
            if (
                window.startMinutes > window.endMinutes &&
                now.getHours() * 60 + now.getMinutes() < window.endMinutes
            ) {
                todayWindowStart.setDate(todayWindowStart.getDate() - 1);
            }

            if (lastDreamAt >= todayWindowStart.getTime()) {
                return 0; // already dreamed during this window
            }
        }
    }

    const projects = findProjectsNeedingDream(db);
    if (projects.length === 0) {
        return 0;
    }

    let enqueued = 0;
    for (const projectPath of projects) {
        const entry = enqueueDream(db, projectPath, "scheduled");
        if (entry) {
            log(`[dreamer] enqueued project for scheduled dream: ${projectPath}`);
            enqueued++;
        }
    }

    return enqueued;
}
