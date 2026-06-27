import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
    DREAMER_AGENT,
    DREAMER_DOCS_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
} from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { RawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { getCompartmentEvents } from "../compartment-events";
import {
    getMemoriesByProject,
    getMemoryCountsByStatus,
    getMemoryVerifications,
    type Memory,
} from "../memory";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { runClassify } from "./classify";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { peekLeaseHolderAndExpiry, startLeaseHeartbeat } from "./lease";
import {
    enforceMaintainDocsProtectedRegions,
    snapshotMaintainDocsFiles,
} from "./maintain-docs-protected-enforcement";
import { mapMemories } from "./map-memories";
import { promotePrimers } from "./promote-primers";
import { refreshPrimers } from "./refresh-primers";
import {
    applyRetrospectiveLearnings,
    parseRetrospectiveLearnings,
} from "./retrospective-learnings";
import {
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import { type DreamRunMemoryChanges, insertDreamRun } from "./storage-dream-runs";
import {
    getTaskScheduleState,
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";
import {
    buildDreamTaskPrompt,
    buildFrictionGatePrompt,
    buildRetrospectivePrompt,
    CURATE_SYSTEM_PROMPT,
    type CuratePromptMemory,
    FRICTION_GATE_SYSTEM_PROMPT,
    MAINTAIN_DOCS_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
    type RetrospectivePromptEvent,
} from "./task-prompts";

import type { DreamTaskRuntimeConfig, TaskExecOutcome, TaskExecutor } from "./task-scheduler";
import { runVerify } from "./verify";

export interface DreamTaskExecutorDeps {
    client: PluginContext["client"];
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
}
/** A failed task either hot-retries (transient: provider/network/rate-limit/
 *  timeout/abort/lease/busy) or advances to the next cron slot (permanent:
 *  model-not-found, validation, parse). Classify off the error shape. */
function classifyFailure(error: unknown): { transient: boolean; brief: string } {
    const described = describeError(error);
    const brief = described.brief;
    const name = error instanceof Error ? error.name : "";
    const combined = `${name} ${brief}`.toLowerCase();
    const transient =
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

/**
 * Build the TaskExecutor the v2 scheduler drives. The scheduler owns the keyed
 * domain lease + holderId and hands them in; this executor runs one task's actual
 * work (LLM loop / specialized runner), renews the lease during the run, aborts
 * if the lease is lost, and writes one per-task dream_runs telemetry row.
 */
export function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor {
    // Memoize the PROMISE, not a flag+value. Domain groups run concurrently
    // (task-scheduler runs them under Promise.all), so several tasks call this at
    // once. A flag-then-await memo set the "resolved" flag BEFORE the session.list
    // await completed, so a concurrent caller in that window read the still-unset
    // value (undefined) and created its child session with no parentID — which is
    // why evaluate-smart-notes children consistently came back parent_id NULL
    // (top-level in the picker) while the memory-domain group won the race. A
    // single shared promise makes every caller await the same populated result.
    let parentSessionIdPromise: Promise<string | undefined> | undefined;

    const resolveParentSessionId = (): Promise<string | undefined> => {
        if (!parentSessionIdPromise) {
            parentSessionIdPromise = (async () => {
                try {
                    const listResponse = await deps.client.session.list({
                        query: { directory: deps.sessionDirectory },
                    });
                    const sessions = shared.normalizeSDKResponse(
                        listResponse,
                        [] as { id?: string }[],
                        { preferResponseOnMissingData: true },
                    );
                    return sessions?.find((s) => typeof s?.id === "string")?.id;
                } catch {
                    return undefined;
                }
            })();
        }
        return parentSessionIdPromise;
    };

    return async (
        config: DreamTaskRuntimeConfig,
        ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    ): Promise<TaskExecOutcome> => {
        const { db, projectIdentity, holderId, leaseKey } = ctx;
        const startedAt = Date.now();
        const deadline = startedAt + config.timeoutMinutes * 60 * 1000;
        const parent = await resolveParentSessionId();

        const recordRun = (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: ReturnType<typeof computeMemoryDelta>;
                smartNotesSurfaced?: number;
                smartNotesPending?: number;
            },
        ): void => {
            try {
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
                            ...(error ? { error } : {}),
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
            if (config.task === "review-user-memories") {
                const result = await reviewUserMemories({
                    db,
                    client: deps.client,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    promotionThreshold: config.promotionThreshold ?? 3,
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
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] map-memories: mapped=${result.mapped} independent=${result.independent} batches=${result.batches} remaining=${result.remaining}`,
                );
                return { status: "completed" };
            }

            if (config.task === "verify" || config.task === "verify-broad") {
                const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);
                await runVerify({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    forceBroad: config.task === "verify-broad",
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                });
                recordRun("completed", null, {
                    memoryChanges: computeMemoryDelta(memoryBefore),
                });
                return { status: "completed" };
            }

            if (config.task === "classify-memories") {
                // Cache-neutral metadata write (classified_at/importance/scope/
                // shareable) — no memory_changes telemetry (status counts unchanged).
                const result = await runClassify({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] classify-memories: stage=${result.stage} classified=${result.classified} changed=${result.changed} chunks=${result.chunks}`,
                );
                return { status: "completed" };
            }

            if (config.task === "promote-primers") {
                const result = await promotePrimers({
                    db,
                    client: deps.client,
                    projectIdentity,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    promotionThreshold: config.promotionThreshold ?? 2,
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
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    rawProviderFactory: deps.primerRawProviderFactory,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`,
                );
                return { status: "completed" };
            }

            if (config.task === "evaluate-smart-notes") {
                const result = await evaluateSmartNotes({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
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
                    deps,
                    deadline,
                    parent,
                    invocationStartedAt: startedAt,
                });
                recordRun("completed", null, {
                    memoryChanges: computeMemoryDelta(memoryBefore),
                });
                // Advance the content watermark on completion (incl. clean "n"
                // runs) so the next run only scans newer messages.
                return {
                    status: "completed",
                    schedulePatch:
                        retro.retrospectiveWatermarkMs != null
                            ? { retrospectiveWatermarkMs: retro.retrospectiveWatermarkMs }
                            : undefined,
                };
            }

            // Agentic tasks: verify / curate / maintain-docs.
            return await runAgenticTask(config, ctx, {
                deps,
                deadline,
                parent,
                recordRun,
                computeMemoryDelta,
            });
        } catch (error) {
            const { transient, brief } = classifyFailure(error);
            recordRun("failed", brief);
            log(`[dreamer] task ${config.task} failed (transient=${transient}): ${brief}`);
            return { status: "failed", transient, error: brief };
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

async function runRetrospectiveTask(
    config: DreamTaskRuntimeConfig,
    ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        invocationStartedAt: number;
    },
): Promise<{ retrospectiveWatermarkMs: number | null }> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const provider = resolveRetrospectiveProvider(deps, db, projectIdentity);
    if (!provider) {
        log("[dreamer] retrospective: no raw provider available — clean no-op");
        return { retrospectiveWatermarkMs: null };
    }

    // Content watermark (max message ts actually scanned) — NOT lastRunAt, which
    // is schedule-completion time and would skip a message that arrived mid-run.
    const watermarkMs =
        getTaskScheduleState(db, projectIdentity, config.task)?.retrospectiveWatermarkMs ?? 0;

    const scan = await readRetrospectiveScanWindow(
        provider,
        projectIdentity,
        watermarkMs,
        RETROSPECTIVE_OVERLAP_USER_LINES,
    );
    const messages = withGlobalOrdinals(scan.messages);
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
        log("[dreamer] retrospective: no user messages in window");
        return { retrospectiveWatermarkMs: scan.maxScannedTs };
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
        return { retrospectiveWatermarkMs: scan.maxScannedTs };
    }

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeat = startLeaseHeartbeat(db, holderId, leaseKey, () => {
        leaseLost = true;
        abortController.abort();
    });

    let childSessionId: string | null = null;
    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(parent ? { parentID: parent } : {}),
                title: "magic-context-dream-retrospective",
            },
            query: { directory: deps.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Retrospective could not create its child session.");
        const sessionId = childSessionId;

        // One child, two turns sharing the same session — OpenCode applies the
        // per-prompt `body.system`, so turn 1 runs the cheap gate system and turn
        // 2 (only on a hit) runs the deepen system. fetchOutput returns the whole
        // child branch, so recording the LAST run's output covers both turns'
        // token usage without double counting.
        const runChildTurn = async (system: string, userText: string) => {
            const remainingMs = Math.max(0, deadline - Date.now());
            return shared.promptSyncWithValidatedOutputRetry(
                deps.client,
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
                    fetchOutput: async () => {
                        const messagesResponse = await deps.client.session.messages({
                            path: { id: sessionId },
                            query: { directory: deps.sessionDirectory, limit: 50 },
                        });
                        return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                            preferResponseOnMissingData: true,
                        });
                    },
                    validateOutput: (outputMessages) => {
                        const text = extractLatestAssistantText(outputMessages);
                        if (!text) throw new Error("Retrospective child returned no output.");
                        return text;
                    },
                },
            );
        };

        const finish = (
            run: { output: unknown[] } | null,
            watermark: number | null,
        ): { retrospectiveWatermarkMs: number | null } => {
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
            return { retrospectiveWatermarkMs: watermark };
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
        // Apply learnings AND record the processed-window key in ONE transaction
        // so a crash between them can't leave the window un-recorded (which would
        // re-deepen + risk a duplicate observation next run, since
        // insertUserMemoryCandidates has no unique key). Both are plain DB writes.
        const applied = db.transaction(
            (): ReturnType<typeof applyRetrospectiveLearnings> | null => {
                if (!peekLeaseHolderAndExpiry(db, holderId, leaseKey)) {
                    leaseLost = true;
                    return null;
                }
                const result = applyRetrospectiveLearnings({
                    db,
                    projectIdentity,
                    sourceSessionId,
                    learnings,
                    userMemoryCollectionEnabled: deps.userMemoryCollectionEnabled === true,
                    // Source user lines for the near-transcription reject: a learning
                    // that echoes a long verbatim run of the user's words is a
                    // transcription.
                    sourceUserTexts: userMessages
                        .map((message) => message.text ?? "")
                        .filter((text) => text.length > 0),
                });
                recordRetrospectiveWindowProcessed(db, projectIdentity, windowKey);
                return result;
            },
        )();
        if (leaseLost || !applied) throw new Error("Dream lease lost during retrospective commit");
        log(
            `[dreamer] retrospective: flagged=${flagged.length} learnings=${learnings.length} memory=${applied.memoryWritten} observations=${applied.observationsInserted} dropped=${applied.observationsDropped} rejected=${applied.rejected.length}`,
        );
        return finish(deepenRun, scan.maxScannedTs);
    } finally {
        heartbeat.stop();
        // PRIVACY: a retrospective child's prompt embeds raw cross-session user
        // text from the friction window. Always delete the child — even on
        // failure, and even when keep_subagents is set. The debug-retention flag
        // must never persist another session's raw user text on disk.
        if (childSessionId) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

/** The generic agentic-task path (prompt + child session + per-task model),
 *  with lease renewal → abort-on-loss and maintain-docs protected-region enforce. */
async function runAgenticTask(
    config: DreamTaskRuntimeConfig,
    ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
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
            },
        ) => void;
        computeMemoryDelta: (
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ) => { written: number; deleted: number; archived: number; merged: number } | null;
    },
): Promise<TaskExecOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const task = config.task as DreamingTask;
    const docsDir = deps.sessionDirectory;
    const invocationStartedAt = Date.now();
    const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;

    const maintainDocsSnapshot =
        task === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
    const existingDocs =
        task === "maintain-docs"
            ? {
                  architecture: existsSync(`${docsDir}/ARCHITECTURE.md`),
                  structure: existsSync(`${docsDir}/STRUCTURE.md`),
              }
            : undefined;
    const userMemories =
        task === "curate"
            ? getActiveUserMemories(db).map((um) => ({ id: um.id, content: um.content }))
            : undefined;

    // verify / verify-broad / classify-memories now run via their own non-agentic
    // manifest runners and never reach runAgenticTask. The agentic path handles
    // curate / maintain-docs only.
    let curateMemories: ReturnType<typeof loadActiveMemoryPromptMemories> | undefined;
    if (task === "curate") {
        curateMemories = loadActiveMemoryPromptMemories(db, projectIdentity);
        log(`[dreamer] curate pool: in_scope=${curateMemories.length}`);
    }

    const taskPrompt = buildDreamTaskPrompt(task, {
        projectPath: projectIdentity,
        lastDreamAt: lastRunAt ? String(lastRunAt) : null,
        existingDocs,
        userMemories,
        curate: curateMemories ? { memories: curateMemories } : undefined,
    });

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeat = startLeaseHeartbeat(db, holderId, leaseKey, () => {
        leaseLost = true;
        abortController.abort();
    });

    let childSessionId: string | null = null;
    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(parent ? { parentID: parent } : {}),
                title: `magic-context-dream-${task}`,
            },
            query: { directory: docsDir },
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
        const run = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: sessionId },
                query: { directory: docsDir },
                body: {
                    // Each agentic task gets its OWN scoped agent + system prompt so
                    // it never sees another task's tools/rules: curate runs on the
                    // base `dreamer` (ctx_memory only, no codebase tools);
                    // maintain-docs runs on `dreamer-docs` (file read/write/bash, no
                    // memory machinery).
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
                fetchOutput: async () => {
                    const messagesResponse = await deps.client.session.messages({
                        path: { id: sessionId },
                        query: { directory: docsDir, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("Dreamer returned no assistant output.");
                    return text;
                },
            },
        );

        if (leaseLost) throw new Error("Dream lease lost during task");

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

        if (task === "maintain-docs" && maintainDocsSnapshot && maintainDocsSnapshot.size > 0) {
            try {
                enforceMaintainDocsProtectedRegions({ docsDir, snapshot: maintainDocsSnapshot });
            } catch (e) {
                log(`[dreamer] maintain-docs protected-region enforcement failed: ${e}`);
            }
        }

        helpers.recordRun("completed", null, {
            memoryChanges: helpers.computeMemoryDelta(memoryBefore),
        });
        return { status: "completed" };
    } finally {
        heartbeat.stop();
        // These children contain full memory-pool snapshots or generated project
        // docs context, so debug-retention must not keep them on disk after a run.
        if (childSessionId) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}
