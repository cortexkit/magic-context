import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { getDataDir } from "../../../shared/data-path";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runKeyFilesTask } from "../key-files/identify-key-files";
import { getMemoryCountsByStatus } from "../memory/storage-memory";
import { reembedStaleSkillNotes } from "../skill-memory/reembed";
import { getPendingSmartNotes, markNoteChecked, markNoteReady } from "../storage-notes";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import {
    enforceMaintainDocsProtectedRegions,
    snapshotMaintainDocsFiles,
} from "./maintain-docs-protected-enforcement";
import {
    clearStaleEntries,
    dequeueNext,
    getEntryRetryCount,
    hasActiveDreamLease,
    removeDreamEntry,
    resetDreamEntry,
} from "./queue";
import { insertDreamRun } from "./storage-dream-runs";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";

// Keyed by project identity (e.g. "git:<sha>"), not filesystem path. Two
// worktrees/clones of the same repo collapse to the same identity, so in a
// single process this map's entry for that identity is "last-registered wins"
// — it can point at a different checkout than the one draining the queue. This
// map is only a FALLBACK now: production drain callers pass their own
// `sessionDirectoryOverride` (the directory of the project THIS process owns),
// so the dequeued entry always runs in a live checkout the draining process
// actually registered, never a stale sibling-checkout path. See
// processDreamQueue's sessionDirectoryOverride.
const dreamProjectDirectories = new Map<string, string>();
const CIRCUIT_BREAKER_THRESHOLD = 3;

interface ExperimentalPinKeyFilesConfig {
    enabled: boolean;
    token_budget: number;
    min_reads: number;
}

export function registerDreamProjectDirectory(projectIdentity: string, directory: string): void {
    dreamProjectDirectories.set(projectIdentity, directory);
}

function resolveDreamSessionDirectory(projectIdentity: string): string {
    return dreamProjectDirectories.get(projectIdentity) ?? projectIdentity;
}

export interface DreamRunResult {
    startedAt: number;
    finishedAt: number;
    holderId: string;
    smartNotesSurfaced: number;
    smartNotesPending: number;
    tasks: {
        name: string;
        durationMs: number;
        result: unknown;
        error?: string;
    }[];
}

function countNewIds(beforeIds: number[], afterIds: number[]): number {
    const beforeSet = new Set(beforeIds);
    let count = 0;
    for (const id of afterIds) {
        if (!beforeSet.has(id)) {
            count += 1;
        }
    }
    return count;
}

function getCircuitBreakerSignature(error: unknown, brief: string): string {
    if (error instanceof Error && error.name && error.name !== "Error") {
        return error.name;
    }

    const namedError = error as { name?: unknown } | null;
    if (
        namedError &&
        typeof namedError === "object" &&
        typeof namedError.name === "string" &&
        namedError.name.length > 0 &&
        namedError.name !== "Error"
    ) {
        return namedError.name;
    }

    return brief.split(":")[0]?.trim().split(/\s+/)[0] || brief || "unknown";
}

function shouldSkipCircuitBreaker(error: unknown, brief: string): boolean {
    const namedError = error as { name?: unknown } | null;
    const name =
        error instanceof Error
            ? error.name
            : namedError && typeof namedError === "object" && typeof namedError.name === "string"
              ? namedError.name
              : "";
    const combined = `${name} ${brief}`.toLowerCase();
    return name === "AbortError" || combined.includes("lease");
}

function logWithStackHead(message: string, stackHead?: string): void {
    log(message, stackHead ? { stackHead } : undefined);
}

function getOpenCodeDbPath(): string {
    return join(getDataDir(), "opencode", "opencode.db");
}

