import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { resolveHiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-historian";
import {
    type HiddenCompletion,
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
} from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { hasShareabilitySensitiveText } from "../../../shared/redaction";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import { formatRunTokenLog, runTokenLog } from "../../../shared/run-token-log";
import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    type Memory,
    setMemoryClassification,
} from "../memory";
import { memoriesWithOpenClassificationItems } from "../memory/turn-two-scoring";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import { failedInvocationStatus, recordChildInvocation } from "../subagent-token-capture";
import {
    buildClassifyPrompt,
    CLASSIFY_SYSTEM_PROMPT,
    type ClassifyAnchorMemory,
    type ClassifyPromptMemory,
    parseClassifyManifest,
    validateClassifyManifest,
} from "./classify-prompt";
import { readFailedChildMessages } from "./failed-invocation-evidence";
import { DREAMER_FIRST_OUTPUT_TIMEOUT_MS } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertManifestCoversExactly } from "./manifest-parser";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "./provider-output-failure";

/**
 * classify-memories: a NON-agentic single-shot transform. Scores each project
 * memory's importance / scope / shareability from its TEXT (no code reads), then
 * the HOST batch-applies the columns via setMemoryClassification — cache-neutral.
 *
 * 3-stage anchoring (hardcoded 10/100 thresholds):
 *  - Stage 1 (< 10 memories): skip — too small a pool to score meaningfully.
 *  - Stage 2 (<= 100): classify new/changed rows and assess unknown safety flags.
 *    No anchors.
 *  - Stage 3 (> 100): classify new/changed rows and assess unknown safety flags,
 *    plus a stratified sample of already-classified memories as scoring ANCHORS
 *    (calibration, not re-scored).
 *
 * The classified_at marker (stamped by setMemoryClassification, cleared on content
 * change) prevents re-scoring. A NULL safety flag still needs an assessment, but
 * that assessment preserves an existing score except to enforce the safety floor.
 */

const MIN_POOL_TO_CLASSIFY = 10; // Stage 1 floor
const FULL_POOL_CEILING = 100; // Stage 2 ceiling (<= → classify all)
const STAGE3_ANCHOR_COUNT = 30; // calibration anchors shown in Stage 3
// Even Stage 2/3 chunk so peak context stays bounded on a 128K window. 100
// memories ≈ 8.6K tokens of pool text + guidance — comfortably one chunk; a
// >100 to-classify Stage-3 backlog splits into chunks of this size.
const CLASSIFY_CHUNK_SIZE = 100;

export interface ClassifyArgs {
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
    language?: string;
    onProgress?: (processed: number) => void;
}

export interface ClassifyResult {
    classified: number;
    changed: number;
    chunks: number;
    stage: 1 | 2 | 3;
    remaining: number;
    complete: boolean;
}

interface ClassifyCandidate {
    /** The shared row used for prompt content. */
    contextMemory: Memory;
    /** The shared row id and content hash used by either writer. */
    id: number;
    normalizedHash: string;
    /** Already scored, or reserved for historian scoring; assess safety only. */
    safetyOnly?: boolean;
}

function getClassifyCandidates(args: ClassifyArgs): ClassifyCandidate[] {
    return getMemoriesByProject(args.db, args.projectIdentity).map((memory) => ({
        contextMemory: memory,
        id: memory.id,
        normalizedHash: memory.normalizedHash,
    }));
}

function toPromptMemory(candidate: ClassifyCandidate): ClassifyPromptMemory {
    const m = candidate.contextMemory;
    return {
        id: candidate.id,
        category: m.category,
        content: m.content,
        importance: m.importance ?? 50,
        scope: m.scope ?? "project",
        shareable: m.shareable ?? false,
    };
}

/** Stratified sample of already-classified memories across importance bands, so
 *  Stage-3 anchors span the full distribution rather than clustering. */
function stratifiedAnchors(classified: ClassifyCandidate[], count: number): ClassifyAnchorMemory[] {
    if (classified.length <= count) {
        return classified.map((candidate) => ({
            id: candidate.id,
            category: candidate.contextMemory.category,
            content: candidate.contextMemory.content,
            importance: candidate.contextMemory.importance ?? 50,
        }));
    }
    const sorted = [...classified].sort(
        (a, b) => (a.contextMemory.importance ?? 50) - (b.contextMemory.importance ?? 50),
    );
    const step = sorted.length / count;
    const out: ClassifyAnchorMemory[] = [];
    for (let i = 0; i < count; i += 1) {
        const candidate = sorted[Math.min(sorted.length - 1, Math.floor(i * step))];
        out.push({
            id: candidate.id,
            category: candidate.contextMemory.category,
            content: candidate.contextMemory.content,
            importance: candidate.contextMemory.importance ?? 50,
        });
    }
    return out;
}

