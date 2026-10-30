import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "../../agents/historian";
import { withContentLanguageDirective } from "../../agents/language-directive";
import {
    forgetHistorianOutputCap,
    forgetRescoreSampling,
    rememberHistorianOutputCap,
    rememberRescoreSampling,
} from "../../config/live-child-output-cap";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import { externalHistorianFailureReason } from "../../features/magic-context/historian-failure-reason";
import { hasHistorianToolActivity } from "../../features/magic-context/memory/historian-wire";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import {
    HISTORIAN_FORMAT_INSTRUCTION,
    parseEnabledTurnOne,
    registerTurnOneChild,
} from "../../features/magic-context/memory/turn-one-publication";
import { openDatabase } from "../../features/magic-context/storage";
import type {
    SubagentInvocationStatus,
    SubagentKind,
} from "../../features/magic-context/storage-subagent-invocations";
import {
    annotateSubagentInvocationError,
    failedInvocationStatus,
    recordChildInvocation,
    sumTokensFromChildMessages,
} from "../../features/magic-context/subagent-token-capture";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import {
    extractLatestAssistantFailure,
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../shared/child-session-teardown";
import {
    ensureCortexKitArtifactGitignore,
    getProjectMagicContextHistorianDir,
} from "../../shared/data-path";
import { describeError, getErrorMessage } from "../../shared/error-message";
import { rememberV1HiddenRun } from "../../shared/hidden-zen-read";
import { isTransientHistorianPromptError } from "../../shared/historian-transient-error";
import type { ModelInput, ResolvedModelEntry } from "../../shared/model-resolution";
import { getSdkContextLimit, getSdkOutputLimit } from "../../shared/models-dev-cache";
import { isRecord } from "../../shared/record-type-guard";
import { modelBodyField, toModelEntry } from "../../shared/resolve-fallbacks";
import { formatRunTokenLog, type RunTokenLog, runTokenLog } from "../../shared/run-token-log";
import type { Database } from "../../shared/sqlite";
import { createChildSessionWithFence } from "./child-session-spawn";
import {
    buildHistorianEditorPrompt,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
    historianSystemPrompt,
} from "./compartment-prompt";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HistorianProgressCallbacks,
    HistorianRunResult,
    RetainedHistorianChild,
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";
import { HiddenCompletionRefusal } from "./compartment-runner-types";
import {
    buildHistorianRepairPrompt,
    type HistorianValidationChunk,
    validateHistorianOutput,
} from "./compartment-runner-validation";
import { resolveHistorianProducerLimits } from "./derive-budgets";
import { PRODUCER_PROMPT_FIT_FAILURE_PATTERN } from "./historian-prompt-fit";
import { reportedProfile } from "./historian-turn-two-carrier";
import {
    historianProducerReserve,
    producerInputTokenLimit,
    producerPromptFailureReason,
} from "./producer-window-guard";
import { estimateTokens } from "./read-session-formatting";

// Intentionally kept: historian validation failure dumps are preserved for
// debugging. They land in the project-local historian dir
// (<project>/.opencode/magic-context/historian/) so they sit inside the
// project boundary OpenCode's permission system already trusts AND so users
// debugging a failed run can find dumps next to the project they belong to.
// The user has explicitly requested keeping these dumps for now (see audit
// #21); they survive until manual cleanup.
function historianResponseDumpDir(directory: string): string {
    return getProjectMagicContextHistorianDir(directory);
}
const MAX_HISTORIAN_RETRIES = 2;
const unknownProducerWindows = new Set<string>();

const HISTORIAN_REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

/**
 * Read reasoning only for the historian after the normal text extractor found no text.
 * Historian output still passes the compartment parser and validator before publication;
 * shared extractors remain text-only so fail-closed dreamer manifest parsers never accept
 * a model's private reasoning as normal task output.
 */
function extractLatestHistorianReasoning(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;

    const latest = messages
        .filter(
            (message): message is Record<string, unknown> =>
                isRecord(message) && isRecord(message.info) && message.info.role === "assistant",
        )
        .sort(
            (left, right) => historianMessageCreatedAt(right) - historianMessageCreatedAt(left),
        )[0];
    if (!latest || !Array.isArray(latest.parts)) return null;

    return (
        latest.parts
            .filter(isHistorianReasoningPart)
            .map((part) => part.text)
            .join("\n") || null
    );
}

function isHistorianReasoningPart(part: unknown): part is { type: string; text: string } {
    return (
        isRecord(part) &&
        typeof part.type === "string" &&
        HISTORIAN_REASONING_PART_TYPES.has(part.type) &&
        typeof part.text === "string" &&
        part.text.length > 0
    );
}

function historianMessageCreatedAt(message: Record<string, unknown>): number {
    if (!isRecord(message.info) || !isRecord(message.info.time)) return 0;
    return typeof message.info.time.created === "number" ? message.info.time.created : 0;
}

function describeAssistantFailure(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (!isRecord(error)) return String(error);

    const data = isRecord(error.data) ? error.data : undefined;
    const name = typeof error.name === "string" ? error.name : undefined;
    const message =
        typeof error.message === "string"
            ? error.message
            : typeof data?.message === "string"
              ? data.message
              : undefined;
    const provider = typeof data?.providerID === "string" ? data.providerID : undefined;
    const status =
        typeof data?.statusCode === "number" || typeof data?.statusCode === "string"
            ? String(data.statusCode)
            : undefined;
    const label = [name, message].filter(Boolean).join(": ");
    const context = [provider ? `provider=${provider}` : null, status ? `status=${status}` : null]
        .filter(Boolean)
        .join(", ");
    if (label) return context ? `${label} (${context})` : label;

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export function resolveHiddenCompletionExecutor(
    executor: HiddenCompletionExecutor | undefined,
    client: PluginContext["client"] | undefined,
    db: Database,
    directory: string,
    entryPoint: string,
): HiddenCompletionExecutor {
    if (executor) return executor;
    if (!client) throw new Error(`${entryPoint}: v2 hidden completion executor is missing`);
    return createV1HiddenCompletionExecutor(client, db, directory);
}

export function createV1HiddenCompletionExecutor(
    client: PluginContext["client"] | undefined,
    db: Database,
    directory: string,
): HiddenCompletionExecutor {
    // Every hidden child (historian, historian editor, dreamer task) sends with
    // prompt_async and polls for idle. A synchronous prompt holds one HTTP request
    // open for the whole run, and some OpenCode 1 builds give plugins a client
    // whose fetch keeps Bun's default request timer, which rejects that request
    // with TimeoutError after 300-360 s. A slow model then never gets the
    // configured historian_timeout_ms. With short requests, the caller's timeout is
    // the only timer, and it still aborts the child when it fires. Clients without
    // prompt_async (the Pi facades) keep the synchronous prompt.
    const historianChildren = new Set<string>();
    const hostErrors = new Map<string, unknown>();
    const runIdentities = new Map<string, import("./compartment-runner-types").HiddenRunIdentity>();
    return {
        capabilities: { tools: true, harness: "opencode" },
        async open(run) {
            if (!client) throw new Error("Hidden completion client is unavailable");
            const response = await createChildSessionWithFence({
                client,
                db,
                parentSessionId: run.parentSessionId,
                title: run.title,
                directory: run.directory,
            });
            const created = shared.normalizeSDKResponse(response, null as { id?: string } | null, {
                preferResponseOnMissingData: true,
            });
            const id = typeof created?.id === "string" ? created.id : "";
            if (id) {
                rememberV1HiddenRun(id, run);
                runIdentities.set(id, run);
            }
            if (id && (run.kind === "historian" || run.kind === "historian-editor")) {
                historianChildren.add(id);
                rememberHistorianOutputCap(id, run.maxOutputTokens);
            }
            if (
                id &&
                run.kind === "rescore" &&
                run.maxOutputTokens !== undefined &&
                typeof run.metadata?.temperature === "number"
            ) {
                rememberRescoreSampling(id, run.maxOutputTokens, run.metadata.temperature);
            }
            const configured = toModelEntry(run.model);
            return {
                id,
                childSessionId: id || undefined,
                ...(configured ? { attemptedModel: configured.model } : {}),
                ...(configured?.sourceConfigKey
                    ? { modelConfigKey: configured.sourceConfigKey }
                    : {}),
            };
        },
        async attempt(handle, request) {
            if (!client) throw new Error("Hidden completion client is unavailable");
            const identity = runIdentities.get(handle.id);
            const requestedModel = request.body?.model;
            const requestedRef =
                requestedModel &&
                typeof requestedModel.providerID === "string" &&
                typeof requestedModel.modelID === "string"
                    ? `${requestedModel.providerID}/${requestedModel.modelID}`
                    : undefined;
            const matchingConfigured = (identity?.configuredModels ?? [])
                .map(toModelEntry)
                .find((entry) => entry?.model === requestedRef);
            const configured =
                matchingConfigured ??
                (requestedRef &&
                identity?.model &&
                toModelEntry(identity.model)?.model === requestedRef
                    ? toModelEntry(identity.model)
                    : toModelEntry(identity?.model));
            handle.attemptedModel = requestedRef ?? configured?.model ?? handle.attemptedModel;
            handle.modelConfigKey = configured?.sourceConfigKey ?? handle.modelConfigKey;
            if (shared.supportsPromptAsync(client)) {
                try {
                    await shared.promptAsyncAndWaitForIdle(client, request, {
                        modelConfigKey: handle.modelConfigKey,
                    });
                } catch (error) {
                    // A provider error the host recorded ends the historian's run. The
                    // synchronous prompt returned normally in that case and collect()
                    // reported the failed assistant message, so the historian moved to
                    // its next model in a fresh child. Keep that: rethrowing here would
                    // make the historian's retry loop send the same prompt again into
                    // this child.
                    if (shared.isHostSessionError(error)) {
                        const hostError = shared.hostSessionErrorOf(error);
                        hostErrors.set(handle.id, hostError);
                        annotateSubagentInvocationError(error, {
                            attemptedModel: handle.attemptedModel,
                            modelConfigKey: handle.modelConfigKey,
                            hostError,
                        });
                        if (historianChildren.has(handle.id)) return;
                    }
                    throw error;
                }
                return;
            }
            await client.session.prompt(request as Parameters<typeof client.session.prompt>[0]);
        },
        async collect(handle, limit) {
            if (!client) throw new Error("Hidden completion client is unavailable");
            const response = await client.session.messages({
                path: { id: handle.id },
                query: { directory, limit },
            });
            const messages = shared.normalizeSDKResponse(response, [] as unknown[], {
                preferResponseOnMissingData: true,
            });
            const assistantFailure = extractLatestAssistantFailure(messages);
            const hostError = hostErrors.get(handle.id);
            if (assistantFailure) {
                const finish = assistantFailure.finish
                    ? ` (finish=${assistantFailure.finish})`
                    : "";
                const error = new Error(
                    `Historian host recorded an assistant error${finish}: ${describeAssistantFailure(assistantFailure.error)}`,
                    hostError === undefined ? undefined : { cause: hostError },
                );
                annotateSubagentInvocationError(error, {
                    attemptedModel: handle.attemptedModel,
                    modelConfigKey: handle.modelConfigKey,
                    hostError,
                });
                throw error;
            }
            const text = extractLatestAssistantText(messages);
            const latest = Array.isArray(messages)
                ? messages
                      .filter(
                          (message): message is Record<string, unknown> =>
                              isRecord(message) &&
                              isRecord(message.info) &&
                              message.info.role === "assistant",
                      )
                      .sort(
                          (left, right) =>
                              historianMessageCreatedAt(right) - historianMessageCreatedAt(left),
                      )[0]
                : undefined;
            const info = latest && isRecord(latest.info) ? latest.info : {};
            return {
                messages,
                text,
                reasoning: text ? null : extractLatestHistorianReasoning(messages),
                lengthCapped: hasLengthCappedOutput(messages),
                usage: sumTokensFromChildMessages(messages),
                tokenLog: runTokenLog(
                    info.tokens,
                    undefined,
                    info.finish ?? info.finish_reason ?? info.finishReason,
                ),
                providerId: typeof info.providerID === "string" ? info.providerID : undefined,
                modelId: typeof info.modelID === "string" ? info.modelID : undefined,
                attemptedModel: handle.attemptedModel,
                modelConfigKey: handle.modelConfigKey,
                ...(hostError === undefined ? {} : { hostError }),
            };
        },
        async recover(id) {
            if (!client) return null;
            const response = await client.session.messages({
                path: { id },
                query: { directory, limit: 10 },
            });
            const messages = shared.normalizeSDKResponse(response, [] as unknown[], {
                preferResponseOnMissingData: true,
            });
            const latest = Array.isArray(messages)
                ? messages
                      .filter(
                          (message): message is Record<string, unknown> =>
                              isRecord(message) &&
                              isRecord(message.info) &&
                              message.info.role === "assistant",
                      )
                      .sort(
                          (a, b) => historianMessageCreatedAt(b) - historianMessageCreatedAt(a),
                      )[0]
                : undefined;
            if (
                !latest ||
                !isRecord(latest.info) ||
                (!latest.info.finish && !(isRecord(latest.info.time) && latest.info.time.completed))
            )
                return null;
            return this.collect({ id }, 10);
        },
        async interrupt(id) {
            if (!client) throw new Error("Hidden completion client is unavailable");
            await client.session.abort({ path: { id }, query: { directory } });
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const state = await this.recoveryState?.(id);
                if (state === "terminal" || state === "unavailable") return;
                if (state !== "active") throw new Error("Cannot confirm score child termination");
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error("Score child did not become idle after interruption");
        },
        async recoveryState(id) {
            if (!client) return "unknown";
            try {
                if (typeof client.session.status === "function") {
                    const response = await client.session.status({ query: { directory } });
                    const statuses = shared.normalizeSDKResponse(
                        response,
                        {} as Record<string, { type?: string }>,
                    );
                    return statuses[id] && statuses[id].type !== "idle" ? "active" : "terminal";
                }
                const response = await client.session.messages({
                    path: { id },
                    query: { directory, limit: 10 },
                });
                const messages = shared.normalizeSDKResponse(response, [] as unknown[], {
                    preferResponseOnMissingData: true,
                });
                return messages.some(
                    (message) =>
                        isRecord(message) &&
                        isRecord(message.info) &&
                        message.info.role === "assistant" &&
                        (message.info.finish ||
                            (isRecord(message.info.time) && message.info.time.completed)),
                )
                    ? "terminal"
                    : "unknown";
            } catch (error) {
                return isRecord(error) && error.status === 404 ? "unavailable" : "unknown";
            }
        },
        async close(handle, settlement) {
            if (handle?.id) {
                rememberV1HiddenRun(handle.id, undefined);
                historianChildren.delete(handle.id);
                hostErrors.delete(handle.id);
                runIdentities.delete(handle.id);
                forgetHistorianOutputCap(handle.id);
                forgetRescoreSampling(handle.id);
            }
            if (!client) return;
            if (settlement.retainForRecovery) return;
            await teardownChildSession({
                client,
                sessionId: handle?.id || null,
                sessionDirectory: directory,
                ...settlement,
            });
        },
    };
}

export function historianReasoningBudgetDiagnostic(
    outputTokens: number,
    tokens?: RunTokenLog,
): string {
    return `historian ran out of output budget while reasoning (length-capped at ${outputTokens} tokens, no text${tokens ? `; ${formatRunTokenLog(tokens)}` : ""}) — set historian.maxTokens or route historian.model to a low-reasoning lane/variant`;
}

export async function runValidatedHistorianPass(args: {
    client: PluginContext["client"] | undefined;
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    /** Use `write` to retain message-block cache markers for a later conversational turn. */
    cacheTail?: import("../../shared/historian-cache").HistorianCacheTail;
    chunk: HistorianValidationChunk;
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    /** Active OpenCode historian entry, including its outbound request variant. */
    model?: ModelInput;
    fallbackModelId?: string;
    /**
     * Resolved historian fallback chain ("provider/modelID" entries). When the
     * primary historian model fails (auth, model-not-found, transient network),
     * each fallback is tried in order. The active session model is eligible
     * only when no historian primary was configured.
     */
    fallbackModels?: readonly ModelInput[];
    callbacks?: HistorianProgressCallbacks;
    /** When true, run a second editor pass after successful historian output
     *  to clean low-signal U: lines and cross-compartment duplicates. If editor
     *  validation fails, falls back to the draft (first-pass) result. */
    twoPass?: boolean;
    subagentKind?: SubagentKind;
    agentId?: string;
    language?: string;
    /**
     * Keep the child whose reply is returned open (`retainedChild` on the result) for
     * historian turn two. Children of replies that fail validation are closed here.
     */
    retainChild?: boolean;
    turnTwoEnabled?: boolean;
    turnOneStageKey?: string;
    recoverTurnOne?: boolean;
}): Promise<ValidatedHistorianPassResult> {
    const withChild = (
        result: ValidatedHistorianPassResult,
        run: HistorianRunResult,
    ): ValidatedHistorianPassResult =>
        result.ok
            ? { ...result, retainedChild: run.retained, reportedProfile: run.reportedProfile }
            : result;
    const firstRun = await runHistorianPrompt({
        ...args,
        dumpLabel: `${args.dumpLabelBase}-initial`,
        modelOverride: args.model,
        agentId: args.agentId,
    });
    if (!firstRun.ok || !firstRun.result) {
        if (
            firstRun.failureReason === "outcome_unknown" ||
            firstRun.failureReason === "carrier_expired"
        )
            return {
                ok: false,
                error: firstRun.error ?? "Turn-one outcome unavailable",
                failureReason: firstRun.failureReason,
            };
        if (
            args.turnTwoEnabled &&
            (firstRun.failureReason === "parse_failed" || firstRun.failureReason === "empty_output")
        )
            return {
                ok: false,
                error: firstRun.error ?? "Invalid turn one",
                failureReason: "parse_failed",
                reportedProfile: firstRun.reportedProfile,
            };
        if (firstRun.refusal?.terminal)
            return {
                ok: false,
                error: firstRun.error ?? firstRun.refusal.message,
                failureReason: firstRun.failureReason ?? "provider_error",
            };
        return runFallbackHistorianPass({
            ...args,
            prompt: args.prompt,
            error: firstRun.error ?? "historian run failed",
            failureReason: firstRun.failureReason ?? "provider_error",
            dumpPaths: [firstRun.dumpPath],
        });
    }

    const firstXml = args.turnTwoEnabled ? parseEnabledTurnOne(firstRun.result) : firstRun.result;
    const firstValidation =
        firstXml === null
            ? { ok: false as const, error: "Invalid turn-one envelope" }
            : validateHistorianOutput(
                  firstXml,
                  args.parentSessionId,
                  args.chunk,
                  args.priorCompartments,
                  args.sequenceOffset,
              );
    if (firstValidation.ok) {
        const finalResult = args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: firstXml!,
                  draftValidation: firstValidation,
                  draftDumpPath: firstRun.dumpPath,
                  draftInvocationId: firstRun.invocationId ?? null,
                  draftRetained: firstRun.retained,
              })
            : withChild(
                  { ...firstValidation, invocationId: firstRun.invocationId ?? null },
                  firstRun,
              );
        cleanupHistorianDump(args.parentSessionId, firstRun.dumpPath);
        return finalResult;
    }
    await firstRun.retained?.close();

    if (args.turnTwoEnabled)
        return {
            ok: false,
            error: firstValidation.error ?? "Invalid turn one",
            failureReason: "parse_failed",
            reportedProfile: firstRun.reportedProfile,
        };

    await args.callbacks?.onRepairRetry?.(firstValidation.error ?? "invalid compartment output");
    const repairPrompt = buildHistorianRepairPrompt(
        args.prompt,
        firstRun.result,
        firstValidation.error ?? "invalid compartment output",
        args.language,
    );
    const repairRun = await runHistorianPrompt({
        ...args,
        prompt: repairPrompt,
        dumpLabel: `${args.dumpLabelBase}-repair`,
        modelOverride: args.model,
        agentId: args.agentId,
    });
    if (!repairRun.ok || !repairRun.result) {
        if (repairRun.refusal?.terminal)
            return {
                ok: false,
                error: repairRun.error ?? repairRun.refusal.message,
                failureReason: repairRun.failureReason ?? "provider_error",
            };
        return runFallbackHistorianPass({
            ...args,
            prompt: repairPrompt,
            error: repairRun.error ?? "historian repair run failed",
            failureReason: repairRun.failureReason ?? "provider_error",
            dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
        });
    }

    const repairValidation = validateHistorianOutput(
        repairRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (repairValidation.ok) {
        const finalResult = args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: repairRun.result,
                  draftValidation: repairValidation,
                  draftDumpPath: repairRun.dumpPath,
                  draftInvocationId: repairRun.invocationId ?? null,
                  draftRetained: repairRun.retained,
              })
            : withChild(
                  { ...repairValidation, invocationId: repairRun.invocationId ?? null },
                  repairRun,
              );
        // Keep firstRun.dumpPath (initial failure) for debugging.
        // Only cleanup the successful repair run's dump.
        cleanupHistorianDump(args.parentSessionId, repairRun.dumpPath);
        return finalResult;
    }
    await repairRun.retained?.close();

    return runFallbackHistorianPass({
        ...args,
        prompt: repairPrompt,
        error: repairValidation.error ?? "invalid compartment output",
        failureReason: repairValidation.error ?? "parse_failed",
        dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
    });
}

