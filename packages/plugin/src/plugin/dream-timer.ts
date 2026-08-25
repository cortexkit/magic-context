import { statSync } from "node:fs";

import type { DreamerConfig } from "../config/schema/magic-context";
import type { ClassifyModuleClient } from "../features/magic-context/dreamer/classify";
import { acquireLease, releaseLease } from "../features/magic-context/dreamer/lease";
import { openOpenCodeDb } from "../features/magic-context/dreamer/open-opencode-db";
import {
    HISTORIAN_CHILD_TITLE_MATCHES,
    historianOrphanStaleMs,
    PRIVACY_SENSITIVE_CHILD_TASKS,
    PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
    retrospectiveOrphanStaleMs,
    sweepOrphanedRetrospectiveChildren,
} from "../features/magic-context/dreamer/retrospective-orphan-sweep";
import {
    OpenCodeRetrospectiveRawProvider,
    type RetrospectiveRawProvider,
} from "../features/magic-context/dreamer/retrospective-raw-provider";
import { deleteTaskScheduleRowsForProject } from "../features/magic-context/dreamer/storage-task-schedule";
import {
    buildDreamTaskRuntimeConfigs,
    userMemoryCollectionEnabled,
} from "../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../features/magic-context/dreamer/task-executor";
import type {
    DreamTaskName,
    DreamTaskProgress,
} from "../features/magic-context/dreamer/task-registry";
import { leaseKeyFor } from "../features/magic-context/dreamer/task-registry";
import { runDueTasksForProject } from "../features/magic-context/dreamer/task-scheduler";
import {
    acquireGitSweepLease,
    embedUnembeddedCommits,
    GIT_SWEEP_LEASE_RENEWAL_MS,
    indexCommitsForProject,
    markGitSweepSuccessAndRelease,
    parkGitSweepNonIndexable,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "../features/magic-context/git-commits";
import {
    embedUnembeddedMemoriesForProject,
    getProjectEmbeddingSnapshot,
} from "../features/magic-context/memory/embedding";
import { sweepOrphanedOpenCodeMessageIndexes } from "../features/magic-context/message-index";
import {
    drainCommitBacklogForProject,
    sweepStaleEmbeddingIdentitiesForProject,
} from "../features/magic-context/project-embedding-registry";
import { runDueCompiledSmartNoteChecks } from "../features/magic-context/smart-notes/runner";
import {
    openDatabase,
    retryPendingSessionCleanups,
    runSqliteOptimize,
} from "../features/magic-context/storage";
import type { RawMessageProvider } from "../hooks/magic-context/read-session-chunk";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { ModelHarness } from "../shared/model-resolution";
import type { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { beginBootQuietPeriod, scheduleAfterBootQuiet } from "./boot-quiet";
import type { PluginContext } from "./types";

/** Check interval for dream schedule (15 minutes). */
const DREAM_TIMER_INTERVAL_MS = 15 * 60 * 1000;
/** Wall-clock budget for post-sweep commit backlog drain (matches indexer embed sweep). */
const GIT_COMMIT_BACKLOG_DRAIN_MAX_MS = 5 * 60 * 1000;
/** First maintenance passes are spread across 30 seconds after boot quiet ends. */
const BOOT_PROJECT_JITTER_SLOT_MS = 1_000;

/**
 * Per-project work registered with the timer. The timer is a process-wide
 * singleton, but Desktop OpenCode can load the same plugin once per project
 * within one process — every load needs its directory's git commits indexed,
 * its dream schedule checked, and its config respected.
 */
interface ProjectRegistration {
    directory: string;
    projectIdentity: string;
    /** The runtime selecting models for this registration. */
    harness: ModelHarness;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    language?: string;
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
    memoryEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historianChildSweep?: {
        timeoutMs: number;
        fallbackModelCount: number;
        keepSubagents: boolean;
    };
    mural?: { enabled: boolean; model?: string };
    retinaHandoff?: boolean;
    embeddingConfig?: { provider?: string };
    ensureRegistered: (directory: string, db: Database) => Promise<void>;
    /**
     * Per-registration retrospective raw-source provider factory. Each harness
     * brings its own (the same way it brings its own `client`): OpenCode reads
     * opencode.db, Pi reads its JSONL sessions. When omitted, the timer defaults
     * to the OpenCode provider (preserving OpenCode behavior exactly).
     */
    retrospectiveRawProvider?: (
        db: Database,
        projectIdentity: string,
    ) => RetrospectiveRawProvider | null;
    /**
     * Per-registration primer raw-source provider factory for the SCHEDULED
     * refresh-primers task. Pi supplies a JSONL-backed factory so the open-book
     * primer seed renders the origin compartment's raw U:/TC: lines; OpenCode
     * omits it (buildPrimerSeed reads opencode.db directly). When omitted on Pi,
     * scheduled refresh-primers silently falls back to a closed-book seed.
     */
    primerRawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    transformMode?: "ts" | "rust";
    onDreamerProgress?: (progress: DreamTaskProgress | null, completedTask?: DreamTaskName) => void;
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
}

/** Singleton timer state. */
let activeTimer: ReturnType<typeof setInterval> | null = null;
let startupTickTimer: ReturnType<typeof setTimeout> | null = null;
const startupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const startupJitters = new Map<string, number>();
let nextStartupJitterSlot = 0;

/** True when `directory` exists and is a directory. Any stat error (gone,
 *  permission, ENOENT) → false: a directory we can't read is treated as gone for
 *  the dead-directory guard. */
function directoryStillExists(directory: string): boolean {
    try {
        return statSync(directory).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Open the shared DB for timer work, returning null (with one clear log) when
 * storage is unavailable. openDatabase() returns a typed-null on the
 * schema-fence path BUT THROWS on a fatal open (corrupt/unwritable DB) — both
 * mean "storage unavailable" here, so we catch the throw and degrade to null
 * too. Every timer entry point MUST null-check before using the handle —
 * otherwise the null reaches `db.transaction(...)` deep in embedding
 * registration and throws a confusing TypeError. Crucially, this also keeps a
 * fatal-open throw from escaping the awaited startup registration in index.ts
 * and aborting the whole plugin load (which would disable the transform).
 */
function openTimerDatabaseOrNull(context: string): Database | null {
    let db: Database | null;
    try {
        db = openDatabase();
    } catch (error) {
        log(`[dreamer] storage fatal; skipping ${context}: ${getErrorMessage(error)}`);
        return null;
    }
    if (!db) {
        log(
            `[dreamer] storage unavailable; skipping ${context} (the cache schema is newer than this binary supports — restart/upgrade OpenCode/Pi/Magic Context to recover)`,
        );
        return null;
    }
    return db;
}
/** All projects that have called startDreamScheduleTimer in this process,
 *  keyed by directory so re-registration of the same directory is idempotent. */
const registeredProjects = new Map<string, ProjectRegistration>();

function stopDreamScheduleTimerIfIdle(): void {
    if (registeredProjects.size !== 0) return;
    const stopped = activeTimer !== null || startupTickTimer !== null;
    if (activeTimer) {
        clearInterval(activeTimer);
        activeTimer = null;
    }
    if (startupTickTimer) {
        clearTimeout(startupTickTimer);
        startupTickTimer = null;
    }
    startupJitters.clear();
    nextStartupJitterSlot = 0;
    if (stopped) log("[dreamer] stopped dream schedule timer (no projects left)");
}

/**
 * Register the calling project with the process-wide dream + maintenance
 * timer. The timer itself is a singleton (we only need one setInterval per
 * process), but every registered project gets its per-directory work — git
 * commit indexing, dream schedule check, dream queue processing — on each
 *  tick. The first registration schedules a quiet-period startup pass so
 *  fresh installs do not create a writer burst during concurrent boot.
 *
 * Returns a cleanup that removes this project's registration. The timer
 * itself stops only when the last project unregisters.
 */
export async function startDreamScheduleTimer(
    args: ProjectRegistration,
): Promise<(() => void) | undefined> {
    beginBootQuietPeriod();
    const db = openTimerDatabaseOrNull("schedule timer registration");
    if (!db) return;
    const dreamingEnabled = Boolean(args.dreamerConfig && args.dreamerConfig.disable !== true);
    const embeddingSweepEnabled = args.memoryEnabled === true;
    const commitIndexingEnabled = args.gitCommitIndexing?.enabled === true;

    // The timer also owns global message-history privacy maintenance, so an
    // enabled plugin registers even when project dream/embedding/git work is off.

    // Idempotent registration — re-registering the same directory replaces
    // the prior config (e.g., if config was reloaded for that project).
    const previousRegistration = registeredProjects.get(args.directory);
    const isNewRegistration = previousRegistration === undefined;
    if (previousRegistration && previousRegistration !== args) {
        const pendingStartup = startupTimers.get(args.directory);
        if (pendingStartup) {
            clearTimeout(pendingStartup);
            startupTimers.delete(args.directory);
        }
    }
    registeredProjects.set(args.directory, args);

    if (isNewRegistration) {
        log(
            `[dreamer] registered project ${args.projectIdentity} (dreaming=${dreamingEnabled} embeddings=${embeddingSweepEnabled} commits=${commitIndexingEnabled}; total=${registeredProjects.size})`,
        );
    }

    if (!activeTimer) {
        // First registration in this process starts a quiet-period timer.
        // Startup work is scheduled only after the quiet period and is
        // staggered per project so a multi-project process does not create
        // one writer burst.
        log(
            `[dreamer] started independent schedule timer (every ${DREAM_TIMER_INTERVAL_MS / 60_000}m)`,
        );

        startupTickTimer = scheduleAfterBootQuiet(() => {
            startupTickTimer = null;
            runTick("startup");
        });

        const timer = setInterval(() => runTick("interval"), DREAM_TIMER_INTERVAL_MS);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        activeTimer = timer;
    } else if (isNewRegistration || previousRegistration !== args) {
        scheduleInitialProjectRun(args, db);
    }

    return () => {
        // A newer registration may have replaced this directory before an async
        // caller receives and invokes its cleanup. Never let stale cleanup remove
        // the replacement's registry entry, startup work, or singleton timer.
        if (registeredProjects.get(args.directory) !== args) {
            stopDreamScheduleTimerIfIdle();
            return;
        }
        registeredProjects.delete(args.directory);
        const startupTimer = startupTimers.get(args.directory);
        if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimers.delete(args.directory);
        }
        log(
            `[dreamer] unregistered project ${args.projectIdentity} (remaining=${registeredProjects.size})`,
        );
        stopDreamScheduleTimerIfIdle();
    };
}

/**
 * Single tick body. Runs global message-history maintenance once, then
 * iterates every registered project for its per-directory work.
 */
function runTick(origin: "startup" | "interval"): void {
    log(`[dreamer] timer tick (${origin}) — projects=${registeredProjects.size}`);
    void (async () => {
        try {
            const db = openTimerDatabaseOrNull("maintenance tick");
            if (!db) return;
            runMessageHistoryMaintenance(db);
            // Per-project work — git commit indexing, dream schedule check,
            // dream queue processing. We iterate all registered projects so
            // Desktop's "open all projects at once" workflow indexes every one,
            // not just whichever project happened to register the timer first.
            for (const reg of registeredProjects.values()) {
                if (origin === "startup") {
                    scheduleInitialProjectRun(reg, db);
                } else {
                    await runProjectMaintenance(reg, origin, db);
                }
            }
            if (origin === "startup") return;
            // Refresh planner stats once per tick (after per-project work).
            // Self-gating: a no-op unless a table's row count drifted enough to
            // warrant re-ANALYZE, and analysis_limit bounds any work it does.
            runSqliteOptimize(db);
        } catch (error) {
            log("[magic-context] timer-triggered maintenance check failed:", error);
        }
    })();
}

function runMessageHistoryMaintenance(db: Database): void {
    const cleanup = retryPendingSessionCleanups(db);
    if (cleanup.cleared > 0 || cleanup.failedSessionIds.length > 0) {
        log(
            `[message-index] pending session cleanup: cleared=${cleanup.cleared} failed=${cleanup.failedSessionIds.length}`,
        );
    }

    const sweep = sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb);
    if (sweep.deleted > 0) {
        log(
            `[message-index] orphan sweep: scanned=${sweep.scanned} deleted=${sweep.deleted} cursor=${sweep.cursor || "<complete>"}`,
        );
    }
}

function startupJitterMs(directory: string): number {
    const existing = startupJitters.get(directory);
    if (existing !== undefined) return existing;
    const slot = nextStartupJitterSlot;
    nextStartupJitterSlot += 1;
    const hash = [...directory].reduce(
        (value, character) => (value * 33 + character.charCodeAt(0)) >>> 0,
        5381,
    );
    const jitter = slot * BOOT_PROJECT_JITTER_SLOT_MS + (hash % BOOT_PROJECT_JITTER_SLOT_MS);
    startupJitters.set(directory, jitter);
    return jitter;
}

function scheduleInitialProjectRun(reg: ProjectRegistration, db: Database): void {
    if (startupTimers.has(reg.directory)) return;
    const timer = scheduleAfterBootQuiet(() => {
        startupTimers.delete(reg.directory);
        if (registeredProjects.get(reg.directory) !== reg) return;
        void runProjectMaintenance(reg, "startup", db);
    }, startupJitterMs(reg.directory));
    startupTimers.set(reg.directory, timer);
}

async function runProjectMaintenance(
    reg: ProjectRegistration,
    origin: "startup" | "interval",
    db: Database,
): Promise<void> {
    const projectMaintenanceEnabled =
        Boolean(reg.dreamerConfig && reg.dreamerConfig.disable !== true) ||
        reg.memoryEnabled === true ||
        reg.gitCommitIndexing?.enabled === true ||
        reg.historianChildSweep !== undefined;
    if (!projectMaintenanceEnabled) return;

    await reg.ensureRegistered(reg.directory, db);
    const memorySnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
    if (memorySnapshot?.enabled) {
        const embeddedCount = await embedUnembeddedMemoriesForProject(db, reg.projectIdentity);
        if (embeddedCount > 0) {
            log(
                `[magic-context] proactively embedded ${embeddedCount} ${embeddedCount === 1 ? "memory" : "memories"} for project ${reg.projectIdentity}`,
            );
        }
        // Compartment-chunk backfill remains demand-driven to avoid bursty
        // requests to local embedding endpoints.
    }
    await sweepProject(reg, origin, db);
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
    db: Database,
    gitCommitEnabled?: boolean,
): Promise<void> {
    // Dead-directory guard: a registration whose directory no longer exists
    // (e.g. a finalized mason worktree) can't have meaningful dreamer work —
    // git indexing + key-files/verify would ENOENT reading from the gone path.
    // Skip it and unregister so it stops being swept. For a `dir:` identity
    // (path-unique → truly orphaned once the path is gone) also GC its schedule
    // rows; a `git:` identity is SHARED across worktrees/clones, so a single dead
    // worktree must NOT delete the shared project's schedule.
    if (!directoryStillExists(reg.directory)) {
        log(
            `[dreamer] project directory no longer exists (${reg.projectIdentity}); skipping + unregistering`,
        );
        if (reg.projectIdentity.startsWith("dir:")) {
            try {
                const removed = deleteTaskScheduleRowsForProject(db, reg.projectIdentity);
                if (removed > 0) {
                    log(
                        `[dreamer] GC'd ${removed} orphaned schedule row(s) for ${reg.projectIdentity}`,
                    );
                }
            } catch (error) {
                log(`[dreamer] orphan schedule GC failed for ${reg.projectIdentity}:`, error);
            }
        }
        if (registeredProjects.get(reg.directory) === reg) {
            registeredProjects.delete(reg.directory);
            const startupTimer = startupTimers.get(reg.directory);
            if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimers.delete(reg.directory);
            }
        }
        stopDreamScheduleTimerIfIdle();
        return;
    }

    await reg.ensureRegistered(reg.directory, db);
    const embeddingSnapshot = getProjectEmbeddingSnapshot(reg.projectIdentity);
    const commitIndexingEnabled = gitCommitEnabled ?? embeddingSnapshot?.gitCommitEnabled === true;
    const gc = sweepStaleEmbeddingIdentitiesForProject(db, reg.projectIdentity);
    const gcDeleted = gc.memoryRowsDeleted + gc.commitRowsDeleted + gc.chunkRowsDeleted;
    if (gcDeleted > 0) {
        log(
            `[magic-context] GC'd ${gcDeleted} stale embedding row(s) for ${reg.projectIdentity} ` +
                `(memory=${gc.memoryRowsDeleted} commit=${gc.commitRowsDeleted} chunk=${gc.chunkRowsDeleted})`,
        );
    }

    await sweepOrphanedHistorianChildren(reg);

    const dreamerConfig = reg.dreamerConfig;
    const dreamingEnabled = Boolean(dreamerConfig && dreamerConfig.disable !== true);
    if (commitIndexingEnabled && reg.gitCommitIndexing) {
        await sweepGitCommits({
            directory: reg.directory,
            gitCommitIndexing: reg.gitCommitIndexing,
            projectIdentity: reg.projectIdentity,
            db,
        });
    }

    if (!dreamingEnabled || !dreamerConfig) {
        return;
    }

    try {
        await runCompiledSmartNoteSweep(reg, db);

        // Dreamer v2: per-task cron scheduling. The scheduler seeds/reads
        // task_schedule_state, evaluates each task's cron + activity gate, and
        // runs due tasks grouped by conflict-domain under keyed leases. The
        // executor runs in THIS registration's own checkout (not a sibling
        // worktree the shared git:<sha> identity might resolve to).
        const runtimeConfigs = buildDreamTaskRuntimeConfigs(
            dreamerConfig,
            "opencode",
            reg.language,
            reg.mural?.model,
        );
        const executor = createDreamTaskExecutor({
            client: reg.client,
            sessionDirectory: reg.directory,
            openOpenCodeDb,
            // Each registration brings its own provider factory (Pi supplies the
            // JSONL provider); default to OpenCode when none is given.
            retrospectiveRawProvider:
                reg.retrospectiveRawProvider ??
                ((db) => new OpenCodeRetrospectiveRawProvider({ contextDb: db, openOpenCodeDb })),
            // Pi-only: scheduled refresh-primers needs the JSONL factory to render
            // the open-book seed. OpenCode omits it (buildPrimerSeed reads
            // opencode.db directly). Without this the scheduled Pi task ran
            // closed-book, defeating the open-book primer redesign.
            primerRawProviderFactory: reg.primerRawProviderFactory,
            userMemoryCollectionEnabled: userMemoryCollectionEnabled(dreamerConfig),
            ensureProjectRegistered: reg.ensureRegistered,
            language: reg.language,
            mural: reg.mural,
            memoryInjectionBudgetTokens: reg.memoryInjectionBudgetTokens,
            retinaHandoff: reg.retinaHandoff,
            transformMode: reg.transformMode,
            moduleClient: reg.moduleClient,
            onProgress: (progress, completedTask) =>
                reg.onDreamerProgress?.(progress, completedTask),
        });
        const ran = await runDueTasksForProject({
            db,
            projectIdentity: reg.projectIdentity,
            tasks: runtimeConfigs,
            executor,
        });
        if (ran > 0) {
            log(`[dreamer] timer tick (${origin}) ${reg.projectIdentity} — ran ${ran} task(s)`);
        }

        // PRIVACY backstop: remove crash-orphaned children carrying raw user or
        // project text only after the longest swept task's timeout has elapsed.
        // OpenCode-only (Pi subprocess children die with their process); skip
        // when no opencode.db.
        const privacySweepTimeouts = runtimeConfigs
            .filter((c) => (PRIVACY_SENSITIVE_CHILD_TASKS as readonly string[]).includes(c.task))
            .map((c) => c.timeoutMinutes);
        const ocDb = openOpenCodeDb();
        if (ocDb) {
            try {
                await sweepOrphanedRetrospectiveChildren({
                    opencodeDb: ocDb,
                    client: reg.client,
                    sessionDirectory: reg.directory,
                    staleMs: retrospectiveOrphanStaleMs(privacySweepTimeouts),
                    titleMatches: PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES,
                });
            } catch (sweepError) {
                log(
                    `[dreamer] retrospective orphan sweep failed for ${reg.projectIdentity}:`,
                    sweepError,
                );
            } finally {
                closeQuietly(ocDb);
            }
        }
    } catch (error) {
        log(`[dreamer] timer-triggered task scheduling failed for ${reg.projectIdentity}:`, error);
    }
}

async function sweepOrphanedHistorianChildren(reg: ProjectRegistration): Promise<void> {
    const config = reg.historianChildSweep;
    if (!config || config.keepSubagents) return;

    const ocDb = openOpenCodeDb();
    if (!ocDb) return;
    try {
        await sweepOrphanedRetrospectiveChildren({
            opencodeDb: ocDb,
            client: reg.client,
            sessionDirectory: reg.directory,
            staleMs: historianOrphanStaleMs(config.timeoutMs, config.fallbackModelCount),
            titleMatches: HISTORIAN_CHILD_TITLE_MATCHES,
        });
    } catch (error) {
        log(
            `[magic-context] historian child orphan sweep failed for ${reg.projectIdentity}:`,
            error,
        );
    } finally {
        closeQuietly(ocDb);
    }
}

async function runCompiledSmartNoteSweep(reg: ProjectRegistration, db: Database): Promise<void> {
    const leaseKey = leaseKeyFor("evaluate-smart-notes", reg.projectIdentity);
    const holderId = crypto.randomUUID();
    if (!acquireLease(db, holderId, leaseKey)) return;
    try {
        const result = await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: reg.projectIdentity,
            projectRoot: reg.directory,
            retinaHandoff: reg.retinaHandoff,
        });
        if (result.ran > 0) {
            log(
                `[dreamer] compiled smart-note sweep ${reg.projectIdentity}: ran=${result.ran} surfaced=${result.surfaced} logic_failed=${result.failed} network_failed=${result.networkFailed}`,
            );
        }
    } finally {
        releaseLease(db, holderId, leaseKey);
    }
}

