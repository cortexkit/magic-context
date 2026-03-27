import type { DreamerConfig } from "../config/schema/magic-context";
import { checkScheduleAndEnqueue, processDreamQueue } from "../features/magic-context/dreamer";
import { openDatabase } from "../features/magic-context/storage";
import { log } from "../shared/logger";
import type { PluginContext } from "./types";

/** Check interval for dream schedule (15 minutes). */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Start an independent timer that checks the dreamer schedule and processes
 * the dream queue. This runs regardless of user activity so overnight
 * dreaming triggers even when the user isn't chatting.
 *
 * The timer is unref'd so it doesn't prevent the process from exiting.
 */
export function startDreamScheduleTimer(args: {
    client: PluginContext["client"];
    dreamerConfig: DreamerConfig;
}): void {
    const { client, dreamerConfig } = args;

    if (!dreamerConfig.enabled || !dreamerConfig.schedule?.trim()) {
        return;
    }

    const timer = setInterval(() => {
        try {
            const db = openDatabase();
            checkScheduleAndEnqueue(db, dreamerConfig.schedule);

            void processDreamQueue({
                db,
                client,
                tasks: dreamerConfig.tasks,
                taskTimeoutMinutes: dreamerConfig.task_timeout_minutes,
                maxRuntimeMinutes: dreamerConfig.max_runtime_minutes,
            }).catch((error: unknown) => {
                log("[dreamer] timer-triggered queue processing failed:", error);
            });
        } catch (error) {
            log("[dreamer] timer-triggered schedule check failed:", error);
        }
    }, DREAM_TIMER_INTERVAL_MS);

    // Unref so the timer doesn't prevent the process from exiting.
    if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
    }

    log(
        `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
    );
}
