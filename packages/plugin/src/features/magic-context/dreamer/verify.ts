import { createHash } from "node:crypto";

import { DREAMER_MEMORY_MAPPER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
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
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import {
    archiveMemory,
    clearMemoryVerifications,
    getMemoryById,
    hasMemoryClassifiedAtColumn,
    hasMemoryShareableColumn,
    invalidateMemory,
    type Memory,
    normalizeVerificationFiles,
    readGitHead,
    recordMemoryVerifications,
} from "../memory";
import { computeNormalizedHash } from "../memory/normalize-hash";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import { failedInvocationStatus, recordChildInvocation } from "../subagent-token-capture";
import { readFailedChildMessages } from "./failed-invocation-evidence";
import { runHiddenSingleShotPrompt } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertNoDuplicateManifestIds } from "./manifest-parser";
import { isDirectiveShapedProjectRule } from "./memory-claim-safety";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    getModuleMemoryIdentities,
} from "./module-apply";
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
    parseVerifyManifest,
    VERIFY_SYSTEM_PROMPT,
    type VerifyPromptMemory,
    validateVerifyManifest,
} from "./verify-prompt";

/**
 * verify / verify-broad: check file-mapped memories against the CURRENT source
 * and apply the agent's verified/update/archive manifest HOST-side.
 *
 * Per-memory verified_at (no global watermark): a timed-out batch banks what it
 * checked; the next run continues. Cost is unique-file-bounded like map, but
 * verify reads DEEPER (it checks claims, not just locates files), so it batches
 * SMALLER than map because deeper reads replay more prompt tokens. No max-turns;
 * a batch that fails to emit a manifest banks nothing and is retried next run.
 *
 * Apply is cache-NEUTRAL: update/archive route through queueMemoryMutation,
 * never bumping the project memory epoch — the dreamer
 * must never bust the prompt cache.
 */

// A 14-day Gemini fit predicts ~1.73M prompt tokens for 20 memories, including
// ~600K fixed per-child overhead (~69% of the 2.5M incremental default budget).
// Broad verification fits ~2.00M at 20, below 70% of its 3M default budget.
// Both leave room to finalize without repeatedly paying overhead for tiny batches.
// Observed costs vary widely around these means; heavy batches can still finalize
// early (docs/reports/verify-token-budget-2026-09-30.md).
const VERIFY_BATCH_SIZE = 20;
// One batch already exhausts the configured model fallback chain. A second
// identical provider-shaped completion means continuing this run only hammers
// the same outage, so leave the remaining memories for the scheduler retry.
const IDENTICAL_PROVIDER_FAILURE_BATCH_LIMIT = 2;

/**
 * Minimum wall-clock budget for one verify batch. Verify reads deeper
 * than map, which already gets this floor, so an even split of
 * the task deadline across many batches (120 s for ten batches in 20 minutes)
 * cannot finish one tool loop. A batch below the floor is not started; its
 * memories keep their old verified_at and a later run picks them up.
 */
export const VERIFY_BATCH_FLOOR_MS = 240_000;

/** Evenly split the remaining deadline, but never below the batch floor. The
 * caller checks that the remaining budget covers the floor before starting a
 * batch, so the result always fits the deadline. */
