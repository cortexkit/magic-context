import type { MagicContextPluginConfig } from "../../config";
import { dreamerRunConfig } from "../../config/live-run-config";
import type { DreamerConfig } from "../../config/schema/magic-context";
import type { HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-types";
import { startDreamScheduleTimer } from "../../plugin/dream-timer";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import { log } from "../../shared/logger";
import { V2RetrospectiveRawProvider } from "../retrospective-raw-provider";
import type { V2StoreReader } from "../store-reader";
import { selectRunnableDreamTasks } from "./dream-manual";

/**
 * Find the session a timer-started dream run's child sessions hang under.
 *
 * A run started by the schedule timer has no triggering session. OpenCode 2
 * shows a hidden child created without a parent as a separate top-level
 * session, so the run borrows the most recently updated user session in this
 * location. Returns undefined when the location has none (or its store cannot
 * be read); the executor then skips the tasks that need a child session.
 */
export function findV2DreamParentSession(
    openReader: () => Pick<V2StoreReader, "latestRootSessionInDirectory" | "close">,
    directory: string,
): string | undefined {
    let reader: Pick<V2StoreReader, "latestRootSessionInDirectory" | "close"> | undefined;
    try {
        reader = openReader();
        const parent = reader.latestRootSessionInDirectory(directory);
        if (!parent) {
            log(
                `[dreamer] no OpenCode 2 session in ${directory} to parent a timer-started dream run; tasks that need a child session are skipped until one exists`,
            );
        }
        return parent;
    } catch (error) {
        log(`[dreamer] OpenCode 2 parent session lookup failed for ${directory}:`, error);
        return undefined;
    } finally {
        reader?.close();
    }
}

/**
 * Register one OpenCode 2 plugin context's project with the process-wide dream
 * schedule timer, so due dream tasks run on their cron schedule and not only
 * after a session turn ends.
 *
 * OpenCode 1 registers from its `server` lane, which OpenCode 2 never calls.
 * The timer is shared by every context in the process and keyed by directory;
 * `dispose` removes only this context's registration, and the timer stops once
 * no project is left. OpenCode 2 runs a context's cleanup when its location
 * shuts down or is rebuilt, so disposal is tied to the context, not to an
 * event.
 */
export function registerV2DreamScheduleTimer(args: {
    directory: string;
    projectIdentity: string;
    config: MagicContextPluginConfig;
    dreamer: DreamerConfig | undefined;
    ensureRegistered?: typeof ensureProjectRegisteredFromOpenCodeDirectory;
    /** The live configuration, re-read before each timer pass. */
    liveConfig: () => MagicContextPluginConfig;
    executor: HiddenCompletionExecutor;
    openReader: () => Pick<V2StoreReader, "latestRootSessionInDirectory" | "close">;
}): { dispose(): Promise<void> } {
    const { config, directory, dreamer, executor } = args;
    const gitCommitIndexing = config.memory.git_commit_indexing;
    let disposed = false;
    const registration = startDreamScheduleTimer({
        directory,
        projectIdentity: args.projectIdentity,
        harness: "opencode",
        hiddenCompletionExecutor: executor,
        findParentSessionId: () => findV2DreamParentSession(args.openReader, directory),
        // OpenCode 2 sessions are not in OpenCode 1's store.
        openOpenCodeDb: () => null,
        retrospectiveRawProvider: (db) => new V2RetrospectiveRawProvider(db),
        dreamerConfig: dreamer,
        sampleDreamRun: () => {
            const current = dreamerRunConfig(config, args.liveConfig());
            return {
                dreamerConfig: current.dreamer ?? dreamer,
                mural: current.mural,
                gitCommitIndexing: current.memory.git_commit_indexing,
            };
        },
        // Scheduled and manual runs share one capability filter, so a host
        // without a tool loop never records tasks it cannot run as failed.
        validateTaskModels: (tasks) =>
            selectRunnableDreamTasks({ tasks, toolsSupported: executor.capabilities.tools })
                .runnable,
        language: config.language,
        mural: config.mural,
        memoryEnabled: config.memory.enabled === true,
        memoryInjectionBudgetTokens: config.memory.injection_budget_tokens,
        retinaHandoff: config.smart_notes.retina_handoff,
        smartNotesEnabled: config.smart_notes.enabled,
        embeddingConfig: config.embedding,
        gitCommitIndexing: gitCommitIndexing?.enabled ? gitCommitIndexing : undefined,
        ensureRegistered: args.ensureRegistered ?? ensureProjectRegisteredFromOpenCodeDirectory,
    }).catch((error: unknown) => {
        log(`[magic-context] v2 dream timer registration failed (continuing without it): ${error}`);
        return undefined;
    });
    return {
        async dispose() {
            if (disposed) return;
            disposed = true;
            // Wait for the registration itself, so a context disposed while it is
            // still being registered does not leave its project on the timer.
            const stop = await registration;
            stop?.();
        },
    };
}
