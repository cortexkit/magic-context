import type { DreamerConfig, EmbeddingConfig } from "../config/schema/magic-context";
import { checkScheduleAndEnqueue, processDreamQueue } from "../features/magic-context/dreamer";
import { embedUnembeddedMemories } from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
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
    directory: string;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    embeddingConfig: EmbeddingConfig;
    memoryEnabled: boolean;
    experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
    experimentalPinKeyFiles?: {
        enabled: boolean;
        token_budget: number;
        min_reads: number;
    };
}): (() => void) | undefined {
    const {
        client,
        directory,
        dreamerConfig,
        embeddingConfig,
        memoryEnabled,
        experimentalUserMemories,
        experimentalPinKeyFiles,
    } = args;
    const dreamingEnabled = Boolean(dreamerConfig?.enabled && dreamerConfig.schedule?.trim());
    const embeddingSweepEnabled = memoryEnabled && embeddingConfig.provider !== "off";

    if (!dreamingEnabled && !embeddingSweepEnabled) {
        return;
    }

    const projectPath = embeddingSweepEnabled ? resolveProjectIdentity(directory) : null;

    const timer = setInterval(() => {
        try {
            if (embeddingSweepEnabled && projectPath) {
                void embedUnembeddedMemories(openDatabase(), projectPath, embeddingConfig)
                    .then((embeddedCount) => {
                        if (embeddedCount > 0) {
                            log(
                                `[magic-context] proactively embedded ${embeddedCount} ${embeddedCount === 1 ? "memory" : "memories"} for project ${projectPath}`,
                            );
                        }
                    })
                    .catch((error: unknown) => {
                        log("[magic-context] periodic memory embedding sweep failed:", error);
                    });
            }

            if (!dreamingEnabled || !dreamerConfig?.schedule?.trim()) {
                return;
            }

            const db = openDatabase();
            checkScheduleAndEnqueue(db, dreamerConfig.schedule);

            void processDreamQueue({
                db,
                client,
                tasks: dreamerConfig.tasks,
                taskTimeoutMinutes: dreamerConfig.task_timeout_minutes,
                maxRuntimeMinutes: dreamerConfig.max_runtime_minutes,
                experimentalUserMemories,
                experimentalPinKeyFiles,
            }).catch((error: unknown) => {
                log("[dreamer] timer-triggered queue processing failed:", error);
            });
        } catch (error) {
            log("[magic-context] timer-triggered maintenance check failed:", error);
        }
    }, DREAM_TIMER_INTERVAL_MS);

    // Unref so the timer doesn't prevent the process from exiting.
    if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
    }

    log(
        `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
    );

    return () => {
        clearInterval(timer);
        log("[dreamer] stopped dream schedule timer");
    };
}
