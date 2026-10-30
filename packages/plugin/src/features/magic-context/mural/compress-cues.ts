import { createHash } from "node:crypto";

import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import { resolveHiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-historian";
import {
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
} from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";

import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "../dreamer/lease";
import { assertManifestCoversExactly } from "../dreamer/manifest-parser";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    getModuleMemoryIdentities,
} from "../dreamer/module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "../dreamer/provider-output-failure";
import { getMemoriesByProject, type Memory } from "../memory";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    buildCompressCuesPrompt,
    COMPRESS_CUES_SYSTEM_PROMPT,
    type CompressCuesPromptMemory,
    cueBudgetFor,
    parseCuesManifest,
} from "./compress-cues-prompt";
import { validateCue } from "./cue-validation";
import {
    computeCueContentHash,
    getMuralCueState,
    markCurrentCuesFresh,
    memoryNeedsCue,
    recordMuralCueRejection,
    setMuralCue,
    timestampStaleCurrentCues,
} from "./storage-mural-cues";

/**
 * compress-cues: a NON-agentic single-shot transform (classify-memories shape).
 * For each project memory whose cue is missing or stale, the host renders one
 * prompt per chunk, a zero-tool agent emits ONE <cues> XML manifest, and the
 * host validates each cue and applies COLUMN-ONLY writes (mural_cue), either locally
 * under TS authority or through the module facade when MODULE owns memories. No per-memory
 * tool calls; no selection/ranking/packing (those are deterministic
 * in resolveMural / renderMural).
 *
 * Selection: mural_cue IS NULL OR mural_cue_hash != sha256(content). The
 * scheduler's cheap gate also treats updated_at > mural_cue_at as due. A
 * timestamp-only write trips that gate without changing the text, so a run
 * first moves mural_cue_at up to updated_at when the stored hash already
 * matches, and leaves the cue text alone. Resumable — cues are written per
 * memory, so a partial run sticks and the next run picks up the remaining set.
 *
 * Economics: chunks are small (~40 memories), so after the initial backfill the
 * daily trickle is cheap. First run on a 470-memory pool is ~12 chunks; steady
 * state is a handful of new/edited memories per day.
 */

/** Memories per compress call. Small so peak context stays bounded and a
 *  partial run leaves little re-work; the daily cadence drains any backlog. */
export const COMPRESS_CUES_CHUNK_SIZE = 40;

/** Minimum wall-clock budget a single chunk is allowed before we consider it
 *  doomed. runCompressCues divides the remaining task deadline evenly across the
 *  chunks still to run; on a large backfill (e.g. a 470-memory pool = 12 chunks)
 *  that even split can hand a slow thinking model far less than it needs, so
 *  every chunk times out, contributes 0 cues, and the loop burns the whole
 *  deadline (and model quota) marching through chunks that can never finish.
 *  The floor keeps each attempted chunk's slice at least this large, and if the
 *  remaining budget drops below it we stop the run and bank progress instead of
 *  starting a chunk we already know cannot complete. */
export const CHUNK_TIMEOUT_FLOOR_MS = 240_000;

/** Three validation failures for one content hash are enough to stop spending
 * a child session on a response that is not going to change. */
export const CUE_REJECTION_LATCH_THRESHOLD = 3;

/** How many chunks in a row may fail with a timeout-class error before the run
 *  stops early. A model that is consistently slower than its time slice will
 *  time out every chunk; continuing just burns the remaining chunks and quota.
 *  Two consecutive timeouts is enough to conclude the model cannot keep up
 *  within its slice, while still tolerating a single flaky/transient timeout. */
const CONSECUTIVE_TIMEOUT_LIMIT = 2;

export interface CompressCuesArgs {
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
    onProgress?: (processed: number) => void;
    /** Present only when MODULE owns memories; cue columns must be written through the facade. */
    moduleRoute?: DreamerModuleRoute;
}

/** How a chunk failed, used by the run loop to decide whether to keep going.
 *  "timeout" means the model did not finish within its time slice; "other"
 *  covers validation failures (bad/missing manifest, length cap) and provider
 *  errors, which keep the existing per-chunk retry-next-run behavior. */
type ChunkFailureClass = "timeout" | "other";

