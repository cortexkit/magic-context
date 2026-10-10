import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
    DREAMER_AGENT,
    DREAMER_DOCS_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
} from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import {
    DREAM_TASK_PROMOTION_DEFAULTS,
    type DreamingTask,
} from "../../../config/schema/magic-context";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import {
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
} from "../../../hooks/magic-context/compartment-runner-types";
import type { RawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import {
    projectNeedsSingleStoreMigration,
    renderSingleStoreMigrationRequiredRefusal,
} from "../../../hooks/magic-context/single-store-refusal";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../../shared/child-session-teardown";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { getSdkContextLimit } from "../../../shared/models-dev-cache";
import { isRecord } from "../../../shared/record-type-guard";
import { sanitizeDiagnosticText } from "../../../shared/redaction";
import {
    modelBodyField,
    parseProviderModel,
    toModelEntry,
} from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { dreamFailureCode, userFacingFailureCode } from "../../../shared/user-facing-codes";
import { getCompartmentEvents } from "../compartment-events";
import {
    getMemoriesByProject,
    getMemoryCountsByStatus,
    getMemoryVerifications,
    type Memory,
} from "../memory";
import { MEMORY_PENDING_PROPOSAL } from "../memory/lifecycle-applier";
import { runCompressCues } from "../mural/compress-cues";
import { detectOverflow } from "../overflow-detection";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { type ClassifyModuleClient, runClassify } from "./classify";
import {
    beginCurateCategoryRun,
    type CurateMemoryCategory,
    curateCategoryForMemoryCategory,
    curateTaskStateAfterSuccess,
} from "./curate-category-rotation";
import { takeCurateSafetyRefusalCount } from "./curate-memory-safety";
import {
    docsBaseHashes,
    docsChangeSet,
    hasCurrentDocsProposal,
    writeDocsProposal,
} from "./docs-proposals";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { archiveExpiredMemories } from "./expire-memories";
import { runHiddenSingleShotPrompt } from "./hidden-single-shot";
import {
    acquireLeaseWithAcquisition,
    type LeaseAcquisition,
    leaseOwnershipMatches,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "./lease";
import { snapshotMaintainDocsFiles } from "./maintain-docs-protected-enforcement";
import { mapMemories } from "./map-memories";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    resolveDreamerModuleRoute,
} from "./module-apply";
import { promotePrimers } from "./promote-primers";
import { refreshPrimers } from "./refresh-primers";
import {
    applyRetrospectiveLearnings,
    parseRetrospectiveLearnings,
    validateRetrospectiveLearningText,
} from "./retrospective-learnings";
import {
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import {
    type DreamRunFailureDetail,
    type DreamRunMemoryChanges,
    formatDreamRunFailure,
    insertDreamRun,
} from "./storage-dream-runs";
import {
    getTaskScheduleState,
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";
import { getDreamTaskBacklog } from "./task-gates";
import {
    buildDreamTaskPrompt,
    buildFrictionGatePrompt,
    buildRetrospectivePrompt,
    CURATE_SYSTEM_PROMPT,
    type CuratePromptMemory,
    chunkCurateMemories,
    FRICTION_GATE_SYSTEM_PROMPT,
    MAINTAIN_DOCS_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
    type RetrospectivePromptEvent,
} from "./task-prompts";
import {
    DREAM_TASK_CAPABILITIES,
    type DreamTaskName,
    type DreamTaskProgress,
    type DreamTaskRunBacklog,
    processedDreamTaskItems,
} from "./task-registry";
import type {
    DreamTaskRuntimeConfig,
    TaskExecOutcome,
    TaskExecutor,
    TaskExecutorContext,
} from "./task-scheduler";
import { DreamTokenBudgetExceeded } from "./token-budget";
import { runVerify } from "./verify";

export interface DreamTaskExecutorDeps {
    client?: PluginContext["client"];
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    /** Existing user session used by a completion-only host. */
    parentSessionId?: string;
    /**
     * Finds a parent session when none was handed in. OpenCode 2's schedule
     * timer uses it: a timer run has no triggering session, and a hidden child
     * created without a parent would show up as a top-level session in the
     * user's session list. When this is set and finds nothing, every task that
     * needs a child session is skipped (not failed); database-only tasks and
     * smart-note evaluation still run.
     */
    findParentSessionId?: () => Promise<string | undefined> | string | undefined;
    /** Filesystem directory of the project this drain owns (NOT the identity). */
    sessionDirectory: string;
    /** Opens the OpenCode DB read-only (for the key-files candidate scan). The
     *  dream-timer owns the path resolution; null when unavailable. */
    openOpenCodeDb: () => Database | null;
    retrospectiveRawProvider?:
        | RetrospectiveRawProvider
        | ((db: Database, projectIdentity: string) => RetrospectiveRawProvider | null);
    /** Host-side privacy gate for route="observation" learnings. */
    userMemoryCollectionEnabled?: boolean;
    /** Ensure the project embedding provider is registered before primer clustering embeds candidates. */
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
    /**
     * Pi only: builds a RawMessageProvider for an arbitrary historical session id
     * so refresh-primers can render the orientation seed from Pi JSONL. OpenCode
     * leaves this undefined (the seed read falls to the read-only opencode.db
     * path). Returning null for a session → refresh falls back to closed-book.
     */
    primerRawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    language?: string;
    /** Resolved project transform mode; an explicit TS mode always stays on TS. */
    transformMode?: "ts" | "rust";
    /** Rust-mode module transport; classify uses it only after MODULE authority is confirmed. */
    mural?: { enabled: boolean };
    memoryInjectionBudgetTokens?: number;
    retinaHandoff?: boolean;
    /** Process-local progress callback for user-facing status displays; it never reads from or writes to the prompt/result cache. */
    onProgress?: (progress: DreamTaskProgress | null, completedTask?: DreamTaskName) => void;
    /** Pi's process runner reports usage after each child exits rather than through session.messages. */
    readTokenBudget?: (
        task: DreamTaskName,
    ) => { spent: number; finalizeFired: boolean } | undefined;
    /** Optional callback for tests and host integrations to resolve the smallest usable input window across child model attempts. */
    resolveRetrospectiveUsableInputTokens?: (models: readonly ModelInput[]) => number | undefined;
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
}

/** A failed task either hot-retries (transient: provider/network/rate-limit/
 *  timeout/abort/lease/busy) or advances to the next cron slot (permanent:
 *  model-not-found, validation, parse). Classify off the error shape. */
function dreamRunFailureDetail(error: unknown): DreamRunFailureDetail {
    const prompt = shared.getPromptFailureDetail(error);
    if (prompt) {
        return {
            failure_class: prompt.failureClass,
            model_attempted: prompt.modelAttempted,
            models_tried: prompt.modelsTried,
            provider_error: prompt.providerError,
            timeout_ms: prompt.timeoutMs,
            child_session_id: prompt.childSessionId,
            ...(prompt.refusalReason ? { refusal_reason: prompt.refusalReason } : {}),
        };
    }

    const described = describeError(error);
    const message = described.brief;
    if (error instanceof DreamTokenBudgetExceeded) {
        return {
            failure_class: "token_budget",
            model_attempted: null,
            models_tried: [],
            provider_error: null,
            timeout_ms: null,
            child_session_id: error.sessionId,
        };
    }
    if (error instanceof Error && error.name === "HiddenAgentStepLimit") {
        return {
            failure_class: "step_limit",
            model_attempted: null,
            models_tried: [],
            provider_error: null,
            timeout_ms: null,
            child_session_id: null,
        };
    }
    const localRefusal = error instanceof HiddenCompletionRefusal;
    const providerFailure =
        error instanceof Error && error.name === "DreamerProviderOutputFailureError";
    return {
        failure_class: localRefusal
            ? "local_refusal"
            : providerFailure
              ? "provider_error"
              : /no models?|model chain is empty/i.test(message)
                ? "no_models"
                : "unknown",
        model_attempted: null,
        models_tried: [],
        provider_error: providerFailure ? sanitizeDiagnosticText(message).slice(0, 500) : null,
        timeout_ms: null,
        child_session_id: null,
        ...(localRefusal
            ? {
                  refusal_reason: sanitizeDiagnosticText(error.message).slice(0, 500),
              }
            : {}),
    };
}

function classifyFailure(error: unknown): { transient: boolean; brief: string } {
    const described = describeError(error);
    const brief = described.brief;
    const name = error instanceof Error ? error.name : "";
    const explicitTransient =
        error !== null &&
        typeof error === "object" &&
        (error as { transient?: unknown }).transient === true;
    const combined = `${name} ${brief}`.toLowerCase();
    const transient =
        explicitTransient ||
        name === "AbortError" ||
        /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/.test(
            combined,
        );
    return { transient, brief };
}

/** Ids present in `afterIds` but not in `beforeIds` (set difference). */
function newIds(beforeIds: number[], afterIds: number[]): number[] {
    const before = new Set(beforeIds);
    const out: number[] = [];
    for (const id of afterIds) if (!before.has(id)) out.push(id);
    return out;
}

function toCuratePromptMemory(
    memory: Memory,
    verificationById: ReturnType<typeof getMemoryVerifications>,
): CuratePromptMemory {
    const verification = verificationById.get(memory.id);
    return {
        id: memory.id,
        category: memory.category,
        content: memory.content,
        mappedFiles: verification?.files ?? [],
        hasNoFileSentinel: verification?.hasSentinel ?? false,
        importance: memory.importance,
        retrievalCount: memory.retrievalCount,
        seenCount: memory.seenCount,
    };
}

function loadActiveMemoryPromptMemories(
    db: Database,
    projectIdentity: string,
): CuratePromptMemory[] {
    const memories = getMemoriesByProject(db, projectIdentity);
    const verificationById = getMemoryVerifications(
        db,
        memories.map((memory) => memory.id),
    );
    return memories.map((memory) => toCuratePromptMemory(memory, verificationById));
}

const TEXTUAL_CURATE_TOOL_CALL_PATTERNS = [
    /\[\s*historical tool call\s*\][\s\S]*?(?:^|\n)\s*name\s*:\s*ctx_memory\b[\s\S]*?(?:^|\n)\s*arguments\s*:/im,
    /(?:^|\n)\s*name\s*:\s*ctx_memory\b[\s\S]*?(?:^|\n)\s*arguments\s*:/im,
    /(?:^|\n)\s*(?:```[^\n]*\n\s*)?ctx_memory\s*\(\s*action\s*=/im,
    /["']name["']\s*:\s*["']ctx_memory["'][\s\S]*?["']arguments["']\s*:/i,
] as const;

/** Reject serialized or hand-written ctx_memory invocations. They are assistant
 * text, not executable tool parts, so accepting one would leave its mutation
 * unapplied while recording the whole curate run as complete. */
function validateCurateAssistantText(text: string): string {
    if (TEXTUAL_CURATE_TOOL_CALL_PATTERNS.some((pattern) => pattern.test(text))) {
        throw new Error("Curate returned an unresolved textual ctx_memory tool call.");
    }
    return text;
}

interface CurateMemoryOperationSummary {
    totalCalls: number;
    completedActions: string[];
    proposedActions: string[];
}

interface CurateValidatedOutput {
    text: string | null;
    memoryOperations: CurateMemoryOperationSummary;
}

export function inspectCurateMemoryOperations(messages: unknown): CurateMemoryOperationSummary {
    const summary: CurateMemoryOperationSummary = {
        totalCalls: 0,
        completedActions: [],
        proposedActions: [],
    };
    if (!Array.isArray(messages)) return summary;

    for (const message of messages) {
        if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant") {
            continue;
        }
        if (!Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "tool") continue;
            const toolName = part.tool ?? part.name;
            if (toolName !== "ctx_memory") continue;
            summary.totalCalls += 1;
            if (!isRecord(part.state) || part.state.status !== "completed") continue;
            const input = isRecord(part.state.input) ? part.state.input : null;
            const action = input?.action;
            const output = typeof part.state.output === "string" ? part.state.output : "";
            // A successful automated edit records a proposal without changing the memory.
            // Keep that receipt separate from applied edits and from tool refusals.
            if (
                (action === "merge" || action === "archive" || action === "update") &&
                output.startsWith(`${MEMORY_PENDING_PROPOSAL}:`)
            ) {
                summary.proposedActions.push(action);
                continue;
            }
            if (
                (output === "completed" &&
                    (action === "merge" || action === "archive" || action === "update")) ||
                (action === "merge" && output.startsWith("Merged memories")) ||
                (action === "archive" && output.startsWith("Archived memor")) ||
                (action === "update" && output.startsWith("Updated memory"))
            )
                summary.completedActions.push(action);
        }
    }

    return summary;
}

function formatExpiredArchiveProgress(count: number): string {
    return `curate: archived ${count} expired ${count === 1 ? "memory" : "memories"}`;
}

function formatCurateMemoryOperations(
    actions: readonly string[],
    outcome: "applied" | "proposed" = "applied",
): string {
    const actionCounts = new Map<string, number>();
    for (const action of actions) actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    const actionDetail = [...actionCounts]
        .map(([action, count]) => (count === 1 ? action : `${action} ×${count}`))
        .join(", ");
    const noun = actions.length === 1 ? "operation" : "operations";
    return `curate: ${actions.length} memory ${noun} ${outcome}${actionDetail ? ` (${actionDetail})` : ""}`;
}

function requireDreamClient(client: PluginContext["client"] | undefined): PluginContext["client"] {
    if (!client)
        throw new HiddenCompletionRefusal(
            "hidden_tools_unsupported",
            "This dream task requires the child-session tool transport",
            true,
        );
    return client;
}

/**
 * Pick the completion transport for a single-shot task: the hidden carrier when
 * the host supplies one, otherwise the child-session client. Returning the
 * fields as an object keeps the two transports mutually exclusive at the call
 * site, so a carrier host never also opens a child session.
 */
function requireDreamTransport(deps: DreamTaskExecutorDeps): {
    client?: PluginContext["client"];
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
} {
    if (deps.hiddenCompletionExecutor)
        return { hiddenCompletionExecutor: deps.hiddenCompletionExecutor };
    return { client: requireDreamClient(deps.client) };
}

/**
 * Build the TaskExecutor the shared task scheduler drives. The scheduler owns the keyed
 * domain lease + holderId and hands them in; this executor runs one task's actual
 * work (LLM loop / specialized runner), renews the lease during the run, aborts
 * if the lease is lost, and writes one per-task dream_runs telemetry row.
 */
export function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor {
    const backgroundSessionsAreHidden =
        (
            deps.client as
                | (PluginContext["client"] & { backgroundSessionsAreHidden?: boolean })
                | undefined
        )?.backgroundSessionsAreHidden === true;
    // Memoize the PROMISE, not a flag+value. Domain groups run concurrently
    // (task-scheduler runs them under Promise.all), so several tasks call this at
    // once. A flag-then-await memo set the "resolved" flag BEFORE the session.list
    // await completed, so a concurrent caller in that window read the still-unset
    // value (undefined) and created its child session with no parentID — which is
    // why evaluate-smart-notes children consistently came back parent_id NULL
    // (top-level in the picker) while the memory-domain group won the race. A
    // single shared promise makes every caller await the same populated result.
    let parentSessionIdPromise: Promise<string | undefined> | undefined;

    const resolveParentSessionId = (deadline: number): Promise<string | undefined> => {
        if (deps.parentSessionId) return Promise.resolve(deps.parentSessionId);
        const findParentSessionId = deps.findParentSessionId;
        if (findParentSessionId) {
            parentSessionIdPromise ??= (async () => {
                try {
                    return await findParentSessionId();
                } catch (error) {
                    log(
                        `[dreamer] parent lookup failed for ${deps.sessionDirectory}: ${describeError(error).brief}`,
                    );
                    return undefined;
                }
            })().then((parent) => {
                // A session can be opened in this directory after the lookup.
                if (!parent) parentSessionIdPromise = undefined;
                return parent;
            });
            return parentSessionIdPromise;
        }
        if (deps.hiddenCompletionExecutor || backgroundSessionsAreHidden)
            return Promise.resolve(deps.parentSessionId);
        if (!parentSessionIdPromise) {
            parentSessionIdPromise = (async () => {
                try {
                    // OpenCode limits session.list to the 100 most recent rows.
                    // Filter children on the host, before that limit, and search
                    // the project: a timer's checkout may have no conversations
                    // while a sibling worktree has the project's ordinary root.
                    // Older leaked Magic Context roots still need client-side
                    // filtering. Grow the prefix until it includes a real parent
                    // or exhausts the roots; /session has no cursor pagination.
                    for (let limit = 100; Date.now() < deadline; limit *= 2) {
                        const query = {
                            directory: deps.sessionDirectory,
                            scope: "project",
                            roots: true,
                            limit,
                        };
                        const listResponse = await requireDreamClient(deps.client).session.list({
                            query,
                        });
                        const sessions = shared.normalizeSDKResponse(
                            listResponse,
                            null as { id?: string; title?: string; parentID?: string }[] | null,
                        );
                        if (!Array.isArray(sessions)) {
                            throw new Error("session.list did not return a session array");
                        }
                        const parent = sessions.find(
                            (s) =>
                                typeof s?.id === "string" &&
                                !s.parentID &&
                                !s.title?.startsWith("magic-context-"),
                        )?.id;
                        if (parent || sessions.length < limit) return parent;
                    }
                    log(`[dreamer] parent lookup timed out for ${deps.sessionDirectory}`);
                    return undefined;
                } catch (error) {
                    log(
                        `[dreamer] parent lookup failed for ${deps.sessionDirectory}: ${describeError(error).brief}`,
                    );
                    return undefined;
                }
            })().then((parent) => {
                // A project can acquire its first ordinary session after boot.
                if (!parent) parentSessionIdPromise = undefined;
                return parent;
            });
        }
        return parentSessionIdPromise;
    };

    return async (
        config: DreamTaskRuntimeConfig,
        ctx: TaskExecutorContext,
    ): Promise<TaskExecOutcome> => {
        const { db, projectIdentity, holderId, leaseKey } = ctx;
        (
            deps.client as unknown as
                | { resetDreamTokenBudget?: (task: DreamTaskName) => void }
                | undefined
        )?.resetDreamTokenBudget?.(config.task);
        const startedAt = Date.now();
        const leaseAcquisition: LeaseAcquisition =
            ctx.leaseAcquisition ??
            acquireLeaseWithAcquisition(db, holderId, leaseKey) ??
            (() => {
                throw new Error("Dream lease unavailable during executor setup");
            })();
        const deadline = startedAt + config.timeoutMinutes * 60 * 1000;
        const backlogAtStart = getDreamTaskBacklog(db, projectIdentity, config.task);
        const reportProgress = (processed: number, refused?: number): void => {
            deps.onProgress?.({
                task: config.task,
                processed: Math.max(0, processed),
                total: backlogAtStart.pending,
                startedAt,
                ...(backlogAtStart.category ? { category: backlogAtStart.category } : {}),
                ...(refused === undefined ? {} : { refused: Math.max(0, refused) }),
            });
        };
        reportProgress(0);
        const incompleteMessage = (remaining: number): string => {
            const processed = processedDreamTaskItems(backlogAtStart.pending, remaining);
            return `${config.task} incomplete: ${remaining} remain (was ${backlogAtStart.pending} at run start; processed ${processed} this run)`;
        };
        const migrationRequired = projectNeedsSingleStoreMigration(db, projectIdentity);
        let moduleRoute: Awaited<ReturnType<typeof resolveDreamerModuleRoute>>;
        if (
            !migrationRequired &&
            !config.modelChainUnavailable &&
            (config.task === "curate" ||
                config.task === "map-memories" ||
                config.task === "compress-cues" ||
                config.task === "classify-memories" ||
                config.task === "verify" ||
                config.task === "verify-broad" ||
                config.task === "retrospective")
        ) {
            try {
                moduleRoute = await resolveDreamerModuleRoute({
                    db,
                    projectIdentity,
                    projectRoot: deps.sessionDirectory,
                    transformMode: deps.transformMode,
                    moduleClient: deps.moduleClient,
                    commandId: `${startedAt}:${holderId}:${config.task}`,
                });
            } catch (error) {
                throw new DreamerModuleFailureError("store admission", error);
            }
        }
        const parent =
            migrationRequired || config.modelChainUnavailable
                ? deps.parentSessionId
                : await resolveParentSessionId(deadline);
        if (!leaseOwnershipMatches(db, holderId, leaseAcquisition.generation, leaseKey)) {
            throw new Error("Dream lease lost during executor setup");
        }

        let budgetSpent = 0;
        let budgetFinalized = false;
        const childSpending = new Map<string, number>();
        const onBudgetUpdate = (state: {
            spent: number;
            finalizeFired: boolean;
            sessionId?: string;
        }) => {
            if (state.sessionId) {
                const previous = childSpending.get(state.sessionId) ?? 0;
                budgetSpent += Math.max(0, state.spent - previous);
                childSpending.set(state.sessionId, state.spent);
            } else budgetSpent = Math.max(budgetSpent, state.spent);
            budgetFinalized ||= state.finalizeFired;
        };
        const recordRun = (
            status: "completed" | "failed" | "skipped",
            error: string | null,
            extra?: {
                memoryChanges?: ReturnType<typeof computeMemoryDelta>;
                smartNotesSurfaced?: number;
                smartNotesPending?: number;
                /** Broad verification closes its cycle before telemetry is recorded,
                 *  so pass the cycle-local backlog explicitly when needed. */
                backlogAfter?: { pending: number; total: number };
                /** Successful progress/detail; empty strings are omitted so absent
                 *  and empty have the same persisted meaning. */
                progress?: string | null;
                banked?: number;
                failure?: DreamRunFailureDetail;
            },
        ): void => {
            try {
                const hostBudget =
                    deps.readTokenBudget?.(config.task) ??
                    (
                        deps.client as unknown as
                            | {
                                  readTokenBudget?: (
                                      task: DreamTaskName,
                                  ) => { spent: number; finalizeFired: boolean } | undefined;
                              }
                            | undefined
                    )?.readTokenBudget?.(config.task);
                if (hostBudget) onBudgetUpdate(hostBudget);
                insertDreamRun(db, {
                    projectPath: projectIdentity,
                    startedAt,
                    finishedAt: Date.now(),
                    holderId,
                    tasks: [
                        {
                            name: config.task,
                            durationMs: Date.now() - startedAt,
                            resultChars: 0,
                            status,
                            ...(status === "skipped" && error ? { skipReason: error } : {}),
                            ...(status === "failed" && error ? { error } : {}),
                            ...(status === "failed"
                                ? {
                                      failure:
                                          extra?.failure ??
                                          dreamRunFailureDetail(error ?? "unknown dreamer failure"),
                                  }
                                : {}),
                            ...(extra?.progress ? { progress: extra.progress } : {}),
                            ...(config.tokenBudget
                                ? {
                                      tokenBudget: {
                                          budget: config.tokenBudget,
                                          spent: budgetSpent,
                                          finalizeFired: budgetFinalized,
                                          banked:
                                              extra?.banked ??
                                              processedDreamTaskItems(
                                                  backlogAtStart.pending,
                                                  (
                                                      extra?.backlogAfter ??
                                                      getDreamTaskBacklog(
                                                          db,
                                                          projectIdentity,
                                                          config.task,
                                                      )
                                                  ).pending,
                                              ),
                                      },
                                  }
                                : {}),
                            backlog: (() => {
                                const end =
                                    extra?.backlogAfter ??
                                    getDreamTaskBacklog(db, projectIdentity, config.task);
                                const processed = processedDreamTaskItems(
                                    backlogAtStart.pending,
                                    end.pending,
                                );
                                const value: DreamTaskRunBacklog = {
                                    pendingAtStart: backlogAtStart.pending,
                                    totalAtStart: backlogAtStart.total,
                                    pendingAtEnd: end.pending,
                                    totalAtEnd: end.total,
                                    processed,
                                    ...(backlogAtStart.category
                                        ? { category: backlogAtStart.category }
                                        : {}),
                                };
                                return value;
                            })(),
                        },
                    ],
                    tasksSucceeded: status === "completed" ? 1 : 0,
                    tasksFailed: status === "failed" ? 1 : 0,
                    smartNotesSurfaced: extra?.smartNotesSurfaced ?? 0,
                    smartNotesPending: extra?.smartNotesPending ?? 0,
                    memoryChanges: extra?.memoryChanges ?? null,
                    parentSessionId: parent ?? null,
                });
            } catch (e) {
                log(`[dreamer] failed to record dream_run for ${config.task}: ${e}`);
            }
        };

        function computeMemoryDelta(
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ): DreamRunMemoryChanges | null {
            const after = getMemoryCountsByStatus(db, projectIdentity);
            // Capture the exact changed ids (#221) — count === array length.
            const writtenIds = newIds(before.ids, after.ids);
            const deletedIds = newIds(after.ids, before.ids);
            const archivedIds = newIds(before.archivedIds, after.archivedIds);
            const mergedIds = newIds(before.mergedIds, after.mergedIds);
            const changes: DreamRunMemoryChanges = {
                written: writtenIds.length,
                deleted: deletedIds.length,
                archived: archivedIds.length,
                merged: mergedIds.length,
                writtenIds,
                deletedIds,
                archivedIds,
                mergedIds,
            };
            return writtenIds.length || deletedIds.length || archivedIds.length || mergedIds.length
                ? changes
                : null;
        }

        try {
            const skip = (reason: string): TaskExecOutcome => {
                log(`[dreamer] ${config.task}: skipped (${reason})`);
                recordRun("skipped", reason);
                return { status: "skipped", detail: reason };
            };
            if (config.modelChainUnavailable)
                return skip("Pi model chain is empty (no configured model resolves in Pi)");
            if (migrationRequired) return skip(renderSingleStoreMigrationRequiredRefusal());
            // A visible host must not create a background root. Skip the whole
            // scheduled task before opening batches or advancing task cursors;
            // the scheduler moves skipped work to its next cron without retries.
            // Hidden carriers and Pi's process-local sessions need no parent.
            // Tasks that may finish without any child session keep running:
            // host-only database work, and smart-note evaluation, whose compiled
            // checks run in the local sandbox (or defer to the wake plane).
            // A host that supplies its own parent lookup (OpenCode 2's timer)
            // needs that parent for the same reason, carrier or not.
            const parentRequired =
                deps.findParentSessionId !== undefined ||
                (deps.client !== undefined &&
                    !deps.hiddenCompletionExecutor &&
                    !backgroundSessionsAreHidden);
            if (
                parentRequired &&
                !parent &&
                DREAM_TASK_CAPABILITIES[config.task].transport !== "host-only" &&
                config.task !== "evaluate-smart-notes"
            )
                return skip(
                    deps.findParentSessionId
                        ? "no session in this directory to hold the run's child session; it runs once one exists"
                        : "no ordinary parent session is available on this host",
                );
            if (
                deps.hiddenCompletionExecutor?.capabilities.tools === false &&
                DREAM_TASK_CAPABILITIES[config.task].requiresTools
            ) {
                // Name the task and what its tool loop is for. A caller that only
                // logs the message still records which specific task was refused
                // and why, instead of one anonymous capability error.
                const purpose = DREAM_TASK_CAPABILITIES[config.task].toolLoopPurpose;
                throw new HiddenCompletionRefusal(
                    "hidden_tools_unsupported",
                    `${config.task} is unavailable on this host (${userFacingFailureCode(
                        "dream_task_needs_tool_loop",
                    )})${purpose ? `: it ${purpose}` : ""}`,
                    true,
                );
            }
            if (config.task === "compress-cues") {
                if (deps.mural?.enabled !== true) {
                    return skip("mural is not enabled");
                }
                // `config.model` is already resolved by task-config from the
                // executing harness's task-specific, then default model settings.
                const result = await runCompressCues({
                    db,
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    moduleRoute,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] compress-cues: compressed=${result.compressed} skipped=${result.skipped} chunks=${result.chunks} remaining=${result.remaining}`,
                );
                if (!result.complete) {
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "review-user-memories") {
                // Single-shot task: the reviewer answers with one JSON verdict, so a
                // completion carrier serves it as well as a child-session client.
                const result = await reviewUserMemories({
                    db,
                    ...requireDreamTransport(deps),
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    promotionThreshold:
                        config.promotionThreshold ??
                        DREAM_TASK_PROMOTION_DEFAULTS["review-user-memories"],
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] review-user-memories: promoted=${result.promoted} merged=${result.merged} dismissed=${result.dismissed}`,
                );
                return { status: "completed" };
            }

            if (config.task === "map-memories") {
                const result = await mapMemories({
                    db,
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    moduleRoute,
                    tokenBudget: config.tokenBudget,
                    onBudgetUpdate,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] map-memories: committed=${result.mapped + result.independent} mapped=${result.mapped} independent=${result.independent} batches=${result.batches} remaining=${result.remaining} complete=${result.complete}${result.stopReason ? ` stop_reason=${result.stopReason}` : ""}`,
                );
                if (!result.complete) {
                    if (result.stopReason === "timeout-circuit-breaker") {
                        // A repeated timeout is a model-capacity starvation signal, not
                        // a normal deadline remainder. Keep its failed status loud so
                        // /ctx-dream and dreamer history expose why it stopped.
                        const error = `map-memories starvation: timeout circuit breaker stopped the run with ${result.remaining} remain`;
                        recordRun("failed", error);
                        return { status: "failed", transient: true, error };
                    }
                    const processed = result.mapped + result.independent;
                    if (processed > 0) {
                        // Mappings are persisted one completed host batch at a time.
                        // Like a resumable verify-broad cycle, bank real progress as a
                        // completed scheduled run so lastRunAt advances, while the
                        // remaining gate set drives the next scheduled run.
                        const progress = `map-memories: committed ${processed} mapping(s) (mapped ${result.mapped}, independent ${result.independent}); ${result.remaining} remain`;
                        recordRun("completed", null, { progress });
                        return { status: "completed" };
                    }
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "verify" || config.task === "verify-broad") {
                const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);
                const result = await runVerify({
                    db,
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    forceBroad: config.task === "verify-broad",
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    moduleRoute,
                    tokenBudget: config.tokenBudget,
                    onBudgetUpdate,
                    onProgress: (processed, refused) => reportProgress(processed, refused),
                });
                const processed =
                    result.verified +
                    result.updated +
                    result.archived +
                    result.skipped +
                    result.refused;
                const verificationProgress = `${config.task}${config.task === "verify-broad" ? ` cycle ${result.broadCycleStartAt ?? "open"}` : ""}: processed ${processed} (verified ${result.verified}, updated ${result.updated}, archived ${result.archived}, skipped ${result.skipped}, refused ${result.refused}); ${result.remaining} remain`;
                const broadProgress = config.task === "verify-broad" ? verificationProgress : null;
                const backlogAfter =
                    config.task === "verify-broad"
                        ? { pending: result.remaining, total: backlogAtStart.total }
                        : undefined;
                if (!result.complete) {
                    // A broad cycle is intentionally resumable: ordinary progress
                    // is a successful scheduled run, even though this deadline did
                    // not drain the complete cycle. Only a zero-progress broad run
                    // is a failure that should raise the dashboard's red status.
                    if (broadProgress && processed > 0) {
                        recordRun("completed", null, {
                            progress: broadProgress,
                            memoryChanges: computeMemoryDelta(memoryBefore),
                            backlogAfter,
                            banked: result.verified + result.updated + result.archived,
                        });
                        return { status: "completed" };
                    }
                    const batchTimedOut = result.stopReason === "batch-timeout";
                    const error = batchTimedOut
                        ? `${config.task}: a batch timed out within its time slice; ${result.remaining} remain`
                        : incompleteMessage(result.remaining);
                    recordRun("failed", error, {
                        progress: verificationProgress,
                        memoryChanges: computeMemoryDelta(memoryBefore),
                        backlogAfter,
                        banked: result.verified + result.updated + result.archived,
                    });
                    // A hot retry would split the deadline the same way and time out
                    // again, so a batch timeout waits for the next scheduled run.
                    return { status: "failed", transient: !batchTimedOut, error };
                }
                recordRun("completed", null, {
                    progress: verificationProgress,
                    memoryChanges: computeMemoryDelta(memoryBefore),
                    backlogAfter,
                    banked: result.verified + result.updated + result.archived,
                });
                return { status: "completed" };
            }

            if (config.task === "classify-memories") {
                // Cache-neutral metadata write (classified_at/importance/scope/
                // shareable) — no memory_changes telemetry (status counts unchanged).
                let moduleArgs:
                    | Pick<
                          import("./classify").ClassifyArgs,
                          | "moduleClient"
                          | "moduleSessionId"
                          | "moduleProjectRoot"
                          | "moduleCommandId"
                      >
                    | undefined;
                if (moduleRoute) {
                    moduleArgs = {
                        moduleClient: moduleRoute.moduleClient,
                        moduleSessionId: moduleRoute.moduleSessionId,
                        moduleProjectRoot: moduleRoute.moduleProjectRoot,
                        moduleCommandId: moduleRoute.moduleCommandId,
                    };
                }
                const result = await runClassify({
                    db,
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    ...moduleArgs,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] classify-memories: stage=${result.stage} classified=${result.classified} changed=${result.changed} chunks=${result.chunks} remaining=${result.remaining}`,
                );
                if (!result.complete) {
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "promote-primers") {
                // Host-only task: clustering and the promotion writes happen here,
                // with no model call, so it must not demand a completion transport.
                const result = await promotePrimers({
                    db,
                    ...(deps.client ? { client: deps.client } : {}),
                    projectIdentity,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    promotionThreshold:
                        config.promotionThreshold ??
                        DREAM_TASK_PROMOTION_DEFAULTS["promote-primers"],
                    ensureProjectRegistered: deps.ensureProjectRegistered,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] promote-primers: promoted=${result.promoted} updated=${result.updated} candidates=${result.candidates}`,
                );
                return { status: "completed" };
            }

            if (config.task === "refresh-primers") {
                const result = await refreshPrimers({
                    db,
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    rawProviderFactory: deps.primerRawProviderFactory,
                    tokenBudget: config.tokenBudget,
                    onBudgetUpdate,
                    onProgress: (processed) => reportProgress(processed),
                });
                recordRun("completed", null);
                log(
                    `[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`,
                );
                return { status: "completed" };
            }

            if (config.task === "evaluate-smart-notes") {
                // Single-shot task: the compiler and the read-only confirmation are
                // both no-tool prompts; the compiled check runs in the local sandbox.
                const result = await evaluateSmartNotes({
                    db,
                    ...requireDreamTransport(deps),
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    retinaHandoff: deps.retinaHandoff,
                });
                recordRun("completed", null, {
                    smartNotesSurfaced: result.surfaced,
                    smartNotesPending: result.pending,
                });
                return { status: "completed" };
            }

            if (config.task === "retrospective") {
                const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);
                const retro = await runRetrospectiveTask(config, ctx, {
                    onBudgetUpdate,
                    deps,
                    deadline,
                    parent,
                    invocationStartedAt: startedAt,
                    moduleRoute,
                });
                if (retro.skipReason) return skip(retro.skipReason);
                recordRun("completed", null, {
                    memoryChanges: computeMemoryDelta(memoryBefore),
                    backlogAfter:
                        retro.retrospectiveWatermarkMs == null
                            ? undefined
                            : getDreamTaskBacklog(db, projectIdentity, "retrospective", {
                                  retrospectiveWatermarkMs: retro.retrospectiveWatermarkMs,
                              }),
                });
                // Advance the content watermark on completion (incl. clean "n"
                // runs) so the next run only scans newer messages.
                return {
                    status: "completed",
                    schedulePatch:
                        retro.retrospectiveWatermarkMs != null || retro.taskStateJson !== undefined
                            ? {
                                  ...(retro.retrospectiveWatermarkMs != null
                                      ? {
                                            retrospectiveWatermarkMs:
                                                retro.retrospectiveWatermarkMs,
                                        }
                                      : {}),
                                  ...(retro.taskStateJson !== undefined
                                      ? { taskStateJson: retro.taskStateJson }
                                      : {}),
                              }
                            : undefined,
                };
            }

            // Agentic tasks: verify / curate / maintain-docs.
            return await runAgenticTask(config, ctx, {
                onBudgetUpdate,
                deps,
                deadline,
                parent,
                recordRun,
                computeMemoryDelta,
                reportProgress,
                leaseAcquisition,
                moduleRoute,
            });
        } catch (error) {
            if (error instanceof DreamTokenBudgetExceeded) {
                budgetSpent = Math.max(budgetSpent, error.spent);
            }
            const classified = classifyFailure(error);
            const retrospectiveOverflow =
                error instanceof RetrospectivePromptOverflowError ? error : null;
            const transient = retrospectiveOverflow ? true : classified.transient;
            const brief = classified.brief;
            const failure = dreamRunFailureDetail(error);
            recordRun("failed", brief, { failure });
            log(
                `[dreamer] task ${config.task} failed code=${dreamFailureCode(failure.failure_class)} (transient=${transient}): ${brief}`,
            );
            return {
                status: "failed",
                transient,
                error: brief,
                failureDetail: formatDreamRunFailure(failure),
                ...(retrospectiveOverflow
                    ? { schedulePatch: retrospectiveOverflow.schedulePatch }
                    : {}),
            };
        } finally {
            deps.onProgress?.(null, config.task);
        }
    };
}

