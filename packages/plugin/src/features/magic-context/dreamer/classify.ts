import { createHash } from "node:crypto";

import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { resolveHiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-historian";
import {
    type HiddenCompletion,
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
} from "../../../hooks/magic-context/compartment-runner-types";
import { isRustAuthorityDrainingError } from "../../../plugin/rust-tool-backends";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { hasShareabilitySensitiveText } from "../../../shared/redaction";
import {
    modelBodyField,
    parseProviderModel,
    toModelEntry,
} from "../../../shared/resolve-fallbacks";
import { formatRunTokenLog, runTokenLog } from "../../../shared/run-token-log";
import type { Database } from "../../../shared/sqlite";
import { renderCapabilityRefusal } from "../../../shared/user-facing-codes";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    type Memory,
    setMemoryClassification,
} from "../memory";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import {
    failedInvocationStatus,
    recordChildInvocation,
    type TokenTotals,
} from "../subagent-token-capture";
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
import { MIN_POOL_TO_CLASSIFY } from "./task-registry";

/**
 * classify-memories: a NON-agentic single-shot transform. Scores each project
 * memory's importance / scope / shareability from its TEXT (no code reads), then
 * the HOST batch-applies the columns via setMemoryClassification — cache-neutral.
 *
 * 3-stage anchoring (hardcoded 10/100 thresholds):
 *  - Stage 1 (< 10 memories): skip — too small a pool to score meaningfully.
 *  - Stage 2 (<= 100): classify the WHOLE pool every run (the model sees the full
 *    distribution, so it can discriminate). No anchors.
 *  - Stage 3 (> 100): classify only the NEW/CHANGED memories (classified_at NULL),
 *    plus a stratified sample of already-classified memories as scoring ANCHORS
 *    (calibration, not re-scored).
 *
 * The classified_at marker (stamped by setMemoryClassification, cleared on content
 * change) is the per-memory run-gate: a classified memory is not re-scored.
 */

const FULL_POOL_CEILING = 100; // Stage 2 ceiling (<= → classify all)
const STAGE3_ANCHOR_COUNT = 30; // calibration anchors shown in Stage 3
// Even Stage 2/3 chunk so peak context stays bounded on a 128K window. 100
// memories ≈ 8.6K tokens of pool text + guidance — comfortably one chunk; a
// >100 to-classify Stage-3 backlog splits into chunks of this size.
const CLASSIFY_CHUNK_SIZE = 100;

// Module-side classify awaits a full broca producer run (CLASSIFY_AWAIT_TIMEOUT is
// 600s in the module); the transport request must outlive it plus dispatch slack.
const CLASSIFY_MODULE_RUN_TIMEOUT_MS = 660_000;

/** The `dreamer.run_task` code a module with no completion runner answers with. */
const HOST_COMPLETION_REQUIRED = "host_completion_required";

/** A classify completion this host ran, in the shape `dreamer.run_task` takes it back. */
interface HostClassifyCompletion {
    text: string;
    model: string;
    length_capped: boolean;
    usage: { input: number; output: number; cache_read: number; cache_write: number };
}

export interface ClassifyModuleCallArgs {
    sessionId: string;
    projectRoot: string;
    method: string;
    body: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface ClassifyModuleClient {
    call(args: ClassifyModuleCallArgs): Promise<unknown>;
}

/**
 * A module-backed classification failure must reach the task scheduler as a
 * transient error. The TypeScript child path is intentionally not a fallback:
 * when MODULE owns memories, writing through the child would violate the
 * authority boundary (or hide a module outage behind a misleading success).
 */
export class ClassifyModuleFailureError extends Error {
    readonly transient = true;