export function computeVerifyBatchSliceMs(remainingMs: number, batchesRemaining: number): number {
    return Math.min(
        remainingMs,
        Math.max(VERIFY_BATCH_FLOOR_MS, Math.floor(remainingMs / batchesRemaining)),
    );
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
    tokenBudget?: number;
    onBudgetUpdate?: (state: { spent: number; finalizeFired: boolean }) => void;
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
     * Why a run stopped before draining its scope. "deadline": the remaining
     * budget could not give the next batch its floor. "batch-timeout": a batch
     * ran out of time, so the next batch would meet the same budget; earlier
     * batches stay banked.
     */
    stopReason?: "deadline" | "batch-timeout";
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
    try {
        for (let i = 0; i < batches.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs < VERIFY_BATCH_FLOOR_MS) {
                result.stopReason = "deadline";
                log(
                    `[dreamer] ${args.forceBroad ? "verify-broad" : "verify"}: stopping before batch ${i + 1}/${batches.length} — remaining budget ${remainingMs}ms is below the ${VERIFY_BATCH_FLOOR_MS}ms batch floor`,
                );
                break;
            }
            const sliceMs = computeVerifyBatchSliceMs(remainingMs, batches.length - i);

            const counts = await verifyOneBatch(args, batches[i], sliceMs, abortController.signal);
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
    let agentSessionId: string | null = null;
    let promptSettled = false;
    const startedAt = Date.now();
    let budgetFinalized = false;
    const onBudgetUpdate: NonNullable<VerifyArgs["onBudgetUpdate"]> = (state) => {
        budgetFinalized ||= state.finalizeFired;
        args.onBudgetUpdate?.(state);
    };
    try {
        const headAtPrompt = await readGitHead(args.sessionDirectory);
        const evidence =
            !args.forceBroad && batch.every((m) => m.verifiedAt)
                ? await buildVerifyDiffEvidence(args.sessionDirectory, batch)
                : null;
        const prompt = buildVerifyPrompt(args.projectIdentity, batch, evidence);
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
                metadata: { tokenBudget: args.tokenBudget, onBudgetUpdate },
                model: args.model,
                fallbackModels: args.fallbackModels,
                language: args.language,
                timeoutMs: sliceMs,
                signal,
                parse: (text, completion) => {
                    const providerFailure = providerOutputFailureFromInvalidManifest(
                        completion.messages ?? [],
                        text,
                    );
                    if (providerFailure) throw providerFailure;
                    return validateVerifyManifest(text, new Set(batch.map((memory) => memory.id)));
                },
            });
            recordInvocation(args, startedAt, {
                status: "completed",
                messages: run.completion.messages ?? [],
            });
            return applyParsedVerifyManifest(
                args,
                batch,
                run.validated,
                evidence?.head ?? headAtPrompt,
                budgetFinalized,
            );
        }
        const client = args.client;
        if (!client) throw new Error("verify requires a client or hidden completion executor");
        const createResponse = await createChildSessionWithFence({
            client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: args.forceBroad
                ? "magic-context-dream-verify-broad"
                : "magic-context-dream-verify",
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
        if (!agentSessionId) throw new Error("Could not create verify session.");

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
                    tokenBudget: args.tokenBudget,
                    onBudgetUpdate,
                }),
                timeoutMs: sliceMs,
                signal,
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
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("verify returned no output");
                    // A provider outage can arrive as a closed but tiny XML fragment.
                    // Detect that response shape before accepting a subset, so transport
                    // garbage cannot bank a verdict simply because its root is complete.
                    const providerFailure = providerOutputFailureFromInvalidManifest(
                        messages,
                        text,
                    );
                    if (providerFailure) throw providerFailure;
                    return validateVerifyManifest(text, new Set(batch.map((memory) => memory.id)));
                },
            },
        );
        promptSettled = true;

        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
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
        recordInvocation(args, startedAt, {
            status: failedInvocationStatus(error),
            error,
            messages: await readFailedChildMessages(
                args.client,
                agentSessionId,
                args.sessionDirectory,
            ),
        });
        if (
            error instanceof DreamerModuleFailureError ||
            error instanceof DreamTokenBudgetExceeded ||
            signal.aborted
        )
            throw error;
        // A timeout is a budget verdict, not a failure of this run: report it so the
        // run can stop cleanly with its earlier batches banked.
        if (
            promptFailure?.failureClass === "provider_timeout" ||
            shared.isPromptTimeoutError(error)
        ) {
            return {
                verified: 0,
                updated: 0,
                archived: 0,
                skipped: 0,
                refused: 0,
                timedOut: true,
            };
        }
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
            await teardownChildSession({
                client: args.client,
                sessionId: agentSessionId,
                sessionDirectory: args.sessionDirectory,
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] verify",
                log,
            });
    }
}

