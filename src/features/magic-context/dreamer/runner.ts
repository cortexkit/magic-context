import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import {
    clearStaleEntries,
    dequeueNext,
    getEntryRetryCount,
    removeDreamEntry,
    resetDreamEntry,
} from "./queue";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";

// Intentional: keyed by project identity (e.g. "git:<sha>"), not filesystem path.
// Multiple checkouts of the same repo overwrite each other; the last-active checkout wins.
// Acceptable for v1 since multi-checkout dreaming is an edge case.
const dreamProjectDirectories = new Map<string, string>();

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
    tasks: {
        name: string;
        durationMs: number;
        result: unknown;
        error?: string;
    }[];
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
}): Promise<DreamRunResult> {
    const holderId = crypto.randomUUID();
    const startedAt = Date.now();
    const result: DreamRunResult = {
        startedAt,
        finishedAt: startedAt,
        holderId,
        tasks: [],
    };

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

                const taskPrompt = buildDreamTaskPrompt(taskName, {
                    projectPath: args.projectIdentity,
                    lastDreamAt,
                    existingDocs,
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
    } finally {
        releaseLease(args.db, holderId);
        log(`[dreamer] lease released: ${holderId}`);
    }

    result.finishedAt = Date.now();
    // Only update dream timestamps when at least one task succeeded — failed runs
    // should not block re-scheduling for the project.
    const hasSuccessfulTask = result.tasks.some((t) => !t.error);
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

const MAX_LEASE_RETRIES = 3;

export async function processDreamQueue(args: {
    db: Database;
    client: PluginContext["client"];
    tasks: DreamingTask[];
    taskTimeoutMinutes: number;
    maxRuntimeMinutes: number;
}): Promise<DreamRunResult | null> {
    clearStaleEntries(args.db, 2 * 60 * 60 * 1000);

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