function resolveRetrospectiveProvider(
    deps: DreamTaskExecutorDeps,
    db: Database,
    projectIdentity: string,
): RetrospectiveRawProvider | null {
    if (!deps.retrospectiveRawProvider) return null;
    return typeof deps.retrospectiveRawProvider === "function"
        ? deps.retrospectiveRawProvider(db, projectIdentity)
        : deps.retrospectiveRawProvider;
}

function withGlobalOrdinals(messages: RetrospectiveRawMessage[]): RetrospectiveRawMessage[] {
    return messages.map((message, index) => ({ ...message, ordinal: index + 1 }));
}

function renderGateUserLines(messages: RetrospectiveRawMessage[]): string[] {
    return messages
        .filter((message) => message.role === "user")
        .map((message) => `${message.ordinal}: ${message.text}`);
}

/** Number of user lines re-read before the watermark each run (the overlap), so
 *  friction straddling a run boundary isn't missed. Bounded; idempotence guards
 *  against the re-read re-extracting an already-processed window. */
const RETROSPECTIVE_OVERLAP_USER_LINES = 12;

/** Parse the gate's verdict. Expected shape: a single line `n` (no friction) or
 *  `y: 3, 7` (flagged ordinals). Robust to a model that wraps it in prose:
 *  - scan LINE BY LINE for the first verdict-leading line (`y`/`yes`/`n`/`no`);
 *  - ordinals are taken ONLY from that verdict line (so a stray year/number in
 *    surrounding prose can't fabricate a deepen);
 *  - if no verdict-leading line exists, look for an embedded `y: <nums>` pattern;
 *  - anything unparseable → NO hit (fail safe — the caller still advances the
 *    watermark on a clean run, so a garbled verdict can't wedge progress).
 *  A `y` with zero ordinals is NOT a hit (there are no lines to deepen on). */
