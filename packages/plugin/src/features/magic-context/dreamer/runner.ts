import { existsSync } from "node:fs";
import { join } from "node:path";
import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { getDataDir } from "../../../shared/data-path";
import { describeError, getErrorMessage } from "../../../shared/error-message";
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
    runKeyFilesTask,
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
const CIRCUIT_BREAKER_THRESHOLD = 3;

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
    /** Resolved fallback chain (user config or builtin); see resolveFallbackChain. */
    fallbackModels?: readonly string[];
    onLeaseLost?: (phase: string, error?: unknown) => void;
    isLeaseLost?: () => boolean;
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
                    args.onLeaseLost?.(`key-files:${args.sessionId}`);
                    abortController.abort();
                }
            } catch (error) {
                args.onLeaseLost?.(`key-files:${args.sessionId}`, error);
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
                        // synthetic: true hides the dreamer prompt from the TUI subagent
                        // pane while still delivering it to the model. See issue #50.
                        parts: [{ type: "text", text: prompt, synthetic: true }],
                    },
                },
                {
                    timeoutMs: Math.min(remainingMs, 5 * 60 * 1000),
                    signal: abortController.signal,
                    fallbackModels: args.fallbackModels,
                    callContext: `dreamer:key-files:${args.sessionId.slice(0, 12)}`,
                },
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
            if (args.isLeaseLost?.() || abortController.signal.aborted) {
                log(
                    `[key-files][${args.sessionId}] lease lost during identification — skipping heuristic fallback`,
                );
                throw error;
            }
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

async function _identifyKeyFiles(args: {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    deadline: number;
    config: ExperimentalPinKeyFilesConfig;
    /** Resolved dreamer fallback chain. */
    fallbackModels?: readonly string[];
    onLeaseLost?: (phase: string, error?: unknown) => void;
    isLeaseLost?: () => boolean;
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
        if (args.isLeaseLost?.()) {
            log("[key-files] lease lost — stopping key-file identification");
            break;
        }
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
            fallbackModels: args.fallbackModels,
            onLeaseLost: args.onLeaseLost,
            isLeaseLost: args.isLeaseLost,
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
    const lastDreamAt =
        getDreamState(args.db, `last_dream_at:${args.projectIdentity}`) ??
        getDreamState(args.db, "last_dream_at");
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
                    },
                );
                if (lostLease) {
                    throw new Error(lostLeaseReason ?? `Dream lease lost during ${taskName}`);
                }

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
                lastErrorSignature = null;
                consecutiveSameErrorFailures = 0;
            } catch (error) {
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
                if (agentSessionId) {
                    await args.client.session
                        .delete({
                            path: { id: agentSessionId },
                        })
                        .catch((error: unknown) => {
                            log("[dreamer] failed to delete child session:", error);
                        });
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
    const POST_TASK_NAMES = new Set([
        "smart-notes",
        "user memories",
        "key files",
        "post-task-phases",
        "circuit-breaker",
    ]);
    const hasSuccessfulTask = result.tasks.some((t) => !t.error && !POST_TASK_NAMES.has(t.name));
    if (hasSuccessfulTask && !lostLease) {
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
            },
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
        if (agentSessionId) {
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
     * Resolved Dreamer fallback chain. See `runDream` for semantics. Callers
     * compute via `resolveFallbackChain(DREAMER_AGENT, pluginConfig.dreamer?.fallback_models)`.
     */
    fallbackModels?: readonly string[];
}): Promise<DreamRunResult | null> {
    // Use configured max runtime + 30min buffer for stale threshold instead of hardcoded 2h
    const maxRuntimeMs = args.maxRuntimeMinutes * 60 * 1000;
    clearStaleEntries(args.db, maxRuntimeMs + 30 * 60 * 1000);
    const entry = dequeueNext(args.db, args.projectIdentity);
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
