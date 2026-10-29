import { createHash, randomUUID } from "node:crypto";

import { DREAMER_MEMORY_MAPPER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
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
import { normalizeVerificationFiles, readGitHead } from "../memory";
import {
    applyMemoryVerification,
    getMemoryRevision,
    type MemoryVerificationRequest,
} from "../memory/lifecycle-applier";
import { computeNormalizedHash } from "../memory/normalize-hash";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import {
    failedInvocationStatus,
    recordChildInvocation,
    sumTokensFromChildMessages,
} from "../subagent-token-capture";
import { readFailedChildMessages } from "./failed-invocation-evidence";
import { DREAMER_FIRST_OUTPUT_TIMEOUT_MS, runHiddenSingleShotPrompt } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertNoDuplicateManifestIds } from "./manifest-parser";
import { isDirectiveShapedProjectRule } from "./memory-claim-safety";
import { DreamerModuleFailureError, type DreamerModuleRoute } from "./module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
    withDreamerModelCooldown,
} from "./provider-output-failure";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { DreamTokenBudgetExceeded } from "./token-budget";
import { buildVerifyDiffEvidence } from "./verify-diff";
import { partitionVerifyScope } from "./verify-gate";
import {
    buildVerifyPrompt,
    type ParsedVerifyManifest,
    parsePartialVerifyManifest,
    parseVerifyManifest,
    seedVerifyCandidates,
    VERIFY_SYSTEM_PROMPT,
    type VerifyPromptMemory,
    validateVerifyManifest,
} from "./verify-prompt";

/**
 * verify / verify-broad: check file-mapped memories against current source and
 * apply the agent's verified/update/archive results on the host.
 *
 * Per-memory verified_at (no global watermark): a timed-out batch banks what it
 * checked; the next run continues. Cost is unique-file-bounded like map, but
 * verify uses small batches because deeper reads replay more prompt tokens.
 * Closed individual verdicts survive interruption; unfinished claims stay pending.
 *
 * Confirmations, corrections and archives are bound to the checked revision.
 * Content/status changes save prior state for undo without appending live prompt
 * updates. Selection changes only at an independently authorized full prompt
 * rebuild (HARD fold); verification never forces a cache rebuild.
 */

export const VERIFY_BATCH_SIZE = 5;
// Completed nightly runs spent 22,103,259 prompt tokens for 295 banked verdicts
// (~74,926 each). Round up to 100k per input, with no spare allocation for a short batch.
// All memories checked in one verifier child session share its batch token budget;
// provider usage reports cannot attribute tokens to individual memories.
export const VERIFY_TOKENS_PER_MEMORY = 100_000;
export const VERIFY_RUN_TOKEN_BUDGET = 2_500_000;
/**
 * Run deadline for starting batches. No new batch starts once this much time
 * has passed since the run began, and no single batch gets a longer time slice.
 */
export const VERIFY_RUN_SLICE_MS = 240_000;
/**
 * Extra time a batch that is already running at the run deadline may take to
 * finish. Cutting such a batch off throws away the tokens it already spent, and
 * finishing it costs little more. On 2026-10-20 live data, five-memory batches
 * finished in 64 s at the median, 90 s at p90 and 96 s at worst. Batches under
 * the 500k token envelope finished in 103 s at p95. The slowest full batch
 * consumed about 4.6k prompt tokens per second, so its token budget runs out
 * after roughly 110 s. 120 s therefore covers nearly every batch that can still
 * finish, and the slice timer stops a runaway batch at deadline + 120 s.
 */
export const VERIFY_IN_FLIGHT_GRACE_MS = 120_000;

export function verifyBatchTokenBudget(size: number, configured?: number): number {
    return Math.min(configured ?? Number.MAX_SAFE_INTEGER, size * VERIFY_TOKENS_PER_MEMORY);
}

function verifyAssistantText(messages: unknown[]): string | null {
    const text = messages
        .filter(
            (m) =>
                isRecord(m) &&
                (m.role === "assistant" || (isRecord(m.info) && m.info.role === "assistant")),
        )
        .map(
            (m) =>
                extractLatestAssistantText([m]) ||
                (isRecord(m) && Array.isArray(m.content)
                    ? m.content
                          .filter(isRecord)
                          .filter((p) => p.type === "text")
                          .map((p) => p.text)
                          .join("\n")
                    : ""),
        )
        .join("\n");
    if (!text.trim()) return null;
    const start = text.lastIndexOf("<verify>");
    return start >= 0 ? text.slice(start) : text;
}

