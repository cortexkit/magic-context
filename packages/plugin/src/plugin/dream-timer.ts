import type { DreamerConfig, EmbeddingConfig } from "../config/schema/magic-context";
import { checkScheduleAndEnqueue, processDreamQueue } from "../features/magic-context/dreamer";
import {
    embedUnembeddedCommits,
    indexCommitsForProject,
} from "../features/magic-context/git-commits";
import { embedAllUnembeddedMemories } from "../features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { openDatabase } from "../features/magic-context/storage";
import { log } from "../shared/logger";
import type { PluginContext } from "./types";

/** Check interval for dream schedule (15 minutes). */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Per-project work registered with the timer. The timer is a process-wide
 * singleton, but Desktop OpenCode can load the same plugin once per project
 * within one process — every load needs its directory's git commits indexed,
 * its dream schedule checked, and its experimental config respected.
 */
interface ProjectRegistration {
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
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
}

/** Singleton timer state. */
let activeTimer: ReturnType<typeof setInterval> | null = null;
/** All projects that have called startDreamScheduleTimer in this process,
 *  keyed by directory so re-registration of the same directory is idempotent. */
const registeredProjects = new Map<string, ProjectRegistration>();

/**
 * Register the calling project with the process-wide dream + maintenance
 * timer. The timer itself is a singleton (we only need one setInterval per
 * process), but every registered project gets its per-directory work — git
 * commit indexing, dream schedule check, dream queue processing — on each
 * tick. The first registration also kicks off an immediate startup tick so
 * fresh installs and restarts don't wait 15 minutes for first-time indexing.
 *
 * Returns a cleanup that removes this project's registration. The timer
 * itself stops only when the last project unregisters.
 */
