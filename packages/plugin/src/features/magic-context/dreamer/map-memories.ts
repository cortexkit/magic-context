import { createHash } from "node:crypto";

import { DREAMER_MEMORY_MAPPER_AGENT } from "../../../agents/dreamer";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
} from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../../shared/child-session-teardown";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { isRecord } from "../../../shared/record-type-guard";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getMemoryVerifications,
    getUnmappedMemoryIds,
    type MemoryMappingOrigin,
    normalizeVerificationFiles,
    recordMemoryMapping,
} from "../memory";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import { failedInvocationStatus, recordChildInvocation } from "../subagent-token-capture";
import { readFailedChildMessages } from "./failed-invocation-evidence";
import { DREAMER_FIRST_OUTPUT_TIMEOUT_MS, runHiddenSingleShotPrompt } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertNoDuplicateManifestIds } from "./manifest-parser";
import {
    buildMapMemoriesPrompt,
    extractMemoryCandidatePaths,
    MAP_MEMORIES_SYSTEM_PROMPT,
    type MapMemoryInput,
    type ParsedMemoryMapping,
    parseMapMemoriesManifest,
    parsePartialMapMemoriesManifest,
    seedIdentifierCandidates,
    validateMapMemoriesManifest,
} from "./map-memories-prompt";
import { isDirectiveShapedProjectRule } from "./memory-claim-safety";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    getModuleMemoryIdentities,
} from "./module-apply";
import { getDreamState, setDreamState } from "./storage-dream-state";
import { DreamTokenBudgetExceeded } from "./token-budget";

/**
 * map-memories: ONE-TIME-style backfill that locates the backing file(s) for
 * every UNMAPPED project memory (or marks it file-independent), so verify can
 * select memories whose backing files changed since their last verification.
 *
 * Self-maintaining: the gate is "unmapped memories exist", so the expensive
 * initial pool backfill happens once (across batches), then only the cheap
 * trickle of newly-added memories is mapped on later runs.
 *
 * Shared files can reduce reads, but cumulative prompt replay, not just peak
 * context, must fit the token budget. Small batches bank progress before the
 * next investigation and leave unmapped memories resumable.
 * Closed per-memory decisions survive an interrupted child. Undecided memories
 * remain unmapped and repeated failures back off without blocking new work.
 */

// Five memories at three investigation calls plus one answer each need about
// 20 steps. Even ten calls plus an answer each fit the mapper agent's 60-step
// limit, leaving room to finalize output rather than aborting an oversized batch.
// Timeouts retry smaller groups: five becomes 2+2+1, and two becomes 1+1.
const MAP_BATCH_SIZE = 5;

/**
 * Minimum wall-clock budget for one agentic mapping batch. Keep the existing
 * four-minute floor even with smaller batches: reducing the memory count does
 * not bound the latency of a slow provider or an individual tool investigation.
 * Timeout splits each receive this same floor, if the task deadline permits;
 * otherwise the unmapped remainder resumes on a later run.
 */
export const MAP_BATCH_FLOOR_MS = 240_000;

/** Split timed-out multi-memory batches; stop after two consecutive singleton
 * timeouts with no committed mappings. */
const CONSECUTIVE_TIMEOUT_LIMIT = 2;

/** Cap on already-mapped file-independent rows re-queued per run. A silent
 *  parse miss used to persist `independent=true` for memories that name real
 *  files; those rows never enter verify. Heal at most one extra batch so new
 *  unmapped memories stay first in line. */
export const MAX_INDEPENDENT_REQUEUE_PER_RUN = MAP_BATCH_SIZE;

export interface MapMemoriesArgs {
    db: Database;
    client?: PluginContext["client"];
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    /** How long a model may stay silent before the chain moves to the next model.
     *  Defaults to DREAMER_FIRST_OUTPUT_TIMEOUT_MS. */
    firstOutputTimeoutMs?: number;
    tokenBudget?: number;
    onBudgetUpdate?: (state: { spent: number; finalizeFired: boolean }) => void;
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number) => void;
}

