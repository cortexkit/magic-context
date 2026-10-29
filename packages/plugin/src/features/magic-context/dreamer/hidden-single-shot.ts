import { withContentLanguageDirective } from "../../../agents/language-directive";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
} from "../../../hooks/magic-context/compartment-runner-types";
import * as shared from "../../../shared";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import type { PromptArgs } from "../../../shared/model-suggestion-retry";
import { modelBodyField, toModelEntry } from "../../../shared/resolve-fallbacks";
import { formatRunTokenLog, runTokenLog } from "../../../shared/run-token-log";
import { annotateSubagentInvocationError } from "../subagent-token-capture";

/**
 * How long a Dreamer model may stay completely silent (nothing streamed, no
 * tokens) before the model chain gives up on it and moves to the next
 * configured model. A free or overloaded model that stops answering otherwise
 * holds the whole task slice, up to 20 minutes, before failing. Healthy models
 * start streaming within seconds, so this only trips on a model that is not
 * answering at all.
 */
export const DREAMER_FIRST_OUTPUT_TIMEOUT_MS = 90_000;

export interface HiddenSingleShotArgs<T> {
    executor: HiddenCompletionExecutor;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    /** Agent id the carrier should answer as; carriers that own their own agent ignore it. */
    agent: string;
    system: string;
    prompt: string;
    /** Child session title, used by carriers that create a visible session. */
    title: string;
    /** Log/telemetry label, e.g. "dreamer:review-user-memories". */
    callContext: string;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    language?: string;
    timeoutMs: number;
    /** See `PromptRetryOptions.firstOutputTimeoutMs`. Undefined = no first-output deadline. */
    firstOutputTimeoutMs?: number;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    privacySensitive?: boolean;
    /** The curation task can finish after completed memory updates without a final text response. */
    allowEmpty?: boolean;
    /** Read completed per-memory XML entries before closing a failed hidden session. */
    onFailureOutput?: (completion: HiddenCompletion) => void;
    onOpened?: (sessionId: string) => void;
    /**
     * Turn the complete assistant text into the caller's result. Throwing here
     * rejects this model's answer and advances to the next configured fallback.
     */
    parse: (text: string, completion: HiddenCompletion) => T;
}

export interface HiddenSingleShotResult<T> {
    validated: T;
    completion: HiddenCompletion;
    childSessionId: string;
}

/**
 * Run one Dreamer prompt through a hidden completion carrier and hand the
 * caller the parsed answer. The carrier owns any tool steps for its agent.
 *
 * Tasks normally answer with one self-contained document (JSON or XML), so
 * incomplete output is rejected. Mapping and verification can recover closed per-memory
 * entries through onFailureOutput. Two guards keep normal completion fail-closed,
 * matching what the memory classifier
 * already does on this same transport:
 *  - a completion the provider cut short at the output limit is rejected before
 *    the parser sees it, so a truncated prefix is never accepted as a complete answer; and
 *  - an empty completion is rejected rather than parsed as "nothing to do".
 * The caller's own parser is still responsible for rejecting a document whose
 * structure is incomplete — for these tasks that means a JSON object that does
 * not close, or a manifest missing its closing root tag.
 */