/**
 * Parse a complete manifest and commit the entries that belong to this batch.
 * A closed root proves the parser did not see a truncated prefix, so omitted ids
 * remain silent for the per-memory gate to select next run; unknown ids are never written.
 * - verified: re-record the (normalized) backing files with verified_at = now
 *   (banks the per-memory verify progress).
 * - update: rewrite the memory content via the cache-neutral mutation log, then
 *   clear old file mappings and embeddings so the new content is mapped and
 *   verified again next cycle.
 * - archive: archive + queue an archive mutation (m[1] delta). Skipped when the
 *   memory is no longer primary-mutable (already archived/superseded), so a stale
 *   manifest can't fight a concurrent change.
 * - skip/refusal: count the verdict for progress without changing the memory.
 * Directive-shaped PROJECT_RULES and unsafe content-loss rewrites are refused
 * before either the local or MODULE authority write path is built.
 * All writes happen under ONE lease-guarded transaction.
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
    const batchIds = new Set(batch.map((m) => m.id));
    const batchById = new Map(batch.map((memory) => [memory.id, memory]));
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
    if (unknown.length > 0) {
        log(
            `[dreamer] verify warning: dropping ${unknown.length} unknown verification entr${unknown.length === 1 ? "y" : "ies"} outside the current batch (${unknown.map((entry) => entry.id).join(", ")})`,
        );
    }
    const validIds = [...valid.verified, ...valid.updated, ...valid.archived, ...valid.skipped].map(
        (entry) => entry.id,
    );
    assertNoDuplicateManifestIds(validIds, "verify");

    // The token guard asks the child to stop investigating and return only ids it
    // checked, so low coverage is expected then. Without that stop request, reject
    // low coverage before writes: the child may have answered a different batch.
    if (!budgetFinalized && validIds.length * 2 < batch.length) {
        throw new Error(
            `verify manifest covers ${validIds.length}/${batch.length} batch ids after filtering unknown entries; rejecting mostly-wrong manifest`,
        );
    }
    if (budgetFinalized && validIds.length < batch.length) {
        log(
            `[dreamer] verify: accepted partial manifest after token budget: ${validIds.length}/${batch.length}`,
        );
    }
    if (validIds.length === 0) {
        return { verified: 0, updated: 0, archived: 0, skipped: 0, refused: 0 };
    }
    const now = Date.now();
    const verifiedHead =
        headAtPrompt === undefined ? await readGitHead(args.sessionDirectory) : headAtPrompt;

    // Pre-normalize files OUTSIDE the transaction (git/realpath I/O). For each
    // affected id, the COMPLETE backing set the agent reports.
    type VerifyWrite =
        | { kind: "verify"; id: number; files: string[] }
        | { kind: "update"; id: number; files: string[]; content: string; hash: string }
        | { kind: "archive"; id: number; reason: string };
    const writes: VerifyWrite[] = [];
    let refused = 0;
    const skipped = valid.skipped.length;
    for (const v of valid.verified) {
        const files = await normalizeFiles(args, v.files);
        writes.push({ kind: "verify", id: v.id, files });
    }
    for (const u of valid.updated) {
        const original = batchById.get(u.id);
        if (!original) continue;
        if (isDirectiveShapedProjectRule(original.category, original.content)) {
            log(
                `[dreamer] verify safety refusal: memory_id=${u.id} verdict=update reason=directive-shaped-project-rule`,
            );
            refused += 1;
            continue;
        }
        const content = u.content.trim();
        // An empty/oversized "update" is unsafe — fall back to a plain re-verify
        // (bank the progress, keep the old content) rather than wipe a memory.
        if (!content || content.length > 20_000) {
            const files = await normalizeFiles(args, u.files);
            writes.push({ kind: "verify", id: u.id, files });
            continue;
        }
        const originalLength = original.content.trim().length;
        // Losing more than half the claim is the characteristic denaturing shape.
        // A model may cross this conservative belt only by explicitly declaring
        // that the shorter rewrite is an intentional consolidation.
        if (!u.consolidation && content.length * 2 < originalLength) {
            log(
                `[dreamer] verify safety refusal: memory_id=${u.id} verdict=update reason=content-loss original_chars=${originalLength} replacement_chars=${content.length}`,
            );
            refused += 1;
            continue;
        }
        const files = await normalizeFiles(args, u.files);
        writes.push({
            kind: "update",
            id: u.id,
            files,
            content,
            hash: computeNormalizedHash(content),
        });
    }
    for (const a of valid.archived) {
        const original = batchById.get(a.id);
        if (!original) continue;
        if (isDirectiveShapedProjectRule(original.category, original.content)) {
            log(
                `[dreamer] verify safety refusal: memory_id=${a.id} verdict=archive reason=directive-shaped-project-rule`,
            );
            refused += 1;
            continue;
        }
        writes.push({ kind: "archive", id: a.id, reason: a.reason });
    }

    let verified = 0;
    let updated = 0;
    let archived = 0;
    if (writes.length === 0) return { verified, updated, archived, skipped, refused };
    if (args.moduleRoute) {
        const identities = getModuleMemoryIdentities(
            args.db,
            args.projectIdentity,
            writes.map((write) => write.id),
        );
        const rows = writes.map((write) => {
            const identity = identities.get(write.id);
            if (!identity)
                throw new DreamerModuleFailureError(
                    "memory.set_verification",
                    new Error(`shared memory no longer belongs to the project: ${write.id}`),
                );
            return {
                memory_id: identity.moduleId,
                content_hash_at_prompt: identity.normalizedHash,
                verification_status: write.kind === "verify" ? "verified" : write.kind,
                ...(write.kind === "update" ? { updated_content: write.content } : {}),
                ...(write.kind === "archive" ? { archive_reason: write.reason } : {}),
            };
        });
        let response: unknown;
        try {
            response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "memory.set_verification",
                body: {
                    name: "memory.set_verification",
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
            throw new DreamerModuleFailureError("memory.set_verification", error);
        }
        const result = ((response as { result?: unknown })?.result ?? response) as {
            accepted?: unknown;
        };
        if (!Array.isArray(result?.accepted))
            throw new DreamerModuleFailureError(
                "memory.set_verification",
                new Error("invalid response"),
            );
        const accepted = new Set(
            result.accepted.filter((id): id is number => typeof id === "number"),
        );
        for (const write of writes) {
            const identity = identities.get(write.id);
            if (!identity || !accepted.has(identity.moduleId)) continue;
            if (write.kind === "verify") verified += 1;
            else if (write.kind === "update") updated += 1;
            else archived += 1;
        }
        return { verified, updated, archived, skipped, refused };
    }
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const w of writes) {
            const memory = getMemoryById(args.db, w.id);
            if (!isPrimaryMutable(memory)) continue;
            if (w.kind === "verify") {
                recordMemoryVerifications(args.db, w.id, w.files, now);
                if (verifiedHead) recordVerifiedCommit(args.db, memory, now, verifiedHead);
                verified += 1;
            } else if (w.kind === "update") {
                rewriteMemoryContent(args.db, memory, w.content, w.hash);
                queueMemoryMutation(args.db, {
                    projectPath: args.projectIdentity,
                    mutationType: "update",
                    targetMemoryId: w.id,
                    category: memory.category,
                    newContent: w.content,
                });
                updated += 1;
            } else {
                archiveMemory(args.db, w.id, w.reason);
                queueMemoryMutation(args.db, {
                    projectPath: args.projectIdentity,
                    mutationType: "archive",
                    targetMemoryId: w.id,
                });
                archived += 1;
            }
        }
    });
    return { verified, updated, archived, skipped, refused };
}

function recordVerifiedCommit(db: Database, memory: Memory, at: number, head: string): void {
    let metadata: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(memory.metadataJson ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            metadata = parsed as Record<string, unknown>;
    } catch {
        /* Preserve verification even when old metadata is malformed. */
    }
    db.prepare("UPDATE memories SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify({ ...metadata, dreamerVerifiedAt: at, dreamerVerifiedCommit: head }),
        memory.id,
    );
}