    constructor(operation: string, cause: unknown) {
        super(`Rust classify ${operation} failed: ${getErrorMessage(cause)}`);
        this.name = "ClassifyModuleFailureError";
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

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
    /** Optional Rust writer for the shared context.db rows. */
    moduleClient?: ClassifyModuleClient;
    moduleSessionId?: string;
    moduleProjectRoot?: string;
    moduleCommandId?: string;
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
}

function isModuleRoute(args: ClassifyArgs): boolean {
    return (
        args.moduleClient !== undefined &&
        args.moduleSessionId !== undefined &&
        args.moduleProjectRoot !== undefined
    );
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
    toClassify = active.filter((candidate) => unclassifiedIds.has(candidate.contextMemory.id));
    if (active.length <= FULL_POOL_CEILING) {
        // An unchanged classification is already durable; only new or changed rows need a prompt.
        stage = 2;
    } else {
        stage = 3;
        const classified = active.filter(
            (candidate) => !unclassifiedIds.has(candidate.contextMemory.id),
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
    const moduleRoute = isModuleRoute(args);
    try {
        const prompt = buildClassifyPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
            anchors,
        });
        // Runs the classify prompt on this host's own carrier. The module route uses
        // it too when the module has no completion runner of its own (under
        // historian.runner = host) and asks the host to run the completion.
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

        if (moduleRoute) {
            const { accounting, ...run } = await runClassifyThroughModule(
                args,
                chunk,
                anchors,
                signal,
                async (system) => {
                    const run = await runOnHostCarrier(system);
                    const output = run.output;
                    return {
                        text: run.validated,
                        model:
                            output.providerId && output.modelId
                                ? `${output.providerId}/${output.modelId}`
                                : run.attempt.label,
                        length_capped: output.lengthCapped === true,
                        // A carrier that reported no usage sends zeros, as the module's
                        // own runner reports nothing it was not given.
                        usage: {
                            input: output.usage?.input ?? 0,
                            output: output.usage?.output ?? 0,
                            cache_read: output.usage?.cacheRead ?? 0,
                            cache_write: output.usage?.cacheWrite ?? 0,
                        },
                    };
                },
            );
            recordInvocation(args, startedAt, {
                status: "completed",
                moduleAccounting: accounting,
            });
            return run;
        }

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
        );
    } catch (error) {
        const failure = moduleRoute ? new ClassifyModuleFailureError("module", error) : error;
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
        // A MODULE-authority failure is not safe to downgrade to the guarded
        // TypeScript child path. Surface it so the scheduler records a
        // transient failure and retries the same task instead.
        if (
            moduleRoute ||
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

/** The module writes classification to the shared rows; the host must not apply it a second time. */
async function runClassifyThroughModule(
    args: ClassifyArgs,
    chunk: ClassifyCandidate[],
    anchors: ClassifyAnchorMemory[],
    signal: AbortSignal,
    runOnHost: (system: string) => Promise<HostClassifyCompletion>,
): Promise<{ classified: number; changed: number; accounting: ModuleClassifyAccounting }> {
    const prompt = buildClassifyPrompt({
        projectPath: args.projectIdentity,
        memories: chunk.map(toPromptMemory),
        anchors,
    });
    const modelEntries = [args.model, ...(args.fallbackModels ?? [])]
        .map(toModelEntry)
        .filter((entry) => entry !== undefined);
    const resolvedModelChain = [...new Set(modelEntries.map((entry) => entry.model))];
    // Each chain model's configured variant (e.g. a reasoning effort), keyed like the
    // chain. The module sends it as the runner's `model.variant`. The chain keeps the
    // first entry for a repeated model, so that entry's variant wins here too.
    const modelVariants: Record<string, string> = {};
    const variantSeen = new Set<string>();
    for (const entry of modelEntries) {
        if (variantSeen.has(entry.model)) continue;
        variantSeen.add(entry.model);
        if (entry.qualifier) modelVariants[entry.model] = entry.qualifier;
    }
    const commandId = `classify:${args.moduleCommandId ?? Date.now()}:${createHash("sha256")
        .update(chunk.map((candidate) => candidate.id).join(","))
        .digest("hex")
        .slice(0, 24)}`;
    const runTask = (hostCompletion?: HostClassifyCompletion) =>
        args.moduleClient?.call({
            sessionId: args.moduleSessionId as string,
            projectRoot: args.moduleProjectRoot as string,
            method: "dreamer.run_task",
            body: {
                method: "dreamer.run_task",
                v: 1,
                session_id: args.moduleSessionId,
                task: "classify",
                // Chunk membership must stay in the id for retry idempotency, but a large
                // chunk's literal id list can exceed the module's 256-byte command-id cap,
                // so the membership rides as a digest.
                command_id: commandId,
                // Always sent, even when empty: the module has no chain of its own and
                // refuses a request without one, while an empty chain reports "no models".
                model_chain: resolvedModelChain,
                ...(Object.keys(modelVariants).length > 0 ? { model_variants: modelVariants } : {}),
                payload: {
                    prompt_body: prompt,
                    items: chunk.map((candidate) => ({
                        memory_id: candidate.id,
                        content_hash: candidate.normalizedHash,
                    })),
                },
                ...(hostCompletion ? { host_completion: hostCompletion } : {}),
            },
            signal,
            // Each model attempt can spend 600 seconds awaiting its provider run and
            // another 60 seconds recovering its response. Allow every fallback to finish.
            timeoutMs:
                Math.max(1, resolvedModelChain.length) * CLASSIFY_MODULE_RUN_TIMEOUT_MS + 30_000,
        });
    const unwrap = (response: unknown) =>
        (response as { result?: unknown } | null)?.result ?? response;
    let result = unwrap(await runTask());
    // Under historian.runner = host the module has no completion runner: it answers
    // with the system prompt to use, this host runs the completion on its own carrier,
    // and the text goes back to the module under the same command id.
    const asked = result as { code?: unknown; system_prompt?: unknown } | null;
    if (asked?.code === HOST_COMPLETION_REQUIRED) {
        if (typeof asked.system_prompt !== "string")
            throw new Error("module asked for a host classify completion without a system prompt");
        result = unwrap(await runTask(await runOnHost(asked.system_prompt)));
    }
    if (!result || typeof result !== "object")
        throw new Error("module returned invalid classify result");
    const manifestText = (result as { manifest_text?: unknown }).manifest_text;
    if (typeof manifestText !== "string") throw new Error("module returned no classify manifest");
    if ((result as { truncated?: unknown }).truncated === true) {
        throw new Error("classify returned length-capped output");
    }
    const accounting = moduleClassifyAccounting(result as Record<string, unknown>);
    const parsed = validateClassifyManifest(
        manifestText,
        new Set(chunk.map((candidate) => candidate.id)),
    );
    const rows = parsed.map((entry) => {
        const candidate = chunk.find((item) => item.id === entry.id);
        if (!candidate) throw new Error(`classify returned unknown memory ${entry.id}`);
        return {
            memory_id: entry.id,
            content_hash_at_prompt: candidate.normalizedHash,
            importance: entry.importance,
            scope: entry.scope,
            // The host forces shareable to false whenever the memory text is sensitive,
            // regardless of whether classification runs through the module or provider path.
            shareable:
                entry.shareable === true &&
                hasShareabilitySensitiveText(candidate.contextMemory.content)
                    ? false
                    : entry.shareable,
        };
    });
    let applied: unknown;
    try {
        applied = await args.moduleClient?.call({
            sessionId: args.moduleSessionId as string,
            projectRoot: args.moduleProjectRoot as string,
            method: "memory.set_classification",
            body: {
                name: "memory.set_classification",
                arguments: {
                    memory_project: args.projectIdentity,
                    rows,
                },
            },
            signal,
        });
    } catch (error) {
        if (isRustAuthorityDrainingError(error)) {
            throw new Error(renderCapabilityRefusal("memory_write"));
        }
        throw error;
    }
    if (isRustAuthorityDrainingError(applied)) {
        throw new Error(renderCapabilityRefusal("memory_write"));
    }
    const applyResult = (applied as { result?: unknown } | null)?.result ?? applied;
    if (!applyResult || typeof applyResult !== "object") {
        throw new Error("module returned invalid classification apply result");
    }
    const accepted = (applyResult as { accepted?: unknown }).accepted;
    if (!Array.isArray(accepted))
        throw new Error("module returned no classification acceptance list");
    const acceptedIds = accepted.map((id) => {
        if (!Number.isInteger(id)) throw new Error("module returned an invalid accepted memory id");
        return id as number;
    });
    const rejected = (applyResult as { rejected?: unknown }).rejected;
    const rejectedRows = Array.isArray(rejected) ? rejected : [];
    const rejectionCounts = new Map<string, number>();
    for (const row of rejectedRows) {
        const reason =
            row &&
            typeof row === "object" &&
            typeof (row as { reason?: unknown }).reason === "string"
                ? (row as { reason: string }).reason
                : "unknown";
        rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
    }
    const nonStaleRejections = [...rejectionCounts].some(([reason]) => reason !== "stale");
    if (nonStaleRejections) {
        const knownReasons = ["not_found", "not_owned", "stale"];
        const known = knownReasons.map((reason) => `${reason}=${rejectionCounts.get(reason) ?? 0}`);
        const unknown = [...rejectionCounts]
            .filter(([reason]) => !knownReasons.includes(reason))
            .map(([reason, count]) => `${reason}=${count}`);
        throw new Error(`module rejected classification (${[...known, ...unknown].join(", ")})`);
    }

    // Validate the module's accepted ids against the submitted chunk. Its write
    // already updated classified_at in context.db, so there is no local replay.
    const byModuleId = new Map(chunk.map((candidate) => [candidate.id, candidate]));
    const acceptedContextIds = acceptedIds.map((moduleId) => {
        const candidate = byModuleId.get(moduleId);
        if (!candidate) throw new Error(`module accepted unknown memory ${moduleId}`);
        return candidate.contextMemory.id;
    });
    return {
        classified: acceptedContextIds.length,
        changed: acceptedContextIds.length,
        accounting,
    };
}

/** Spend and model the module reports for a classify run, in the shape the
 *  invocation record takes. */
export interface ModuleClassifyAccounting {
    tokens?: TokenTotals;
    providerId?: string;
    modelId?: string;
}

function nonNegativeCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Reads the `dreamer.run_task` response's `usage` (input / output / cache_read /
 *  cache_write) and `diagnostics.model` ("provider/model"). Either may be absent:
 *  modules that predate `usage` omit it, and the row then keeps zero tokens. */
export function moduleClassifyAccounting(
    result: Record<string, unknown>,
): ModuleClassifyAccounting {
    const accounting: ModuleClassifyAccounting = {};
    const usage = result.usage;
    if (usage && typeof usage === "object") {
        const record = usage as Record<string, unknown>;
        accounting.tokens = {
            input: nonNegativeCount(record.input),
            output: nonNegativeCount(record.output),
            cacheRead: nonNegativeCount(record.cache_read),
            cacheWrite: nonNegativeCount(record.cache_write),
        };
    }
    const diagnostics = result.diagnostics;
    const model =
        diagnostics && typeof diagnostics === "object"
            ? (diagnostics as Record<string, unknown>).model
            : undefined;
    if (typeof model === "string") {
        const parsed = parseProviderModel(model);
        if (parsed) {
            accounting.providerId = parsed.providerID;
            accounting.modelId = parsed.modelID;
        } else if (model.trim()) {
            accounting.modelId = model.trim();
        }
    }
    return accounting;
}

export function applyClassifications(
    args: ClassifyArgs,
    chunk: Memory[],
    manifestText: string,
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
            const didChange = setMemoryClassification(args.db, p.id, {
                importance: p.importance,
                scope: p.scope,
                shareable,
            });
            classified += 1; // stamped classified_at (run-gate satisfied)
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
        moduleAccounting?: ModuleClassifyAccounting;
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
        ...(params.moduleAccounting
            ? {
                  tokens: params.moduleAccounting.tokens,
                  providerId: params.moduleAccounting.providerId,
                  modelId: params.moduleAccounting.modelId,
              }
            : {}),
        error: params.error,
    });
}