function validateVerifyCompletion(
    messages: unknown[],
    text: string,
    expectedIds: ReadonlySet<number>,
    responseText = text,
): ParsedVerifyManifest {
    let parsed: ParsedVerifyManifest;
    try {
        parsed = validateVerifyManifest(text, expectedIds);
    } catch (error) {
        throw providerOutputFailureFromInvalidManifest(messages, responseText) ?? error;
    }
    const ids = [...parsed.verified, ...parsed.updated, ...parsed.archived, ...parsed.skipped].map(
        (entry) => entry.id,
    );
    // A valid manifest covering every requested id once is authoritative even
    // when tiny. Missing or extra ids cannot rule out a provider-outage fragment.
    if (ids.length !== expectedIds.size || ids.some((id) => !expectedIds.has(id))) {
        const providerFailure = providerOutputFailureFromInvalidManifest(messages, responseText);
        if (providerFailure) throw providerFailure;
    }
    return parsed;
}

// One batch already exhausts the configured model fallback chain. A second
// identical provider-shaped completion means continuing this run only hammers
// the same outage, so leave the remaining memories for the scheduler retry.
const IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT = 2;

/**
 * Do not start an investigation with less than thirty seconds left. Completed
 * verdicts are recoverable, so a batch no longer needs four uninterrupted minutes.
 */
export const VERIFY_BATCH_FLOOR_MS = 30_000;

/**
 * Cap each batch at VERIFY_RUN_SLICE_MS, even when the run has more time left.
 * `remainingMs` is measured to the hard stop (run deadline plus in-flight grace).
 */
export function computeVerifyBatchSliceMs(remainingMs: number, _batchesRemaining: number): number {
    return Math.min(remainingMs, VERIFY_RUN_SLICE_MS);
}

export interface VerifyVerdictCounts {
    verified: number;
    updated: number;
    archived: number;
    skipped: number;
    refused: number;
}

interface VerifyBatchResult extends VerifyVerdictCounts {
    providerFailure?: DreamerProviderOutputFailureError;
    /** The batch's prompt ran out of time (our slice or a host request timer). */
    timedOut?: boolean;
    tokenLimited?: boolean;
}

export interface VerifyArgs {
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
    forceBroad?: boolean;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    /** How long a model may stay silent before the chain moves to the next model.
     *  Defaults to DREAMER_FIRST_OUTPUT_TIMEOUT_MS. */
    firstOutputTimeoutMs?: number;
    tokenBudget?: number;
    onBudgetUpdate?: (state: { spent: number; finalizeFired: boolean; sessionId?: string }) => void;
    language?: string;
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number, refused: number) => void;
    normalizeFiles?: (files: readonly string[]) => Promise<string[]>;
}

export interface VerifyResult extends VerifyVerdictCounts {
    batches: number;
    inScope: number;
    remaining: number;
    complete: boolean;
    mode: string;
    /** The open broad-cycle watermark, when this run used verify-broad. */
    broadCycleStartAt?: number;
    /**
     * Why a run stopped before draining its scope. "deadline": the run deadline
     * passed before the next batch could start, or the remaining time could not
     * meet VERIFY_BATCH_FLOOR_MS. "batch-timeout": a batch
     * ran out of time, so the next batch would meet the same budget; earlier
     * batches stay banked.
     */
    stopReason?: "deadline" | "batch-timeout" | "token-budget";
}

function closeBroadCycle(args: VerifyArgs, cycleStartAt: number | undefined): void {
    if (!args.forceBroad || cycleStartAt === undefined) return;
    // Direct runVerify tests and legacy callers may not have a scheduler row. A
    // scheduled run always has one because the scheduler seeds it before execution.
    if (!getTaskScheduleState(args.db, args.projectIdentity, "verify-broad")) return;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        const current = getTaskScheduleState(args.db, args.projectIdentity, "verify-broad");
        // Do not clear a cycle opened by a newer run if state changed while the
        // model was working. The domain lease normally prevents this, but the
        // equality check keeps the close operation safe under recovery tooling.
        if (current?.lastBroadRunAt !== cycleStartAt) return;
        if (!current) return;
        writeTaskScheduleState(args.db, {
            ...current,
            lastBroadRunAt: null,
        });
    });
}