interface ChunkOutcome {
    compressed: number;
    skipped: number;
    /** Present only when the chunk failed. Carries the failure class plus the
     *  measured elapsed time so the run loop can log how long the doomed chunk
     *  actually ran (helps an operator size chunk vs model). */
    failure?: {
        error?: unknown;
        stage?: "child-start" | "prompt" | "apply";
        class: ChunkFailureClass;
        brief: string;
        elapsedMs: number;
    };
}

export interface CompressCuesResult {
    failure?: unknown;
    failureStage?: "child-start" | "prompt" | "apply";
    stopReason?: "deadline" | "timeout-circuit-breaker";
    /** Cues written this run (memories whose cue moved from missing/stale to set). */
    compressed: number;
    /** Cues the model returned that failed per-cue validation and were skipped. */
    skipped: number;
    chunks: number;
    remaining: number;
    complete: boolean;
}

/** A memory selected for (re)compression plus the content hash captured at
 *  SELECTION time. Storing this hash (not a re-hash at write time) is the race
 *  guard: if the memory is edited between selection and write, the stored hash
 *  won't match the new content, so resolveMural excludes the cue and the gate
 *  re-selects the memory next run — it never adopts a cue for content it wasn't
 *  compressed from. */
interface CueCandidate {
    memory: Memory;
    contentHash: string;
}

function toPromptMemory(candidate: CueCandidate): CompressCuesPromptMemory {
    const memory = candidate.memory;
    return {
        id: memory.id,
        category: memory.category,
        importance: memory.importance ?? 50,
        content: memory.content,
    };
}

function stripOwnIdToken(value: string, ownId: number): string {
    return value.replace(new RegExp(`#${ownId}\\b`, "g"), "");
}

/** Truncate by codepoint budget, preferring a complete word when one exists. */
function truncateCue(value: string, budget: number): string {
    const trimmed = value.trim();
    const codepoints = [...trimmed];
    if (codepoints.length <= budget) return trimmed;
    const prefix = codepoints.slice(0, budget).join("");
    const boundary = prefix.search(/\s+\S*$/);
    return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trim();
}

function sanitizeCue(value: string, candidate: CueCandidate): string {
    return truncateCue(
        stripOwnIdToken(value, candidate.memory.id),
        cueBudgetFor(candidate.memory.importance ?? 50),
    );
}

/**
 * Make a deterministic cue after the same response has failed validation three
 * times. The model's final candidate gets first choice; source content is the
 * second choice so a bad polarity or mechanism cannot keep the gate open.
 */
function deterministicFallbackCue(candidate: CueCandidate, lastCandidate: string): string {
    const importance = candidate.memory.importance ?? 50;
    const budget = cueBudgetFor(importance);
    const sanitizedCandidate = sanitizeCue(lastCandidate, candidate);
    if (validateCue(sanitizedCandidate, importance, candidate.memory.id) === null) {
        return sanitizedCandidate;
    }

    const sourceSlice = sanitizeCue(candidate.memory.content, candidate);
    if (validateCue(sourceSlice, importance, candidate.memory.id) === null) {
        return sourceSlice;
    }

    // Source content can itself contain grammar markers or an unmatched
    // parenthesis. Remove only those validator controls as a final deterministic
    // repair; the remaining text is still a bounded slice of the memory.
    const grammarSafe = truncateCue(
        sourceSlice
            .replaceAll("⊘", "")
            .replace(/[()]/g, "")
            .replace(/\b(?:must not|never|without|instead of|exclude|excludes)\b/gi, "")
            .replace(/\s+/g, " "),
        budget,
    );
    if (validateCue(grammarSafe, importance, candidate.memory.id) === null) {
        return grammarSafe;
    }

    // Memory content is normally non-empty; keep this guard deterministic for
    // malformed legacy rows while preserving the validator's non-empty rule.
    return "memory";
}

/** Select the memories whose cue is missing or stale (content hash mismatch). */
function selectCandidates(db: Database, projectIdentity: string): CueCandidate[] {
    const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const cueState = getMuralCueState(
        db,
        memories.map((memory) => memory.id),
    );
    const candidates: CueCandidate[] = [];
    for (const memory of memories) {
        if (memoryNeedsCue(cueState.get(memory.id), memory.content)) {
            candidates.push({ memory, contentHash: computeCueContentHash(memory.content) });
        }
    }
    return candidates;
}