export function parseFrictionGateVerdict(verdict: string): { hit: boolean; ordinals: number[] } {
    const ordinalsFrom = (line: string): number[] => {
        const afterColon = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
        return (afterColon.match(/\d+/g) ?? [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
    };

    for (const raw of verdict.split(/\r?\n/)) {
        const line = raw.trim().toLowerCase();
        if (!line) continue;
        if (/^n(o)?\b/.test(line)) return { hit: false, ordinals: [] };
        // A POSITIVE verdict requires the `y:`/`yes:` colon form. A `y`-leading
        // line WITHOUT a colon is prose ("yes, the user was upset about 3…") —
        // keep scanning so its stray digits aren't harvested as ordinals and a
        // later well-formed `y: 3` isn't swallowed.
        if (/^y(es)?\s*:/.test(line)) {
            const ordinals = ordinalsFrom(line);
            return { hit: ordinals.length > 0, ordinals };
        }
    }

    // No clean verdict line — accept an embedded `y: <nums>` form, else fail safe.
    const embedded = verdict.toLowerCase().match(/\by(?:es)?\s*:\s*([\d,\s]+)/);
    if (embedded) {
        const ordinals = (embedded[1].match(/\d+/g) ?? [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
        return { hit: ordinals.length > 0, ordinals };
    }
    return { hit: false, ordinals: [] };
}

/** Stable source-window key for idempotence: a hash over the flagged user lines'
 *  (sessionId:ts) anchors — NOT prompt ordinals (batch-local). Sorted so order
 *  is irrelevant; the same friction window yields the same key across runs. */
function computeRetrospectiveWindowKey(flagged: RetrospectiveRawMessage[]): string {
    const anchors = flagged
        .map((message) => `${message.sessionId}:${message.ts}`)
        .sort()
        .join("|");
    return createHash("sha256").update(anchors).digest("hex").slice(0, 32);
}

/** Render the deepen zoom window: the gate-flagged user lines plus ±radius
 *  surrounding context (other user lines + tool metadata), with the flagged
 *  lines marked. Privacy: only user TEXT carries content; tool rows are
 *  metadata-only (the provider already strips assistant prose + tool output). */
function renderFrictionWindow(
    messages: RetrospectiveRawMessage[],
    flaggedOrdinals: number[],
    radius = 2,
): string {
    const flagged = new Set(flaggedOrdinals);
    const included = new Set<number>();
    for (const anchor of flaggedOrdinals) {
        for (let ordinal = anchor - radius; ordinal <= anchor + radius; ordinal += 1) {
            included.add(ordinal);
        }
    }

    return messages
        .filter((message) => included.has(message.ordinal))
        .map((message) => {
            const role =
                message.role === "assistant" ? "A" : message.role === "tool" ? "tool" : "U";
            const suffix = flagged.has(message.ordinal) ? "  [friction]" : "";
            const tool = message.toolName ? ` ${message.toolName}` : "";
            return `${message.ordinal}. (${message.sessionId}) ${role}${tool}: ${message.text}${suffix}`;
        })
        .join("\n");
}

function retrospectiveEventsForSessions(
    db: Database,
    sessionIds: Iterable<string>,
): RetrospectivePromptEvent[] {
    const events: RetrospectivePromptEvent[] = [];
    for (const sessionId of sessionIds) {
        try {
            for (const event of getCompartmentEvents(db, sessionId)) {
                if (event.kind !== "causal_incident" && event.kind !== "trajectory_correction") {
                    log(`[dreamer] dropping event: unknown kind="${event.kind}"`);
                    continue;
                }
                events.push({
                    sessionId,
                    kind: event.kind,
                    fields: event.fields,
                    createdAt: event.createdAt,
                });
            }
        } catch {
            // Older/partial test DBs may not have event rows; corroboration is optional.
        }
    }
    return events.sort((a, b) => a.createdAt - b.createdAt).slice(-20);
}

const RETROSPECTIVE_DEFAULT_USABLE_INPUT_TOKENS = 128_000;
const RETROSPECTIVE_OVERFLOW_FAILURE_LIMIT = 2;
const RETROSPECTIVE_MIN_RETRY_INPUT_TOKENS = 512;
const RETROSPECTIVE_DAY_MS = 24 * 60 * 60 * 1000;

interface RetrospectiveOverflowState {
    watermarkMs: number;
    failures: number;
    nextUsableInputTokens: number;
    abandonAfterMs: number;
}

class RetrospectivePromptOverflowError extends Error {
    constructor(
        message: string,
        readonly schedulePatch: NonNullable<TaskExecOutcome["schedulePatch"]>,
    ) {
        super(message);
        this.name = "DreamerProviderOutputFailureError";
    }
}

function readRetrospectiveTaskState(taskStateJson: string | null | undefined): {
    root: Record<string, unknown>;
    overflow?: RetrospectiveOverflowState;
} {
    let root: Record<string, unknown> = {};
    if (taskStateJson) {
        try {
            const parsed = JSON.parse(taskStateJson);
            if (isRecord(parsed)) root = parsed;
        } catch {
            // A malformed task-local blob must not wedge retrospective progress.
        }
    }
    const candidate = root.retrospectiveOverflow;
    if (!isRecord(candidate)) return { root };
    const { watermarkMs, failures, nextUsableInputTokens, abandonAfterMs } = candidate;
    if (
        typeof watermarkMs !== "number" ||
        typeof failures !== "number" ||
        typeof nextUsableInputTokens !== "number" ||
        typeof abandonAfterMs !== "number"
    ) {
        return { root };
    }
    return {
        root,
        overflow: { watermarkMs, failures, nextUsableInputTokens, abandonAfterMs },
    };
}

function writeRetrospectiveOverflowState(
    root: Record<string, unknown>,
    overflow: RetrospectiveOverflowState | null,
): string {
    const next = { ...root };
    if (overflow) next.retrospectiveOverflow = overflow;
    else delete next.retrospectiveOverflow;
    return JSON.stringify(next);
}

function resolveRetrospectiveUsableInputTokens(
    config: DreamTaskRuntimeConfig,
    deps: DreamTaskExecutorDeps,
): number {
    const models: ModelInput[] = [];
    if (config.model) models.push(config.model);
    for (const fallback of config.fallbackModels ?? []) models.push(fallback);
    const injected = deps.resolveRetrospectiveUsableInputTokens?.(models);
    if (typeof injected === "number" && Number.isFinite(injected) && injected > 0) {
        return Math.floor(injected);
    }
    if (models.length === 0) return RETROSPECTIVE_DEFAULT_USABLE_INPUT_TOKENS;

    // The same prompt is attempted on every configured fallback. Admit against
    // the smallest known usable input; an unknown catalog entry receives the
    // historian's conservative 128K fallback rather than an unbounded prompt.
    return Math.min(
        ...models.map((model) => {
            const entry = toModelEntry(model);
            const parsed = entry ? parseProviderModel(entry.model) : null;
            if (!parsed) return RETROSPECTIVE_DEFAULT_USABLE_INPUT_TOKENS;
            return (
                getSdkContextLimit(parsed.providerID, parsed.modelID) ??
                RETROSPECTIVE_DEFAULT_USABLE_INPUT_TOKENS
            );
        }),
    );
}

async function runRetrospectiveTask(
    config: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        invocationStartedAt: number;
        onBudgetUpdate: (state: { spent: number; finalizeFired: boolean }) => void;
        moduleRoute?: DreamerModuleRoute;
    },
): Promise<{
    retrospectiveWatermarkMs: number | null;
    taskStateJson?: string;
    skipReason?: string;
}> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent, onBudgetUpdate } = helpers;
    const provider = resolveRetrospectiveProvider(deps, db, projectIdentity);
    if (!provider) {
        return {
            retrospectiveWatermarkMs: null,
            skipReason: "no raw-history provider is available",
        };
    }

    // Content watermark (max message ts actually scanned) — NOT lastRunAt, which
    // is schedule-completion time and would skip a message that arrived mid-run.
    const scheduleState = getTaskScheduleState(db, projectIdentity, config.task);
    const watermarkMs = scheduleState?.retrospectiveWatermarkMs ?? 0;
    const taskState = readRetrospectiveTaskState(scheduleState?.taskStateJson);
    const activeOverflow =
        taskState.overflow?.watermarkMs === watermarkMs ? taskState.overflow : undefined;
    const baseUsableInputTokens = resolveRetrospectiveUsableInputTokens(config, deps);
    const usableInputTokens = activeOverflow
        ? Math.min(baseUsableInputTokens, activeOverflow.nextUsableInputTokens)
        : baseUsableInputTokens;
    const recencyDays = Math.max(1, Math.floor(config.retrospectiveRecencyDays ?? 30));
    const recencyCutoffMs = helpers.invocationStartedAt - recencyDays * RETROSPECTIVE_DAY_MS;

    const scan = await readRetrospectiveScanWindow(
        provider,
        projectIdentity,
        watermarkMs,
        RETROSPECTIVE_OVERLAP_USER_LINES,
        { usableInputTokens, recencyCutoffMs },
    );
    const clearedTaskStateJson = activeOverflow
        ? writeRetrospectiveOverflowState(taskState.root, null)
        : undefined;
    const completedWindow = (
        retrospectiveWatermarkMs: number | null,
    ): { retrospectiveWatermarkMs: number | null; taskStateJson?: string } => ({
        retrospectiveWatermarkMs,
        ...(clearedTaskStateJson ? { taskStateJson: clearedTaskStateJson } : {}),
    });
    const messages = withGlobalOrdinals(scan.messages);
    const userMessages = messages.filter(
        (message) => message.role === "user" && message.text.trim().length > 0,
    );
    if (userMessages.length === 0) {
        log("[dreamer] retrospective: no user messages in window");
        return completedWindow(scan.maxScannedTs);
    }

    // Only POST-watermark user lines are genuinely new; the rest are the overlap
    // re-read. If nothing is new, the window was already handled last run.
    const postWatermarkOrdinals = new Set(
        userMessages
            .filter((message) => message.ts > watermarkMs)
            .map((message) => message.ordinal),
    );
    if (postWatermarkOrdinals.size === 0) {
        log("[dreamer] retrospective: only overlap lines, nothing new");
        return completedWindow(scan.maxScannedTs);
    }

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeat = startLeaseHeartbeat(
        db,
        holderId,
        leaseKey,
        () => {
            leaseLost = true;
            abortController.abort();
        },
        ctx.leaseAcquisition,
    );

    let childSessionId: string | null = null;
    let hiddenHandle: HiddenRunHandle | null = null;
    let promptSettled = false;
    try {
        if (deps.hiddenCompletionExecutor) {
            hiddenHandle = await deps.hiddenCompletionExecutor.open({
                parentSessionId: parent ?? undefined,
                agent: DREAMER_RETROSPECTIVE_AGENT,
                kind: "dreamer-task",
                system: FRICTION_GATE_SYSTEM_PROMPT,
                model: config.model,
                configuredModels: [
                    ...(config.model ? [config.model] : []),
                    ...(config.fallbackModels ?? []),
                ],
                timeoutMs: Math.max(1, deadline - Date.now()),
                title: "magic-context-dream-retrospective",
                directory: deps.sessionDirectory,
                metadata: { tokenBudget: config.tokenBudget, onBudgetUpdate },
            });
            childSessionId = hiddenHandle.id;
        } else {
            const createResponse = await createChildSessionWithFence({
                client: requireDreamClient(deps.client),
                db,
                parentSessionId: parent ?? undefined,
                title: "magic-context-dream-retrospective",
                directory: deps.sessionDirectory,
            });
            const created = shared.normalizeSDKResponse(
                createResponse,
                null as { id?: string } | null,
                { preferResponseOnMissingData: true },
            );
            childSessionId = typeof created?.id === "string" ? created.id : null;
            if (!childSessionId)
                throw new Error("Retrospective could not create its child session.");
        }
        const sessionId = childSessionId;
        if (!sessionId) throw new Error("Retrospective could not create its child session.");

        // One child handles the cheap gate and (on a hit) the deepen turn.
        // Each turn supplies its own system prompt. On OpenCode 1 the final
        // message fetch includes both turns; the OpenCode 2 carrier returns
        // only the current turn's tool history.
        const runChildTurn = async (system: string, userText: string) => {
            const remainingMs = Math.max(0, deadline - Date.now());
            promptSettled = false;
            const run = await shared.promptSyncWithValidatedOutputRetry(
                deps.hiddenCompletionExecutor ? undefined : requireDreamClient(deps.client),
                {
                    path: { id: sessionId },
                    query: { directory: deps.sessionDirectory },
                    body: {
                        agent: DREAMER_RETROSPECTIVE_AGENT,
                        system,
                        ...modelBodyField(config.model),
                        parts: [{ type: "text", text: userText, synthetic: true }],
                    },
                },
                {
                    timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                    signal: abortController.signal,
                    fallbackModels: config.fallbackModels,
                    callContext: "dreamer:retrospective",
                    ...(!hiddenHandle && deps.client
                        ? {
                              transport: shared.createPromptAsyncTransport(deps.client, sessionId, {
                                  tokenBudget: config.tokenBudget,
                                  onBudgetUpdate,
                              }),
                          }
                        : {}),
                    ...(hiddenHandle && deps.hiddenCompletionExecutor
                        ? {
                              transport: Object.assign(
                                  (
                                      request: import("../../../shared/model-suggestion-retry").PromptArgs,
                                  ) =>
                                      deps.hiddenCompletionExecutor?.attempt(
                                          hiddenHandle as HiddenRunHandle,
                                          request,
                                      ) ??
                                      Promise.reject(new Error("Hidden transport unavailable")),
                                  { childSessionId: hiddenHandle.childSessionId },
                              ),
                          }
                        : {}),
                    fetchOutput: async () => {
                        if (hiddenHandle && deps.hiddenCompletionExecutor) {
                            return deps.hiddenCompletionExecutor.collect(hiddenHandle, 50);
                        }
                        const messagesResponse = await requireDreamClient(
                            deps.client,
                        ).session.messages({
                            path: { id: sessionId },
                            query: { directory: deps.sessionDirectory, limit: 50 },
                        });
                        return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                            preferResponseOnMissingData: true,
                        });
                    },
                    validateOutput: (outputMessages) => {
                        const text = hiddenHandle
                            ? (outputMessages as { text: string | null }).text
                            : extractLatestAssistantText(outputMessages);
                        if (!text) throw new Error("Retrospective child returned no output.");
                        return text;
                    },
                },
            );
            promptSettled = true;
            const output: unknown[] = hiddenHandle
                ? ((run.output as { messages?: unknown[] }).messages ?? [])
                : (run.output as unknown[]);
            return { ...run, output };
        };

        const finish = (
            run: { output: unknown[] } | null,
            watermark: number | null,
        ): { retrospectiveWatermarkMs: number | null; taskStateJson?: string } => {
            if (parent && run) {
                recordChildInvocation({
                    db,
                    parentSessionId: parent,
                    harness: "opencode",
                    subagent: "dreamer",
                    task: config.task,
                    startedAt: helpers.invocationStartedAt,
                    status: "completed",
                    messages: run.output,
                });
            }
            return completedWindow(watermark);
        };

        // ── Turn 1: cheap LLM gate over U: lines only ──────────────────────
        const userLines = renderGateUserLines(messages);
        const gateRun = await runChildTurn(
            FRICTION_GATE_SYSTEM_PROMPT,
            buildFrictionGatePrompt({ userLines }),
        );
        if (leaseLost) throw new Error("Dream lease lost during retrospective");
        const gate = parseFrictionGateVerdict(gateRun.validated);
        if (!gate.hit) {
            log("[dreamer] retrospective: gate — no friction");
            return finish(gateRun, scan.maxScannedTs);
        }

        const flagged = userMessages.filter((message) => gate.ordinals.includes(message.ordinal));
        // Require at least one genuinely-new (post-watermark) flagged line —
        // friction wholly inside the overlap was handled last run.
        if (!flagged.some((message) => postWatermarkOrdinals.has(message.ordinal))) {
            log("[dreamer] retrospective: gate hit only on overlap lines");
            return finish(gateRun, scan.maxScannedTs);
        }

        // Source-window idempotence: a stable key over the flagged anchors
        // (sessionId:ts) — NOT prompt ordinals, which are batch-local. If we have
        // already deepened this exact window, skip the (expensive) second turn.
        const windowKey = computeRetrospectiveWindowKey(flagged);
        if (isRetrospectiveWindowProcessed(db, projectIdentity, windowKey)) {
            log("[dreamer] retrospective: window already processed");
            return finish(gateRun, scan.maxScannedTs);
        }

        // ── Turn 2: deepen — host renders the zoom window, LLM extracts the rule.
        const frictionWindow = renderFrictionWindow(
            messages,
            flagged.map((message) => message.ordinal),
        );
        const eventSessionIds = new Set(messages.map((message) => message.sessionId));
        const events = retrospectiveEventsForSessions(db, eventSessionIds);
        const deepenRun = await runChildTurn(
            withContentLanguageDirective(
                RETROSPECTIVE_SYSTEM_PROMPT,
                config.language ?? deps.language,
                {
                    retrospective: true,
                },
            ),
            buildRetrospectivePrompt({ projectPath: projectIdentity, frictionWindow, events }),
        );
        if (leaseLost) throw new Error("Dream lease lost during retrospective");

        const sourceSessionId =
            flagged[0]?.sessionId ?? userMessages[0]?.sessionId ?? "retrospective";
        const learnings = parseRetrospectiveLearnings(deepenRun.validated);
        let moduleMemoryWritten = 0;
        const moduleRejected: Array<{ content: string; reason: string }> = [];
        let hostLearnings = learnings;
        if (helpers.moduleRoute) {
            const moduleLearnings = learnings.filter((learning) => {
                if (learning.route !== "memory") return false;
                const reason = validateRetrospectiveLearningText(
                    learning.content,
                    userMessages.map((message) => message.text ?? ""),
                );
                if (reason || !learning.category) {
                    if (reason) moduleRejected.push({ content: learning.content, reason });
                    return false;
                }
                return true;
            });
            hostLearnings = learnings.filter((learning) => learning.route !== "memory");
            for (const learning of moduleLearnings) {
                try {
                    const response = await helpers.moduleRoute.moduleClient.call({
                        sessionId: helpers.moduleRoute.moduleSessionId,
                        projectRoot: helpers.moduleRoute.moduleProjectRoot,
                        method: "ctx_memory",
                        body: {
                            name: "ctx_memory",
                            arguments: {
                                action: "write",
                                memory_project: projectIdentity,
                                category: learning.category,
                                content: learning.content,
                                command_id: `${helpers.moduleRoute.moduleCommandId}:${moduleMemoryWritten}`,
                            },
                        },
                    });
                    const body = ((response as { result?: unknown })?.result ?? response) as {
                        ok?: unknown;
                        error?: unknown;
                    };
                    if (body?.ok === false || body?.error)
                        throw new Error("module rejected retrospective memory");
                    moduleMemoryWritten += 1;
                } catch (error) {
                    throw new DreamerModuleFailureError("ctx_memory retrospective write", error);
                }
            }
            // Invalid memory learnings remain rejected, but never reach a TypeScript memory insert.
        }
        // Apply learnings AND record the processed-window key in ONE transaction
        // so a crash between them can't leave the window un-recorded (which would
        // re-deepen + risk a duplicate observation next run, since
        // insertUserMemoryCandidates has no unique key). Both are plain DB writes.
        const applied = runLeaseGuardedWrite(
            db,
            holderId,
            leaseKey,
            (): ReturnType<typeof applyRetrospectiveLearnings> => {
                const result = applyRetrospectiveLearnings({
                    db,
                    projectIdentity,
                    sourceSessionId,
                    learnings: hostLearnings,
                    userMemoryCollectionEnabled: deps.userMemoryCollectionEnabled === true,
                    // Source user lines for the near-transcription reject: a learning
                    // that echoes a long verbatim run of the user's words is a
                    // transcription.
                    sourceUserTexts: userMessages
                        .map((message) => message.text ?? "")
                        .filter((text) => text.length > 0),
                });
                result.memoryWritten += moduleMemoryWritten;
                result.rejected.push(...moduleRejected);
                recordRetrospectiveWindowProcessed(db, projectIdentity, windowKey);
                return result;
            },
        );
        if (leaseLost || !applied) throw new Error("Dream lease lost during retrospective commit");
        log(
            `[dreamer] retrospective: flagged=${flagged.length} learnings=${learnings.length} memory=${applied.memoryWritten} observations=${applied.observationsInserted} dropped=${applied.observationsDropped} rejected=${applied.rejected.length}`,
        );
        return finish(deepenRun, scan.maxScannedTs);
    } catch (error) {
        if (!detectOverflow(error).isOverflow) throw error;

        const failures = (activeOverflow?.failures ?? 0) + 1;
        const abandonAfterMs = Math.max(
            activeOverflow?.abandonAfterMs ?? watermarkMs,
            scan.maxScannedTs,
        );
        const providerMessage = describeError(error).brief;
        if (failures >= RETROSPECTIVE_OVERFLOW_FAILURE_LIMIT) {
            const taskStateJson = writeRetrospectiveOverflowState(taskState.root, null);
            log(
                `[dreamer] retrospective: child rejected source window for size ${failures} times; advancing content watermark from ${watermarkMs} to ${abandonAfterMs} so the same window is not retried forever`,
            );
            throw new RetrospectivePromptOverflowError(
                `retrospective prompt overflow; abandoned repeatedly rejected source window after ${failures} attempts: ${providerMessage}`,
                { retrospectiveWatermarkMs: abandonAfterMs, taskStateJson },
            );
        }

        const nextUsableInputTokens = Math.max(
            RETROSPECTIVE_MIN_RETRY_INPUT_TOKENS,
            Math.floor(usableInputTokens / 2),
        );
        const overflowState: RetrospectiveOverflowState = {
            watermarkMs,
            failures,
            nextUsableInputTokens,
            abandonAfterMs,
        };
        log(
            `[dreamer] retrospective: child rejected ${scan.promptTokens}-token estimated prompt for size; retrying watermark=${watermarkMs} with usable input ${usableInputTokens} -> ${nextUsableInputTokens}`,
        );
        throw new RetrospectivePromptOverflowError(
            `retrospective prompt overflow; retrying with a smaller source window: ${providerMessage}`,
            {
                taskStateJson: writeRetrospectiveOverflowState(taskState.root, overflowState),
            },
        );
    } finally {
        heartbeat.stop();
        if (hiddenHandle && deps.hiddenCompletionExecutor) {
            await deps.hiddenCompletionExecutor.close(hiddenHandle, {
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] retrospective",
                log,
            });
        } else
            await teardownChildSession({
                client: requireDreamClient(deps.client),
                sessionId: childSessionId,
                sessionDirectory: deps.sessionDirectory,
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] retrospective",
                log,
            });
    }
}