/**
 * Index commits for the current project and drain embeddings. Runs in the
 * background under the timer's fire-and-forget contract.
 *
 * Project identity resolution happens inside the indexer so we always read
 * the same `git:<sha>` identity used by memories and ctx_search.
 */
function startGitSweepLeaseRenewal(
    db: Database,
    projectIdentity: string,
    holderId: string,
): () => void {
    const timer = setInterval(() => {
        try {
            if (!renewGitSweepLease(db, projectIdentity, holderId)) {
                log(`[git-commits] sweep lease renewal failed for ${projectIdentity}`);
            }
        } catch (error) {
            log(
                `[git-commits] sweep lease renewal errored for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }, GIT_SWEEP_LEASE_RENEWAL_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}

async function sweepGitCommits(args: {
    directory: string;
    projectIdentity: string;
    db: Database;
    gitCommitIndexing: { enabled: boolean; since_days: number; max_commits: number };
}): Promise<void> {
    const { directory, projectIdentity, db, gitCommitIndexing } = args;
    const holderId = crypto.randomUUID();
    const lease = acquireGitSweepLease(db, projectIdentity, holderId);
    if (!lease.acquired) {
        const reason =
            lease.reason === "cooldown_active"
                ? `cooldown active until ${lease.nextAllowedAt}`
                : `lease held by ${lease.leaseHolder ?? "another holder"} until ${lease.leaseExpiresAt ?? "unknown"}`;
        log(`[git-commits] sweep skipped for ${projectIdentity}: ${reason}`);
        return;
    }

    const startedAt = Date.now();
    const stopRenewal = startGitSweepLeaseRenewal(db, projectIdentity, holderId);
    log(
        `[git-commits] sweep starting for ${projectIdentity} (sinceDays=${gitCommitIndexing.since_days} maxCommits=${gitCommitIndexing.max_commits})`,
    );
    try {
        const result = await indexCommitsForProject(db, projectIdentity, directory, {
            sinceDays: gitCommitIndexing.since_days,
            maxCommits: gitCommitIndexing.max_commits,
        });
        if (result.nonIndexable) {
            // Not a repo / repo with no commits: park on the long re-probe
            // cooldown so the timer doesn't retry (and log) every tick.
            if (!parkGitSweepNonIndexable(db, projectIdentity, holderId)) {
                releaseGitSweepLease(db, projectIdentity, holderId);
            }
            return;
        }
        // Drain any remaining embedding backlog from this sweep (indexer caps per run).
        let drainedEmbeddings = 0;
        if (result.embedded > 0) {
            drainedEmbeddings = await embedUnembeddedCommits(db, projectIdentity);
        }
        const cooldownMarked = markGitSweepSuccessAndRelease(db, projectIdentity, holderId);
        if (!cooldownMarked) {
            releaseGitSweepLease(db, projectIdentity, holderId);
            log(
                `[git-commits] sweep finished for ${projectIdentity}, but lease was no longer active; cooldown not advanced`,
            );
        }

        const memorySnapshot = getProjectEmbeddingSnapshot(projectIdentity);
        let backlogDrained = 0;
        if (memorySnapshot?.gitCommitEnabled) {
            try {
                backlogDrained = await drainCommitBacklogForProject(
                    db,
                    projectIdentity,
                    Date.now() + GIT_COMMIT_BACKLOG_DRAIN_MAX_MS,
                );
            } catch (error) {
                log(
                    `[git-commits] commit backlog drain failed for ${projectIdentity}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep finished for ${projectIdentity} in ${elapsedMs}ms: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded} drained=${drainedEmbeddings} backlogDrained=${backlogDrained}`,
        );
    } catch (error) {
        releaseGitSweepLease(db, projectIdentity, holderId);
        const elapsedMs = Date.now() - startedAt;
        log(
            `[git-commits] sweep failed for ${projectIdentity} after ${elapsedMs}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        stopRenewal();
    }
}
