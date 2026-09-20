import type { DreamerConfig } from "../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import {
    CANONICAL_DREAM_TASKS,
    DREAM_TASK_CAPABILITIES,
    type DreamTaskName,
    isCanonicalDreamTask,
} from "../../features/magic-context/dreamer/task-registry";
import {
    type DreamTaskRuntimeConfig,
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
 * Split the configured tasks into what this host can actually run and what needs
 * a tool loop it does not have. Without this split a v2 no-arg run reports every
 * `requiresTools` task as a failure instead of an unsupported-on-this-host line.
 */
export function selectRunnableDreamTasks(args: {
    tasks: readonly DreamTaskRuntimeConfig[];
    toolsSupported: boolean;
    requestedTask?: DreamTaskName;
}): { runnable: DreamTaskRuntimeConfig[]; unsupported: DreamTaskName[] } {
    const requiresTools = (task: DreamTaskName) => DREAM_TASK_CAPABILITIES[task].requiresTools;
    if (args.toolsSupported) return { runnable: [...args.tasks], unsupported: [] };
    if (args.requestedTask !== undefined) {
        if (requiresTools(args.requestedTask)) {
            return { runnable: [], unsupported: [args.requestedTask] };
        }
        return {
            runnable: args.tasks.filter((config) => config.task === args.requestedTask),
            unsupported: [],
        };
    }
    // A no-arg run only considers enabled tasks (schedule != ""), so only those
    // are worth reporting as unsupported.
    const unsupported = args.tasks
        .filter((config) => config.schedule.trim() !== "" && requiresTools(config.task))
        .map((config) => config.task);
    return {
        runnable: args.tasks.filter((config) => !requiresTools(config.task)),
        unsupported,
    };
}

export interface ManualDreamOutcome {
    summary: ManualRunResult;
    /** Selected tasks skipped because this host has no tool loop. */
    unsupportedTasks: DreamTaskName[];
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
}): Promise<ManualDreamOutcome> {
    const tasks = buildDreamTaskRuntimeConfigs(
        args.dreamer,
        "opencode",
        args.language,
        args.mural?.model,
    );
    const executor = createDreamTaskExecutor({
        hiddenCompletionExecutor: args.executor,
        parentSessionId: args.sessionId,
        sessionDirectory: args.directory,
        openOpenCodeDb: () => null,
        language: args.language,
        mural: args.mural,
    });
    const selection = selectRunnableDreamTasks({
        tasks,
        toolsSupported: args.executor.capabilities.tools === true,
        ...(args.task !== undefined ? { requestedTask: args.task } : {}),
    });
    const summary = await runManualDream({
        db: args.db,
        projectIdentity: args.projectIdentity,
        tasks: selection.runnable,
        executor,
        ...(args.task !== undefined ? { task: args.task } : {}),
    });
    return { summary, unsupportedTasks: selection.unsupported };
}