export interface MapMemoriesResult {
    failure?: unknown;
    failureStage?: "child-start" | "prompt" | "apply";
    deferred?: boolean;
    mapped: number;
    independent: number;
    /** Batches whose mappings were durably committed, not merely attempted. */
    batches: number;
    remaining: number;
    complete: boolean;
    /** Why a resumable run stopped before draining the selected input. */
    stopReason?: "deadline" | "timeout-circuit-breaker";
}

type MapBatchFailureClass = "timeout" | "other";

interface MapBatchOutcome {
    mapped: number;
    independent: number;
    committedIds: number[];
    /** A response with a closing root element may still omit trailing ids. Those
     * ids get one targeted in-run retry; if it omits them again, they stay unmapped
     * for the next resumable run. */
    requeue?: MapMemoryInput[];
    /** Interrupted batches may still bank closed per-memory decisions. */
    failure?: {
        error?: unknown;
        stage?: "child-start" | "prompt" | "apply";
        class: MapBatchFailureClass;
        elapsedMs: number;
    };
}

interface MappingRetry {
    content: string;
    failures: number;
    deferUntil: number;
}

function retryKey(project: string): string {
    return `map-memories:retry:${project}`;
}

function readRetries(db: Database, project: string): Record<string, MappingRetry> {
    try {
        const parsed: unknown = JSON.parse(getDreamState(db, retryKey(project)) ?? "{}");
        if (!isRecord(parsed)) return {};
        const retries: Record<string, MappingRetry> = {};
        for (const [id, value] of Object.entries(parsed)) {
            if (
                isRecord(value) &&
                typeof value.content === "string" &&
                typeof value.failures === "number" &&
                typeof value.deferUntil === "number"
            ) {
                retries[id] = {
                    content: value.content,
                    failures: value.failures,
                    deferUntil: value.deferUntil,
                };
            }
        }
        return retries;
    } catch {
        return {};
    }
}

function contentKey(memory: MapMemoryInput): string {
    return createHash("sha256").update(`${memory.category}\n${memory.content}`).digest("hex");
}

function isDeferred(memory: MapMemoryInput, retries: Record<string, MappingRetry>): boolean {
    const retry = retries[memory.id];
    return !!retry && retry.content === contentKey(memory) && retry.deferUntil > Date.now();
}

function assistantText(messages: unknown[]): string | null {
    const joined = messages
        .filter(
            (message) =>
                isRecord(message) &&
                (message.role === "assistant" ||
                    (isRecord(message.info) && message.info.role === "assistant")),
        )
        .map(
            (message) =>
                extractLatestAssistantText([message]) ??
                (isRecord(message) && Array.isArray(message.content)
                    ? message.content
                          .filter(isRecord)
                          .filter((part) => part.type === "text" && typeof part.text === "string")
                          .map((part) => part.text)
                          .join("\n")
                    : ""),
        )
        .join("\n");
    return joined.trim() ? joined : null;
}

function currentManifest(text: string): string {
    // A retry model can replace invalid output with a new <mappings> document
    // in the same session. Validate that document, not the earlier rejected one.
    const start = text.lastIndexOf("<mappings>");
    return start < 0 ? text : text.slice(start);
}

export function parseMapMemoriesCompletion(
    text: string,
    completion: { messages?: unknown[] },
    expectedIds: ReadonlySet<number>,
): ReturnType<typeof validateMapMemoriesManifest> {
    // A self-contained final reply replaces earlier incremental or rejected text.
    // A closing fragment still needs the transcript's opening tag and decisions.
    const source = /<mappings\b/i.test(text)
        ? text
        : assistantText(completion.messages ?? []) || text;
    return validateMapMemoriesManifest(currentManifest(source), expectedIds);
}