async function normalizeFiles(args: VerifyArgs, rawFiles: readonly string[]): Promise<string[]> {
    if (rawFiles.length === 0) return [];
    if (args.normalizeFiles) return args.normalizeFiles(rawFiles);
    const normalized = await normalizeVerificationFiles({
        cwd: args.sessionDirectory,
        files: rawFiles,
    });
    return normalized.files;
}

function isPrimaryMutable(memory: Memory | null): memory is Memory {
    return (
        memory !== null &&
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

/** Cache-neutral content rewrite (mirrors ctx_memory's in-transaction update):
 *  new content + hash, reset shareable + classified_at (re-scored later by
 *  classify), drop stale embeddings/cache, and clear old file mappings. */
function rewriteMemoryContent(db: Database, memory: Memory, content: string, hash: string): void {
    db.prepare(
        "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
    ).run(content, hash, Date.now(), memory.id);
    if (hasMemoryShareableColumn(db)) {
        db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
    }
    if (hasMemoryClassifiedAtColumn(db)) {
        db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
    }
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    clearMemoryVerifications(db, memory.id);
    invalidateMemory(memory.projectPath, memory.id);
}

function recordInvocation(
    args: VerifyArgs,
    startedAt: number,
    params: { status: SubagentInvocationStatus; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: args.forceBroad ? "verify-broad" : "verify",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