/** Compute the wall-clock slice for the next chunk: an even split of the
 *  remaining budget across the chunks still to run, but never below
 *  CHUNK_TIMEOUT_FLOOR_MS (a slice smaller than the model needs guarantees a
 *  timeout) and never more than the budget actually remaining. Exported for
 *  test; the run loop calls this once per chunk. */
export function computeChunkSliceMs(remainingMs: number, chunksRemaining: number): number {
    return Math.min(
        remainingMs,
        Math.max(CHUNK_TIMEOUT_FLOOR_MS, Math.floor(remainingMs / chunksRemaining)),
    );
}

export async function runCompressCues(args: CompressCuesArgs): Promise<CompressCuesResult> {
    // A newer updated_at does not mean the cue is stale. Retire those rows
    // before selection so the scheduler gate goes quiet without a model call.
    const currentButTimestampStale = timestampStaleCurrentCues(args.db, args.projectIdentity);
    if (currentButTimestampStale.length > 0) {
        runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
            markCurrentCuesFresh(args.db, args.projectIdentity, currentButTimestampStale);
        });
    }
    const candidates = selectCandidates(args.db, args.projectIdentity);
    const result: CompressCuesResult = {
        compressed: 0,
        skipped: 0,
        chunks: 0,
        remaining: candidates.length,
        complete: candidates.length === 0,
    };
    if (candidates.length === 0) {
        log(`[dreamer] compress-cues: nothing to compress for ${args.projectIdentity}`);
        return result;
    }

    const chunks: CueCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += COMPRESS_CUES_CHUNK_SIZE) {
        chunks.push(candidates.slice(i, i + COMPRESS_CUES_CHUNK_SIZE));
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );
    try {
        let consecutiveTimeouts = 0;
        // Elapsed time of each chunk in the current consecutive-timeout streak,
        // logged when the breaker trips so an operator can size chunk vs model.
        let timeoutStreakElapsedMs: number[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) {
                result.stopReason = "deadline";
                break;
            }
            // Not enough budget left to give this chunk a fair (>= floor) slice.
            // Starting it would just produce another timeout, so stop here and
            // bank progress: cues already written are durable per memory, and the
            // incomplete result keeps this task transient so cron retries it.
            if (remainingMs < CHUNK_TIMEOUT_FLOOR_MS) {
                result.stopReason = "deadline";
                log(
                    `[dreamer] compress-cues: stopping before chunk ${i + 1}/${chunks.length} — remaining budget ${remainingMs}ms is below the ${CHUNK_TIMEOUT_FLOOR_MS}ms chunk floor; banking ${result.compressed} compressed cue(s)`,
                );
                break;
            }
            // Even-split the remaining budget across the chunks still to run, but
            // never hand a chunk less than the floor (a slice too small for the
            // model guarantees a timeout).
            const sliceMs = computeChunkSliceMs(remainingMs, chunks.length - i);
            const chunk = chunks[i];
            if (!chunk) break;
            const outcome = await compressOneChunk(args, chunk, sliceMs, abortController.signal);
            if (outcome.failure) {
                result.failure = outcome.failure.error;
                result.failureStage = outcome.failure.stage;
            }
            result.compressed += outcome.compressed;
            result.skipped += outcome.skipped;
            result.remaining -= outcome.compressed;
            result.chunks += 1;
            args.onProgress?.(result.compressed + result.skipped);

            if (outcome.failure?.class === "timeout") {
                consecutiveTimeouts += 1;
                timeoutStreakElapsedMs.push(outcome.failure.elapsedMs);
                if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                    result.stopReason = "timeout-circuit-breaker";
                    // Circuit breaker: the model is consistently slower than its
                    // time slice. Stop now instead of burning the remaining chunks
                    // (and model quota) on attempts that will also time out.
                    log(
                        `[dreamer] compress-cues: circuit breaker tripped — ${consecutiveTimeouts} consecutive chunk timeouts (model too slow for its time slice); per-chunk elapsed [${timeoutStreakElapsedMs.join("ms, ")}ms] vs ${sliceMs}ms slice; stopping run incomplete with ${chunks.length - i - 1} chunk(s) unattempted`,
                    );
                    break;
                }
            } else {
                // A success or a non-timeout failure (validation/provider) breaks
                // the streak: those keep the existing retry-next-run behavior and
                // must not trip the timeout breaker.
                consecutiveTimeouts = 0;
                timeoutStreakElapsedMs = [];
            }
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] compress-cues: compressed=${result.compressed} skipped=${result.skipped} chunks=${result.chunks} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

