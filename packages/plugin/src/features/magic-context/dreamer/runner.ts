import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { getDataDir } from "../../../shared/data-path";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    applyKeyFileResults,
    buildKeyFilesPrompt,
    getKeyFileCandidates,
    heuristicKeyFileSelection,
    KEY_FILES_SYSTEM_PROMPT,
    parseKeyFilesOutput,
} from "../key-files/identify-key-files";
import { getMemoryCountsByStatus } from "../memory/storage-memory";
import { getPendingSmartNotes, markNoteChecked, markNoteReady } from "../storage-notes";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import {
    clearStaleEntries,
    dequeueNext,
    getEntryRetryCount,
    removeDreamEntry,
    resetDreamEntry,
} from "./queue";
import { insertDreamRun } from "./storage-dream-runs";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";

// Intentional: keyed by project identity (e.g. "git:<sha>"), not filesystem path.
// Multiple checkouts of the same repo overwrite each other; the last-active checkout wins.
// Acceptable for v1 since multi-checkout dreaming is an edge case.
const dreamProjectDirectories = new Map<string, string>();

interface SessionListEntry {
    id?: string;
}

interface SessionIdRow {
    sessionId: string;
}

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

function isSessionIdRow(row: unknown): row is SessionIdRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    return typeof (row as SessionIdRow).sessionId === "string";
}

function hasExplicitEmptyKeyFilesOutput(text: string): boolean {
    return /```(?:json)?\s*\[\s*\]\s*```/s.test(text) || /^\s*\[\s*\]\s*$/s.test(text);
}

async function getActiveProjectSessionIds(args: {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    sessionDirectory: string | undefined;
}): Promise<string[]> {
    // Query OpenCode's DB directly for sessions matching this project identity.
    // The SDK's session.list endpoint filters by directory/workspace which can miss sessions
    // in different workspace contexts. Direct DB access finds ALL project sessions reliably.
    try {
        const { withReadOnlySessionDb } = await import(
            "../../../hooks/magic-context/read-session-db"
        );
        const projectSessionIds = withReadOnlySessionDb((openCodeDb) => {
            // Magic-context stores project identity as "git:<hash>" but OpenCode's
            // session table stores just the bare hash in project_id. Strip the prefix.
            const bareIdentity = args.projectIdentity.replace(/^git:/, "");
            const rows = openCodeDb
                .prepare(
                    "SELECT id FROM session WHERE project_id = ? AND parent_id IS NULL ORDER BY time_updated DESC",
                )
                .all(bareIdentity) as Array<{ id: string }>;
            return new Set(rows.map((r) => r.id));
        });

        if (projectSessionIds.size === 0) {
            return [];
        }

        // Intersect with our session_meta to filter to non-subagent sessions we know about
        return args.db
            .prepare(
                "SELECT session_id AS sessionId FROM session_meta WHERE is_subagent = 0 ORDER BY session_id ASC",
            )
            .all()
            .filter(isSessionIdRow)
            .map((row) => row.sessionId)
            .filter((sessionId) => projectSessionIds.has(sessionId));
    } catch (error) {
        // Fallback to SDK list if OpenCode DB is unavailable
        shared.sessionLog(
            args.projectIdentity,
            `key-files: OpenCode DB lookup failed, falling back to SDK list: ${getErrorMessage(error)}`,
        );
        const listResponse = await args.client.session.list({
            query: { directory: args.sessionDirectory ?? args.projectIdentity },
        });
        const sessions = shared.normalizeSDKResponse(listResponse, [] as SessionListEntry[], {
            preferResponseOnMissingData: true,
        });
        const projectSessionIds = new Set(
            sessions
                .map((session) => (typeof session?.id === "string" ? session.id : null))
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );

        if (projectSessionIds.size === 0) {
            return [];
        }

        return args.db
            .prepare(
                "SELECT session_id AS sessionId FROM session_meta WHERE is_subagent = 0 ORDER BY session_id ASC",
            )
            .all()
            .filter(isSessionIdRow)
            .map((row) => row.sessionId)
            .filter((sessionId) => projectSessionIds.has(sessionId));
    }
}

