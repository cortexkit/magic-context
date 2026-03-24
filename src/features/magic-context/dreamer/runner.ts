import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { extractLatestAssistantText } from "../../../tools/look-at/assistant-message-extractor";
import { acquireLease, getLeaseHolder, releaseLease, renewLease } from "./lease";
import { clearStaleEntries, dequeueNext, removeDreamEntry } from "./queue";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { buildDreamTaskPrompt, DREAMER_SYSTEM_PROMPT } from "./task-prompts";

const dreamProjectDirectories = new Map<string, string>();

export function registerDreamProjectDirectory(projectPath: string, directory: string): void {
    dreamProjectDirectories.set(projectPath, directory);
}

function resolveDreamSessionDirectory(projectPath: string): string {
    return dreamProjectDirectories.get(projectPath) ?? projectPath;
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
    projectPath: string;
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
        `[dreamer] starting dream run: ${args.tasks.length} tasks, timeout=${args.taskTimeoutMinutes}m, maxRuntime=${args.maxRuntimeMinutes}m, project=${args.projectPath}`,
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

    const deadline = startedAt + args.maxRuntimeMinutes * 60 * 1000;
    const lastDreamAt = getDreamState(args.db, "last_dream_at");
    log(`[dreamer] last dream at: ${lastDreamAt ?? "never"}`);

    try {
        for (const taskName of args.tasks) {
            if (Date.now() > deadline) {
                log(`[dreamer] deadline reached, stopping after ${result.tasks.length} tasks`);
                break;
            }

            log(`[dreamer] starting task: ${taskName}`);
            const taskStartedAt = Date.now();
            let agentSessionId: string | null = null;
            // Renew lease periodically while the LLM task runs (can take 5+ min on slow models)
            const leaseRenewalInterval = setInterval(() => {
                if (!renewLease(args.db, holderId)) {
                    log(`[dreamer] task ${taskName}: background lease renewal failed`);
                }
            }, 60_000);

            try {
                const existingDocs =
                    taskName === "maintain-docs"
                        ? {
                              architecture: existsSync(join(args.projectPath, "ARCHITECTURE.md")),
                              structure: existsSync(join(args.projectPath, "STRUCTURE.md")),
                          }
                        : undefined;

                const taskPrompt = buildDreamTaskPrompt(taskName, {
                    projectPath: args.projectPath,
                    lastDreamAt,
                    existingDocs,
                });

                const createResponse = await args.client.session.create({
                    body: {
                        ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                        title: `magic-context-dream-${taskName}`,
                    },
                    query: { directory: args.sessionDirectory ?? args.projectPath },
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
                        query: { directory: args.sessionDirectory ?? args.projectPath },
                        body: {
                            agent: DREAMER_AGENT,
                            system: DREAMER_SYSTEM_PROMPT,
                            parts: [{ type: "text", text: taskPrompt }],
                        },
                    },
                    { timeoutMs: args.taskTimeoutMinutes * 60 * 1000 },
                );

                const messagesResponse = await args.client.session.messages({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory ?? args.projectPath },
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
                            query: { directory: args.sessionDirectory ?? args.projectPath },
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
    setDreamState(args.db, "last_dream_at", String(result.finishedAt));
    const totalDuration = ((result.finishedAt - startedAt) / 1000).toFixed(1);
    const succeeded = result.tasks.filter((t) => !t.error).length;
    const failed = result.tasks.filter((t) => t.error).length;
    log(
        `[dreamer] dream run finished in ${totalDuration}s: ${succeeded} succeeded, ${failed} failed`,
    );
    return result;
}

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

    const projectDirectory = resolveDreamSessionDirectory(entry.projectPath);
    log(
        `[dreamer] dequeued project ${entry.projectPath} (dir=${projectDirectory}), starting dream run`,
    );

    try {
        return await runDream({
            db: args.db,
            client: args.client,
            projectPath: projectDirectory,
            tasks: args.tasks,
            taskTimeoutMinutes: args.taskTimeoutMinutes,
            maxRuntimeMinutes: args.maxRuntimeMinutes,
            sessionDirectory: projectDirectory,
        });
    } finally {
        removeDreamEntry(args.db, entry.id);
    }
}