export async function runHiddenSingleShotPrompt<T>(
    args: HiddenSingleShotArgs<T>,
): Promise<HiddenSingleShotResult<T>> {
    const system = withContentLanguageDirective(args.system, args.language);
    const opening = args.executor.open({
        parentSessionId: args.parentSessionId,
        agent: args.agent,
        kind: "dreamer-task",
        system,
        model: args.model,
        configuredModels: [...(args.model ? [args.model] : []), ...(args.fallbackModels ?? [])],
        timeoutMs: args.timeoutMs,
        title: args.title,
        directory: args.sessionDirectory,
        ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    // If opening ignores cancellation, retire its eventual handle without dispatching.
    void opening
        .then((handle) => {
            if (args.signal?.aborted)
                return args.executor.close(handle, {
                    promptSettled: false,
                    privacySensitive: args.privacySensitive ?? true,
                    context: `[dreamer] ${args.callContext}`,
                    log,
                });
        })
        .catch(() => {});
    const handle: HiddenRunHandle = await shared.raceWithSignal(opening, args.signal);
    let completion: HiddenCompletion | undefined;
    args.onOpened?.(handle.id);
    let promptSettled = false;
    try {
        if (!handle.id) throw new Error(`${args.callContext}: carrier returned no session id`);
        const run = await shared.promptSyncWithValidatedOutputRetry(
            // The carrier owns dispatch through `transport` and output reading
            // through `fetchOutput`, so the SDK client is never consulted; passing
            // undefined keeps a completion-only host from needing one at all.
            undefined,
            {
                path: { id: handle.id },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: args.agent,
                    system,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: args.prompt, synthetic: true }],
                },
            },
            {
                transport: Object.assign(
                    (request: PromptArgs) => args.executor.attempt(handle, request),
                    { childSessionId: handle.childSessionId },
                ),
                timeoutMs: args.timeoutMs,
                ...(args.firstOutputTimeoutMs !== undefined
                    ? { firstOutputTimeoutMs: args.firstOutputTimeoutMs }
                    : {}),
                ...(args.signal ? { signal: args.signal } : {}),
                fallbackModels: args.fallbackModels,
                callContext: args.callContext,
                fetchOutput: async () => {
                    completion = await args.executor.collect(handle, 50);
                    return completion;
                },
                validateOutput: (completion) => {
                    const tokens = completion.tokenLog ?? runTokenLog(undefined);
                    shared.sessionLog(
                        args.parentSessionId ?? "dreamer",
                        `${args.callContext} response_chars=${(completion.text ?? completion.reasoning ?? "").length} ${formatRunTokenLog(tokens)}`,
                    );
                    if (completion.lengthCapped) {
                        throw new Error(
                            completion.reasoning && !completion.text
                                ? `${args.callContext} ran out of output budget while reasoning (length-capped at ${completion.usage.output} tokens, no text; ${formatRunTokenLog(tokens)}) — set dreamer.maxTokens or use a low-reasoning model`
                                : `${args.callContext} returned length-capped output; ${formatRunTokenLog(tokens)}`,
                        );
                    }
                    const text = completion.text;
                    if (!text && !args.allowEmpty)
                        throw new Error(`${args.callContext} returned no output`);
                    return args.parse(text ?? "", completion);
                },
            },
        );
        promptSettled = true;
        return { validated: run.validated, completion: run.output, childSessionId: handle.id };
    } catch (error) {
        const configuredModel = toModelEntry(args.model);
        annotateSubagentInvocationError(error, {
            attemptedModel:
                completion?.attemptedModel ?? handle.attemptedModel ?? configuredModel?.model,
            modelConfigKey:
                completion?.modelConfigKey ??
                handle.modelConfigKey ??
                configuredModel?.sourceConfigKey,
            ...(completion?.hostError === undefined ? {} : { hostError: completion.hostError }),
        });
        if (args.onFailureOutput) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const completion = await Promise.race([
                    args.executor.collectPartial?.(handle, 200) ??
                        args.executor.collect(handle, 200),
                    new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), 5_000);
                    }),
                ]);
                if (completion) args.onFailureOutput(completion);
            } catch (readError) {
                log(
                    `${args.callContext}: failed to collect interrupted output: ${String(readError)}`,
                );
            } finally {
                clearTimeout(timer);
            }
        }
        throw error;
    } finally {
        const close = args.executor.close(handle, {
            promptSettled,
            privacySensitive: args.privacySensitive ?? true,
            context: `[dreamer] ${args.callContext}`,
            log,
        });
        // Retiring an interrupted child must not reopen the investigation deadline.
        if (args.signal?.aborted) void close.catch(() => {});
        else await shared.raceWithSignal(close, args.signal);
    }
}