function openOpenCodeDb(): Database | null {
    const dbPath = getOpenCodeDbPath();
    if (!existsSync(dbPath)) {
        log(`[key-files] OpenCode DB not found at ${dbPath} — skipping`);
        return null;
    }

    try {
        const db = new Database(dbPath, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
    } catch (error) {
        log(`[key-files] failed to open OpenCode DB at ${dbPath}: ${getErrorMessage(error)}`);
        return null;
    }
}

export async function runDream(args: {
    db: Database;
    client: PluginContext["client"];
    /** Project identity (e.g. "git:<sha>"), NOT a filesystem path. Used for dream state keys. */
    projectIdentity: string;
    tasks: DreamingTask[];
    taskTimeoutMinutes: number;
    maxRuntimeMinutes: number;
    parentSessionId?: string;
    sessionDirectory?: string;
    experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
    experimentalPinKeyFiles?: ExperimentalPinKeyFilesConfig;
    /**
     * Resolved fallback chain for dreamer subagent calls. When the primary
     * `dreamer.model` fails (auth, model-not-found, rate limit, transient
     * network), each entry is tried in order before giving up. Empty/undefined
     * disables fallback iteration (legacy single-suggestion-retry only).
     *
     * Caller (`processDreamQueue` / direct caller) resolves this via
     * `resolveFallbackChain(DREAMER_AGENT, config.dreamer.fallback_models)`.
     */
    fallbackModels?: readonly string[];
}): Promise<DreamRunResult> {
    const holderId = crypto.randomUUID();
    const startedAt = Date.now();
    const result: DreamRunResult = {
        startedAt,
        finishedAt: startedAt,
        holderId,
        smartNotesSurfaced: 0,
        smartNotesPending: 0,
        tasks: [],
    };
    const memoryCountsBefore = getMemoryCountsByStatus(args.db, args.projectIdentity);

    log(
        `[dreamer] starting dream run: ${args.tasks.length} tasks, timeout=${args.taskTimeoutMinutes}m, maxRuntime=${args.maxRuntimeMinutes}m, project=${args.projectIdentity}`,
    );

    if (!acquireLease(args.db, holderId)) {
        const currentHolder = getLeaseHolder(args.db) ?? "another holder";
        log(`[dreamer] lease acquisition failed — already held by ${currentHolder}`);
        result.tasks.push({
            name: "lease",
            durationMs: 0,
            result: null,
            error: `Dream lease is already held by ${currentHolder}`,
        });
        result.finishedAt = Date.now();
        return result;
    }
    log(`[dreamer] lease acquired: ${holderId}`);

    // Resolve a parent session ID so child sessions are hidden from the UI session list.
    // /ctx-dream passes the active session; scheduled runs resolve from the API.
    let parentSessionId = args.parentSessionId;
    if (!parentSessionId) {
        try {
            const sessionDir = args.sessionDirectory ?? args.projectIdentity;
            const listResponse = await args.client.session.list({
                query: { directory: sessionDir },
            });
            const sessions = shared.normalizeSDKResponse(listResponse, [] as { id?: string }[], {
                preferResponseOnMissingData: true,
            });
            // Intentional: any existing session works — we just need parentID so child sessions don't appear in the UI
            parentSessionId = sessions?.find((s) => typeof s?.id === "string")?.id;
            if (parentSessionId) {
                log(`[dreamer] resolved parent session: ${parentSessionId}`);
            }
        } catch {
            log(
                "[dreamer] could not resolve parent session — child sessions will be visible in UI",
            );
        }
    }

    const deadline = startedAt + args.maxRuntimeMinutes * 60 * 1000;
    // Strictly per-project (no global-key fallback — it cross-contaminated the
    // maintain-docs cutoff across projects).
    const lastDreamAt = getDreamState(args.db, `last_dream_at:${args.projectIdentity}`);
    log(`[dreamer] last dream at: ${lastDreamAt ?? "never"} (project=${args.projectIdentity})`);

    let lastErrorSignature: string | null = null;
    let consecutiveSameErrorFailures = 0;
    let circuitBreakerTripped = false;
    let lostLease = false;
    let lostLeaseReason: string | null = null;
    let lostLeaseRecorded = false;

    const markLeaseLost = (phase: string, error?: unknown): void => {
        const detail = error ? `: ${getErrorMessage(error)}` : "";
        lostLeaseReason = `Dream lease lost during ${phase}${detail}`;
        if (!lostLease) {
            log(`[dreamer] FATAL: ${lostLeaseReason}; aborting all remaining dream work`);
        } else {
            log(`[dreamer] FATAL: ${lostLeaseReason}; dream work is already aborting`);
        }
        lostLease = true;
    };

    const recordLeaseLostTask = (phase: string): void => {
        if (lostLeaseRecorded) return;
        lostLeaseRecorded = true;
        result.tasks.push({
            name: "lease-lost",
            durationMs: 0,
            result: "",
            error: lostLeaseReason ?? `Dream lease lost during ${phase}; aborted remaining work`,
        });
    };

    const verifyLeaseStillHeld = (phase: string): boolean => {
        if (lostLease) return false;
        try {
            if (!renewLease(args.db, holderId)) {
                markLeaseLost(phase);
                return false;
            }
            return true;
        } catch (error) {
            markLeaseLost(phase, error);
            return false;
        }
    };

    try {
        for (const taskName of args.tasks) {
            if (!verifyLeaseStillHeld(`before task ${taskName}`)) {
                recordLeaseLostTask(`before task ${taskName}`);
                break;
            }
            if (Date.now() > deadline) {
                log(`[dreamer] deadline reached, stopping after ${result.tasks.length} tasks`);
                break;
            }

            log(`[dreamer] starting task: ${taskName}`);
            const taskStartedAt = Date.now();
            let agentSessionId: string | null = null;
            // Keep FAILED dreamer child sessions for debugging (the task's model
            // output + error stay inspectable); delete only on success.
            let taskFailed = false;
            const invocationStartedAt = Date.now();
            let invocationRecorded = false;
            const recordInvocation = (params: {
                status: "completed" | "failed" | "aborted";
                messages?: unknown[];
                error?: unknown;
            }) => {
                if (!parentSessionId || invocationRecorded) return;
                invocationRecorded = true;
                recordChildInvocation({
                    db: args.db,
                    parentSessionId,
                    harness: "opencode",
                    subagent: "dreamer",
                    task: taskName,
                    startedAt: invocationStartedAt,
                    status: params.status,
                    messages: params.messages,
                    error: params.error,
                });
            };
            // AbortController lets us cancel the in-flight LLM prompt immediately when lease is lost
            const taskAbortController = new AbortController();
            // Renew lease periodically while the LLM task runs (can take 5+ min on slow models)
            const leaseRenewalInterval = setInterval(() => {
                try {
                    if (!renewLease(args.db, holderId)) {
                        log(`[dreamer] task ${taskName}: lease renewal failed — aborting LLM call`);
                        markLeaseLost(`task ${taskName} lease renewal`);
                        taskAbortController.abort();
                    }
                } catch (err) {
                    log(
                        `[dreamer] task ${taskName}: lease renewal threw — aborting LLM call: ${err}`,
                    );
                    markLeaseLost(`task ${taskName} lease renewal`, err);
                    taskAbortController.abort();
                }
            }, 60_000);

            try {
                // Use sessionDirectory (filesystem path) for file checks, not projectPath (identity like "git:<sha>")
                const docsDir = args.sessionDirectory ?? args.projectIdentity;
                const maintainDocsSnapshot =
                    taskName === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
                const existingDocs =
                    taskName === "maintain-docs"
                        ? {
                              architecture: existsSync(join(docsDir, "ARCHITECTURE.md")),
                              structure: existsSync(join(docsDir, "STRUCTURE.md")),
                          }
                        : undefined;

                // Load user memories for archive-stale dedup context
                const userMemories =
                    taskName === "archive-stale"
                        ? getActiveUserMemories(args.db).map((um) => ({
                              id: um.id,
                              content: um.content,
                          }))
                        : undefined;

                if (taskName === "distill-skill-memory") {
                    await reembedStaleSkillNotes(args.db, args.projectIdentity);
                }

                const taskPrompt = buildDreamTaskPrompt(taskName, {
                    projectPath: args.projectIdentity,
                    lastDreamAt,
                    existingDocs,
                    userMemories,
                });

                const createResponse = await args.client.session.create({
                    body: {
                        ...(parentSessionId ? { parentID: parentSessionId } : {}),
                        title: `magic-context-dream-${taskName}`,
                    },
                    query: { directory: args.sessionDirectory ?? args.projectIdentity },
                });

                const createdSession = shared.normalizeSDKResponse(
                    createResponse,
                    null as { id?: string } | null,
                    { preferResponseOnMissingData: true },
                );
                agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;
                if (!agentSessionId) {
                    const error = new Error("Dreamer could not create its child session.");
                    recordInvocation({ status: "failed", error });
                    throw error;
                }
                log(`[dreamer] task ${taskName}: child session created ${agentSessionId}`);
                const childSessionId = agentSessionId;

                const dreamTaskRun = await shared.promptSyncWithValidatedOutputRetry(
                    args.client,
                    {
                        path: { id: childSessionId },
                        query: { directory: args.sessionDirectory ?? args.projectIdentity },
                        body: {
                            agent: DREAMER_AGENT,
                            system: DREAMER_SYSTEM_PROMPT,
                            // synthetic: true hides the dreamer task prompt from the TUI
                            // subagent pane while still delivering it to the model. See issue #50.
                            parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                        },
                    },
                    {
                        timeoutMs: args.taskTimeoutMinutes * 60 * 1000,
                        signal: taskAbortController.signal,
                        fallbackModels: args.fallbackModels,
                        callContext: `dreamer:${taskName}`,
                        fetchOutput: async () => {
                            const messagesResponse = await args.client.session.messages({
                                path: { id: childSessionId },
                                query: {
                                    directory: args.sessionDirectory ?? args.projectIdentity,
                                    limit: 50,
                                },
                            });
                            return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                                preferResponseOnMissingData: true,
                            });
                        },
                        validateOutput: (messages) => {
                            const taskResult = extractLatestAssistantText(messages);
                            if (!taskResult) {
                                throw new Error("Dreamer returned no assistant output.");
                            }
                            return taskResult;
                        },
                    },
                );
                if (lostLease) {
                    throw new Error(lostLeaseReason ?? `Dream lease lost during ${taskName}`);
                }

                const taskResult = dreamTaskRun.validated;
                recordInvocation({ status: "completed", messages: dreamTaskRun.output });

                if (
                    taskName === "maintain-docs" &&
                    maintainDocsSnapshot &&
                    maintainDocsSnapshot.size > 0
                ) {
                    try {
                        enforceMaintainDocsProtectedRegions({
                            docsDir,
                            snapshot: maintainDocsSnapshot,
                        });
                    } catch (error) {
                        log(
                            `[dreamer] maintain-docs protected-region enforcement failed: ${error}`,
                        );
                    }
                }

                const durationMs = Date.now() - taskStartedAt;
                log(
                    `[dreamer] task ${taskName}: completed in ${(durationMs / 1000).toFixed(1)}s (result: ${String(taskResult).length} chars)`,
                );
                result.tasks.push({
                    name: taskName,
                    durationMs,
                    result: taskResult,
                });
                lastErrorSignature = null;
                consecutiveSameErrorFailures = 0;
            } catch (error) {
                taskFailed = true;
                recordInvocation({ status: lostLease ? "aborted" : "failed", error });
                const durationMs = Date.now() - taskStartedAt;
                const errorDescription = describeError(error);
                logWithStackHead(
                    `[dreamer] task ${taskName}: failed after ${(durationMs / 1000).toFixed(1)}s — ${errorDescription.brief}`,
                    errorDescription.stackHead,
                );
                result.tasks.push({
                    name: taskName,
                    durationMs,
                    result: null,
                    error: errorDescription.brief,
                });

                if (lostLease) {
                    lastErrorSignature = null;
                    consecutiveSameErrorFailures = 0;
                } else if (shouldSkipCircuitBreaker(error, errorDescription.brief)) {
                    lastErrorSignature = null;
                    consecutiveSameErrorFailures = 0;
                } else {
                    const signature = getCircuitBreakerSignature(error, errorDescription.brief);
                    if (signature === lastErrorSignature) {
                        consecutiveSameErrorFailures += 1;
                    } else {
                        lastErrorSignature = signature;
                        consecutiveSameErrorFailures = 1;
                    }

                    if (consecutiveSameErrorFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                        circuitBreakerTripped = true;
                        log(
                            `[dreamer] circuit breaker: ${consecutiveSameErrorFailures} consecutive ${signature} failures — aborting remaining tasks`,
                        );
                        result.tasks.push({
                            name: "circuit-breaker",
                            durationMs: 0,
                            result: "",
                            error: `Aborted remaining tasks: ${consecutiveSameErrorFailures} consecutive ${signature} failures. Configure dreamer model/fallback_models in magic-context.jsonc.`,
                        });
                    }
                }
            } finally {
                clearInterval(leaseRenewalInterval);
                // Delete the child session only on SUCCESS. Keep failed sessions so
                // the task's prompt / model output / error can be inspected (the
                // failure is already recorded in subagent_invocations).
                // keep_subagents debug flag retains successful ones too.
                if (agentSessionId && !taskFailed && !shouldKeepSubagents()) {
                    await args.client.session
                        .delete({
                            path: { id: agentSessionId },
                        })
                        .catch((error: unknown) => {
                            log("[dreamer] failed to delete child session:", error);
                        });
                } else if (agentSessionId && (taskFailed || shouldKeepSubagents())) {
                    log(
                        `[dreamer] KEEPING child session ${agentSessionId} for task ${taskName} (${taskFailed ? "failed" : "keep_subagents"})`,
                    );
                }
            }

            if (lostLease) {
                recordLeaseLostTask(`task ${taskName}`);
                break;
            }

            if (circuitBreakerTripped) {
                break;
            }
        }

        if (lostLease) {
            log("[dreamer] lease lost: skipping all post-task phases");
            recordLeaseLostTask("post-task phases");
        } else if (circuitBreakerTripped) {
            log("[dreamer] circuit breaker: skipping post-task phases");
            result.tasks.push({
                name: "post-task-phases",
                durationMs: 0,
                result: "",
                error: "Skipped post-task phases after circuit breaker tripped; configure dreamer model/fallback_models in magic-context.jsonc.",
            });
        }
        // ── User memory review phase ──
        // Runs after regular dream tasks, reviews user memory candidates for promotion.
        if (
            !circuitBreakerTripped &&
            !lostLease &&
            args.experimentalUserMemories?.enabled &&
            Date.now() <= deadline
        ) {
            const umStart = Date.now();
            try {
                if (!verifyLeaseStillHeld("before user-memory review")) {
                    throw new Error(
                        lostLeaseReason ?? "Dream lease lost before user-memory review",
                    );
                }
                const reviewResult = await reviewUserMemories({
                    db: args.db,
                    client: args.client,
                    parentSessionId,
                    sessionDirectory: args.sessionDirectory,
                    holderId,
                    deadline,
                    promotionThreshold: args.experimentalUserMemories.promotionThreshold,
                    fallbackModels: args.fallbackModels,
                });
                if (!verifyLeaseStillHeld("after user-memory review")) {
                    throw new Error(lostLeaseReason ?? "Dream lease lost after user-memory review");
                }
                const umOutput = `promoted=${reviewResult.promoted} merged=${reviewResult.merged} dismissed=${reviewResult.dismissed} consumed=${reviewResult.candidatesConsumed}`;
                if (
                    reviewResult.promoted > 0 ||
                    reviewResult.merged > 0 ||
                    reviewResult.dismissed > 0
                ) {
                    log(`[dreamer] user-memories: ${umOutput}`);
                }
                result.tasks.push({
                    name: "user memories",
                    durationMs: Date.now() - umStart,
                    result: umOutput,
                });
            } catch (error) {
                const errorDescription = describeError(error);
                logWithStackHead(
                    `[dreamer] user-memory review failed: ${errorDescription.brief}`,
                    errorDescription.stackHead,
                );
                result.tasks.push({
                    name: "user memories",
                    durationMs: Date.now() - umStart,
                    result: "",
                    error: errorDescription.brief,
                });
            }
            if (lostLease) recordLeaseLostTask("user-memory review");
        }
        // ── Smart note evaluation phase ──
        // Runs after regular dream tasks, evaluates pending smart note conditions.
        // Not a user-configurable task — always runs when dreamer has pending smart notes.
        if (!circuitBreakerTripped && !lostLease && Date.now() <= deadline) {
            try {
                if (!verifyLeaseStillHeld("before smart-note evaluation")) {
                    throw new Error(
                        lostLeaseReason ?? "Dream lease lost before smart-note evaluation",
                    );
                }
                await evaluateSmartNotes({
                    db: args.db,
                    client: args.client,
                    projectIdentity: args.projectIdentity,
                    parentSessionId,
                    sessionDirectory: args.sessionDirectory,
                    holderId,
                    deadline,
                    result,
                    fallbackModels: args.fallbackModels,
                    onLeaseLost: markLeaseLost,
                    isLeaseLost: () => lostLease,
                });
                if (!verifyLeaseStillHeld("after smart-note evaluation")) {
                    throw new Error(
                        lostLeaseReason ?? "Dream lease lost after smart-note evaluation",
                    );
                }
            } catch (error) {
                const errorDescription = describeError(error);
                logWithStackHead(
                    `[dreamer] smart note evaluation failed: ${errorDescription.brief}`,
                    errorDescription.stackHead,
                );
            }
            if (lostLease) recordLeaseLostTask("smart-note evaluation");
        }
        if (
            !circuitBreakerTripped &&
            !lostLease &&
            args.experimentalPinKeyFiles?.enabled &&
            Date.now() <= deadline
        ) {
            const kfStart = Date.now();
            try {
                if (!verifyLeaseStillHeld("before key-file identification")) {
                    throw new Error(
                        lostLeaseReason ?? "Dream lease lost before key-file identification",
                    );
                }
                const openCodeDb = openOpenCodeDb();
                if (openCodeDb) {
                    try {
                        await runKeyFilesTask({
                            db: args.db,
                            openCodeDb,
                            client: args.client,
                            projectPath: args.sessionDirectory ?? args.projectIdentity,
                            holderId,
                            deadline,
                            parentSessionId,
                            config: args.experimentalPinKeyFiles,
                            fallbackModels: args.fallbackModels,
                        });
                    } finally {
                        closeQuietly(openCodeDb);
                    }
                }
                if (!verifyLeaseStillHeld("after key-file identification")) {
                    throw new Error(
                        lostLeaseReason ?? "Dream lease lost after key-file identification",
                    );
                }
                result.tasks.push({
                    name: "key files",
                    durationMs: Date.now() - kfStart,
                    result: "completed",
                });
            } catch (error) {
                const errorDescription = describeError(error);
                logWithStackHead(
                    `[key-files] identification phase failed: ${errorDescription.brief}`,
                    errorDescription.stackHead,
                );
                result.tasks.push({
                    name: "key files",
                    durationMs: Date.now() - kfStart,
                    result: "",
                    error: errorDescription.brief,
                });
            }
            if (lostLease) recordLeaseLostTask("key-file identification");
        }
    } finally {
        releaseLease(args.db, holderId);
        log(`[dreamer] lease released: ${holderId}`);
    }

    result.finishedAt = Date.now();
    const memoryCountsAfter = getMemoryCountsByStatus(args.db, args.projectIdentity);
    const merged = countNewIds(memoryCountsBefore.mergedIds, memoryCountsAfter.mergedIds);
    const memoryChanges = {
        written: countNewIds(memoryCountsBefore.ids, memoryCountsAfter.ids),
        deleted: countNewIds(memoryCountsAfter.ids, memoryCountsBefore.ids),
        // archivedIds already EXCLUDES merged/superseded rows — getMemoryCountsByStatus
        // routes a memory with superseded_by_memory_id into mergedIds and never into
        // archivedIds (the two sets are disjoint). So the archived delta is already
        // merge-free; subtracting `merged` again double-counted and under-reported
        // archived (often to zero).
        archived: countNewIds(memoryCountsBefore.archivedIds, memoryCountsAfter.archivedIds),
        merged,
    };
    const persistedMemoryChanges = Object.values(memoryChanges).some((value) => value > 0)
        ? memoryChanges
        : null;
    insertDreamRun(args.db, {
        projectPath: args.projectIdentity,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        holderId: result.holderId,
        tasks: result.tasks.map((task) => ({
            name: task.name,
            durationMs: task.durationMs,
            resultChars: typeof task.result === "string" ? task.result.length : 0,
            ...(task.error ? { error: task.error } : {}),
        })),
        tasksSucceeded: result.tasks.filter((task) => !task.error).length,
        tasksFailed: result.tasks.filter((task) => Boolean(task.error)).length,
        smartNotesSurfaced: result.smartNotesSurfaced,
        smartNotesPending: result.smartNotesPending,
        memoryChanges: persistedMemoryChanges,
    });
    // Only update dream timestamps when at least one task succeeded — failed runs
    // should not block re-scheduling for the project.
    //
    // Only count configured dream tasks (consolidate / verify / archive-stale /
    // improve / maintain-docs) for success. Post-task phases (smart-notes,
    // user memories, key files) run unconditionally after the main task loop
    // and must NOT mask failures of the configured tasks — otherwise a
    // successful key-file evaluation would suppress re-scheduling a project
    // whose consolidate/verify/archive tasks all failed.
    const POST_TASK_NAMES = new Set([
        "smart-notes",
        "user memories",
        "key files",
        "post-task-phases",
        "circuit-breaker",
    ]);
    const hasSuccessfulTask = result.tasks.some((t) => !t.error && !POST_TASK_NAMES.has(t.name));
    if (hasSuccessfulTask && !lostLease) {
        // Per-project only. Do NOT also write the legacy global "last_dream_at"
        // key — that write is what let one project's run suppress another's.
        setDreamState(args.db, `last_dream_at:${args.projectIdentity}`, String(result.finishedAt));
    }
    const totalDuration = ((result.finishedAt - startedAt) / 1000).toFixed(1);
    const succeeded = result.tasks.filter((t) => !t.error).length;
    const failed = result.tasks.filter((t) => t.error).length;
    log(
        `[dreamer] dream run finished in ${totalDuration}s: ${succeeded} succeeded, ${failed} failed`,
    );
    return result;
}