export function validateClientMapMemories(
    messages: unknown[],
    expectedIds: ReadonlySet<number>,
): ReturnType<typeof validateMapMemoriesManifest> {
    if (hasLengthCappedOutput(messages)) {
        throw new Error("map-memories returned length-capped output");
    }
    const raw = assistantText(messages);
    if (raw == null) {
        throw new Error("map-memories returned no output");
    }
    return validateMapMemoriesManifest(currentManifest(raw), expectedIds);
}

function logBatchUsage(messages: unknown[], committed: number, startedAt: number): void {
    const steps = messages.filter(
        (message) =>
            isRecord(message) &&
            (message.role === "assistant" ||
                (isRecord(message.info) && message.info.role === "assistant")),
    ).length;
    log(
        `[dreamer] map-memories batch: steps=${steps} committed=${committed} steps_per_memory=${committed ? (steps / committed).toFixed(2) : "n/a"} elapsed_ms=${Date.now() - startedAt}`,
    );
}

/** Evenly split the remaining deadline, but never starve an agentic mapping batch
 * below its floor. The caller first verifies that the remaining budget can fit the
 * floor, so the returned slice always fits the current deadline. */
export function computeMapBatchSliceMs(remainingMs: number, batchesRemaining: number): number {
    return Math.min(
        remainingMs,
        Math.max(MAP_BATCH_FLOOR_MS, Math.floor(remainingMs / batchesRemaining)),
    );
}

/** Our own slice expiry and the host client's request timer both count as
 * timeouts. Validation and provider failures remain ordinary per-batch retries. */
function isTimeoutClassError(error: unknown): boolean {
    return shared.isPromptTimeoutError(error);
}

/** Re-queue predicate: a file-independent mapping (sentinel, no real files)
 *  whose memory text names existing repo paths — the same seed heuristic the
 *  mapper already uses. That is the silent-corruption shape: a memory WITH
 *  backing files was persisted as independent. A legitimately-independent
 *  memory that names no existing path is a bystander and is left alone. */
export function shouldRequeueIndependentMapping(
    state: {
        hasSentinel: boolean;
        files: readonly string[];
        mappingOrigin?: MemoryMappingOrigin;
    },
    content: string,
    repoDir: string,
): boolean {
    if (!state.hasSentinel || state.files.length > 0) return false;
    // A host rejection is a durable disposition, not the mapper's unsupported
    // independent choice. It can be reopened by a content rewrite that clears
    // mappings, but retrying it every cron would recreate the rejected-path loop.
    if (state.mappingOrigin === "host_rejected_fallback") return false;
    return extractMemoryCandidatePaths(content, repoDir).length > 0;
}

function toMapInput(
    memory: { id: number; category: string; content: string },
    repoDir: string,
): MapMemoryInput {
    return {
        id: memory.id,
        category: memory.category,
        content: memory.content,
        candidates: extractMemoryCandidatePaths(memory.content, repoDir),
    };
}

/** Unmapped active memories first, then a bounded heal of corrupted
 *  independent rows. Exported so tests can assert the re-queue predicate
 *  without standing up a child session. */
export function selectMapMemoryInputs(
    db: Database,
    projectIdentity: string,
    repoDir: string,
    includeDeferred = false,
): MapMemoryInput[] {
    const active = getMemoriesByProject(db, projectIdentity);
    const activeIds = active.map((m) => m.id);
    const unmapped = new Set(getUnmappedMemoryIds(db, activeIds));
    const verifications = getMemoryVerifications(db, activeIds);

    const unmappedInputs = active
        .filter((m) => unmapped.has(m.id))
        .map((m) => toMapInput(m, repoDir));

    const requeue: MapMemoryInput[] = [];
    for (const memory of active) {
        if (unmapped.has(memory.id)) continue;
        const state = verifications.get(memory.id);
        if (!state) continue;
        if (!shouldRequeueIndependentMapping(state, memory.content, repoDir)) continue;
        requeue.push(toMapInput(memory, repoDir));
        if (requeue.length >= MAX_INDEPENDENT_REQUEUE_PER_RUN) break;
    }

    const retries = readRetries(db, projectIdentity);
    return [...unmappedInputs, ...requeue].filter(
        (memory) => includeDeferred || !isDeferred(memory, retries),
    );
}

