import type { DreamerConfig } from "../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import { runDueTasksForProject } from "../../features/magic-context/dreamer/task-scheduler";
import { advanceSessionActivity } from "../../features/magic-context/session-activity";
import { openCurrentDatabase as openDatabase } from "../../features/magic-context/storage";
import type { HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-types";
import { getDataDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { V2RetrospectiveRawProvider } from "../retrospective-raw-provider";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { selectRunnableDreamTasks } from "./dream-manual";
import type { V2Context } from "./types";

/**
 * Whether a session belongs to this plugin instance's own location.
 *
 * OpenCode 2 builds one plugin instance per location (a directory, plus a
 * workspace when one is set) and runs each session's hooks in the instance of
 * that session's location, but `event.subscribe` delivers every location's
 * events to every instance. A dream run started here for another location's
 * session would hang its child under that session, the child would take that
 * location, and its turns would reach the other instance, which never
 * registered the run: the child would run unshaped, in the other directory,
 * under the user's own permissions. A session that cannot be read is treated
 * as foreign.
 */
export async function sessionInThisLocation(
    context: Pick<V2Context, "location" | "session">,
    sessionID: string,
): Promise<boolean> {
    let location: { directory?: string; workspaceID?: string } | undefined;
    try {
        location = (await context.session.get({ sessionID })).location;
    } catch {
        return false;
    }
    return (
        location?.directory === context.location.directory &&
        (location.workspaceID ?? "") === (context.location.workspaceID ?? "")
    );
}

/** The event carrier only wakes the shared scheduler; it never implements another
 * queue or task loop. Generate completions have no execution-ended event, so a hidden
 * completion cannot recursively schedule itself through this subscription. */
export function startDreamTrigger(
    context: Pick<V2Context, "location" | "event" | "session">,
    args: {
        config: DreamerConfig;
        sample?: () => { config: DreamerConfig; mural?: { enabled: boolean; model?: string } };
        executor: HiddenCompletionExecutor;
        projectIdentity: () => string;
        /** The project's `memory.enabled`; `false` keeps the identity unscheduled. */
        projectMemoryEnabled?: boolean;
        language?: string;
        mural?: { enabled: boolean; model?: string };
        /** Native source boundary; injectable for scheduler-only tests. */
        openReader?: () => Pick<V2StoreReader, "rootSessionActivity" | "close">;
    },
) {
    const controller = new AbortController();
    const done = (async () => {
        try {
            for await (const value of context.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                const event = value as { type?: string; data?: { sessionID?: string } };
                if (event.type !== "session.execution.succeeded" || !event.data?.sessionID)
                    continue;
                if (!(await sessionInThisLocation(context, event.data.sessionID))) continue;
                const db = openDatabase();
                if (!db) continue;
                try {
                    // Keep the shared retrospective gate current on OC2, which
                    // does not emit the OC1 message events that maintain these
                    // keys. Source timestamps, not completion time, align the
                    // gate with the raw provider's content watermark.
                    const reader =
                        args.openReader?.() ??
                        new V2StoreReader(
                            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                        );
                    try {
                        const activity = reader
                            .rootSessionActivity([event.data.sessionID])
                            .get(event.data.sessionID);
                        if (activity !== undefined)
                            advanceSessionActivity(db, event.data.sessionID, activity);
                    } finally {
                        reader.close();
                    }
                    // Scheduled and manual runs share one capability filter so a
                    // host without a tool loop never records unsupported tasks as failed.
                    const sampled = args.sample?.();
                    // `dreamer.disable` is read live, so turning the dreamer off
                    // stops new runs without a restart.
                    if ((sampled?.config ?? args.config).disable === true) continue;
                    const { runnable } = selectRunnableDreamTasks({
                        tasks: buildDreamTaskRuntimeConfigs(
                            sampled?.config ?? args.config,
                            "opencode",
                            args.language,
                            (sampled?.mural ?? args.mural)?.model,
                        ),
                        toolsSupported: args.executor.capabilities.tools === true,
                    });
                    await runDueTasksForProject({
                        db,
                        projectIdentity: args.projectIdentity(),
                        projectMemoryEnabled: args.projectMemoryEnabled,
                        tasks: runnable,
                        executor: createDreamTaskExecutor({
                            hiddenCompletionExecutor: args.executor,
                            parentSessionId: event.data.sessionID,
                            sessionDirectory: context.location.directory,
                            openOpenCodeDb: () => null,
                            retrospectiveRawProvider: (db) => new V2RetrospectiveRawProvider(db),
                            language: args.language,
                            mural: sampled?.mural ?? args.mural,
                        }),
                    });
                } catch (error) {
                    log("[magic-context] v2 dream scheduling failed", error);
                }
            }
        } catch (error) {
            if (!controller.signal.aborted)
                log("[magic-context] v2 dream event subscription failed", error);
        }
    })();
    return {
        async dispose() {
            controller.abort();
            await done;
        },
    };
}