/**
 * Run the historian-editor agent on a validated historian draft. Returns the
 * editor's validated result if successful; falls back to the draft on any
 * failure (editor call, validation, or invalid structure). Editor can never
 * regress behavior — worst case we return the same validated draft.
 *
 * Fallback-chain policy (Audit Finding #10 clarification): the editor pass
 * deliberately does NOT receive `fallbackModels`. If the configured editor
 * model fails (auth, model-not-found, transient network, or the editor's own
 * output fails validation), the function returns the already-validated draft
 * unchanged. Iterating through fallback models here would cost extra LLM
 * calls per chunk for no compression benefit — the draft is already known to
 * be valid and the editor pass is purely a polish step. Letting the editor
 * silently no-op back to the draft is the cheaper and safer behavior.
 */
async function runEditorPassOrFallback(args: {
    client: PluginContext["client"] | undefined;
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    draftXml: string;
    language?: string;
    draftValidation: ValidatedHistorianPassResult;
    draftDumpPath?: string;
    draftInvocationId?: number | null;
    model?: ModelInput;
    /**
     * The draft's child, when the caller retains children for turn two. The child of
     * whichever reply is returned (the editor's when accepted, else the draft's) is
     * kept on the result; the other is closed.
     */
    draftRetained?: RetainedHistorianChild;
    retainChild?: boolean;
    turnTwoEnabled?: boolean;
}): Promise<ValidatedHistorianPassResult> {
    shared.sessionLog(args.parentSessionId, "historian two-pass: running editor on draft");
    const keepDraft = (): ValidatedHistorianPassResult =>
        args.draftValidation.ok
            ? {
                  ...args.draftValidation,
                  invocationId: args.draftInvocationId ?? null,
                  retainedChild: args.draftRetained,
                  reportedProfile: args.draftRetained?.reportedProfile,
              }
            : args.draftValidation;
    const editorRun = await runHistorianPrompt({
        client: args.client,
        hiddenCompletionExecutor: args.hiddenCompletionExecutor,
        db: args.db,
        parentSessionId: args.parentSessionId,
        sessionDirectory: args.sessionDirectory,
        prompt: buildHistorianEditorPrompt(args.draftXml),
        timeoutMs: args.timeoutMs,
        maxOutputTokens: args.maxOutputTokens,
        language: args.language,
        dumpLabel: `${args.dumpLabelBase}-editor`,
        agentId: HISTORIAN_EDITOR_AGENT,
        parentInvocationId: args.draftInvocationId ?? null,
        modelOverride: args.model,
        retainChild: args.retainChild,
    });

    if (!editorRun.ok || !editorRun.result) {
        shared.sessionLog(args.parentSessionId, "historian two-pass: editor call failed", {
            error: editorRun.error,
        });
        // Editor failed → keep the validated draft; FK links to the draft run.
        return keepDraft();
    }

    const editorValidation = validateHistorianOutput(
        editorRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (!editorValidation.ok) {
        shared.sessionLog(
            args.parentSessionId,
            "historian two-pass: editor validation failed, falling back to draft",
            { error: editorValidation.error },
        );
        // Editor output was bad — keep editor dump for debugging.
        await editorRun.retained?.close();
        return keepDraft();
    }

    cleanupHistorianDump(args.parentSessionId, editorRun.dumpPath);
    if (args.turnTwoEnabled) {
        await editorRun.retained?.close();
        return keepDraft();
    }
    shared.sessionLog(args.parentSessionId, "historian two-pass: editor accepted");
    // The editor's reply is the one published, so its child is the one turn two continues.
    await args.draftRetained?.close();
    return {
        ...editorValidation,
        invocationId: editorRun.invocationId ?? null,
        retainedChild: editorRun.retained,
    };
}

async function runHistorianPrompt(args: {
    client: PluginContext["client"] | undefined;
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    dumpLabel?: string;
    language?: string;
    modelOverride?: ModelInput;
    /** Use `write` to retain cache markers when a later turn can reuse the complete user block. */
    cacheTail?: import("../../shared/historian-cache").HistorianCacheTail;
    /** Agent identifier to route the request to. Defaults to HISTORIAN_AGENT.
     *  Use HISTORIAN_EDITOR_AGENT for the second pass in two-pass mode. */
    agentId?: string;
    /** Resolved historian fallback chain (forwarded to the prompt helper). */
    fallbackModels?: readonly ModelInput[];
    subagentKind?: SubagentKind;
    accountingTask?: string | null;
    parentInvocationId?: number | null;
    /**
     * Keep the child open after a successful run and hand it back as `retained`, so
     * turn two can continue the same session. The caller then owns closing it.
     */
    retainChild?: boolean;
    turnTwoEnabled?: boolean;
    turnOneStageKey?: string;
    recoverTurnOne?: boolean;
}): Promise<HistorianRunResult> {
    const {
        client,
        db,
        parentSessionId,
        sessionDirectory,
        prompt,
        timeoutMs,
        dumpLabel,
        modelOverride,
        agentId = HISTORIAN_AGENT,
        fallbackModels,
        subagentKind,
        parentInvocationId,
    } = args;
    let agentSessionId: string | null = null;
    let handle: HiddenRunHandle | null = null;
    let completion: HiddenCompletion | undefined;
    const executor = resolveHiddenCompletionExecutor(
        args.hiddenCompletionExecutor,
        client,
        db,
        sessionDirectory,
        "historian",
    );
    // OpenCode 1 keeps the host's historical cache behavior; OpenCode 2 can
    // omit the one-shot body tail while still caching its configured system prompt.
    const cacheTail =
        args.cacheTail ?? (executor.capabilities.harness === "opencode2" ? "skip" : undefined);
    let promptSettled = false;
    let hadUnsettledPrompt = false;
    let childRetained = false;
    let releaseChild: (() => Promise<void>) | undefined;
    let answeringModel = modelOverride;
    const startedAt = Date.now();
    let invocationRecorded = false;

    const recordInvocation = (params: {
        status: SubagentInvocationStatus;
        messages?: unknown[];
        error?: unknown;
        hostError?: unknown;
    }): number | null => {
        if (invocationRecorded) return null;
        invocationRecorded = true;
        const configuredModel = toModelEntry(modelOverride);
        const actualModelRef =
            completion?.providerId && completion.modelId
                ? `${completion.providerId}/${completion.modelId}`
                : (handle?.attemptedModel ?? configuredModel?.model ?? null);
        const usedConfiguredFallback =
            actualModelRef !== null &&
            (fallbackModels ?? []).some(
                (candidate) => toModelEntry(candidate)?.model === actualModelRef,
            );
        return recordChildInvocation({
            db: openDatabase(),
            parentSessionId,
            harness: executor.capabilities.harness,
            subagent:
                agentId === HISTORIAN_EDITOR_AGENT
                    ? "historian_editor"
                    : (subagentKind ?? "historian"),
            task: args.accountingTask ?? (usedConfiguredFallback ? "fallback" : null),
            startedAt,
            status: params.status,
            messages: params.messages,
            ...(completion && !completion.messages
                ? {
                      tokens: completion.usage,
                      providerId: completion.providerId,
                      modelId: completion.modelId,
                  }
                : {}),
            attemptedModel: handle?.attemptedModel ?? modelOverride,
            configuredModels: fallbackModels,
            modelConfigKey: handle?.modelConfigKey ?? configuredModel?.sourceConfigKey,
            hostError: params.hostError ?? completion?.hostError,
            error: params.error,
            parentInvocationId:
                agentId === HISTORIAN_EDITOR_AGENT ? (parentInvocationId ?? null) : null,
        });
    };

    let system = withContentLanguageDirective(
        agentId === HISTORIAN_EDITOR_AGENT
            ? HISTORIAN_EDITOR_SYSTEM_PROMPT
            : historianSystemPrompt(args.turnTwoEnabled === true),
        args.language,
    );
    if (args.turnOneStageKey) {
        const row = db
            .prepare("SELECT request_json FROM memory_stage_attempts WHERE stage_key=?")
            .get(args.turnOneStageKey) as { request_json: string };
        system = JSON.parse(row.request_json).system;
    }
    // Admit the prompt before opening a child session. A prompt that cannot fit
    // the selected model would be refused by the transport anyway, and opening
    // first left one more hidden session behind for every refused attempt.
    const overrideModel = parseModelOverride(toModelEntry(modelOverride)?.model ?? "");
    const preOpenFailure =
        !args.recoverTurnOne && overrideModel
            ? historianPromptAdmissionFailure({
                  model: overrideModel,
                  prompt,
                  system,
                  maxOutputTokens: args.maxOutputTokens,
                  parentSessionId,
              })
            : null;
    if (preOpenFailure) {
        shared.sessionLog(
            parentSessionId,
            `historian: prompt refused before opening a child session: ${preOpenFailure}`,
        );
        return {
            ok: false,
            error: `Historian failed while processing this session: ${preOpenFailure}`,
            failureReason: preOpenFailure,
        };
    }

    try {
        shared.sessionLog(
            parentSessionId,
            `historian: creating child session (agent=${toModelEntry(modelOverride)?.model ?? `agent:${agentId}`})`,
        );
        const recovering =
            args.recoverTurnOne && args.turnOneStageKey
                ? (db
                      .prepare(
                          "SELECT child_session_id,reply_json FROM memory_stage_attempts WHERE stage_key=? AND state IN ('sending','replied')",
                      )
                      .get(args.turnOneStageKey) as {
                      child_session_id: string;
                      reply_json: string | null;
                  } | null)
                : null;
        handle = recovering
            ? { id: recovering.child_session_id, childSessionId: recovering.child_session_id }
            : await executor.open({
                  parentSessionId,
                  parentInvocationId,
                  agent: agentId,
                  kind: agentId === HISTORIAN_EDITOR_AGENT ? "historian-editor" : "historian",
                  system,
                  maxOutputTokens: args.maxOutputTokens,
                  model: modelOverride,
                  configuredModels: [
                      ...(modelOverride ? [modelOverride] : []),
                      ...(fallbackModels ?? []),
                  ],
                  timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                  title: "magic-context-compartment",
                  directory: sessionDirectory,
                  metadata: { dumpLabel, subagentKind },
              });
        agentSessionId = handle.id || null;
        // The retry transport closes over the opened run; bind it once so the closure
        // sees the resolved handle rather than the nullable slot it was assigned to.
        const opened = handle;
        if (args.turnOneStageKey)
            releaseChild = registerTurnOneChild(opened.childSessionId ?? opened.id, () =>
                executor.close(opened, {
                    promptSettled,
                    privacySensitive: false,
                    context: "historian",
                    log: (message) => shared.sessionLog(parentSessionId, message),
                }),
            );
        if (args.turnOneStageKey && !recovering)
            db.prepare(
                "UPDATE memory_stage_attempts SET state='sending',child_session_id=? WHERE stage_key=? AND state='dispatched'",
            ).run(opened.childSessionId ?? opened.id, args.turnOneStageKey);

        if (recovering) {
            const saved = db
                .prepare("SELECT request_json FROM memory_stage_attempts WHERE stage_key=?")
                .get(args.turnOneStageKey!) as { request_json: string };
            answeringModel = JSON.parse(saved.request_json).answerModel ?? modelOverride;
            if (recovering.reply_json)
                completion = JSON.parse(recovering.reply_json) as HiddenCompletion;
            const state = await executor.recoveryState?.(recovering.child_session_id);
            if (!completion && state === "unavailable") {
                promptSettled = true;
                db.prepare(
                    "UPDATE memory_stage_attempts SET state='expired' WHERE stage_key=? AND state='sending'",
                ).run(args.turnOneStageKey!);
                return {
                    ok: false,
                    error: "Turn-one child no longer exists",
                    failureReason: "carrier_expired",
                };
            }
            if (!completion && state !== "active")
                completion = (await executor.recover?.(recovering.child_session_id)) ?? undefined;
            if (!completion) {
                childRetained = true;
                return {
                    ok: false,
                    error: "Turn-one outcome is still unknown",
                    failureReason: "outcome_unknown",
                };
            }
            promptSettled = true;
        }

        if (!agentSessionId) {
            recordInvocation({
                status: "failed",
                error: "Historian could not create its child session.",
            });
            return {
                ok: false,
                error: "Historian could not create its child session.",
                failureReason: "provider_error",
            };
        }

        for (
            let retryIndex = 0;
            !recovering && retryIndex <= MAX_HISTORIAN_RETRIES;
            retryIndex += 1
        ) {
            try {
                await shared.promptSyncWithModelSuggestionRetry(
                    client,
                    {
                        path: { id: agentSessionId },
                        ...(cacheTail !== undefined
                            ? { cacheTail: retryIndex > 0 ? "write" : cacheTail }
                            : {}),
                        query: { directory: sessionDirectory },
                        body: {
                            // Use the specified agent (HISTORIAN_AGENT by default, or
                            // HISTORIAN_EDITOR_AGENT for two-pass editor pass) so OpenCode
                            // loads the right system prompt. When modelOverride is set,
                            // OpenCode uses the override model but still loads the agent's
                            // registered system prompt.
                            agent: agentId,
                            ...modelBodyField(modelOverride),
                            // synthetic: true keeps this big internal prompt out of the
                            // OpenCode TUI subagent pane (would otherwise render as a huge
                            // unreadable visible message — see issue #50). The historian
                            // model still receives the part because toModelMessages only
                            // filters `ignored`, not `synthetic`.
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    },
                    {
                        transport: Object.assign(
                            (request: import("../../shared/model-suggestion-retry").PromptArgs) => {
                                const failure = historianPromptAdmissionFailure({
                                    model: request.body?.model,
                                    prompt,
                                    system,
                                    maxOutputTokens: args.maxOutputTokens,
                                    parentSessionId,
                                });
                                if (failure) throw new Error(failure);
                                if (request.body?.model)
                                    answeringModel = {
                                        model: `${request.body.model.providerID}/${request.body.model.modelID}`,
                                        qualifier: request.body.variant,
                                    };
                                if (args.turnOneStageKey)
                                    db.prepare(
                                        "UPDATE memory_stage_attempts SET request_json=json_set(request_json,'$.answerModel',json(?)) WHERE stage_key=?",
                                    ).run(
                                        JSON.stringify(answeringModel ?? null),
                                        args.turnOneStageKey,
                                    );
                                return executor.attempt(opened, request);
                            },
                            { childSessionId: opened.childSessionId },
                        ),
                        timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                        // A provider's spelling suggestion may name an unconfigured, costly model.
                        // Only the configured historian fallback chain may select a different model.
                        allowModelSuggestions: false,
                        // When modelOverride is set we're already in the last-ditch retry
                        // path; iterating fallbacks again would be redundant.
                        fallbackModels: modelOverride ? undefined : fallbackModels,
                        callContext:
                            agentId === HISTORIAN_EDITOR_AGENT ? "historian:editor" : "historian",
                    },
                );
                promptSettled = !hadUnsettledPrompt;
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt completed (attempt ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES + 1})`,
                );
                break;
            } catch (error: unknown) {
                hadUnsettledPrompt = true;
                promptSettled = false;
                const errorMsg = getErrorMessage(error);
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt attempt ${retryIndex + 1} failed: ${errorMsg}`,
                );
                const shouldRetry =
                    !args.turnTwoEnabled &&
                    retryIndex < MAX_HISTORIAN_RETRIES &&
                    isTransientHistorianPromptError(errorMsg);
                if (!shouldRetry) {
                    throw error;
                }

                const backoffMs = getHistorianRetryBackoffMs(retryIndex);
                shared.sessionLog(
                    parentSessionId,
                    `historian retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} after ${backoffMs}ms: ${errorMsg}`,
                );
                await sleep(backoffMs);
            }
        }

        completion ??= await executor.collect(handle, 50);
        if (args.turnOneStageKey)
            db.prepare(
                "UPDATE memory_stage_attempts SET state='replied',reply_json=? WHERE stage_key=? AND state='sending'",
            ).run(JSON.stringify(completion), args.turnOneStageKey);
        const lengthCapped = completion.lengthCapped;
        const tokens = {
            ...runTokenLog(undefined, args.maxOutputTokens),
            ...completion.tokenLog,
            max_tokens: args.maxOutputTokens ?? null,
        };
        shared.sessionLog(
            parentSessionId,
            `historian response_chars=${(completion.text ?? completion.reasoning ?? "").length} ${formatRunTokenLog(tokens)}`,
        );
        const textResult = completion.text;
        const profile = reportedProfile(
            completion,
            answeringModel,
            lifecycleTextHash(system),
            {
                harness: executor.capabilities.harness,
                carrier: args.hiddenCompletionExecutor ? "hidden-completion" : "opencode-session",
                agent: agentId,
            },
            args.turnTwoEnabled ? HISTORIAN_FORMAT_INSTRUCTION : undefined,
        );
        if (
            args.turnTwoEnabled &&
            (completion.toolActivity ||
                hasHistorianToolActivity(completion.messages) ||
                lengthCapped)
        )
            return {
                ok: false,
                error: "Invalid turn-one transport output",
                failureReason: "parse_failed",
                reportedProfile: profile ?? undefined,
            };
        const reasoningResult = textResult ? null : completion.reasoning;
        const emptyError =
            !textResult && reasoningResult && lengthCapped
                ? historianReasoningBudgetDiagnostic(completion.usage.output, tokens)
                : !textResult && !reasoningResult
                  ? "Historian returned no assistant output."
                  : !textResult
                    ? "Historian returned reasoning but no assistant text."
                    : lengthCapped
                      ? `Historian returned length-capped output. ${formatRunTokenLog(tokens)}`
                      : null;
        const invocationId = recordInvocation({
            status: emptyError ? "empty" : "completed",
            messages: completion.messages,
            error: emptyError,
            hostError: completion.hostError,
        });
        if (emptyError && (!reasoningResult || lengthCapped)) {
            return {
                ok: false,
                error: emptyError,
                failureReason: "empty_output",
                invocationId: invocationId ?? undefined,
                reportedProfile: profile ?? undefined,
            };
        }

        // The empty-output guard above returns when neither text nor reasoning came back.
        const result = textResult ?? reasoningResult;
        if (result == null) {
            return {
                ok: false,
                error: emptyError ?? "Historian returned no assistant output.",
                failureReason: "empty_output",
                invocationId: invocationId ?? undefined,
                reportedProfile: profile ?? undefined,
            };
        }
        const dumpPath = dumpHistorianResponse(
            parentSessionId,
            sessionDirectory,
            dumpLabel ?? "historian-response",
            result,
        );
        if (args.retainChild && textResult) {
            childRetained = true;
            const retainedHandle = handle;
            // The child stays open for turn two, but it must not keep other hidden
            // runs (later historian runs, turn two's own checks) waiting for its slot.
            executor.detach?.(retainedHandle);
            const settled = promptSettled;
            let closed = false;
            return {
                ok: true,
                result,
                dumpPath,
                invocationId: invocationId ?? undefined,
                reportedProfile: profile ?? undefined,
                retained: {
                    executor,
                    handle: retainedHandle,
                    agent: agentId,
                    system,
                    model: profile
                        ? {
                              model: `${profile.provider}/${profile.modelId}`,
                              qualifier: profile.variant ?? undefined,
                          }
                        : modelOverride,
                    directory: sessionDirectory,
                    turnOneText: textResult,
                    providerId: completion.providerId,
                    modelId: completion.modelId,
                    reportedProfile: profile ?? undefined,
                    close: async () => {
                        if (closed) return;
                        closed = true;
                        if (releaseChild) {
                            await releaseChild();
                            return;
                        }
                        await executor.close(retainedHandle, {
                            promptSettled: settled,
                            privacySensitive: false,
                            context: "historian",
                            log: (message) => shared.sessionLog(parentSessionId, message),
                        });
                    },
                },
            };
        }
        return {
            ok: true,
            result,
            dumpPath,
            invocationId: invocationId ?? undefined,
            reportedProfile: profile ?? undefined,
        };
    } catch (modelError: unknown) {
        // A failed response read does not make an accepted prompt safe to send again.
        // Keep its child and key until recovery observes a reply or confirms expiry.
        if (
            args.turnOneStageKey &&
            handle &&
            !completion &&
            (promptSettled ||
                args.recoverTurnOne ||
                /timed?\s*out|outcome.*unknown/i.test(getErrorMessage(modelError)))
        ) {
            childRetained = true;
            executor.detach?.(handle);
            return {
                ok: false,
                error: "Turn-one outcome is unknown",
                failureReason: "outcome_unknown",
            };
        }
        if (args.turnOneStageKey)
            db.prepare(
                "UPDATE memory_stage_attempts SET state='dispatched' WHERE stage_key=? AND state='sending'",
            ).run(args.turnOneStageKey);
        const desc = describeError(modelError);
        shared.sessionLog(
            parentSessionId,
            `historian prompt failed: ${desc.brief} promptLength=${prompt.length}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        recordInvocation({
            status: failedInvocationStatus(modelError),
            error: modelError,
        });
        const failureMessage = getErrorMessage(modelError);
        return {
            ok: false,
            error: `Historian failed while processing this session: ${desc.brief}`,
            failureReason: PRODUCER_PROMPT_FIT_FAILURE_PATTERN.test(failureMessage)
                ? failureMessage
                : externalHistorianFailureReason(modelError, "exception"),
            ...(modelError instanceof HiddenCompletionRefusal ? { refusal: modelError } : {}),
        };
    } finally {
        // A retained child stays open for turn two; its owner closes it.
        if (!childRetained && releaseChild) await releaseChild();
        else if (!childRetained)
            await executor.close(handle, {
                promptSettled,
                privacySensitive: false,
                context: "historian",
                log: (message) => shared.sessionLog(parentSessionId, message),
            });
    }
}

async function runFallbackHistorianPass(args: {
    client: PluginContext["client"] | undefined;
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    /** Active primary entry, used to avoid re-running the exact same attempt. */
    model?: ModelInput;
    /**
     * Configured historian fallback chain (e.g. `anthropic/claude-sonnet-4-6`),
     * tried in order without adding the session model. Each candidate's
     * output is validated — empty or unparseable output (e.g. a misconfigured
     * primary that returns nothing, or a model that replies conversationally
     * instead of emitting compartments) escalates to the next candidate rather
     * than failing the whole pass.
     */
    fallbackModels?: readonly ModelInput[];
    /**
     * The live session provider/model, used only when no primary is configured.
     */
    fallbackModelId?: string;
    callbacks?: HistorianProgressCallbacks;
    agentId?: string;
    error: string;
    failureReason?: string;
    language?: string;
    dumpPaths: Array<string | undefined>;
    retainChild?: boolean;
    turnTwoEnabled?: boolean;
    turnOneStageKey?: string;
}): Promise<ValidatedHistorianPassResult> {
    // Ordered escalation that matches the intended fallback policy:
    //   configured fallback_models (in order); only an absent primary permits
    //   the session model. A configured primary owns the complete allowed chain.
    // The primary model already ran (and was repaired) before we get here.
    // Validation gates EVERY candidate, so a model that returns no usable
    // compartments escalates to the next instead of ending the pass — this is
    // exactly the path a misconfigured/empty-returning primary needs, since an
    // empty-but-successful response never throws and so never triggers the
    // throw-based chain inside the prompt call.
    const seen = new Set<string>();
    const chain: ResolvedModelEntry[] = [];
    const primary = toModelEntry(args.model);
    for (const candidateInput of [
        ...(args.fallbackModels ?? []),
        ...(!primary && args.fallbackModelId ? [{ model: args.fallbackModelId }] : []),
    ]) {
        const candidate = toModelEntry(candidateInput);
        if (!candidate) continue;
        const key = `${candidate.model}\u0000${candidate.qualifier ?? ""}`;
        if (!candidate.model || seen.has(key)) continue;
        // Do not repeat the primary attempt, but keep the same model when its
        // fallback intentionally selects a different variant.
        if (primary?.model === candidate.model && primary.qualifier === candidate.qualifier) {
            continue;
        }
        seen.add(key);
        chain.push(candidate);
    }
    if (chain.length === 0) {
        return {
            ok: false,
            error: args.error,
            failureReason: args.failureReason ?? "provider_error",
        };
    }

    let lastError = args.error;
    let lastFailureReason = args.failureReason ?? "provider_error";
    for (let i = 0; i < chain.length; i += 1) {
        const modelOverride = chain[i];
        const modelId = modelOverride.model;
        if (!parseModelOverride(modelId)) continue;

        const isSessionModelLastResort = modelId === args.fallbackModelId && i === chain.length - 1;
        shared.sessionLog(
            args.parentSessionId,
            `compartment agent: retrying historian with ${modelId} (${
                isSessionModelLastResort ? "session-model last resort" : "configured fallback"
            } ${i + 1}/${chain.length})`,
        );
        args.callbacks?.onModelFallback?.(modelId, i + 1, chain.length);

        const fallbackRun = await runHistorianPrompt({
            client: args.client,
            hiddenCompletionExecutor: args.hiddenCompletionExecutor,
            db: args.db,
            parentSessionId: args.parentSessionId,
            sessionDirectory: args.sessionDirectory,
            prompt: args.prompt,
            timeoutMs: args.timeoutMs,
            maxOutputTokens: args.maxOutputTokens,
            language: args.language,
            dumpLabel: `${args.dumpLabelBase}-fallback-${i + 1}`,
            modelOverride,
            agentId: args.agentId,
            retainChild: args.retainChild,
            turnTwoEnabled: args.turnTwoEnabled,
            turnOneStageKey: args.turnOneStageKey,
            accountingTask: isSessionModelLastResort ? "fallback-session" : "fallback",
        });
        if (!fallbackRun.ok || !fallbackRun.result) {
            if (
                fallbackRun.failureReason === "outcome_unknown" ||
                fallbackRun.failureReason === "carrier_expired"
            )
                return {
                    ok: false,
                    error: fallbackRun.error ?? "Turn-one outcome unavailable",
                    failureReason: fallbackRun.failureReason,
                };
            if (
                args.turnTwoEnabled &&
                (fallbackRun.failureReason === "parse_failed" ||
                    fallbackRun.failureReason === "empty_output")
            )
                return {
                    ok: false,
                    error: fallbackRun.error ?? "Invalid turn one",
                    failureReason: "parse_failed",
                    reportedProfile: fallbackRun.reportedProfile,
                };
            lastError = fallbackRun.error ?? lastError;
            lastFailureReason = fallbackRun.failureReason ?? "provider_error";
            continue;
        }

        const fallbackXml = args.turnTwoEnabled
            ? parseEnabledTurnOne(fallbackRun.result)
            : fallbackRun.result;
        const fallbackValidation =
            fallbackXml === null
                ? { ok: false as const, error: "Invalid turn-one envelope" }
                : validateHistorianOutput(
                      fallbackXml,
                      args.parentSessionId,
                      args.chunk,
                      args.priorCompartments,
                      args.sequenceOffset,
                  );
        if (fallbackValidation.ok) {
            // Only cleanup the successful run's dump. Prior failed dumps
            // (args.dumpPaths + earlier chain attempts) are kept for debugging.
            cleanupHistorianDump(args.parentSessionId, fallbackRun.dumpPath);
            return {
                ...fallbackValidation,
                invocationId: fallbackRun.invocationId ?? null,
                retainedChild: fallbackRun.retained,
                reportedProfile: fallbackRun.reportedProfile,
            };
        }
        await fallbackRun.retained?.close();
        if (args.turnTwoEnabled)
            return {
                ok: false,
                error: fallbackValidation.error ?? "Invalid turn one",
                failureReason: "parse_failed",
                reportedProfile: fallbackRun.reportedProfile,
            };
        lastError = fallbackValidation.error ?? lastError;
        lastFailureReason = fallbackValidation.error ?? "parse_failed";
        // Keep the dump for debugging; escalate to the next candidate.
    }

    return { ok: false, error: lastError, failureReason: lastFailureReason };
}

/**
 * Whether `prompt` fits the selected producer model's window, after its output
 * reserve and the estimator margin. Returns the refusal reason, or null when the
 * prompt fits or the window is unknown (the prompt then goes out unguarded).
 */
export function historianPromptAdmissionFailure(args: {
    model: { providerID: string; modelID: string } | undefined;
    prompt: string;
    system: string;
    maxOutputTokens?: number;
    parentSessionId: string;
}): string | null {
    const selected = args.model;
    const modelKey = selected ? `${selected.providerID}/${selected.modelID}` : undefined;
    const contextLimitTokens = selected
        ? getSdkContextLimit(selected.providerID, selected.modelID, undefined, {
              reservation: "none",
          })
        : undefined;
    const producerLimits = selected ? resolveHistorianProducerLimits(modelKey) : {};
    const producerContext =
        producerLimits.context ??
        (producerLimits.input === undefined ? contextLimitTokens : undefined);
    const reserve = historianProducerReserve(
        producerContext,
        args.maxOutputTokens,
        selected ? getSdkOutputLimit(selected.providerID, selected.modelID) : undefined,
    );
    if (
        contextLimitTokens !== undefined &&
        producerInputTokenLimit(producerContext, reserve, producerLimits.input) === undefined &&
        modelKey &&
        !unknownProducerWindows.has(modelKey)
    ) {
        unknownProducerWindows.add(modelKey);
        shared.sessionLog(
            args.parentSessionId,
            `producer window inconsistent for ${modelKey}: window=${contextLimitTokens} reserve=${reserve}; sending unguarded`,
        );
    }
    const failure = producerPromptFailureReason({
        sourceLocal: estimateTokens(args.prompt),
        systemLocal: estimateTokens(args.system),
        toolsLocal: 0,
        modelKey,
        contextLimitTokens: producerContext,
        inputLimitTokens: producerLimits.input,
        maxOutputTokens: reserve,
    });
    if (failure) return failure;
    if (modelKey && contextLimitTokens === undefined && !unknownProducerWindows.has(modelKey)) {
        unknownProducerWindows.add(modelKey);
        shared.sessionLog(
            args.parentSessionId,
            `producer window unknown for ${modelKey}: sending unguarded`,
        );
    }
    return null;
}

function parseModelOverride(modelId: string): { providerID: string; modelID: string } | null {
    const [providerID, ...modelParts] = modelId.split("/");
    const modelID = modelParts.join("/");
    if (!providerID || modelID.length === 0) {
        return null;
    }

    return { providerID, modelID };
}

function getHistorianRetryBackoffMs(retryIndex: number): number {
    if (retryIndex === 0) {
        return 2_000 + Math.floor(Math.random() * 1_001);
    }

    return 6_000 + Math.floor(Math.random() * 2_001);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function cleanupHistorianDump(sessionId: string, dumpPath?: string): void {
    if (!dumpPath) return;

    try {
        unlinkSync(dumpPath);
    } catch (error: unknown) {
        shared.sessionLog(
            sessionId,
            "compartment agent: failed to remove historian response dump",
            {
                dumpPath,
                error: getErrorMessage(error),
            },
        );
    }
}

function dumpHistorianResponse(
    sessionId: string,
    directory: string,
    label: string,
    text: string,
): string | undefined {
    try {
        const dumpDir = historianResponseDumpDir(directory);
        mkdirSync(dumpDir, { recursive: true });
        // Keep the transient dump dir out of the user's git status.
        ensureCortexKitArtifactGitignore(directory);
        const safeSessionId = sanitizeDumpName(sessionId);
        const safeLabel = sanitizeDumpName(label);
        const dumpPath = join(dumpDir, `${safeSessionId}-${safeLabel}-${Date.now()}.xml`);
        writeFileSync(dumpPath, text, "utf8");
        shared.sessionLog(sessionId, "compartment agent: historian response dumped", {
            label,
            dumpPath,
        });
        return dumpPath;
    } catch (error: unknown) {
        shared.sessionLog(sessionId, "compartment agent: failed to dump historian response", {
            label,
            error: getErrorMessage(error),
        });
        return undefined;
    }
}

function sanitizeDumpName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
