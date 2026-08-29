import { createHash } from "node:crypto";

import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from '../../../agents/language-directive';
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import { isRustAuthorityDrainingError } from "../../../plugin/rust-tool-backends";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { hasShareabilitySensitiveText } from "../../../shared/redaction";
import { modelBodyField, toModelEntry } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    type Memory,
    setMemoryClassification,
} from "../memory";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    buildClassifyPrompt,
    CLASSIFY_SYSTEM_PROMPT,
    type ClassifyAnchorMemory,
    type ClassifyPromptMemory,
    parseClassifyManifest,
    validateClassifyManifest,
} from "./classify-prompt";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { assertManifestCoversExactly } from "./manifest-parser";
import { getModuleMemoryIdentities } from "./module-apply";
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
 *  - Stage 2 (<= 100): classify the WHOLE pool every run (the model sees the full
 *    distribution, so it can discriminate). No anchors.
 *  - Stage 3 (> 100): classify only the NEW/CHANGED memories (classified_at NULL),
 *    plus a stratified sample of already-classified memories as scoring ANCHORS
 *    (calibration, not re-scored).
 *
 * The classified_at marker (stamped by setMemoryClassification, cleared on content
 * change) is the per-memory run-gate: a classified memory is not re-scored.
 */

const MIN_POOL_TO_CLASSIFY = 10; // Stage 1 floor
const FULL_POOL_CEILING = 100; // Stage 2 ceiling (<= → classify all)
const STAGE3_ANCHOR_COUNT = 30; // calibration anchors shown in Stage 3
// Even Stage 2/3 chunk so peak context stays bounded on a 128K window. 100
// memories ≈ 8.6K tokens of pool text + guidance — comfortably one chunk; a
// >100 to-classify Stage-3 backlog splits into chunks of this size.
const CLASSIFY_CHUNK_SIZE = 100;

// Module-side classify awaits a full broca producer run (CLASSIFY_AWAIT_TIMEOUT is
// 600s in the module); the transport request must outlive it plus dispatch slack.
const CLASSIFY_MODULE_RUN_TIMEOUT_MS = 660_000;

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
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    language?: string;
    /** Present only for rust-mode projects whose memories authority is MODULE. */
    moduleClient?: ClassifyModuleClient;
    moduleSessionId?: string;
    moduleProjectRoot?: string;
    moduleContextStoreUuid?: string;
    moduleAuthorityGeneration?: number;
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
    /** The context.db row used for mirrored prompt content and local identity. */
    contextMemory: Memory;
    /** The id and hash understood by the module authority, or the TS row values. */
    id: number;
    normalizedHash: string;
}

function isModuleRoute(args: ClassifyArgs): boolean {
    return (
        args.moduleClient !== undefined &&
        args.moduleSessionId !== undefined &&
        args.moduleProjectRoot !== undefined &&
        args.moduleContextStoreUuid !== undefined &&
        args.moduleAuthorityGeneration !== undefined
    );
}

/**
 * Build the classify pool in the authority's id space. The context rows are still the
 * prompt source, but module classification must use the mirrored module id and hash.
 * The live mirror hash is preferred over recomputing it in TypeScript because it is
 * the exact value checked by memory.set_classification.
 */
function getClassifyCandidates(args: ClassifyArgs): ClassifyCandidate[] {
    const active = getMemoriesByProject(args.db, args.projectIdentity);
    if (!isModuleRoute(args) || active.length === 0) {
        return active.map((memory) => ({
            contextMemory: memory,
            id: memory.id,
            normalizedHash: memory.normalizedHash,
        }));
    }

    const mappedByContextId = getModuleMemoryIdentities(
        args.db,
        args.projectIdentity,
        active.map((memory) => memory.id),
    );
    const candidates = active.flatMap((contextMemory) => {
        const mapped = mappedByContextId.get(contextMemory.id);
        return mapped
            ? [{ contextMemory, id: mapped.moduleId, normalizedHash: mapped.normalizedHash }]
            : [];
    });
    if (candidates.length !== active.length) {
        const mappedContextIds = new Set(mappedByContextId.keys());
        const withoutIdentity = active.filter((memory) => !mappedContextIds.has(memory.id)).length;
        const withoutLiveHash = active.length - candidates.length - withoutIdentity;
        log(
            `[dreamer] classify: excluded ${active.length - candidates.length} module candidates for ${args.projectIdentity}` +
                ` (${withoutIdentity} without mirror_identity, ${withoutLiveHash} without live module hash)`,
        );
    }
    return candidates;
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
    if (active.length <= FULL_POOL_CEILING) {
        // Stage 2: classify the whole pool every run.
        stage = 2;
        toClassify = active;
    } else {
        // Stage 3: only the new/changed (unclassified) memories, with stratified
        // already-classified anchors for distribution calibration.
        stage = 3;
        const unclassifiedIds = new Set(
            getUnclassifiedMemoryIds(
                args.db,
                active.map((candidate) => candidate.contextMemory.id),
            ),
        );
        toClassify = active.filter((candidate) => unclassifiedIds.has(candidate.contextMemory.id));
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
        () => abortController.abort(),
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
    const startedAt = Date.now();
    const moduleRoute = isModuleRoute(args);
    try {
        const prompt = buildClassifyPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
            anchors,
        });
        if (moduleRoute) {
            const run = await runClassifyThroughModule(args, chunk, anchors, signal);
            recordInvocation(args, startedAt, { status: "completed" });
            return run;
        }

        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-classify",
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
        if (!agentSessionId) throw new Error("Could not create classify session.");

        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_CLASSIFIER_AGENT,
                    system: withContentLanguageDirective(CLASSIFY_SYSTEM_PROMPT, args.language),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:classify-memories",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("classify returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
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

        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
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
        recordInvocation(args, startedAt, { status: "failed", error: failure });
        // A MODULE-authority failure is not safe to downgrade to the guarded
        // TypeScript child path. Surface it so the scheduler records a
        // transient failure and retries the same task instead.
        if (moduleRoute || signal.aborted || failure instanceof DreamerProviderOutputFailureError)
            throw failure;
        return { classified: 0, changed: 0 };
    } finally {
        // Delete on success AND failure (the failed child still holds the
        // memory-pool snapshot from the prompt). keep_subagents still honored —
        // memory-pool text, not raw user transcripts.
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] classify session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}

