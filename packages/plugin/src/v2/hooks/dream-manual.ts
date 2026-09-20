import type { DreamerConfig } from "../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskName,
    isCanonicalDreamTask,
} from "../../features/magic-context/dreamer/task-registry";
import {
    type ManualRunResult,
    runManualDream,
} from "../../features/magic-context/dreamer/task-scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import type { HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-types";

/** Validate the optional `/ctx-dream <task>` argument (mirrors the v1 command). */
export function resolveManualDreamTask(raw: unknown): { task?: DreamTaskName; error?: string } {
    const requested = typeof raw === "string" ? raw.trim() : "";
    if (!requested) return {};
    if (!isCanonicalDreamTask(requested)) {
        return {
            error: `Unknown task "${requested}". Valid tasks: ${CANONICAL_DREAM_TASKS.join(", ")}.`,
        };
    }
    return { task: requested };
}

/**
 * Run the manual dream pass for a project on the v2 lane.
 *
 * The v1 lane drives this from its command handler; v2 has no host command
 * template path, so the TUI's `/ctx-dream` slash command reaches it through the
 * "dream" RPC. Uses the same scheduler entry point and executor wiring as the
 * event-driven `startDreamTrigger`, with the requesting session as the hidden
 * children's parent.
 */
export async function runManualDreamNow(args: {
    db: ContextDatabase;
    dreamer: DreamerConfig;
    projectIdentity: string;
    directory: string;
    language?: string;
    mural?: { enabled: boolean; model?: string };
    executor: HiddenCompletionExecutor;
    sessionId: string;
    task?: DreamTaskName;
}): Promise<ManualRunResult> {
    return runManualDream({
        db: args.db,
        projectIdentity: args.projectIdentity,
        tasks: buildDreamTaskRuntimeConfigs(
            args.dreamer,
            "opencode",
            args.language,
            args.mural?.model,
        ),
        executor: createDreamTaskExecutor({
            hiddenCompletionExecutor: args.executor,
            parentSessionId: args.sessionId,
            sessionDirectory: args.directory,
            openOpenCodeDb: () => null,
            language: args.language,
            mural: args.mural,
        }),
        ...(args.task !== undefined ? { task: args.task } : {}),
    });
}