export async function runClassify(args: ClassifyArgs): Promise<ClassifyResult> {
    const active = getClassifyCandidates(args);

    // Stage 1: too small a pool to score meaningfully.
    if (active.length < MIN_POOL_TO_CLASSIFY) {
        return {
            classified: 0,
            changed: 0,
            chunks: 0,
            stage: 1,
            remaining: 0,
            complete: true,
        };
    }

    let stage: 2 | 3;
    let toClassify: ClassifyCandidate[];
    let anchors: ClassifyAnchorMemory[] = [];
    const unclassifiedIds = new Set(
        getUnclassifiedMemoryIds(
            args.db,
            active.map((candidate) => candidate.contextMemory.id),
        ),
    );
    const historianScored = memoriesWithOpenClassificationItems(args.db);
    toClassify = active.flatMap((candidate) => {
        const needsClassification =
            unclassifiedIds.has(candidate.contextMemory.id) &&
            !historianScored.has(candidate.contextMemory.id);
        if (needsClassification) return [candidate];
        return candidate.contextMemory.safetyCritical === null
            ? [{ ...candidate, safetyOnly: true }]
            : [];
    });
    if (active.length <= FULL_POOL_CEILING) {
        // Memories whose content has not changed and whose safety is assessed need no prompt.
        stage = 2;
    } else {
        stage = 3;
        const classified = active.filter(
            (candidate) =>
                !unclassifiedIds.has(candidate.contextMemory.id) &&
                candidate.contextMemory.safetyCritical !== null,
        );
        anchors = stratifiedAnchors(classified, STAGE3_ANCHOR_COUNT);
    }

    const result: ClassifyResult = {
        classified: 0,
        changed: 0,
        chunks: 0,
        stage,
        remaining: toClassify.length,
        complete: toClassify.length === 0,
    };
    if (toClassify.length === 0) {
        log(`[dreamer] classify: stage=${stage} nothing to classify`);
        return result;
    }

    const chunks: ClassifyCandidate[][] = [];
    for (let i = 0; i < toClassify.length; i += CLASSIFY_CHUNK_SIZE) {
        chunks.push(toClassify.slice(i, i + CLASSIFY_CHUNK_SIZE));
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
        for (let i = 0; i < chunks.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            const chunksRemaining = chunks.length - i;
            const sliceMs = Math.max(1, Math.floor(remainingMs / chunksRemaining));

            const counts = await classifyOneChunk(
                args,
                chunks[i],
                anchors,
                sliceMs,
                abortController.signal,
            );
            result.classified += counts.classified;
            result.changed += counts.changed;
            result.remaining -= counts.classified;
            result.chunks += 1;
            args.onProgress?.(result.classified);
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] classify: stage=${stage} classified=${result.classified} changed=${result.changed} chunks=${result.chunks} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function classifyOneChunk(
    args: ClassifyArgs,
    chunk: ClassifyCandidate[],
    anchors: ClassifyAnchorMemory[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<{ classified: number; changed: number }> {
    let agentSessionId: string | null = null;
    let handle: HiddenRunHandle | null = null;
    let closeExecutor: HiddenCompletionExecutor | undefined;
    let promptSettled = false;
    const startedAt = Date.now();
    try {
        const prompt = buildClassifyPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
            anchors,
        });
        // Runs the classify prompt on this host's own carrier.
        const runOnHostCarrier = async (system: string) => {
            const executor = resolveHiddenCompletionExecutor(
                args.hiddenCompletionExecutor,
                args.client,
                args.db,
                args.sessionDirectory,
                "classify-memories",
            );
            closeExecutor = executor;
            handle = await executor.open({
                parentSessionId: args.parentSessionId,
                agent: DREAMER_CLASSIFIER_AGENT,
                kind: "dreamer-task",
                system,
                model: args.model,
                configuredModels: [
                    ...(args.model ? [args.model] : []),
                    ...(args.fallbackModels ?? []),
                ],
                timeoutMs: sliceMs,
                title: "magic-context-dream-classify",
                directory: args.sessionDirectory,
                metadata: { task: "classify-memories" },
            });
            agentSessionId = handle.id || null;
            if (!agentSessionId) throw new Error("Could not create classify session.");
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
                        system,
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
                    firstOutputTimeoutMs:
                        args.firstOutputTimeoutMs ?? DREAMER_FIRST_OUTPUT_TIMEOUT_MS,
                    signal,
                    fallbackModels: args.fallbackModels,
                    callContext: "dreamer:classify-memories",
                    fetchOutput: () => executor.collect(opened, 50),
                    validateOutput: (completion) => {
                        const messages = completion.messages ?? [];
                        const tokens = completion.tokenLog ?? runTokenLog(undefined);
                        shared.sessionLog(
                            args.parentSessionId ?? "dreamer",
                            `dreamer:classify response_chars=${(completion.text ?? completion.reasoning ?? "").length} ${formatRunTokenLog(tokens)}`,
                        );
                        if (completion.lengthCapped) {
                            throw new Error(
                                completion.reasoning && !completion.text
                                    ? `classify ran out of output budget while reasoning (length-capped at ${completion.usage.output} tokens, no text; ${formatRunTokenLog(tokens)}) — set dreamer.maxTokens or use a low-reasoning model`
                                    : `classify returned length-capped output; ${formatRunTokenLog(tokens)}`,
                            );
                        }
                        const text = completion.text;
                        if (!text) throw new Error("classify returned no output");
                        try {
                            validateClassifyManifest(
                                text,
                                new Set(chunk.map((candidate) => candidate.id)),
                            );
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
            return run;
        };

        const run = await runOnHostCarrier(
            withContentLanguageDirective(CLASSIFY_SYSTEM_PROMPT, args.language),
        );

        recordInvocation(args, startedAt, {
            status: "completed",
            messages: run.output.messages,
            completion: run.output,
        });
        return applyClassifications(
            args,
            chunk.map((candidate) => candidate.contextMemory),
            run.validated,
            new Set(
                chunk.filter((candidate) => candidate.safetyOnly).map((candidate) => candidate.id),
            ),
        );
    } catch (error) {
        const failure = error;
        const desc = describeError(failure);
        log(
            `[dreamer] classify chunk failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, {
            status: failedInvocationStatus(failure),
            error: failure,
            // Only an OpenCode 1 child can be read back here; other carriers own
            // their children and report no messages.
            messages: args.hiddenCompletionExecutor
                ? undefined
                : await readFailedChildMessages(args.client, agentSessionId, args.sessionDirectory),
        });
        if (
            failure instanceof HiddenCompletionRefusal ||
            signal.aborted ||
            failure instanceof DreamerProviderOutputFailureError ||
            (shared.getPromptFailureDetail(failure)?.failureClass !== "parse_failed" &&
                shared.getPromptFailureDetail(failure) !== null)
        )
            throw failure;
        return { classified: 0, changed: 0 };
    } finally {
        await closeExecutor?.close(handle, {
            promptSettled,
            privacySensitive: true,
            context: "[dreamer] classify",
            log,
        });
    }
}

export function applyClassifications(
    args: ClassifyArgs,
    chunk: Memory[],
    manifestText: string,
    safetyOnlyIds: ReadonlySet<number> = new Set(),
): { classified: number; changed: number } {
    const byId = new Map(chunk.map((m) => [m.id, m]));
    const parsed = parseClassifyManifest(manifestText);
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        new Set(byId.keys()),
        "classify",
    );
    if (parsed.length === 0) return { classified: 0, changed: 0 };

    let classified = 0;
    let changed = 0;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const p of parsed) {
            const memory = byId.get(p.id);
            if (!memory) continue;
            // Fail closed: secret/credential/personal-path text is forced private
            // regardless of the model's verdict.
            const shareable =
                p.shareable === true && hasShareabilitySensitiveText(memory.content)
                    ? false
                    : p.shareable;
            const classification = safetyOnlyIds.has(p.id)
                ? {}
                : {
                      importance: p.importance,
                      scope: p.scope,
                      shareable,
                  };
            const didChange =
                safetyOnlyIds.has(p.id) && p.safety_critical === undefined
                    ? false
                    : setMemoryClassification(args.db, p.id, {
                          ...classification,
                          safetyCritical: p.safety_critical,
                      });
            classified += 1; // the row's reply was processed, including flag-only assessments
            if (didChange) changed += 1; // an actual column value moved
        }
    });
    return { classified, changed };
}

function recordInvocation(
    args: ClassifyArgs,
    startedAt: number,
    params: {
        status: SubagentInvocationStatus;
        messages?: unknown[];
        error?: unknown;
        completion?: HiddenCompletion;
    },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
        subagent: "dreamer",
        task: "classify-memories",
        startedAt,
        status: params.status,
        messages: params.messages,
        attemptedModel: args.model,
        configuredModels: args.fallbackModels,
        ...(params.completion && !params.completion.messages
            ? {
                  tokens: params.completion.usage,
                  providerId: params.completion.providerId,
                  modelId: params.completion.modelId,
              }
            : {}),
        error: params.error,
    });
}