export async function mapMemories(args: MapMemoriesArgs): Promise<MapMemoriesResult> {
    const result: MapMemoriesResult = {
        mapped: 0,
        independent: 0,
        batches: 0,
        remaining: 0,
        complete: true,
    };
    const allInputs = selectMapMemoryInputs(
        args.db,
        args.projectIdentity,
        args.sessionDirectory,
        true,
    );
    const retries = readRetries(args.db, args.projectIdentity);
    const activeIds = new Set(allInputs.map((memory) => String(memory.id)));
    for (const id of Object.keys(retries)) if (!activeIds.has(id)) delete retries[id];
    const inputs = allInputs.filter((memory) => !isDeferred(memory, retries));
    result.remaining = allInputs.length;
    result.complete = result.remaining === 0;
    if (inputs.length === 0) {
        if (allInputs.length > 0) result.deferred = true;
        return result;
    }

    const batches: Array<{ inputs: MapMemoryInput[]; isOmissionRetry: boolean }> = [];
    for (let i = 0; i < inputs.length; i += MAP_BATCH_SIZE) {
        batches.push({ inputs: inputs.slice(i, i + MAP_BATCH_SIZE), isOmissionRetry: false });
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        (reason) => abortController.abort(new Error(reason)),
        args.leaseAcquisition,
    );

    try {
        let consecutiveTimeouts = 0;
        let timeoutStreakElapsedMs: number[] = [];
        for (let i = 0; i < batches.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) {
                result.stopReason = "deadline";
                break;
            }
            // Do not start a batch that cannot receive a fair agentic slice. Its
            // mappings are host-committed, so stopping here preserves prior batches
            // and lets a later run continue with this untouched remainder.
            if (remainingMs < MAP_BATCH_FLOOR_MS) {
                result.stopReason = "deadline";
                log(
                    `[dreamer] map-memories: stopping before batch ${i + 1}/${batches.length} — remaining budget ${remainingMs}ms is below the ${MAP_BATCH_FLOOR_MS}ms batch floor; banking ${result.mapped + result.independent} mapping(s)`,
                );
                break;
            }
            const sliceMs = computeMapBatchSliceMs(remainingMs, batches.length - i);
            const batch = batches[i];
            if (!batch) break;
            const outcome = await mapOneBatch(args, batch.inputs, sliceMs, abortController.signal);
            if (outcome.failure) {
                result.failure = outcome.failure.error;
                result.failureStage = outcome.failure.stage;
            }
            const committed = outcome.mapped + outcome.independent;
            const committedIds = new Set(outcome.committedIds);
            runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
                for (const memory of batch.inputs) {
                    if (committedIds.has(memory.id)) {
                        delete retries[memory.id];
                        continue;
                    }
                    const content = contentKey(memory);
                    const prior = retries[memory.id];
                    const failures = (prior?.content === content ? prior.failures : 0) + 1;
                    retries[memory.id] = {
                        content,
                        failures,
                        deferUntil:
                            failures < 2
                                ? 0
                                : Date.now() + Math.min(24, 2 ** (failures - 2)) * 3_600_000,
                    };
                }
                setDreamState(args.db, retryKey(args.projectIdentity), JSON.stringify(retries));
            });
            result.mapped += outcome.mapped;
            result.independent += outcome.independent;
            result.remaining -= committed;
            if (committed > 0) {
                result.batches += 1;
                args.onProgress?.(result.mapped + result.independent);
            }
            if (outcome.requeue?.length) {
                if (!batch.isOmissionRetry) {
                    // A closed root proves this is an omission rather than a truncated
                    // prefix. Retry only the omitted tail once; repeat omissions stay
                    // unmapped so a later run can resume without an unbounded loop.
                    batches.push({
                        inputs: outcome.requeue.filter((memory) => !isDeferred(memory, retries)),
                        isOmissionRetry: true,
                    });
                    log(
                        `[dreamer] map-memories: committed ${committed}/${batch.inputs.length} mapping(s); requeueing ${outcome.requeue.length} omitted id(s) in a targeted retry`,
                    );
                } else {
                    log(
                        `[dreamer] map-memories: targeted retry still omitted ${outcome.requeue.length} id(s); leaving them unmapped for the next run`,
                    );
                }
            }

            if (outcome.failure?.class === "timeout" && batch.inputs.length > 1) {
                const unmapped = batch.inputs.filter((memory) => !committedIds.has(memory.id));
                const splitSize = Math.floor(batch.inputs.length / 2);
                const splits: typeof batches = [];
                for (let offset = 0; offset < unmapped.length; offset += splitSize) {
                    splits.push({
                        inputs: unmapped.slice(offset, offset + splitSize),
                        isOmissionRetry: batch.isOmissionRetry,
                    });
                }
                if (splits.length > 0) {
                    // Queue children before later work and include each in the batch
                    // count used to divide the deadline. Try these splits now, before
                    // backoff, to distinguish a slow memory from an oversized batch.
                    batches.splice(i + 1, 0, ...splits);
                    log(
                        `[dreamer] map-memories: splitting batch [${batch.inputs.map((memory) => memory.id).join(",")}] into ${splits.map((split) => split.inputs.length).join("+")} after timeout; retrying ${unmapped.length} uncommitted mapping(s)`,
                    );
                }
            }

            if (
                outcome.failure?.class === "timeout" &&
                batch.inputs.length === 1 &&
                committed === 0
            ) {
                consecutiveTimeouts += 1;
                timeoutStreakElapsedMs.push(outcome.failure.elapsedMs);
                if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                    result.stopReason = "timeout-circuit-breaker";
                    log(
                        `[dreamer] map-memories starvation: circuit breaker tripped after ${consecutiveTimeouts} consecutive batch timeouts with no committed mappings (investigation made no durable progress); per-batch elapsed [${timeoutStreakElapsedMs.join("ms, ")}ms] vs ${sliceMs}ms slice; stopping with ${result.remaining} mapping(s) remaining`,
                    );
                    break;
                }
            } else if (committed > 0 || outcome.failure?.class !== "timeout") {
                // A success or non-timeout failure should not poison the next
                // timeout streak; those preserve the existing retry-next-run path.
                consecutiveTimeouts = 0;
                timeoutStreakElapsedMs = [];
            }
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] map-memories: committed=${result.mapped + result.independent} mapped=${result.mapped} independent=${result.independent} batches=${result.batches} remaining=${result.remaining} complete=${result.complete}${result.stopReason ? ` stop_reason=${result.stopReason}` : ""}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