async function evaluateSmartNotes(args: {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    deadline: number;
    result: DreamRunResult;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    onLeaseLost?: (phase: string, error?: unknown) => void;
    isLeaseLost?: () => boolean;
}): Promise<void> {
    const pendingNotes = getPendingSmartNotes(args.db, args.projectIdentity);
    if (pendingNotes.length === 0) {
        log("[dreamer] smart notes: no pending notes to evaluate");
        return;
    }

    log(`[dreamer] smart notes: evaluating ${pendingNotes.length} pending note(s)`);

    // Build a single evaluation prompt for all pending notes.
    // The dreamer checks each condition and returns structured results.
    const noteDescriptions = pendingNotes
        .map((n) => `- Note #${n.id}: "${n.content}"\n  Condition: ${n.surfaceCondition}`)
        .join("\n");

    const evaluationPrompt = `You are evaluating smart note conditions for the magic-context system.

For each note below, determine whether its surface condition has been met.
You have access to tools like GitHub CLI (gh), web search, and the local codebase to verify conditions.

You DO NOT have access to:
- Any conversation between the user and the original agent that wrote the note
- The state of any active session, including whether messages have been sent
- The current task, mood, or intent of the human user

If a condition references conversation context the user is having ("When the user mentions X", "When they ask to do Y", "When we revisit Z", "When relevant to current discussion", etc.), it is UNEVALUATABLE — skip it (do not include in results) so the note stays pending. These are misuse cases that should never have been written as smart notes; leaving them pending is the correct outcome, the dreamer's archive-stale task will eventually retire them.

## Pending Smart Notes

${noteDescriptions}

## Instructions

1. Check each condition using the tools available to you.
2. Be conservative — only mark a condition as met when you have clear evidence.
3. Skip conditions that depend on session/conversation context you cannot observe — do not invent a "false" verdict for them, just omit them from your response.
4. Respond with a JSON array of results:

\`\`\`json
[
  { "id": <note_id>, "met": true/false, "reason": "brief explanation" }
]
\`\`\`

Only include notes whose conditions you could definitively evaluate against external signals. Skip notes where you cannot determine the status (they will be re-evaluated next run, or eventually archived as stale).`;

    const taskStartedAt = Date.now();
    let agentSessionId: string | null = null;
    // Retain the child session on failure so its prompt/output/error can be
    // inspected — mirrors the main-task cleanup rule. Optional phases used to
    // delete unconditionally, losing the evidence for exactly the runs worth
    // debugging.
    let phaseFailed = false;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed" | "aborted";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            subagent: "dreamer",
            task: "smart-notes",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };
    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId)) {
                log("[dreamer] smart notes: lease renewal failed — aborting");
                args.onLeaseLost?.("smart notes");
                abortController.abort();
            }
        } catch (error) {
            args.onLeaseLost?.("smart notes", error);
            abortController.abort();
        }
    }, 60_000);

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-smart-notes",
            },
            query: { directory: args.sessionDirectory ?? args.projectIdentity },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) {
            const error = new Error("Could not create smart note evaluation session.");
            recordInvocation({ status: "failed", error });
            throw error;
        }

        log(`[dreamer] smart notes: child session created ${agentSessionId}`);
        const childSessionId = agentSessionId;

        const remainingMs = Math.max(0, args.deadline - Date.now());
        const smartNoteRun = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: childSessionId },
                query: { directory: args.sessionDirectory ?? args.projectIdentity },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    // synthetic: true hides the dreamer evaluation prompt from the TUI
                    // subagent pane while still delivering it to the model. See issue #50.
                    parts: [{ type: "text", text: evaluationPrompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(remainingMs, 5 * 60 * 1000),
                signal: abortController.signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:smart-notes",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: childSessionId },
                        query: {
                            directory: args.sessionDirectory ?? args.projectIdentity,
                            limit: 50,
                        },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const output = extractLatestAssistantText(messages);
                    if (!output) throw new Error("Smart note evaluation returned no output.");

                    // Parse the JSON results from the LLM response — use greedy match to handle
                    // `]` chars inside JSON string values (e.g., reasons containing brackets).
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (!jsonMatch) {
                        throw new Error("Smart note evaluation returned no JSON array.");
                    }

                    try {
                        return JSON.parse(jsonMatch[0]) as Array<{
                            id: number;
                            met: boolean;
                            reason?: string;
                        }>;
                    } catch {
                        throw new Error("Smart note evaluation returned invalid JSON.");
                    }
                },
            },
        );

        recordInvocation({ status: "completed", messages: smartNoteRun.output });
        const evaluations = smartNoteRun.validated;
        let surfaced = 0;
        for (const evaluation of evaluations) {
            if (typeof evaluation.id !== "number") continue;
            const note = pendingNotes.find((n) => n.id === evaluation.id);
            if (!note) continue;

            if (evaluation.met) {
                markNoteReady(args.db, note.id, evaluation.reason);
                surfaced++;
                log(
                    `[dreamer] smart notes: #${note.id} condition MET — "${evaluation.reason ?? "condition satisfied"}"`,
                );
            } else {
                markNoteChecked(args.db, note.id);
            }
        }

        // Mark any notes not in the evaluation as checked (LLM skipped them)
        for (const note of pendingNotes) {
            if (!evaluations.some((e) => e.id === note.id)) {
                markNoteChecked(args.db, note.id);
            }
        }

        const durationMs = Date.now() - taskStartedAt;
        const pending = Math.max(0, pendingNotes.length - surfaced);
        args.result.smartNotesSurfaced = surfaced;
        args.result.smartNotesPending = pending;
        log(
            `[dreamer] smart notes: evaluated ${pendingNotes.length} notes in ${(durationMs / 1000).toFixed(1)}s — ${surfaced} surfaced, ${pending} still pending`,
        );
        args.result.tasks.push({
            name: "smart-notes",
            durationMs,
            result: `${surfaced} surfaced, ${pending} still pending`,
        });
    } catch (error) {
        phaseFailed = true;
        if (
            error instanceof Error &&
            error.message === "Smart note evaluation returned no JSON array."
        ) {
            log("[dreamer] smart notes: no JSON array found in output, skipping");
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
        } else if (
            error instanceof Error &&
            error.message === "Smart note evaluation returned invalid JSON."
        ) {
            log(`[dreamer] smart notes: failed to parse JSON from LLM output, marking all checked`);
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
        }
        const durationMs = Date.now() - taskStartedAt;
        const errorDescription = describeError(error);
        args.result.smartNotesSurfaced = 0;
        args.result.smartNotesPending = pendingNotes.length;
        logWithStackHead(
            `[dreamer] smart notes: failed after ${(durationMs / 1000).toFixed(1)}s — ${errorDescription.brief}`,
            errorDescription.stackHead,
        );
        args.result.tasks.push({
            name: "smart-notes",
            durationMs,
            result: null,
            error: errorDescription.brief,
        });
    } finally {
        clearInterval(leaseInterval);
        // Keep the child session on failure (debugging) or under keep_subagents.
        if (agentSessionId && !phaseFailed && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                })
                .catch(() => {});
        }
    }
}