/** True when a chunk failed because the model did not finish within its time
 *  slice — the "prompt timed out after Nms" error thrown by promptWithTimeout in
 *  shared/model-suggestion-retry. Validation failures (bad/missing manifest,
 *  length-capped output) and provider errors are deliberately NOT timeout-class:
 *  those keep the existing per-chunk retry-next-run behavior and must not trip
 *  the consecutive-timeout circuit breaker. */
function isTimeoutClassError(error: unknown): boolean {
    return (
        shared.isPromptTimeoutError(error) ||
        shared.getPromptFailureDetail(error)?.failureClass === "provider_timeout"
    );
}

async function compressOneChunk(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<ChunkOutcome> {
    let agentSessionId: string | null = null;
    let handle: HiddenRunHandle | null = null;
    const executor = resolveHiddenCompletionExecutor(
        args.hiddenCompletionExecutor,
        args.client,
        args.db,
        args.sessionDirectory,
        "compress-cues",
    );
    let promptSettled = false;
    const startedAt = Date.now();
    let stage: "child-start" | "prompt" | "apply" = "child-start";
    try {
        const prompt = buildCompressCuesPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
        });

        handle = await executor.open({
            parentSessionId: args.parentSessionId,
            agent: DREAMER_CLASSIFIER_AGENT,
            kind: "dreamer-task",
            system: COMPRESS_CUES_SYSTEM_PROMPT,
            model: args.model,
            configuredModels: [...(args.model ? [args.model] : []), ...(args.fallbackModels ?? [])],
            timeoutMs: sliceMs,
            title: "magic-context-dream-compress-cues",
            directory: args.sessionDirectory,
            metadata: { task: "compress-cues" },
        });
        agentSessionId = handle.id || null;
        if (!agentSessionId) throw new Error("Could not create compress-cues session.");
        stage = "prompt";
        // The retry callbacks close over the opened run; bind it once so the closures
        // see the resolved handle rather than the nullable slot it was assigned to.
        const opened = handle;

        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_CLASSIFIER_AGENT,
                    system: COMPRESS_CUES_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                transport: Object.assign(
                    (request: import("../../../shared/model-suggestion-retry").PromptArgs) =>
                        executor.attempt(opened, request),
                    { childSessionId: opened.childSessionId },
                ),
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:compress-cues",
                fetchOutput: () => executor.collect(opened, 50),
                validateOutput: (completion) => {
                    const messages = completion.messages ?? [];
                    if (completion.lengthCapped) {
                        throw new Error("compress-cues returned length-capped output");
                    }
                    const text = completion.text;
                    if (!text) throw new Error("compress-cues returned no output");
                    // Fail-closed root parse: a missing/truncated <cues> root rejects
                    // the whole chunk here (no partial apply from a truncated reply).
                    try {
                        parseCuesManifest(text);
                    } catch (error) {
                        const providerFailure = providerOutputFailureFromInvalidManifest(
                            messages,
                            text,
                        );
                        if (providerFailure) throw providerFailure;
                        throw error;
                    }
                    return text;
                },
            },
        );
        promptSettled = true;
        if (args.hiddenCompletionExecutor && args.parentSessionId) {
            recordChildInvocation({
                db: args.db,
                parentSessionId: args.parentSessionId,
                harness: executor.capabilities.harness,
                subagent: "dreamer",
                task: "compress-cues",
                startedAt,
                status: "completed",
                tokens: run.output.usage,
                providerId: run.output.providerId,
                modelId: run.output.modelId,
                attemptedModel: args.model,
                configuredModels: args.fallbackModels,
            });
        }

        stage = "apply";
        return args.moduleRoute
            ? await applyCuesThroughModule(args, chunk, run.validated, signal)
            : applyCues(args, chunk, run.validated);
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] compress-cues chunk failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        // A chunk failure is not fatal to the run: other chunks still compress,
        // and this chunk's memories stay NULL and are retried next run. Rethrow
        // only on abort (lease lost / deadline) so the scheduler records it.
        if (
            signal.aborted ||
            error instanceof DreamerModuleFailureError ||
            error instanceof HiddenCompletionRefusal ||
            error instanceof DreamerProviderOutputFailureError
        )
            throw error;
        // Classify the failure so the run loop can drive the consecutive-timeout
        // circuit breaker. The measured elapsed time lets the operator compare
        // how long the model actually ran against the slice it was given.
        return {
            compressed: 0,
            skipped: 0,
            failure: {
                error,
                stage,
                class: isTimeoutClassError(error) ? "timeout" : "other",
                brief: desc.brief,
                elapsedMs: Date.now() - startedAt,
            },
        };
    } finally {
        await executor.close(handle, {
            promptSettled,
            privacySensitive: true,
            context: "[dreamer] compress-cues",
            log,
        });
    }
}