export async function runVerify(args: VerifyArgs): Promise<VerifyResult> {
    return withDreamerModelCooldown(() => runVerifyWithCooldown(args));
}

async function runVerifyWithCooldown(args: VerifyArgs): Promise<VerifyResult> {
    const runStartedAt = Date.now();
    const sliceDeadline = runStartedAt + VERIFY_RUN_SLICE_MS;
    const result: VerifyResult = {
        verified: 0,
        updated: 0,
        archived: 0,
        skipped: 0,
        refused: 0,
        batches: 0,
        inScope: 0,
        remaining: 0,
        complete: true,
        mode: "incremental",
    };

    const gate = await partitionVerifyScope({
        db: args.db,
        projectIdentity: args.projectIdentity,
        projectDirectory: args.sessionDirectory,
        forceBroad: args.forceBroad,
        now: runStartedAt,
        holderId: args.holderId,
        leaseKey: args.leaseKey,
    });
    result.mode = gate.mode;
    result.broadCycleStartAt = gate.broadCycleStartAt;
    result.inScope = gate.inScope.length;
    result.remaining = gate.inScope.length;
    if (gate.unmapped?.length) {
        await commitVerificationWrites(
            args,
            gate.unmapped,
            gate.unmapped.map((memory) => ({
                kind: "unmapped",
                id: memory.id,
                files: [],
            })),
            await readGitHead(args.sessionDirectory),
        );
    }
    log(
        `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"} gate: mode=${gate.mode} in_scope=${gate.inScope.length} skipped=${gate.skippedIds.length} reason=${gate.reason}`,
    );
    if (gate.inScope.length === 0) {
        closeBroadCycle(args, gate.broadCycleStartAt);
        return result;
    }

    const batches: VerifyPromptMemory[][] = [];
    const groups =
        !args.forceBroad && gate.mode === "incremental"
            ? [gate.inScope.filter((m) => m.verifiedAt), gate.inScope.filter((m) => !m.verifiedAt)]
            : [gate.inScope];
    for (const group of groups) {
        for (let i = 0; i < group.length; i += VERIFY_BATCH_SIZE) {
            batches.push(group.slice(i, i + VERIFY_BATCH_SIZE));
        }
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        (reason) => abortController.abort(new Error(reason)),
        args.leaseAcquisition,
    );

    let consecutiveProviderFailures = 0;
    let priorProviderFailureFingerprint: string | null = null;
    let lastProviderFailure: DreamerProviderOutputFailureError | null = null;
    let runSpent = 0;
    const runTokenBudget = Math.min(
        args.tokenBudget ?? VERIFY_RUN_TOKEN_BUDGET,
        VERIFY_RUN_TOKEN_BUDGET,
    );
    try {
        for (let i = 0; i < batches.length; i += 1) {
            const now = Date.now();
            // The run deadline only stops new batches from starting. A batch that
            // starts before it may run on to the hard stop, which adds the
            // in-flight grace but never passes the task's own deadline.
            const startCutoff = Math.min(args.deadline, sliceDeadline);
            const hardStop = Math.min(args.deadline, sliceDeadline + VERIFY_IN_FLIGHT_GRACE_MS);
            const remainingMs = Math.max(0, hardStop - now);
            if (now >= startCutoff) {
                result.stopReason = "deadline";
                log(
                    `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: stopping before batch ${i + 1}/${batches.length} — the run deadline passed ${now - startCutoff}ms ago`,
                );
                break;
            }
            if (remainingMs < VERIFY_BATCH_FLOOR_MS) {
                result.stopReason = "deadline";
                log(
                    `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: stopping before batch ${i + 1}/${batches.length} — remaining budget ${remainingMs}ms is below the ${VERIFY_BATCH_FLOOR_MS}ms batch floor`,
                );
                break;
            }
            const sliceMs = computeVerifyBatchSliceMs(remainingMs, batches.length - i);
            if (runSpent >= runTokenBudget) {
                result.stopReason = "token-budget";
                break;
            }
            let batchSpent = 0;
            const counts = await verifyOneBatch(
                {
                    ...args,
                    tokenBudget: runTokenBudget - runSpent,
                    onBudgetUpdate: (state) => {
                        runSpent += Math.max(0, state.spent - batchSpent);
                        batchSpent = Math.max(batchSpent, state.spent);
                        args.onBudgetUpdate?.(state);
                    },
                },
                batches[i],
                sliceMs,
                abortController.signal,
            );
            result.verified += counts.verified;
            result.updated += counts.updated;
            result.archived += counts.archived;
            result.skipped += counts.skipped;
            result.refused += counts.refused;
            const batchProcessed =
                counts.verified +
                counts.updated +
                counts.archived +
                counts.skipped +
                counts.refused;
            result.remaining -= batchProcessed;
            result.batches += 1;
            args.onProgress?.(
                result.verified +
                    result.updated +
                    result.archived +
                    result.skipped +
                    result.refused,
                result.refused,
            );

            if (counts.tokenLimited) {
                result.stopReason = "token-budget";
                break;
            }

            if (counts.timedOut) {
                // Every later batch gets the same or a smaller share of the deadline,
                // so starting one would repeat this timeout. Keep what earlier
                // batches committed and stop.
                result.stopReason = "batch-timeout";
                log(
                    `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: batch ${i + 1}/${batches.length} timed out after its ${sliceMs}ms slice; stopping with ${result.remaining} remaining`,
                );
                break;
            }

            if (counts.providerFailure) {
                lastProviderFailure = counts.providerFailure;
                if (counts.providerFailure.fingerprint === priorProviderFailureFingerprint) {
                    consecutiveProviderFailures += 1;
                } else {
                    priorProviderFailureFingerprint = counts.providerFailure.fingerprint;
                    consecutiveProviderFailures = 1;
                }
                if (consecutiveProviderFailures >= IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT) {
                    log(
                        `[dreamer] verify run aborting after ${consecutiveProviderFailures} identical provider-failure batches`,
                    );
                    throw counts.providerFailure;
                }
            } else {
                priorProviderFailureFingerprint = null;
                consecutiveProviderFailures = 0;
            }
        }
        // A single-batch project cannot reach the circuit-breaker threshold. Still
        // surface its provider failure so the scheduler hot-retries instead of
        // recording a generic incomplete-manifest result.
        if (lastProviderFailure) throw lastProviderFailure;

        result.complete = result.remaining === 0;
        if (result.complete) closeBroadCycle(args, gate.broadCycleStartAt);
        log(
            `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: verified=${result.verified} updated=${result.updated} archived=${result.archived} skipped=${result.skipped} refused=${result.refused} batches=${result.batches} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function verifyOneBatch(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<VerifyBatchResult> {
    const batchController = new AbortController();
    const abort = () => batchController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(
        () => batchController.abort(new Error(`verify slice timed out after ${sliceMs}ms`)),
        sliceMs,
    );
    const batchSignal = batchController.signal;
    const tokenBudget = verifyBatchTokenBudget(batch.length, args.tokenBudget);
    const expectedIds = new Set(batch.map((memory) => memory.id));
    let agentSessionId: string | null = null;
    let hiddenSessionId: string | null = null;
    let promptSettled = false;
    const startedAt = Date.now();
    let budgetFinalized = false;
    let failedCompletion: HiddenCompletion | undefined;
    let headAtPrompt: string | null = null;
    const onBudgetUpdate: NonNullable<VerifyArgs["onBudgetUpdate"]> = (state) => {
        budgetFinalized ||= state.finalizeFired;
        args.onBudgetUpdate?.({
            ...state,
            ...(hiddenSessionId ? { sessionId: hiddenSessionId } : {}),
        });
    };
    const reportUsage = (messages: unknown[], sessionId: string | null, fallbackSpent = 0) => {
        const usage = sumTokensFromChildMessages(messages);
        onBudgetUpdate({
            spent: Math.max(fallbackSpent, usage.input + usage.cacheRead + usage.cacheWrite),
            finalizeFired: budgetFinalized,
            ...(sessionId ? { sessionId } : {}),
        });
    };
    try {
        headAtPrompt = await shared.raceWithSignal(readGitHead(args.sessionDirectory), batchSignal);
        const evidence =
            !args.forceBroad && batch.every((m) => m.verifiedAt)
                ? await shared.raceWithSignal(
                      buildVerifyDiffEvidence(args.sessionDirectory, batch),
                      batchSignal,
                  )
                : null;
        const prompt = buildVerifyPrompt(
            args.projectIdentity,
            await shared.raceWithSignal(
                seedVerifyCandidates(batch, args.sessionDirectory),
                batchSignal,
            ),
            evidence,
        );
        batchSignal.throwIfAborted();
        if (args.hiddenCompletionExecutor) {
            const run = await runHiddenSingleShotPrompt({
                executor: args.hiddenCompletionExecutor,
                parentSessionId: args.parentSessionId,
                sessionDirectory: args.sessionDirectory,
                agent: DREAMER_MEMORY_MAPPER_AGENT,
                system: VERIFY_SYSTEM_PROMPT,
                prompt,
                title: "magic-context-dream-verify",
                callContext: "dreamer:verify",
                metadata: { tokenBudget, onBudgetUpdate },
                model: args.model,
                fallbackModels: args.fallbackModels,
                language: args.language,
                timeoutMs: sliceMs,
                firstOutputTimeoutMs: args.firstOutputTimeoutMs ?? DREAMER_FIRST_OUTPUT_TIMEOUT_MS,
                signal: batchSignal,
                onFailureOutput: (completion) => {
                    failedCompletion = completion;
                },
                onOpened: (sessionId) => {
                    hiddenSessionId = sessionId;
                    onBudgetUpdate({ spent: 0, finalizeFired: false, sessionId });
                },
                parse: (text, completion) => {
                    const manifest =
                        verifyAssistantText(completion.messages ?? []) ??
                        (text.trim() ? text : null);
                    if (!manifest) throw new Error("verify returned no output");
                    return validateVerifyCompletion(
                        completion.messages ?? [],
                        manifest,
                        expectedIds,
                        text,
                    );
                },
            });
            recordInvocation(args, startedAt, {
                status: "completed",
                messages: run.completion.messages ?? [],
                tokens: run.completion.usage,
            });
            reportUsage(
                run.completion.messages ?? [],
                run.childSessionId,
                run.completion.usage.input +
                    (run.completion.usage.cacheRead ?? 0) +
                    (run.completion.usage.cacheWrite ?? 0),
            );
            return await applyParsedVerifyManifest(
                args,
                batch,
                run.validated,
                evidence?.head ?? headAtPrompt,
                budgetFinalized,
            );
        }
        const client = args.client;
        if (!client) throw new Error("verify requires a client or hidden completion executor");
        const createResponse = await shared.raceWithSignal(
            createChildSessionWithFence({
                client,
                db: args.db,
                parentSessionId: args.parentSessionId,
                title: args.forceBroad
                    ? "magic-context-dream-verify-broad"
                    : "magic-context-dream-verify",
                directory: args.sessionDirectory,
            }),
            batchSignal,
        );
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create verify session.");
        onBudgetUpdate({ spent: 0, finalizeFired: false, sessionId: agentSessionId });

        const run = await shared.promptSyncWithValidatedOutputRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_MEMORY_MAPPER_AGENT,
                    system: withContentLanguageDirective(VERIFY_SYSTEM_PROMPT, args.language),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                // Send without holding a request open for the whole batch, so the
                // slice below is the only timer (see prompt-async-transport.ts).
                transport: shared.createPromptAsyncTransport(client, agentSessionId, {
                    tokenBudget,
                    onBudgetUpdate,
                }),
                timeoutMs: sliceMs,
                firstOutputTimeoutMs: args.firstOutputTimeoutMs ?? DREAMER_FIRST_OUTPUT_TIMEOUT_MS,
                signal: batchSignal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:verify",
                fetchOutput: async () => {
                    const messagesResponse = await client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 100 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("verify returned length-capped output");
                    }
                    const text = verifyAssistantText(messages);
                    if (!text) throw new Error("verify returned no output");
                    return validateVerifyCompletion(messages, text, expectedIds);
                },
            },
        );
        promptSettled = true;

        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
        reportUsage(run.output, agentSessionId);
        return await applyParsedVerifyManifest(
            args,
            batch,
            run.validated,
            evidence?.head ?? headAtPrompt,
            budgetFinalized,
        );
    } catch (error) {
        const desc = describeError(error);
        const providerFailure =
            error instanceof DreamerProviderOutputFailureError ? error : undefined;
        const promptFailure = shared.getPromptFailureDetail(error);
        log(
            `[dreamer] verify batch ${providerFailure ? "provider failure" : "failed"}: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        const messages =
            failedCompletion?.messages ??
            (await readFailedChildMessages(args.client, agentSessionId, args.sessionDirectory)) ??
            [];
        reportUsage(
            messages,
            hiddenSessionId ?? agentSessionId,
            failedCompletion?.usage.input ?? 0,
        );
        recordInvocation(args, startedAt, {
            status: failedInvocationStatus(error),
            error,
            messages,
            tokens: failedCompletion?.usage,
        });
        if (error instanceof DreamerModuleFailureError || signal.aborted) throw error;
        // A timeout is a budget verdict, not a failure of this run: report it so the
        // run can stop cleanly with its earlier batches banked.
        const interrupted =
            batchSignal.aborted ||
            error instanceof DreamTokenBudgetExceeded ||
            promptFailure?.failureClass === "provider_timeout" ||
            shared.isPromptTimeoutError(error);
        if (interrupted) {
            const text = verifyAssistantText(messages) ?? failedCompletion?.text ?? "";
            const recovered = parsePartialVerifyManifest(text, new Set(batch.map((m) => m.id)));
            const counts = await applyParsedVerifyManifest(
                args,
                batch,
                recovered,
                headAtPrompt,
                true,
            );
            return {
                ...counts,
                timedOut: !(error instanceof DreamTokenBudgetExceeded),
                tokenLimited: error instanceof DreamTokenBudgetExceeded,
            };
        }
        await commitVerificationWrites(
            args,
            batch,
            await Promise.all(
                batch.map(async (memory) => ({
                    kind: "failed" as const,
                    id: memory.id,
                    files: await normalizeFiles(args, memory.mappedFiles),
                    reason: desc.brief,
                })),
            ),
            headAtPrompt,
        );
        if (
            promptFailure !== null &&
            promptFailure.failureClass !== "parse_failed" &&
            !providerFailure
        )
            throw error;
        return {
            verified: 0,
            updated: 0,
            archived: 0,
            skipped: 0,
            refused: 0,
            providerFailure,
        };
    } finally {
        if (agentSessionId && args.client)
            await shared
                .raceWithSignal(
                    teardownChildSession({
                        client: args.client,
                        sessionId: agentSessionId,
                        sessionDirectory: args.sessionDirectory,
                        promptSettled,
                        privacySensitive: true,
                        context: "[dreamer] verify",
                        log,
                    }),
                    batchSignal,
                )
                .catch(() => {});
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}

/**
 * Parse a complete manifest and commit only entries belonging to this batch.
 * A closed root rules out a truncated reply. Unreported memories remain eligible
 * for the next verification run, and unknown ids are never written.
 * Confirmations replace the complete file set and stamp the checked revision.
 * Updates and archives save prior content/status for undo; skips and refusals
 * record outcomes without advancing confirmation timestamps. Both the local
 * TypeScript and module-owned routes use their automated memory applier, and
 * stale revisions never advance verification timestamps. Local writes use one
 * lease-guarded transaction; module writes use its fenced transaction.
 */
export async function applyVerifyManifest(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    manifestText: string,
): Promise<VerifyVerdictCounts> {
    return applyParsedVerifyManifest(args, batch, parseVerifyManifest(manifestText));
}

async function applyParsedVerifyManifest(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    parsed: ParsedVerifyManifest,
    headAtPrompt?: string | null,
    budgetFinalized = false,
): Promise<VerifyVerdictCounts> {
    batch = batch.map((memory) => ({
        ...memory,
        revision: memory.revision ?? getMemoryRevision(args.db, memory.id) ?? 0,
        contentHash: memory.contentHash ?? computeNormalizedHash(memory.content),
    }));
    const batchIds = new Set(batch.map((memory) => memory.id));
    const checkedCommit =
        headAtPrompt === undefined ? await readGitHead(args.sessionDirectory) : headAtPrompt;
    const valid = {
        verified: parsed.verified.filter((entry) => batchIds.has(entry.id)),
        updated: parsed.updated.filter((entry) => batchIds.has(entry.id)),
        archived: parsed.archived.filter((entry) => batchIds.has(entry.id)),
        skipped: parsed.skipped.filter((entry) => batchIds.has(entry.id)),
    };
    const unknown = [
        ...parsed.verified,
        ...parsed.updated,
        ...parsed.archived,
        ...parsed.skipped,
    ].filter((entry) => !batchIds.has(entry.id));
    if (unknown.length)
        log(
            `[dreamer] verify warning: dropping ${unknown.length} unknown verification entries outside the current batch (${unknown.map((entry) => entry.id).join(", ")})`,
        );
    const validIds = [...valid.verified, ...valid.updated, ...valid.archived, ...valid.skipped].map(
        (entry) => entry.id,
    );
    assertNoDuplicateManifestIds(validIds, "verify");

    // Token or deadline stops leave only the ids already checked, so low coverage
    // is expected then. Without an investigation stop, reject
    // low coverage before writes: the child may have answered a different batch.
    if (!budgetFinalized && validIds.length * 2 < batch.length) {
        throw new Error(
            `verify manifest covers ${validIds.length}/${batch.length} batch ids after filtering unknown entries; rejecting mostly-wrong manifest`,
        );
    }
    if (budgetFinalized && validIds.length < batch.length) {
        log(
            `[dreamer] verify: accepted partial manifest after investigation stop: ${validIds.length}/${batch.length}`,
        );
    }
    if (validIds.length === 0) {
        return { verified: 0, updated: 0, archived: 0, skipped: 0, refused: 0 };
    }
    const writes: VerifyWrite[] = [];
    const originals = new Map(batch.map((memory) => [memory.id, memory]));
    for (const entry of valid.verified)
        writes.push({
            kind: "verified",
            id: entry.id,
            files: await normalizeFiles(args, entry.files),
        });
    for (const entry of valid.updated) {
        const original = originals.get(entry.id);
        if (!original) throw new Error("verification target missing from batch");
        const content = entry.content.trim();
        const reason = isDirectiveShapedProjectRule(original.category, original.content)
            ? "directive-shaped-project-rule"
            : !content || content.length > 20_000
              ? "invalid_content"
              : !entry.consolidation && content.length * 2 < original.content.trim().length
                ? "content-loss"
                : undefined;
        if (reason)
            log(
                `[dreamer] verify safety refusal: memory_id=${entry.id} verdict=update reason=${reason}`,
            );
        writes.push({
            kind: "update",
            id: entry.id,
            files: await normalizeFiles(args, entry.files),
            content,
            refusalReason: reason,
        });
    }
    for (const entry of valid.archived) {
        const original = originals.get(entry.id);
        if (!original) throw new Error("verification target missing from batch");
        const refusalReason = isDirectiveShapedProjectRule(original.category, original.content)
            ? "directive-shaped-project-rule"
            : undefined;
        if (refusalReason)
            log(
                `[dreamer] verify safety refusal: memory_id=${entry.id} verdict=archive reason=${refusalReason}`,
            );
        writes.push({
            kind: "archive",
            id: entry.id,
            files: await normalizeFiles(args, original.mappedFiles),
            reason: entry.reason,
            refusalReason,
        });
    }
    for (const entry of valid.skipped)
        writes.push({
            kind: "skipped",
            id: entry.id,
            files: await normalizeFiles(args, originals.get(entry.id)?.mappedFiles ?? []),
            reason: entry.reason,
        });
    return commitVerificationWrites(args, batch, writes, checkedCommit);
}

type VerifyWrite = {
    kind: MemoryVerificationRequest["kind"];
    id: number;
    files: string[];
    content?: string;
    reason?: string;
    refusalReason?: string;
};

async function commitVerificationWrites(
    args: VerifyArgs,
    batch: VerifyPromptMemory[],
    writes: VerifyWrite[],
    checkedCommit: string | null,
): Promise<VerifyVerdictCounts> {
    const counts = { verified: 0, updated: 0, archived: 0, skipped: 0, refused: 0 };
    if (!writes.length) return counts;
    const checkedAt = Date.now();
    const batchKey = randomUUID();
    const currentHead = await readGitHead(args.sessionDirectory);
    const originals = new Map(batch.map((memory) => [memory.id, memory]));
    const requests: MemoryVerificationRequest[] = writes.map((write) => {
        const original = originals.get(write.id);
        if (!original) throw new Error("verification target missing from batch");
        return {
            key: `verify:${batchKey}:${write.id}`,
            projectPath: args.projectIdentity,
            memoryId: write.id,
            expectedRevision: original.revision ?? getMemoryRevision(args.db, write.id) ?? 0,
            contentHashAtPrompt: original.contentHash ?? computeNormalizedHash(original.content),
            kind: write.kind,
            files: write.files,
            checkedCommit,
            sourceCommitMatches: currentHead === checkedCommit,
            checkedAt,
            content: write.content,
            reason: write.reason,
            refusalReason: write.refusalReason,
        };
    });
    const count = (result: string, kind: VerifyWrite["kind"], state?: string) => {
        if (
            state === "applied" &&
            kind === "update" &&
            (result === "updated" || result === "unmapped")
        )
            counts.updated += 1;
        else if (result === "archived" && state === "applied") counts.archived += 1;
        else if (result === "confirmed") counts.verified += 1;
        else if (kind === "skipped") counts.skipped += 1;
        else if (kind !== "failed" && kind !== "unmapped") counts.refused += 1;
    };
    if (args.moduleRoute) {
        const rows = requests.map((request) => ({
            memory_id: request.memoryId,
            expected_revision: request.expectedRevision,
            content_hash_at_prompt: request.contentHashAtPrompt,
            verification_status: request.kind,
            files: request.files,
            checked_commit: request.checkedCommit,
            source_commit_matches: request.sourceCommitMatches,
            updated_content: request.content,
            archive_reason: request.reason,
            refusal_reason: request.refusalReason,
        }));
        try {
            const response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "memory.set_verification",
                body: {
                    name: "memory.set_verification",
                    arguments: {
                        memory_project: args.projectIdentity,
                        command_id: `${args.moduleRoute.moduleCommandId}:${createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}`,
                        rows,
                    },
                },
            });
            const result = ((response as { result?: unknown })?.result ?? response) as {
                results?: Array<{ memory_id: number; result: string; state?: string }>;
            };
            if (!Array.isArray(result?.results) || result.results.length !== requests.length)
                throw new Error("invalid verification response");
            for (const request of requests) {
                const matches = result.results.filter((row) => row.memory_id === request.memoryId);
                if (matches.length !== 1)
                    throw new Error("invalid verification response identities");
                count(matches[0].result, request.kind, matches[0].state);
            }
        } catch (error) {
            throw new DreamerModuleFailureError("memory.set_verification", error);
        }
    } else {
        runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
            for (const request of requests) {
                const receipt = applyMemoryVerification(args.db, request);
                if (receipt.reason.startsWith("duplicate_of:"))
                    log(
                        `[dreamer] verify safety refusal: memory_id=${request.memoryId} verdict=update reason=duplicate-of duplicate_id=${receipt.reason.slice("duplicate_of:".length)}`,
                    );
                count(receipt.verificationResult ?? "failed", request.kind, receipt.state);
            }
        });
    }
    return counts;
}

async function normalizeFiles(args: VerifyArgs, rawFiles: readonly string[]): Promise<string[]> {
    if (rawFiles.length === 0) return [];
    if (args.normalizeFiles) return [...new Set(await args.normalizeFiles(rawFiles))].sort();
    const normalized = await normalizeVerificationFiles({
        cwd: args.sessionDirectory,
        files: rawFiles,
    });
    return [...new Set(normalized.files)].sort();
}

function recordInvocation(
    args: VerifyArgs,
    startedAt: number,
    params: {
        status: SubagentInvocationStatus;
        messages?: unknown[];
        tokens?: HiddenCompletion["usage"];
        error?: unknown;
    },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
        subagent: "dreamer",
        task: args.forceBroad ? "verify-broad" : "verify",
        startedAt,
        status: params.status,
        messages: params.messages,
        tokens:
            args.hiddenCompletionExecutor?.capabilities.harness === "opencode2"
                ? params.tokens
                : undefined,
        attemptedModel: args.model,
        configuredModels: args.fallbackModels,
        error: params.error,
    });
}