const MAX_LEASE_RETRIES = 3;

export async function processDreamQueue(args: {
    db: Database;
    client: PluginContext["client"];
    tasks: DreamingTask[];
    taskTimeoutMinutes: number;
    maxRuntimeMinutes: number;
    experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
    experimentalPinKeyFiles?: ExperimentalPinKeyFilesConfig;
    /**
     * Optional project identity filter — when provided, only entries belonging
     * to this project are dequeued. Each running OpenCode/Pi process registers
     * exactly one project, and the host's dreamer client (and `pi` runner, in
     * Pi's case) is project-specific. Without this filter, a Pi process running
     * for project A would dequeue queue entries for project B and try to
     * `posix_spawn 'pi'` in B's `git:<sha>` identity string as a directory,
     * failing with ENOENT every cycle.
     *
     * Callers should pass this whenever they own a single project — both the
     * scheduled timer tick (`sweepProject`) and the `/ctx-dream` command
     * handler. Tests pass `undefined` to keep the legacy "dequeue any" semantics.
     */
    projectIdentity?: string;
    /**
     * Filesystem directory of the project THIS draining process owns. Because
     * project identity collapses worktrees/clones to one `git:<sha>`, resolving
     * the execution directory from the shared in-memory map can pick a stale
     * sibling checkout ("last-registered wins"). The drain caller always knows
     * its own live directory, so passing it here guarantees the dream runs in a
     * checkout this process actually registered. Paired with projectIdentity
     * (the queue filter), so the dequeued entry is guaranteed to be this
     * project's. Falls back to the map (then the identity string) when omitted.
     */
    sessionDirectoryOverride?: string;
    /**
     * Resolved Dreamer fallback chain. See `runDream` for semantics. Callers
     * compute via `resolveFallbackChain(DREAMER_AGENT, pluginConfig.dreamer?.fallback_models)`.
     */
    fallbackModels?: readonly string[];
}): Promise<DreamRunResult | null> {
    // Use configured max runtime + 30min buffer for stale threshold instead of hardcoded 2h.
    // Only reap when no live lease exists — a healthy long-running dream renews its lease and
    // would otherwise have its own queue row deleted mid-run. Scope to this project so the
    // cross-process shared queue doesn't reap another host's still-running rows.
    const maxRuntimeMs = args.maxRuntimeMinutes * 60 * 1000;
    // A live lease means another dream (this project or a sibling on the shared
    // queue) is actively running. Don't dequeue underneath it: runDream would just
    // fail lease acquisition, increment this entry's retry count, and after
    // MAX_LEASE_RETRIES DELETE the queue row — silently dropping a project's
    // pending dream that never got a fair chance to run. Skip this tick; the entry
    // stays queued for when the lease frees.
    if (hasActiveDreamLease(args.db)) {
        return null;
    }
    clearStaleEntries(args.db, maxRuntimeMs + 30 * 60 * 1000, args.projectIdentity);
    const entry = dequeueNext(args.db, args.projectIdentity);
    if (!entry) {
        return null;
    }

    // Prefer the draining caller's own directory (the project THIS process
    // owns). The dequeue filter (projectIdentity) guarantees entry belongs to
    // this project, so the override is the correct live checkout — not a stale
    // sibling-worktree path the shared identity map might resolve to.
    const projectDirectory =
        args.sessionDirectoryOverride ?? resolveDreamSessionDirectory(entry.projectIdentity);
    // Log the project identity only — never the resolved directory. The
    // absolute path carries the username + project name (privacy), and the
    // git:<sha>/dir:<hash> identity uniquely correlates the run for debugging.
    log(`[dreamer] dequeued project ${entry.projectIdentity}, starting dream run`);

    let result: DreamRunResult;
    try {
        result = await runDream({
            db: args.db,
            client: args.client,
            // entry.projectIdentity is the project identity (e.g. "git:<sha>") — used for dream state keys.
            // projectDirectory is the filesystem path — used for session creation and file access.
            projectIdentity: entry.projectIdentity,
            tasks: args.tasks,
            taskTimeoutMinutes: args.taskTimeoutMinutes,
            maxRuntimeMinutes: args.maxRuntimeMinutes,
            sessionDirectory: projectDirectory,
            experimentalUserMemories: args.experimentalUserMemories,
            experimentalPinKeyFiles: args.experimentalPinKeyFiles,
            fallbackModels: args.fallbackModels,
        });
    } catch (error) {
        log(`[dreamer] runDream threw for ${entry.projectIdentity}: ${getErrorMessage(error)}`);
        // Remove the entry so it doesn't stay stuck in "started" state for 2 hours
        removeDreamEntry(args.db, entry.id);
        return null;
    }

    // Only remove queue entry if the dream actually ran (lease acquired).
    // If lease acquisition failed, the entry stays so it can be retried (up to MAX_LEASE_RETRIES).
    const leaseError = result.tasks.find((t) => t.name === "lease" && t.error);
    if (leaseError) {
        const retryCount = getEntryRetryCount(args.db, entry.id);
        if (retryCount >= MAX_LEASE_RETRIES) {
            log(
                `[dreamer] lease acquisition failed ${retryCount + 1} times for ${entry.projectIdentity} — removing queue entry`,
            );
            removeDreamEntry(args.db, entry.id);
        } else {
            log(
                `[dreamer] lease acquisition failed for ${entry.projectIdentity} (attempt ${retryCount + 1}/${MAX_LEASE_RETRIES}) — keeping for retry`,
            );
            resetDreamEntry(args.db, entry.id);
        }
    } else {
        removeDreamEntry(args.db, entry.id);
    }

    return result;
}