/**
 * Validate each returned cue independently and write the valid ones as
 * column-only updates. The first validation failures are skipped (the memory keeps
 * a NULL cue); after the rejection latch trips, a deterministic fallback is
 * written instead of retrying forever. The stored hash is the SELECTION-time
 * content hash, so a memory
 * edited mid-run doesn't adopt a cue compressed from its old content.
 */
export function applyCues(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    manifestText: string,
): { compressed: number; skipped: number } {
    const byId = new Map(chunk.map((candidate) => [candidate.memory.id, candidate]));
    const parsed = parseCuesManifest(manifestText);
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        new Set(byId.keys()),
        "cues",
    );
    let compressed = 0;
    let skipped = 0;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const entry of parsed) {
            const candidate = byId.get(entry.id);
            if (!candidate) throw new Error(`cues manifest contains unknown id ${entry.id}`);
            const importance = candidate.memory.importance ?? 50;
            const failure = validateCue(entry.cue, importance, candidate.memory.id);
            if (failure) {
                const rejectionCount = recordMuralCueRejection(
                    args.db,
                    args.projectIdentity,
                    entry.id,
                    candidate.contentHash,
                );
                if (rejectionCount >= CUE_REJECTION_LATCH_THRESHOLD) {
                    const fallback = deterministicFallbackCue(candidate, entry.cue);
                    setMuralCue(
                        args.db,
                        args.projectIdentity,
                        entry.id,
                        fallback,
                        candidate.contentHash,
                    );
                    compressed += 1;
                    log(
                        `[dreamer] compress-cues: fallback cue for memory ${entry.id} (${failure.reason}; ${rejectionCount} rejections; fallback)`,
                    );
                    continue;
                }
                skipped += 1;
                log(
                    `[dreamer] compress-cues: skipped cue for memory ${entry.id} (${failure.reason}; rejection ${rejectionCount}/${CUE_REJECTION_LATCH_THRESHOLD})`,
                );
                continue;
            }
            setMuralCue(
                args.db,
                args.projectIdentity,
                entry.id,
                entry.cue.trim(),
                candidate.contentHash,
            );
            compressed += 1;
        }
    });
    return { compressed, skipped };
}

interface PlannedCueUpdate {
    contextId: number;
    moduleId: number;
    contentHash: string;
    cue: string | null;
    rejectionCount: number;
    kind: "compressed" | "skipped";
}

/** Use the same validation and rejection-counter behavior as the local writer, but send every
 * derived-column update to the module authority. Read only the last mirrored rejection count
 * from the context database; the module rechecks that the content is still current and performs
 * the durable write. */
