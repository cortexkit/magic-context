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
import { V2RetrospectiveRawProvider } from "../retrospective-raw-provider";

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
 * Split configured tasks into the set this host can run and tasks that need a
 * tool loop. This keeps unsupported tasks out of failure accounting.
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
    // A no-argument run reports only enabled unsupported tasks, while still
    // excluding every tool-requiring task from execution.
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

/** Run a manual dream pass through the shared scheduler and v2 hidden executor. */
export async function runManualDreamNow(args: {
    db: ContextDatabase;
    dreamer: DreamerConfig;
    projectIdentity: string;
    directory: string;
    language?: string;
    mural?: { enabled: boolean };
    executor: HiddenCompletionExecutor;
    sessionId: string;
    task?: DreamTaskName;
}): Promise<ManualDreamOutcome> {
    const tasks = buildDreamTaskRuntimeConfigs(args.dreamer, "opencode", args.language);
    const executor = createDreamTaskExecutor({
        hiddenCompletionExecutor: args.executor,
        parentSessionId: args.sessionId,
        sessionDirectory: args.directory,
        openOpenCodeDb: () => null,
        retrospectiveRawProvider: (db) => new V2RetrospectiveRawProvider(db),
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