/** The generic agentic-task path (prompt + child session + per-task model),
 *  with lease renewal → abort-on-loss and maintain-docs protected-region enforce. */
async function runAgenticTask(
    config: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        recordRun: (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: {
                    written: number;
                    deleted: number;
                    archived: number;
                    merged: number;
                } | null;
                progress?: string | null;
                banked?: number;
                failure?: DreamRunFailureDetail;
                backlogAfter?: { pending: number; total: number };
            },
        ) => void;
        computeMemoryDelta: (
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ) => { written: number; deleted: number; archived: number; merged: number } | null;
        reportProgress: (processed: number, refused?: number) => void;
        onBudgetUpdate: (state: { spent: number; finalizeFired: boolean }) => void;
        leaseAcquisition: LeaseAcquisition;
        moduleRoute?: DreamerModuleRoute;
    },
): Promise<TaskExecOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent, onBudgetUpdate } = helpers;
    const task = config.task as DreamingTask;
    const docsDir = deps.sessionDirectory;
    const invocationStartedAt = Date.now();
    const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;

    const maintainDocsSnapshot =
        task === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
    const docsHashes = task === "maintain-docs" ? docsBaseHashes(docsDir) : undefined;
    const storedAnchor = getTaskScheduleState(db, projectIdentity, config.task)?.taskStateJson;
    let anchor: string | undefined;
    try {
        anchor = JSON.parse(storedAnchor ?? "null")?.head;
    } catch {
        /* legacy task state */
    }
    const changes = task === "maintain-docs" ? docsChangeSet(docsDir, anchor) : null;
    const existingDocs =
        task === "maintain-docs"
            ? {
                  architecture: existsSync(`${docsDir}/ARCHITECTURE.md`),
                  structure: existsSync(`${docsDir}/STRUCTURE.md`),
              }
            : undefined;

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeat = startLeaseHeartbeat(
        db,
        holderId,
        leaseKey,
        () => {
            leaseLost = true;
            abortController.abort();
        },
        ctx.leaseAcquisition,
    );

    let childSessionId: string | null = null;
    let promptSettled = false;
    let expiredArchived = 0;
    try {
        // Curate owns the TTL lifecycle transition. It runs after the memory-domain
        // lease heartbeat starts and uses the same authority-specific archive path
        // as curate's ctx_memory operations.
        let curateMemories: ReturnType<typeof loadActiveMemoryPromptMemories> | undefined;
        let curateCategory: CurateMemoryCategory | undefined;
        if (task === "curate") {
            expiredArchived = await archiveExpiredMemories({
                db,
                projectIdentity,
                holderId,
                leaseKey,
                leaseAcquisition: helpers.leaseAcquisition,
                moduleRoute: helpers.moduleRoute,
            });
            if (leaseLost) throw new Error("Dream lease lost during expired-memory archive");
            const scope = beginCurateCategoryRun(
                db,
                projectIdentity,
                loadActiveMemoryPromptMemories(db, projectIdentity),
            );
            curateMemories = scope?.memories ?? [];
            curateCategory = scope?.category;
            log(
                `[dreamer] curate pool: category=${curateCategory ?? "none"} in_scope=${curateMemories.length} expired_archived=${expiredArchived}`,
            );
            if (curateMemories.length === 0) {
                const progress =
                    expiredArchived > 0
                        ? formatExpiredArchiveProgress(expiredArchived)
                        : "curate: no populated project-memory category";
                helpers.recordRun("completed", null, {
                    memoryChanges: helpers.computeMemoryDelta(memoryBefore),
                    progress,
                });
                return { status: "completed", detail: progress };
            }
        }

        if (task === "maintain-docs" && !changes) {
            const reason = "no relevant commits or no git repository";
            helpers.recordRun("completed", null, { progress: reason });
            return { status: "completed", detail: reason };
        }
        if (task === "maintain-docs" && changes && (changes.unchanged || !changes.relevant)) {
            const reason = changes.unchanged
                ? "no commits since last run"
                : "diff does not describe a documented area";
            helpers.recordRun("completed", null, { progress: reason });
            return {
                status: "completed",
                detail: reason,
                schedulePatch: { taskStateJson: JSON.stringify({ head: changes.head }) },
            };
        }
        if (task === "maintain-docs" && hasCurrentDocsProposal(docsDir)) {
            const reason = "pending proposal matches current docs";
            helpers.recordRun("completed", null, { progress: reason });
            return {
                status: "completed",
                detail: reason,
                ...(changes
                    ? { schedulePatch: { taskStateJson: JSON.stringify({ head: changes.head }) } }
                    : {}),
            };
        }
        const curateChunks = curateMemories
            ? chunkCurateMemories(
                  curateMemories,
                  Math.max(
                      4000,
                      Math.floor(resolveRetrospectiveUsableInputTokens(config, deps) * 2),
                  ),
              )
            : [];
        const batches =
            task === "curate"
                ? curateChunks
                : [{ memories: [] as CuratePromptMemory[], crossChunkCandidates: [] as string[] }];
        const completedActions: string[] = [];
        const proposedActions: string[] = [];
        let curateRefused = 0;
        let run: { output: unknown[]; validated: string | CurateValidatedOutput } = {
            output: [],
            validated: "",
        };
        for (const batch of batches) {
            const taskPrompt = buildDreamTaskPrompt(task, {
                projectPath: projectIdentity,
                lastDreamAt: lastRunAt ? String(lastRunAt) : null,
                existingDocs,
                docsChangeSet: changes?.text,
                docsContents:
                    task === "maintain-docs"
                        ? {
                              architecture: existingDocs?.architecture
                                  ? readFileSync(`${docsDir}/ARCHITECTURE.md`, "utf8")
                                  : "(missing)",
                              structure: existingDocs?.structure
                                  ? readFileSync(`${docsDir}/STRUCTURE.md`, "utf8")
                                  : "(missing)",
                          }
                        : undefined,
                docsBudget: config.docsMaxTokens ?? 12000,
                docsCurrentTokens: maintainDocsSnapshot
                    ? Math.ceil([...maintainDocsSnapshot.values()].join("").length / 3.5)
                    : 0,
                curate:
                    curateMemories && curateCategory
                        ? {
                              category: curateCategory,
                              memories: batch.memories,
                              crossChunkCandidates: batch.crossChunkCandidates,
                          }
                        : undefined,
            });
            if (deps.hiddenCompletionExecutor) {
                const hidden = await runHiddenSingleShotPrompt({
                    executor: deps.hiddenCompletionExecutor,
                    parentSessionId: parent ?? undefined,
                    sessionDirectory: docsDir,
                    agent: task === "maintain-docs" ? DREAMER_DOCS_AGENT : DREAMER_AGENT,
                    system:
                        task === "maintain-docs"
                            ? MAINTAIN_DOCS_SYSTEM_PROMPT
                            : CURATE_SYSTEM_PROMPT,
                    prompt: taskPrompt,
                    title: `magic-context-dream-${task}`,
                    callContext: `dreamer:${task}`,
                    metadata: { tokenBudget: config.tokenBudget, onBudgetUpdate },
                    allowEmpty: task === "curate",
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: task === "curate" ? (config.language ?? deps.language) : undefined,
                    timeoutMs: Math.min(
                        Math.max(0, deadline - Date.now()),
                        config.timeoutMinutes * 60 * 1000,
                    ),
                    signal: abortController.signal,
                    parse: (text, completion): string | CurateValidatedOutput => {
                        if (task !== "curate") return text;
                        const memoryOperations = inspectCurateMemoryOperations(completion.messages);
                        if (text) validateCurateAssistantText(text);
                        if (
                            memoryOperations.totalCalls > 0 &&
                            memoryOperations.completedActions.length === 0 &&
                            memoryOperations.proposedActions.length === 0
                        )
                            throw new Error("Curate returned no completed ctx_memory tool result.");
                        if (
                            !text &&
                            memoryOperations.completedActions.length === 0 &&
                            memoryOperations.proposedActions.length === 0
                        )
                            throw new Error("Dreamer returned no assistant output.");
                        return { text: text || null, memoryOperations };
                    },
                });
                childSessionId = hidden.childSessionId;
                run = { output: hidden.completion.messages ?? [], validated: hidden.validated };
                promptSettled = true;
            } else {
                const createResponse = await createChildSessionWithFence({
                    client: requireDreamClient(deps.client),
                    db,
                    parentSessionId: parent ?? undefined,
                    title: `magic-context-dream-${task}`,
                    directory: docsDir,
                });
                const created = shared.normalizeSDKResponse(
                    createResponse,
                    null as { id?: string } | null,
                    {
                        preferResponseOnMissingData: true,
                    },
                );
                childSessionId = typeof created?.id === "string" ? created.id : null;
                if (!childSessionId) throw new Error("Dreamer could not create its child session.");
                const sessionId = childSessionId;

                const remainingMs = Math.max(0, deadline - Date.now());
                run = await shared.promptSyncWithValidatedOutputRetry(
                    requireDreamClient(deps.client),
                    {
                        path: { id: sessionId },
                        query: { directory: docsDir },
                        body: {
                            // Each agentic task gets its OWN scoped agent + system prompt so
                            // it never sees another task's tools/rules: curate runs on the
                            // base `dreamer` (ctx_memory only, no codebase tools);
                            // maintain-docs uses a locked read-only agent; the host validates final text.
                            agent: task === "maintain-docs" ? DREAMER_DOCS_AGENT : DREAMER_AGENT,
                            system:
                                task === "maintain-docs"
                                    ? MAINTAIN_DOCS_SYSTEM_PROMPT
                                    : withContentLanguageDirective(
                                          CURATE_SYSTEM_PROMPT,
                                          config.language ?? deps.language,
                                      ),
                            ...modelBodyField(config.model),
                            parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                        },
                    },
                    {
                        timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                        signal: abortController.signal,
                        fallbackModels: config.fallbackModels,
                        callContext: `dreamer:${task}`,
                        transport: shared.createPromptAsyncTransport(
                            requireDreamClient(deps.client),
                            sessionId,
                            { tokenBudget: config.tokenBudget, onBudgetUpdate },
                        ),
                        fetchOutput: async () => {
                            const messagesResponse = await requireDreamClient(
                                deps.client,
                            ).session.messages({
                                path: { id: sessionId },
                                query: {
                                    directory: docsDir,
                                    // Curate can use up to 150 steps, so its applied-operation
                                    // count must not be truncated to the newest 50 messages.
                                    ...(task === "curate" ? {} : { limit: 50 }),
                                },
                            });
                            return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                                preferResponseOnMissingData: true,
                            });
                        },
                        validateOutput: (messages): string | CurateValidatedOutput => {
                            const text = extractLatestAssistantText(messages);
                            if (task !== "curate") {
                                if (!text) throw new Error("Dreamer returned no assistant output.");
                                return text;
                            }

                            const memoryOperations = inspectCurateMemoryOperations(messages);
                            if (text) validateCurateAssistantText(text);
                            if (
                                memoryOperations.completedActions.length > 0 ||
                                memoryOperations.proposedActions.length > 0
                            ) {
                                return { text, memoryOperations };
                            }
                            if (!text) throw new Error("Dreamer returned no assistant output.");
                            if (memoryOperations.totalCalls > 0) {
                                throw new Error(
                                    "Curate returned no completed ctx_memory tool result.",
                                );
                            }
                            return { text, memoryOperations };
                        },
                    },
                );
                promptSettled = true;
            }
            if (task === "curate") {
                completedActions.push(
                    ...(run.validated as CurateValidatedOutput).memoryOperations.completedActions,
                );
                proposedActions.push(
                    ...(run.validated as CurateValidatedOutput).memoryOperations.proposedActions,
                );
                curateRefused += takeCurateSafetyRefusalCount(childSessionId ?? "");
            }
            if (childSessionId && !deps.hiddenCompletionExecutor) {
                await teardownChildSession({
                    client: requireDreamClient(deps.client),
                    sessionId: childSessionId,
                    sessionDirectory: docsDir,
                    promptSettled,
                    privacySensitive: true,
                    context: `[dreamer] ${task}`,
                    log,
                });
                childSessionId = null;
            }
        }
        if (task === "curate")
            run.validated = {
                text: null,
                memoryOperations: {
                    totalCalls: completedActions.length + proposedActions.length,
                    completedActions,
                    proposedActions,
                },
            };

        if (leaseLost) throw new Error("Dream lease lost during task");

        if (curateRefused > 0) {
            helpers.reportProgress(curateRefused, curateRefused);
            log(`[dreamer] curate safety summary: refused=${curateRefused}`);
        }

        if (parent) {
            recordChildInvocation({
                db,
                parentSessionId: parent,
                harness: "opencode",
                subagent: "dreamer",
                task,
                startedAt: invocationStartedAt,
                status: "completed",
                messages: run.output,
            });
        }

        if (task === "maintain-docs" && docsHashes && changes) {
            try {
                if (run.validated === "[]") {
                    helpers.recordRun("completed", null, { progress: "no corrections proposed" });
                    return {
                        status: "completed",
                        detail: "no corrections proposed",
                        schedulePatch: { taskStateJson: JSON.stringify({ head: changes.head }) },
                    };
                }
                const path = writeDocsProposal(
                    docsDir,
                    String(run.validated),
                    config.docsMaxTokens ?? 12000,
                    docsHashes,
                    changes.head,
                );
                helpers.recordRun("completed", null, { progress: `proposal: ${path}` });
                return {
                    status: "completed",
                    detail: `proposal: ${path}`,
                    schedulePatch: { taskStateJson: JSON.stringify({ head: changes.head }) },
                };
            } catch (error) {
                const reason = `maintain-docs failed validation: ${String(error)}`;
                log(`[dreamer] ${reason}`);
                helpers.recordRun("failed", reason);
                return { status: "failed", error: reason };
            }
        }

        const curateOutput =
            task === "curate" ? (run.validated as CurateValidatedOutput) : undefined;
        const curateScopeProgress =
            task === "curate" && curateCategory && curateMemories
                ? `curate: ${curateCategory} (${curateMemories.length})`
                : null;
        const progress = [
            curateScopeProgress,
            expiredArchived > 0 ? formatExpiredArchiveProgress(expiredArchived) : null,
            curateOutput && curateOutput.memoryOperations.completedActions.length > 0
                ? formatCurateMemoryOperations(curateOutput.memoryOperations.completedActions)
                : null,
            curateOutput && curateOutput.memoryOperations.proposedActions.length > 0
                ? formatCurateMemoryOperations(
                      curateOutput.memoryOperations.proposedActions,
                      "proposed",
                  )
                : null,
            curateRefused > 0 ? `curate: refused ${curateRefused} unsafe mutation(s)` : null,
        ]
            .filter((value): value is string => Boolean(value))
            .join("; ");
        const curateCount =
            task === "curate" && curateCategory
                ? loadActiveMemoryPromptMemories(db, projectIdentity).filter(
                      (memory) =>
                          curateCategoryForMemoryCategory(memory.category) === curateCategory,
                  ).length
                : undefined;
        const curateBacklog =
            curateCount !== undefined && curateCategory
                ? {
                      pending: curateCount,
                      total: curateCount,
                      category: curateCategory,
                  }
                : undefined;
        helpers.recordRun("completed", null, {
            memoryChanges: helpers.computeMemoryDelta(memoryBefore),
            progress: progress || null,
            backlogAfter: curateBacklog,
        });
        return {
            status: "completed",
            ...(progress ? { detail: progress } : {}),
            ...(curateBacklog ? { backlog: curateBacklog } : {}),
            ...(curateCategory
                ? {
                      schedulePatch: {
                          taskStateJson: curateTaskStateAfterSuccess(
                              db,
                              projectIdentity,
                              curateCategory,
                          ),
                      },
                  }
                : {}),
        };
    } finally {
        heartbeat.stop();
        if (childSessionId) takeCurateSafetyRefusalCount(childSessionId);
        if (!deps.hiddenCompletionExecutor)
            await teardownChildSession({
                client: requireDreamClient(deps.client),
                sessionId: childSessionId,
                sessionDirectory: docsDir,
                promptSettled,
                privacySensitive: true,
                context: `[dreamer] ${task}`,
                log,
            });
    }
}