async function applyCuesThroughModule(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    manifestText: string,
    signal: AbortSignal,
): Promise<{ compressed: number; skipped: number }> {
    const route = args.moduleRoute;
    if (!route) throw new Error("module cue apply called without a module route");
    const byId = new Map(chunk.map((candidate) => [candidate.memory.id, candidate]));
    const parsed = parseCuesManifest(manifestText);
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        new Set(byId.keys()),
        "cues",
    );
    const state = getMuralCueState(
        args.db,
        chunk.map((candidate) => candidate.memory.id),
    );
    const identities = getModuleMemoryIdentities(
        args.db,
        args.projectIdentity,
        chunk.map((candidate) => candidate.memory.id),
    );
    const updates: PlannedCueUpdate[] = [];
    for (const entry of parsed) {
        const candidate = byId.get(entry.id);
        if (!candidate) throw new Error(`cues manifest contains unknown id ${entry.id}`);
        const identity = identities.get(candidate.memory.id);
        if (!identity) {
            throw new Error(`module mirror identity missing for memory ${candidate.memory.id}`);
        }
        const failure = validateCue(
            entry.cue,
            candidate.memory.importance ?? 50,
            candidate.memory.id,
        );
        if (!failure) {
            updates.push({
                contextId: candidate.memory.id,
                moduleId: identity.moduleId,
                contentHash: candidate.contentHash,
                cue: entry.cue.trim(),
                rejectionCount: 0,
                kind: "compressed",
            });
            continue;
        }
        const previous = state.get(candidate.memory.id);
        const rejectionCount =
            previous?.hash === candidate.contentHash ? (previous.rejectionCount ?? 0) + 1 : 1;
        if (rejectionCount >= CUE_REJECTION_LATCH_THRESHOLD) {
            updates.push({
                contextId: candidate.memory.id,
                moduleId: identity.moduleId,
                contentHash: candidate.contentHash,
                cue: deterministicFallbackCue(candidate, entry.cue),
                rejectionCount: 0,
                kind: "compressed",
            });
            log(
                `[dreamer] compress-cues: fallback cue for memory ${entry.id} (${failure.reason}; ${rejectionCount} rejections; fallback)`,
            );
        } else {
            updates.push({
                contextId: candidate.memory.id,
                moduleId: identity.moduleId,
                contentHash: candidate.contentHash,
                cue: null,
                rejectionCount,
                kind: "skipped",
            });
            log(
                `[dreamer] compress-cues: skipped cue for memory ${entry.id} (${failure.reason}; rejection ${rejectionCount}/${CUE_REJECTION_LATCH_THRESHOLD})`,
            );
        }
    }

    const commandId = `mural-cues:${route.moduleCommandId}:${createHash("sha256")
        .update(chunk.map((candidate) => candidate.memory.id).join(","))
        .digest("hex")
        .slice(0, 24)}`;
    let response: unknown;
    try {
        response = await route.moduleClient.call({
            sessionId: route.moduleSessionId,
            projectRoot: route.moduleProjectRoot,
            method: "memory.set_mural_cue",
            body: {
                name: "memory.set_mural_cue",
                arguments: {
                    memory_project: args.projectIdentity,

                    command_id: commandId,
                    rows: updates.map((update) => ({
                        memory_id: update.moduleId,
                        content_hash_at_prompt: update.contentHash,
                        cue: update.cue,
                        rejection_count: update.rejectionCount,
                    })),
                },
            },
            signal,
        });
    } catch (error) {
        throw new DreamerModuleFailureError("mural cue apply", error);
    }
    const result = (response as { result?: unknown } | null)?.result ?? response;
    if (!result || typeof result !== "object") {
        throw new Error("module returned invalid mural cue apply result");
    }
    const accepted = (result as { accepted?: unknown }).accepted;
    if (!Array.isArray(accepted) || !accepted.every((id) => Number.isInteger(id))) {
        throw new Error("module returned no mural cue acceptance list");
    }
    const acceptedIds = new Set(accepted as number[]);
    const rejected = (result as { rejected?: unknown }).rejected;
    const rejectedReasons = new Map<string, number>();
    for (const row of Array.isArray(rejected) ? rejected : []) {
        const reason =
            row &&
            typeof row === "object" &&
            typeof (row as { reason?: unknown }).reason === "string"
                ? (row as { reason: string }).reason
                : "unknown";
        rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + 1);
    }
    if ([...rejectedReasons].some(([reason]) => reason !== "stale")) {
        throw new Error(
            `module rejected mural cues (${[...rejectedReasons]
                .map(([reason, count]) => `${reason}=${count}`)
                .join(", ")})`,
        );
    }
    return updates.reduce(
        (counts, update) => {
            if (acceptedIds.has(update.moduleId)) counts[update.kind] += 1;
            return counts;
        },
        { compressed: 0, skipped: 0 },
    );
}