async function identifyKeyFilesForSession(args: {
    db: Database;
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    deadline: number;
    sessionId: string;
    config: ExperimentalPinKeyFilesConfig;
}): Promise<void> {
    let openCodeDb: Database | null = null;

    try {
        openCodeDb = openOpenCodeDb();
        if (!openCodeDb) {
            return;
        }

        const candidates = getKeyFileCandidates(
            openCodeDb,
            args.sessionId,
            args.config.min_reads,
            args.config.token_budget,
            args.sessionDirectory,
        );
        if (candidates.length === 0) {
            log(`[key-files][${args.sessionId}] no candidates found — skipping`);
            return;
        }

        const prompt = buildKeyFilesPrompt(
            candidates,
            args.config.token_budget,
            args.config.min_reads,
        );
        const applyHeuristicFallback = (): void => {
            heuristicKeyFileSelection(
                args.db,
                args.sessionId,
                candidates,
                args.config.token_budget,
            );
        };

        let agentSessionId: string | null = null;
        const abortController = new AbortController();
        const leaseInterval = setInterval(() => {
            try {
                if (!renewLease(args.db, args.holderId)) {
                    log(`[key-files][${args.sessionId}] lease renewal failed — aborting`);
                    abortController.abort();
                }
            } catch {
                abortController.abort();
            }
        }, 60_000);

        try {
            const createResponse = await args.client.session.create({
                body: {
                    ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                    title: `magic-context-dream-key-files-${args.sessionId.slice(0, 12)}`,
                },
                query: { directory: args.sessionDirectory },
            });
            const created = shared.normalizeSDKResponse(
                createResponse,
                null as { id?: string } | null,
                { preferResponseOnMissingData: true },
            );
            agentSessionId = typeof created?.id === "string" ? created.id : null;
            if (!agentSessionId) {
                throw new Error("Could not create key-file identification session.");
            }

            log(`[key-files][${args.sessionId}] child session created ${agentSessionId}`);

            const remainingMs = Math.max(0, args.deadline - Date.now());
            await shared.promptSyncWithModelSuggestionRetry(
                args.client,
                {
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                    body: {
                        agent: DREAMER_AGENT,
                        system: KEY_FILES_SYSTEM_PROMPT,
                        parts: [{ type: "text", text: prompt }],
                    },
                },
                { timeoutMs: Math.min(remainingMs, 5 * 60 * 1000), signal: abortController.signal },
            );

            const messagesResponse = await args.client.session.messages({
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
            });
            const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                preferResponseOnMissingData: true,
            });
            const responseText = extractLatestAssistantText(messages);
            if (!responseText) {
                log(
                    `[key-files][${args.sessionId}] no response from agent — using heuristic fallback`,
                );
                applyHeuristicFallback();
                return;
            }

            const parsed = parseKeyFilesOutput(responseText);
            if (parsed.length > 0 || hasExplicitEmptyKeyFilesOutput(responseText)) {
                const candidatePaths = new Set(candidates.map((c) => c.filePath));
                applyKeyFileResults(
                    args.db,
                    args.sessionId,
                    parsed,
                    args.config.token_budget,
                    candidatePaths,
                );
                return;
            }

            log(
                `[key-files][${args.sessionId}] could not parse agent output — using heuristic fallback`,
            );
            applyHeuristicFallback();
        } catch (error) {
            log(
                `[key-files][${args.sessionId}] identification failed: ${getErrorMessage(error)} — using heuristic fallback`,
            );
            try {
                applyHeuristicFallback();
            } catch (fallbackError) {
                log(
                    `[key-files][${args.sessionId}] heuristic fallback failed: ${getErrorMessage(fallbackError)}`,
                );
            }
        } finally {
            clearInterval(leaseInterval);
            if (agentSessionId) {
                await args.client.session
                    .delete({
                        path: { id: agentSessionId },
                        query: { directory: args.sessionDirectory },
                    })
                    .catch((error: unknown) => {
                        log(
                            `[key-files][${args.sessionId}] session cleanup failed: ${getErrorMessage(error)}`,
                        );
                    });
            }
        }
    } finally {
        if (openCodeDb) {
            try {
                closeQuietly(openCodeDb);
            } catch (error) {
                log(
                    `[key-files][${args.sessionId}] failed to close OpenCode DB: ${getErrorMessage(error)}`,
                );
            }
        }
    }
}