/**
 * Map one batch in its own child session. Cleanup deletes a finished session;
 * unfinished sessions are left for the stale-child cleanup job. Complete
 * <memory .../> decisions can commit even when interruption prevents </mappings>.
 * Omitted ids stay unmapped; a finished document may retry omissions once, after
 * the other queued memories have had a turn.
 */
async function mapOneBatch(
    args: MapMemoriesArgs,
    batch: MapMemoryInput[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<MapBatchOutcome> {
    let agentSessionId: string | null = null;
    let promptSettled = false;
    const startedAt = Date.now();
    let budgetFinalized = false;
    let failedCompletion: HiddenCompletion | undefined;
    let stage: "child-start" | "prompt" | "apply" = "child-start";
    const onBudgetUpdate: NonNullable<MapMemoriesArgs["onBudgetUpdate"]> = (state) => {
        budgetFinalized ||= state.finalizeFired;
        args.onBudgetUpdate?.(state);
    };
    try {
        const prompt = buildMapMemoriesPrompt(
            args.projectIdentity,
            await seedIdentifierCandidates(batch, args.sessionDirectory),
        );
        if (args.hiddenCompletionExecutor) {
            const run = await runHiddenSingleShotPrompt({
                executor: args.hiddenCompletionExecutor,
                parentSessionId: args.parentSessionId,
                sessionDirectory: args.sessionDirectory,
                agent: DREAMER_MEMORY_MAPPER_AGENT,
                system: MAP_MEMORIES_SYSTEM_PROMPT,
                prompt,
                title: "magic-context-dream-map-memories",
                callContext: "dreamer:map-memories",
                metadata: { tokenBudget: args.tokenBudget, onBudgetUpdate },
                model: args.model,
                fallbackModels: args.fallbackModels,
                timeoutMs: sliceMs,
                firstOutputTimeoutMs: args.firstOutputTimeoutMs ?? DREAMER_FIRST_OUTPUT_TIMEOUT_MS,
                signal,
                onOpened: () => {
                    stage = "prompt";
                },
                onFailureOutput: (completion) => {
                    failedCompletion = completion;
                },
                parse: (text, completion) =>
                    parseMapMemoriesCompletion(
                        text,
                        completion,
                        new Set(batch.map((memory) => memory.id)),
                    ),
            });
            recordInvocation(args, startedAt, {
                status: "completed",
                messages: run.completion.messages ?? [],
            });
            stage = "apply";
            const outcome = await applyParsedBatchMappings(
                args,
                batch,
                run.validated,
                budgetFinalized,
                true,
            );
            logBatchUsage(
                run.completion.messages ?? [],
                outcome.mapped + outcome.independent,
                startedAt,
            );
            const returnedIds = new Set(outcome.committedIds);
            return {
                ...outcome,
                requeue: budgetFinalized
                    ? []
                    : batch.filter((memory) => !returnedIds.has(memory.id)),
            };
        }
        const client = args.client;
        if (!client)
            throw new Error("map-memories requires a client or hidden completion executor");
        const createResponse = await createChildSessionWithFence({
            client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-map-memories",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create map-memories session.");
        stage = "prompt";

        const run = await shared.promptSyncWithValidatedOutputRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_MEMORY_MAPPER_AGENT,
                    system: MAP_MEMORIES_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                // Send without holding a request open for the whole batch, so the
                // slice below is the only timer (see prompt-async-transport.ts).
                transport: shared.createPromptAsyncTransport(client, agentSessionId, {
                    tokenBudget: args.tokenBudget,
                    onBudgetUpdate,
                }),
                timeoutMs: sliceMs,
                firstOutputTimeoutMs: args.firstOutputTimeoutMs ?? DREAMER_FIRST_OUTPUT_TIMEOUT_MS,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:map-memories",
                fetchOutput: async () => {
                    const messagesResponse = await client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 200 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) =>
                    validateClientMapMemories(messages, new Set(batch.map((memory) => memory.id))),
            },
        );
        promptSettled = true;

        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
        stage = "apply";
        const outcome = await applyParsedBatchMappings(
            args,
            batch,
            run.validated,
            budgetFinalized,
            true,
        );
        logBatchUsage(run.output, outcome.mapped + outcome.independent, startedAt);
        const returnedIds = new Set(outcome.committedIds);
        return {
            ...outcome,
            requeue: budgetFinalized ? [] : batch.filter((memory) => !returnedIds.has(memory.id)),
        };
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] map-memories batch failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        const messages =
            failedCompletion?.messages ??
            (await readFailedChildMessages(args.client, agentSessionId, args.sessionDirectory)) ??
            [];
        recordInvocation(args, startedAt, {
            status: failedInvocationStatus(error),
            error,
            messages,
        });
        // Stop if another worker took ownership of this task or the shared memory
        // module rejected its write. Neither condition permits a local fallback write.
        if (error instanceof DreamerModuleFailureError) throw error;
        if (signal.aborted) throw error;
        const recovered = parsePartialMapMemoriesManifest(
            assistantText(messages) || failedCompletion?.text || "",
            new Set(batch.map((memory) => memory.id)),
        );
        const outcome = await applyParsedBatchMappings(
            args,
            batch,
            recovered,
            budgetFinalized,
            true,
        );
        logBatchUsage(messages, outcome.mapped + outcome.independent, startedAt);
        // A token-budget stop still terminates the task, but does not erase decisions
        // already emitted by the child. The next run observes their durable mappings.
        if (error instanceof DreamTokenBudgetExceeded) throw error;
        return {
            ...outcome,
            failure: {
                error,
                stage,
                class: isTimeoutClassError(error) ? "timeout" : "other",
                elapsedMs: Date.now() - startedAt,
            },
        };
    } finally {
        if (agentSessionId && args.client)
            await teardownChildSession({
                client: args.client,
                sessionId: agentSessionId,
                sessionDirectory: args.sessionDirectory,
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] map-memories",
                log,
            });
    }
}