export function startDreamScheduleTimer(args: ProjectRegistration): (() => void) | undefined {
    const dreamingEnabled = Boolean(
        args.dreamerConfig?.enabled && args.dreamerConfig.schedule?.trim(),
    );
    const embeddingSweepEnabled = args.memoryEnabled && args.embeddingConfig.provider !== "off";
    const commitIndexingEnabled = args.gitCommitIndexing?.enabled === true;

    if (!dreamingEnabled && !embeddingSweepEnabled && !commitIndexingEnabled) {
        return;
    }

    // Idempotent registration — re-registering the same directory replaces
    // the prior config (e.g., if config was reloaded for that project).
    const isNewRegistration = !registeredProjects.has(args.directory);
    registeredProjects.set(args.directory, args);

    if (isNewRegistration) {
        log(
            `[dreamer] registered project ${args.directory} (dreaming=${dreamingEnabled} embeddings=${embeddingSweepEnabled} commits=${commitIndexingEnabled}; total=${registeredProjects.size})`,
        );
    }

    if (!activeTimer) {
        // First registration in this process — start the timer and run an
        // immediate startup tick so embedding backfill, commit indexing, and
        // dream schedule checks don't wait 15 minutes after a fresh install.
        log(
            `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
        );

        runTick("startup");

        const timer = setInterval(() => runTick("interval"), DREAM_TIMER_INTERVAL_MS);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        activeTimer = timer;
    } else if (isNewRegistration) {
        // Timer is already running, but this is a brand-new project — give
        // it the same "no 15-minute wait" treatment by sweeping just this
        // project immediately. Existing projects keep their tick cadence.
        void sweepProject(args, "startup");
    }

    return () => {
        registeredProjects.delete(args.directory);
        log(
            `[dreamer] unregistered project ${args.directory} (remaining=${registeredProjects.size})`,
        );
        if (registeredProjects.size === 0 && activeTimer) {
            clearInterval(activeTimer);
            activeTimer = null;
            log("[dreamer] stopped dream schedule timer (no projects left)");
        }
    };
}

/**
 * Single tick body. Runs the global memory embedding sweep once, then
 * iterates every registered project for its per-directory work.
 */
function runTick(origin: "startup" | "interval"): void {
    log(`[dreamer] timer tick (${origin}) — projects=${registeredProjects.size}`);
    try {
        // Memory embedding sweep is global (iterates all projects in DB),
        // so we only need to call it once per tick — not per registered
        // project.
        const anyEmbeddingEnabled = Array.from(registeredProjects.values()).some(
            (r) => r.memoryEnabled && r.embeddingConfig.provider !== "off",
        );
        if (anyEmbeddingEnabled) {
            // Use the first registered project's embeddingConfig — they
            // should all match (it's a top-level user config).
            const first = registeredProjects.values().next().value;
            if (first) {
                void embedAllUnembeddedMemories(openDatabase(), first.embeddingConfig)
                    .then((embeddedCount) => {
                        if (embeddedCount > 0) {
                            log(
                                `[magic-context] proactively embedded ${embeddedCount} ${embeddedCount === 1 ? "memory" : "memories"} across all projects`,
                            );
                        }
                    })
                    .catch((error: unknown) => {
                        log("[magic-context] periodic memory embedding sweep failed:", error);
                    });
            }
        }

        // Per-project work — git commit indexing, dream schedule check,
        // dream queue processing. We iterate all registered projects so
        // Desktop's "open all projects at once" workflow indexes every one,
        // not just whichever project happened to register the timer first.
        for (const reg of registeredProjects.values()) {
            void sweepProject(reg, origin);
        }
    } catch (error) {
        log("[magic-context] timer-triggered maintenance check failed:", error);
    }
}

/**
 * Run all per-project maintenance for one registration: git commit indexing
 * (when enabled) plus dream schedule check + queue processing (when enabled).
 *
 * Each registered project gets its own pass per tick — Desktop loads the
 * plugin once per project in the same process, and every project needs its
 * own commits indexed and its own dream schedule honored.
 */
async function sweepProject(
    reg: ProjectRegistration,
    origin: "startup" | "interval",
): Promise<void> {
    const dreamingEnabled = Boolean(
        reg.dreamerConfig?.enabled && reg.dreamerConfig.schedule?.trim(),
    );
    const commitIndexingEnabled = reg.gitCommitIndexing?.enabled === true;

    if (commitIndexingEnabled && reg.gitCommitIndexing) {
        await sweepGitCommits({
            directory: reg.directory,
            gitCommitIndexing: reg.gitCommitIndexing,
            embeddingConfig: reg.embeddingConfig,
        });
    }

    if (!dreamingEnabled || !reg.dreamerConfig?.schedule?.trim()) {
        return;
    }

    try {
        const db = openDatabase();
        log(
            `[dreamer] timer tick (${origin}) ${reg.directory} — checking schedule window "${reg.dreamerConfig.schedule}"`,
        );
        checkScheduleAndEnqueue(db, reg.dreamerConfig.schedule);

        await processDreamQueue({
            db,
            client: reg.client,
            tasks: reg.dreamerConfig.tasks,
            taskTimeoutMinutes: reg.dreamerConfig.task_timeout_minutes,
            maxRuntimeMinutes: reg.dreamerConfig.max_runtime_minutes,
            experimentalUserMemories: reg.experimentalUserMemories,
            experimentalPinKeyFiles: reg.experimentalPinKeyFiles,
        });
    } catch (error) {
        log(`[dreamer] timer-triggered queue processing failed for ${reg.directory}:`, error);
    }
}

/**
 * Index commits for the current project and drain embeddings. Runs in the
 * background under the timer's fire-and-forget contract.
 *
 * Project identity resolution happens inside the indexer so we always read
 * the same `git:<sha>` identity used by memories and ctx_search.
 */
async function sweepGitCommits(args: {
    directory: string;
    gitCommitIndexing: { enabled: boolean; since_days: number; max_commits: number };
    embeddingConfig: EmbeddingConfig;
}): Promise<void> {
    const { directory, gitCommitIndexing, embeddingConfig } = args;
    const startedAt = Date.now();
    log(
        `[git-commits] sweep starting for ${directory} (sinceDays=${gitCommitIndexing.since_days} maxCommits=${gitCommitIndexing.max_commits} embedding=${embeddingConfig.provider})`,
    );
    try {
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        const result = await indexCommitsForProject(db, projectPath, directory, embeddingConfig, {
            sinceDays: gitCommitIndexing.since_days,
            maxCommits: gitCommitIndexing.max_commits,
        });
        // Drain any remaining embedding backlog (indexer caps per run).
        let drainedEmbeddings = 0;
        if (embeddingConfig.provider !== "off" && result.embedded > 0) {
            drainedEmbeddings = await embedUnembeddedCommits(db, projectPath, embeddingConfig);
        }
        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep finished for ${projectPath} in ${elapsedMs}ms: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded} drained=${drainedEmbeddings}`,
        );
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep failed for ${directory} after ${elapsedMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