async function identifyKeyFiles(args: {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    deadline: number;
    config: ExperimentalPinKeyFilesConfig;
}): Promise<void> {
    const sessionIds = await getActiveProjectSessionIds({
        db: args.db,
        client: args.client,
        projectIdentity: args.projectIdentity,
        sessionDirectory: args.sessionDirectory,
    });
    if (sessionIds.length === 0) {
        log(`[key-files] no active sessions found for ${args.projectIdentity}`);
        return;
    }

    log(
        `[key-files] evaluating ${sessionIds.length} active session(s) for ${args.projectIdentity}`,
    );

    for (const sessionId of sessionIds) {
        if (Date.now() > args.deadline) {
            log("[key-files] deadline reached — stopping key-file identification");
            break;
        }

        await identifyKeyFilesForSession({
            db: args.db,
            client: args.client,
            parentSessionId: args.parentSessionId,
            sessionDirectory: args.sessionDirectory,
            holderId: args.holderId,
            deadline: args.deadline,
            sessionId,
            config: args.config,
        });
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
    const lastDreamAt =
        getDreamState(args.db, `last_dream_at:${args.projectIdentity}`) ??
        getDreamState(args.db, "last_dream_at");
    log(`[dreamer] last dream at: ${lastDreamAt ?? "never"} (project=${args.projectIdentity})`);

    try {
        for (const taskName of args.tasks) {
            if (Date.now() > deadline) {
                log(`[dreamer] deadline reached, stopping after ${result.tasks.length} tasks`);
                break;
            }

            log(`[dreamer] starting task: ${taskName}`);
            const taskStartedAt = Date.now();
            let agentSessionId: string | null = null;
            // AbortController lets us cancel the in-flight LLM prompt immediately when lease is lost
            const taskAbortController = new AbortController();
            // Renew lease periodically while the LLM task runs (can take 5+ min on slow models)
            const leaseRenewalInterval = setInterval(() => {
                try {
                    if (!renewLease(args.db, holderId)) {
                        log(`[dreamer] task ${taskName}: lease renewal failed — aborting LLM call`);
                        taskAbortController.abort();
                    }
                } catch (err) {
                    log(
                        `[dreamer] task ${taskName}: lease renewal threw — aborting LLM call: ${err}`,
                    );
                    taskAbortController.abort();
                }
            }, 60_000);

            try {
                // Use sessionDirectory (filesystem path) for file checks, not projectPath (identity like "git:<sha>")
                const docsDir = args.sessionDirectory ?? args.projectIdentity;
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
                    throw new Error("Dreamer could not create its child session.");
                }
                log(`[dreamer] task ${taskName}: child session created ${agentSessionId}`);

                await shared.promptSyncWithModelSuggestionRetry(
                    args.client,
                    {
                        path: { id: agentSessionId },
                        query: { directory: args.sessionDirectory ?? args.projectIdentity },
                        body: {
                            agent: DREAMER_AGENT,
                            system: DREAMER_SYSTEM_PROMPT,
                            parts: [{ type: "text", text: taskPrompt }],
                        },
                    },
                    {
                        timeoutMs: args.taskTimeoutMinutes * 60 * 1000,
                        signal: taskAbortController.signal,
                    },
                );

                const messagesResponse = await args.client.session.messages({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory ?? args.projectIdentity },
                });
                const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                    preferResponseOnMissingData: true,
                });
                const taskResult = extractLatestAssistantText(messages);
                if (!taskResult) {
                    throw new Error("Dreamer returned no assistant output.");
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
            } catch (error) {
                const durationMs = Date.now() - taskStartedAt;
                const errorMsg = getErrorMessage(error);
                log(
                    `[dreamer] task ${taskName}: failed after ${(durationMs / 1000).toFixed(1)}s — ${errorMsg}`,
                );
                result.tasks.push({
                    name: taskName,
                    durationMs,
                    result: null,
                    error: errorMsg,
                });
            } finally {
                clearInterval(leaseRenewalInterval);
                if (agentSessionId) {
                    await args.client.session
                        .delete({
                            path: { id: agentSessionId },
                            query: { directory: args.sessionDirectory ?? args.projectIdentity },
                        })
                        .catch((error: unknown) => {
                            log("[dreamer] failed to delete child session:", error);
                        });
                }
            }
        }
        // ── User memory review phase ──
        // Runs after regular dream tasks, reviews user memory candidates for promotion.
        if (args.experimentalUserMemories?.enabled && Date.now() <= deadline) {
            const umStart = Date.now();
            try {
                const reviewResult = await reviewUserMemories({
                    db: args.db,
                    client: args.client,
                    parentSessionId,
                    sessionDirectory: args.sessionDirectory,
                    holderId,
                    deadline,
                    promotionThreshold: args.experimentalUserMemories.promotionThreshold,
                });
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
                log(`[dreamer] user-memory review failed: ${getErrorMessage(error)}`);
                result.tasks.push({
                    name: "user memories",
                    durationMs: Date.now() - umStart,
                    result: "",
                    error: getErrorMessage(error),
                });
            }
        }
        // ── Smart note evaluation phase ──
        // Runs after regular dream tasks, evaluates pending smart note conditions.
        // Not a user-configurable task — always runs when dreamer has pending smart notes.
        if (Date.now() <= deadline) {
            try {
                await evaluateSmartNotes({
                    db: args.db,
                    client: args.client,
                    projectIdentity: args.projectIdentity,
                    parentSessionId,
                    sessionDirectory: args.sessionDirectory,
                    holderId,
                    deadline,
                    result,
                });
            } catch (error) {
                log(`[dreamer] smart note evaluation failed: ${getErrorMessage(error)}`);
            }
        }
        if (args.experimentalPinKeyFiles?.enabled && Date.now() <= deadline) {
            const kfStart = Date.now();
            try {
                await identifyKeyFiles({
                    db: args.db,
                    client: args.client,
                    projectIdentity: args.projectIdentity,
                    parentSessionId,
                    sessionDirectory: args.sessionDirectory ?? args.projectIdentity,
                    holderId,
                    deadline,
                    config: args.experimentalPinKeyFiles,
                });
                result.tasks.push({
                    name: "key files",
                    durationMs: Date.now() - kfStart,
                    result: "completed",
                });
            } catch (error) {
                log(`[key-files] identification phase failed: ${getErrorMessage(error)}`);
                result.tasks.push({
                    name: "key files",
                    durationMs: Date.now() - kfStart,
                    result: "",
                    error: getErrorMessage(error),
                });
            }
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
        archived: Math.max(
            0,
            countNewIds(memoryCountsBefore.archivedIds, memoryCountsAfter.archivedIds) - merged,
        ),
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
    const POST_TASK_NAMES = new Set(["smart-notes", "user memories", "key files"]);
    const hasSuccessfulTask = result.tasks.some((t) => !t.error && !POST_TASK_NAMES.has(t.name));
    if (hasSuccessfulTask) {
        setDreamState(args.db, `last_dream_at:${args.projectIdentity}`, String(result.finishedAt));
        setDreamState(args.db, "last_dream_at", String(result.finishedAt));
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

## Pending Smart Notes

${noteDescriptions}

## Instructions

1. Check each condition using the tools available to you.
2. Be conservative — only mark a condition as met when you have clear evidence.
3. Respond with a JSON array of results:

\`\`\`json
[
  { "id": <note_id>, "met": true/false, "reason": "brief explanation" }
]
\`\`\`

Only include notes whose conditions you could definitively evaluate. Skip notes where you cannot determine the status (they will be re-evaluated next run).`;

    const taskStartedAt = Date.now();
    let agentSessionId: string | null = null;
    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId)) {
                log("[dreamer] smart notes: lease renewal failed — aborting");
                abortController.abort();
            }
        } catch {
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
        if (!agentSessionId) throw new Error("Could not create smart note evaluation session.");

        log(`[dreamer] smart notes: child session created ${agentSessionId}`);

        const remainingMs = Math.max(0, args.deadline - Date.now());
        await shared.promptSyncWithModelSuggestionRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory ?? args.projectIdentity },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    parts: [{ type: "text", text: evaluationPrompt }],
                },
            },
            { timeoutMs: Math.min(remainingMs, 5 * 60 * 1000), signal: abortController.signal },
        );

        const messagesResponse = await args.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: args.sessionDirectory ?? args.projectIdentity },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const output = extractLatestAssistantText(messages);
        if (!output) throw new Error("Smart note evaluation returned no output.");

        // Parse the JSON results from the LLM response — use greedy match to handle
        // `]` chars inside JSON string values (e.g., reasons containing brackets).
        const jsonMatch = output.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            log("[dreamer] smart notes: no JSON array found in output, skipping");
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
            throw new Error("Smart note evaluation returned no JSON array.");
        }

        let evaluations: Array<{ id: number; met: boolean; reason?: string }>;
        try {
            evaluations = JSON.parse(jsonMatch[0]);
        } catch {
            log(`[dreamer] smart notes: failed to parse JSON from LLM output, marking all checked`);
            for (const note of pendingNotes) markNoteChecked(args.db, note.id);
            throw new Error("Smart note evaluation returned invalid JSON.");
        }
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
        const durationMs = Date.now() - taskStartedAt;
        const errorMsg = getErrorMessage(error);
        args.result.smartNotesSurfaced = 0;
        args.result.smartNotesPending = pendingNotes.length;
        log(`[dreamer] smart notes: failed after ${(durationMs / 1000).toFixed(1)}s — ${errorMsg}`);
        args.result.tasks.push({
            name: "smart-notes",
            durationMs,
            result: null,
            error: errorMsg,
        });
    } finally {
        clearInterval(leaseInterval);
        if (agentSessionId) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory ?? args.projectIdentity },
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
}): Promise<DreamRunResult | null> {
    // Use configured max runtime + 30min buffer for stale threshold instead of hardcoded 2h
    const maxRuntimeMs = args.maxRuntimeMinutes * 60 * 1000;
    clearStaleEntries(args.db, maxRuntimeMs + 30 * 60 * 1000);
    const entry = dequeueNext(args.db);
    if (!entry) {
        return null;
    }

    const projectDirectory = resolveDreamSessionDirectory(entry.projectIdentity);
    log(
        `[dreamer] dequeued project ${entry.projectIdentity} (dir=${projectDirectory}), starting dream run`,
    );

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