/** Parse a complete manifest and commit the entries that belong to this batch.
 * A closed root proves the parser did not see a truncated prefix, so omitted ids
 * may remain unmapped for a targeted retry; unknown ids are never written. */
export async function applyBatchMappings(
    args: MapMemoriesArgs,
    batch: MapMemoryInput[],
    manifestText: string,
): Promise<{ mapped: number; independent: number }> {
    const { mapped, independent } = await applyParsedBatchMappings(
        args,
        batch,
        parseMapMemoriesManifest(manifestText),
    );
    return { mapped, independent };
}

async function applyParsedBatchMappings(
    args: MapMemoriesArgs,
    batch: MapMemoryInput[],
    parsed: ParsedMemoryMapping[],
    budgetFinalized = false,
    allowPartial = false,
): Promise<{ mapped: number; independent: number; committedIds: number[] }> {
    const batchIds = new Set(batch.map((memory) => memory.id));
    const valid = parsed.filter((entry) => batchIds.has(entry.id));
    const unknown = parsed.filter((entry) => !batchIds.has(entry.id));
    if (unknown.length > 0) {
        log(
            `[dreamer] map-memories warning: dropping ${unknown.length} unknown mapping entr${unknown.length === 1 ? "y" : "ies"} outside the current batch (${unknown.map((entry) => entry.id).join(", ")})`,
        );
    }
    assertNoDuplicateManifestIds(
        valid.map((entry) => entry.id),
        "mappings",
    );

    // The token guard asks the child to stop investigating and return only ids it
    // checked, so low coverage is expected then. Without that stop request, reject
    // low coverage before writes: the child may have answered a different batch.
    if (!allowPartial && !budgetFinalized && valid.length * 2 < batch.length) {
        throw new Error(
            `mappings manifest covers ${valid.length}/${batch.length} batch ids after filtering unknown entries; rejecting mostly-wrong manifest`,
        );
    }
    if (budgetFinalized && valid.length < batch.length) {
        log(
            `[dreamer] map-memories: accepted partial manifest after token budget: ${valid.length}/${batch.length}`,
        );
    }
    if (valid.length === 0) return { mapped: 0, independent: 0, committedIds: [] };

    // Pre-normalize each mapping's files OUTSIDE the transaction (path
    // normalization does git/realpath I/O). Independent → sentinel (empty set).
    const planned: Array<{
        id: number;
        files: string[];
        independent: boolean;
        mappingOrigin: MemoryMappingOrigin;
    }> = [];
    const batchById = new Map(batch.map((memory) => [memory.id, memory]));
    for (const p of valid) {
        const memory = batchById.get(p.id);
        if (
            !p.independent &&
            p.files.length > 0 &&
            memory &&
            isDirectiveShapedProjectRule(memory.category, memory.content)
        ) {
            // File names in workflow rules are usually action targets. Treating
            // them as backing code would send a behavioral claim to code verify.
            log(
                `[dreamer] map-memories safety override: memory_id=${p.id} verdict=file-mapping replacement=independent mapping_origin=host_rejected_fallback reason=directive-shaped-project-rule`,
            );
            planned.push({
                id: p.id,
                files: [],
                independent: true,
                mappingOrigin: "host_rejected_fallback",
            });
            continue;
        }
        if (p.independent) {
            planned.push({
                id: p.id,
                files: [],
                independent: true,
                mappingOrigin: "mapper",
            });
            continue;
        }
        // The parser guarantees independent XOR files-present; a files-empty entry
        // reaching here means that invariant broke upstream. Refuse rather than
        // default to independent — a silent independent=true removes the memory
        // from the verify gate permanently (the #323 corruption shape).
        if (p.files.length === 0) {
            throw new Error(`mapping entry ${p.id} has no files and no independent sentinel`);
        }
        const normalized = await normalizeVerificationFiles({
            cwd: args.sessionDirectory,
            files: p.files,
        });
        if (normalized.files.length === 0) {
            // Every mapper-supplied file was rejected by the host's containment or
            // tracked-file checks. Persist a marked no-file disposition so this
            // memory converges without claiming that the mapper chose independence.
            log(
                `[dreamer] map-memories: all ${p.files.length} path(s) for memory ${p.id} were rejected; recording host_rejected_fallback`,
            );
            planned.push({
                id: p.id,
                files: [],
                independent: true,
                mappingOrigin: "host_rejected_fallback",
            });
            continue;
        }
        planned.push({
            id: p.id,
            files: normalized.files,
            independent: false,
            mappingOrigin: "mapper",
        });
    }
    if (planned.length === 0) return { mapped: 0, independent: 0, committedIds: [] };

    let mapped = 0;
    let independent = 0;
    const committedIds: number[] = [];
    if (args.moduleRoute) {
        const identities = getModuleMemoryIdentities(
            args.db,
            args.projectIdentity,
            planned.map((item) => item.id),
        );
        const rows = planned.map((item) => {
            const identity = identities.get(item.id);
            if (!identity)
                throw new DreamerModuleFailureError(
                    "memory.set_mapping",
                    new Error(`shared memory no longer belongs to the project: ${item.id}`),
                );
            return {
                memory_id: identity.moduleId,
                content_hash_at_prompt: identity.normalizedHash,
                mapped_files: item.independent ? null : item.files,
                mapping_origin: item.mappingOrigin,
            };
        });
        let response: unknown;
        try {
            response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "memory.set_mapping",
                body: {
                    name: "memory.set_mapping",
                    arguments: {
                        memory_project: args.projectIdentity,
                        command_id: `${args.moduleRoute.moduleCommandId}:${createHash("sha256")
                            .update(rows.map((row) => row.memory_id).join(","))
                            .digest("hex")
                            .slice(0, 16)}`,
                        rows,
                    },
                },
            });
        } catch (error) {
            throw new DreamerModuleFailureError("memory.set_mapping", error);
        }
        const result = ((response as { result?: unknown })?.result ?? response) as {
            accepted?: unknown;
        };
        if (!Array.isArray(result?.accepted))
            throw new DreamerModuleFailureError(
                "memory.set_mapping",
                new Error("invalid response"),
            );
        const accepted = new Set(
            result.accepted.filter((id): id is number => typeof id === "number"),
        );
        for (const item of planned) {
            const identity = identities.get(item.id);
            if (identity && accepted.has(identity.moduleId)) {
                item.independent ? (independent += 1) : (mapped += 1);
                committedIds.push(item.id);
            }
        }
        return { mapped, independent, committedIds };
    }
    const now = Date.now();
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const item of planned) {
            recordMemoryMapping(args.db, item.id, item.files, now, item.mappingOrigin);
            item.independent ? (independent += 1) : (mapped += 1);
            committedIds.push(item.id);
        }
    });
    return { mapped, independent, committedIds };
}

function recordInvocation(
    args: MapMemoriesArgs,
    startedAt: number,
    params: { status: SubagentInvocationStatus; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
        subagent: "dreamer",
        task: "map-memories",
        startedAt,
        status: params.status,
        messages: params.messages,
        attemptedModel: args.model,
        configuredModels: args.fallbackModels,
        error: params.error,
    });
}