/** Run the module classifier and apply its manifest in module id space. The
 *  mirror-back changefeed refreshes the context rows, including classified_at;
 *  this path must not write the context rows a second time. */
async function runClassifyThroughModule(
    args: ClassifyArgs,
    chunk: ClassifyCandidate[],
    anchors: ClassifyAnchorMemory[],
    signal: AbortSignal,
): Promise<{ classified: number; changed: number }> {
    const prompt = buildClassifyPrompt({
        projectPath: args.projectIdentity,
        memories: chunk.map(toPromptMemory),
        anchors,
    });
    const modelChain = [args.model, ...(args.fallbackModels ?? [])]
        .map(toModelEntry)
        .filter((entry) => entry !== undefined)
        .map((entry) => entry.model);
    const resolvedModelChain = [...new Set(modelChain)];
    const response = await args.moduleClient?.call({
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
            command_id: `classify:${args.moduleCommandId ?? Date.now()}:${createHash("sha256")
                .update(chunk.map((candidate) => candidate.id).join(","))
                .digest("hex")
                .slice(0, 24)}`,
            authority_generation: args.moduleAuthorityGeneration,
            ...(resolvedModelChain.length > 0 ? { model_chain: resolvedModelChain } : {}),
            payload: {
                prompt_body: prompt,
                items: chunk.map((candidate) => ({
                    memory_id: candidate.id,
                    content_hash: candidate.normalizedHash,
                })),
            },
        },
        signal,
        // The module drives a full producer run (model call included) before replying,
        // so this request carries the classify slice budget, not the transport default.
        timeoutMs: CLASSIFY_MODULE_RUN_TIMEOUT_MS,
    });
    const result = (response as { result?: unknown } | null)?.result ?? response;
    if (!result || typeof result !== "object")
        throw new Error("module returned invalid classify result");
    const manifestText = (result as { manifest_text?: unknown }).manifest_text;
    if (typeof manifestText !== "string") throw new Error("module returned no classify manifest");
    if ((result as { truncated?: unknown }).truncated === true) {
        throw new Error("classify returned length-capped output");
    }
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
                    context_store_uuid: args.moduleContextStoreUuid,
                    authority_generation: args.moduleAuthorityGeneration,
                    rows,
                },
            },
            signal,
        });
    } catch (error) {
        if (isRustAuthorityDrainingError(error)) {
            throw new Error("Rust memory authority is not ready; TypeScript fallback is disabled.");
        }
        throw error;
    }
    if (isRustAuthorityDrainingError(applied)) {
        throw new Error("Rust memory authority is not ready; TypeScript fallback is disabled.");
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

    // Module ids are translated back only to identify the context rows whose
    // mirror-back updates will satisfy the local classified_at run-gate. Do not
    // call setMemoryClassification here: the authority feed owns that write.
    const byModuleId = new Map(chunk.map((candidate) => [candidate.id, candidate]));
    const acceptedContextIds = acceptedIds.map((moduleId) => {
        const candidate = byModuleId.get(moduleId);
        if (!candidate) throw new Error(`module accepted unknown memory ${moduleId}`);
        return candidate.contextMemory.id;
    });
    return { classified: acceptedContextIds.length, changed: acceptedContextIds.length };
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
    params: { status: "completed" | "failed"; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: "classify-memories",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
