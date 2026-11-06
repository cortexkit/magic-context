import type { createOpencodeClient } from "@opencode-ai/sdk";
import {
    DreamerProviderOutputFailureError,
    primaryQuotaFailure,
    providerOutputFailureFromInvalidManifest,
    rememberPrimaryQuota,
} from "../features/magic-context/dreamer/provider-output-failure";
import { DreamTokenBudgetExceeded } from "../features/magic-context/dreamer/token-budget";
import { detectOverflow } from "../features/magic-context/overflow-detection";
import { HiddenCompletionRefusal } from "../hooks/magic-context/compartment-runner-types";
import { HiddenAgentStepLimit } from "../v2/hooks/hidden-child";
import {
    describeAssistantError,
    describeAssistantSettlement,
    extractLatestAssistantFailure,
    extractLatestAssistantText,
} from "./assistant-message-extractor";
import { log } from "./logger";
import type { ModelInput } from "./model-resolution";
import { sanitizeDiagnosticText } from "./redaction";
import { parseProviderModel, toModelEntry } from "./resolve-fallbacks";

type Client = ReturnType<typeof createOpencodeClient> | undefined;

export type PromptTransport = ((args: PromptArgs) => Promise<void>) & {
    readonly childSessionId?: string;
};

/** Max time to wait for the best-effort child-session abort HTTP call before
 *  giving up on its response (the abort still proceeds server-side). Keeps a
 *  wedged abort endpoint from masking the original timeout/abort error. */
const ABORT_CALL_TIMEOUT_MS = 3000;

export type PromptBody = {
    model?: { providerID: string; modelID: string };
    /** OpenCode variant; Pi's facade also uses it as the active thinking level. */
    variant?: string;
    [key: string]: unknown;
};

export type PromptArgs = {
    path: { id: string };
    body: PromptBody;
    /** Controls hidden historian message-block cache markers; never serialized in the prompt body. */
    cacheTail?: import("./historian-cache").HistorianCacheTail;
    signal?: AbortSignal;
    [key: string]: unknown;
};

/**
 * Keep a prompt body independent from SDK/client mutation. Some prompt facades
 * normalize or consume request bodies while handling a failed attempt; fallback
 * attempts must start from the original system prompt and request body every time.
 */
function copyPromptArgs(args: PromptArgs, body: PromptBody): PromptArgs {
    return { ...args, body: { ...body } };
}

export interface PromptAttemptInfo {
    /** Human-readable model label used in logs ("primary" or "provider/model"). */
    label: string;
    /** Zero-based attempt index: 0 is primary, 1+ are fallback models. */
    attemptIndex: number;
    /** True for configured fallback models, false for the primary attempt. */
    isFallback: boolean;
    /** Total attempted models including the primary and all configured fallbacks. */
    totalAttempts: number;
    /** Explicit model override for this attempt, when one was supplied. */
    model?: { providerID: string; modelID: string };
    /** A run-local quota deadline prevented dispatch; not an actual model call. */
    skipped?: boolean;
}

export interface PromptRetryOptions {
    transport?: PromptTransport;
    timeoutMs?: number;
    /** False for callers whose configured model chain must not accept provider suggestions. Defaults to true. */
    allowModelSuggestions?: boolean;
    /** External abort signal — cancels the in-flight LLM prompt immediately when aborted */
    signal?: AbortSignal;
    /**
     * Ordered list of "provider/modelID" alternates to try if the primary call
     * (and its single-suggestion retry) fails. Empty / undefined = no fallback
     * iteration (legacy behavior).
     *
     * Fallback policy:
     *   - Each fallback gets the FULL `timeoutMs` budget (per-attempt, not total).
     *   - Suggestion-retry runs inside each attempt (so "did you mean X?" errors
     *     still self-heal at the primary AND at each fallback).
     *   - Iteration stops immediately on abort/timeout/context-overflow errors —
     *     fallbacks won't help and the caller's emergency-recovery path needs
     *     to handle these. The exception is an attempt cut by
     *     `firstOutputTimeoutMs` (see there), which moves on to the next model.
     *   - On all-failed, the LAST error is thrown (matches legacy behavior when
     *     `fallbackModels` is empty).
     */
    fallbackModels?: readonly ModelInput[];
    /**
     * How long an attempt may go without the model producing anything (no
     * streamed text, reasoning, tool call, or token usage) before the model is
     * treated as hung. The attempt is then stopped and the next configured model
     * runs with whatever is left of `timeoutMs`, so a dead model costs this
     * bound instead of the whole timeout. An attempt that has produced output
     * keeps its full timeout and, if that expires, still ends the chain.
     *
     * Applies only to an attempt that has a later model to move to, is capped at
     * half that attempt's timeout so the next model keeps a usable share, and
     * only works with transports that watch the child for output (OpenCode's
     * `prompt_async` wait). Undefined = no first-output deadline.
     */
    firstOutputTimeoutMs?: number;
    /**
     * Identifier for structured logging (e.g. "dreamer:consolidate",
     * "historian", "compressor", "dreamer"). Helps correlate fallback
     * attempts to a specific call site in `magic-context.log`. Defaults to
     * "subagent" if not provided.
     */
    callContext?: string;
}

export interface ValidatedPromptRetryOptions<TOutput, TValidated> extends PromptRetryOptions {
    /**
     * Fetch the output produced by the just-completed prompt attempt. This is
     * intentionally caller-owned because OpenCode exposes results via session
     * messages and each caller validates a different shape.
     */
    fetchOutput: (args: PromptArgs, attempt: PromptAttemptInfo) => Promise<TOutput>;
    /**
     * Validate and optionally transform the fetched output. Throw to reject this
     * model's output and advance to the next configured fallback model.
     */
    validateOutput: (
        output: TOutput,
        attempt: PromptAttemptInfo,
    ) => TValidated | Promise<TValidated>;
}

export interface ValidatedPromptRetryResult<TOutput, TValidated> {
    output: TOutput;
    validated: TValidated;
    attempt: PromptAttemptInfo;
}

export type PromptFailureClass =
    | "provider_timeout"
    | "provider_error"
    | "local_refusal"
    | "step_limit"
    | "token_budget"
    | "empty_completion"
    | "no_models"
    | "child_aborted"
    | "parse_failed"
    | "unknown";

/** Diagnostic facts retained when a validated child prompt ultimately fails. */
export interface PromptFailureDetail {
    failureClass: PromptFailureClass;
    modelAttempted: string | null;
    modelsTried: string[];
    providerError: string | null;
    timeoutMs: number | null;
    childSessionId: string | null;
    refusalReason?: string | null;
}

const promptFailureDetails = new WeakMap<object, PromptFailureDetail>();

/**
 * True for a request timer that fired inside the host client rather than ours.
 * Bun's fetch rejects with a DOMException named "TimeoutError" ("The operation
 * timed out.", legacy code 23) when its default per-request timer expires, and
 * `AbortSignal.timeout` produces the same shape. Some OpenCode 1 builds hand
 * plugins an SDK client whose fetch keeps Bun's default timer (about five to six
 * minutes), so a synchronous `session.prompt` that stays open for a whole agent
 * loop fails this way while the host keeps running the child session.
 */
export function isHostTimeoutError(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === "object" &&
        (error as { name?: unknown }).name === "TimeoutError"
    );
}

/**
 * The model chain cut this attempt short because the model had produced nothing
 * (no streamed text, reasoning, tool call, or token usage) by the first-output
 * deadline. A model that has not answered at all is treated like a provider
 * failure, so the next configured model gets the rest of the time.
 */
export class ModelProducedNoOutputError extends Error {
    constructor(readonly waitedMs: number) {
        // Keeps "timed out after Nms" so ledgers record the attempt as timed out.
        super(`prompt timed out after ${waitedMs}ms with no model output`);
        this.name = "ModelProducedNoOutputError";
    }
}

/**
 * What a transport has seen of the model during one attempt. `monitored` means
 * the transport watches the child's messages and will set `received` as soon as
 * the model streams anything. Transports that cannot see progress never set
 * `monitored`, and the first-output deadline then never fires for them.
 */
interface ModelActivity {
    monitored: boolean;
    received: boolean;
}

/** Keyed by the per-attempt abort signal that `promptWithTimeout` hands the transport. */
const modelActivityBySignal = new WeakMap<AbortSignal, ModelActivity>();

/** A transport calls this once it is watching the child for model output. */
export function noteModelActivityMonitored(signal: AbortSignal | undefined): void {
    const activity = signal ? modelActivityBySignal.get(signal) : undefined;
    if (activity) activity.monitored = true;
}

/** A transport calls this when it sees the model produce anything for this attempt. */
export function noteModelOutputReceived(signal: AbortSignal | undefined): void {
    const activity = signal ? modelActivityBySignal.get(signal) : undefined;
    if (activity) {
        activity.monitored = true;
        activity.received = true;
    }
}

/** Our own slice expiry (see `promptWithTimeout`) or a host request timer. */
export function isPromptTimeoutError(error: unknown): boolean {
    if (isHostTimeoutError(error)) return true;
    if (error instanceof ModelProducedNoOutputError) return true;
    return error instanceof Error && /^prompt timed out after \d+ms$/.test(error.message);
}

export function getPromptFailureDetail(error: unknown): PromptFailureDetail | null {
    return error !== null && typeof error === "object"
        ? (promptFailureDetails.get(error) ?? null)
        : null;
}

export interface ModelSuggestionInfo {
    providerID: string;
    modelID: string;
    suggestion: string;
}

function extractMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        const obj = error as Record<string, unknown>;
        if (typeof obj.message === "string") return obj.message;
    }

    try {
        return JSON.stringify(error);
    } catch (_error) {
        return String(error);
    }
}

export function parseModelSuggestion(error: unknown): ModelSuggestionInfo | null {
    if (!error) return null;

    if (typeof error === "object" && error !== null) {
        const errObj = error as Record<string, unknown>;

        if (
            errObj.name === "ProviderModelNotFoundError" &&
            typeof errObj.data === "object" &&
            errObj.data !== null
        ) {
            const data = errObj.data as Record<string, unknown>;
            const suggestions = data.suggestions;
            if (Array.isArray(suggestions) && typeof suggestions[0] === "string") {
                return {
                    providerID: String(data.providerID ?? ""),
                    modelID: String(data.modelID ?? ""),
                    suggestion: suggestions[0],
                };
            }
        }

        for (const key of ["data", "error", "cause"] as const) {
            const nested = errObj[key];
            if (nested && typeof nested === "object") {
                const result = parseModelSuggestion(nested);
                if (result) return result;
            }
        }
    }

    const message = extractMessage(error);
    const modelMatch = message.match(/model not found:\s*([^/\s]+)\s*\/\s*([^.,\s]+)/i);
    const suggestionMatch = message.match(/did you mean:\s*([^,?]+)/i);

    if (!modelMatch || !suggestionMatch) {
        return null;
    }

    return {
        providerID: modelMatch[1].trim(),
        modelID: modelMatch[2].trim(),
        suggestion: suggestionMatch[1].trim(),
    };
}

function externalAbortMessage(signal: AbortSignal): string {
    const reason = signal.reason;
    return `prompt aborted by external signal${reason instanceof Error && /^lease_(?:lost|expired):/.test(reason.message) ? `: ${reason.message}` : ""}`;
}

/** A carrier may ignore cancellation; stop waiting without trusting it to reject. */
export function raceWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    // Match await's handling of synchronous completion as well as promises.
    work = Promise.resolve(work);
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error(externalAbortMessage(signal)));
        if (signal.aborted) {
            work.catch(() => {});
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

async function promptWithTimeout(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal?: AbortSignal,
    transport?: PromptTransport,
    firstOutputTimeoutMs?: number,
): Promise<void> {
    // Bail immediately if the caller's signal is already aborted (e.g.
    // lease loss before this attempt was scheduled). Per spec
    // `addEventListener('abort', ...)` on an already-aborted signal fires
    // synchronously in modern Node/Bun, but an explicit guard is clearer
    // and avoids one wasted upstream `client.session.prompt` round-trip
    // before `isNonRetryable` catches the cancellation at the chain loop.
    if (signal?.aborted) {
        throw new Error(externalAbortMessage(signal));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const activity: ModelActivity = { monitored: false, received: false };
    modelActivityBySignal.set(controller.signal, activity);
    // Set when the first-output deadline, not the attempt timeout, ended the attempt.
    let silent = false;
    const firstOutputTimer =
        firstOutputTimeoutMs !== undefined && firstOutputTimeoutMs < timeoutMs
            ? setTimeout(() => {
                  // Only a transport that watches the child can say the model is silent.
                  if (!activity.monitored || activity.received) return;
                  silent = true;
                  controller.abort(new ModelProducedNoOutputError(firstOutputTimeoutMs));
              }, firstOutputTimeoutMs)
            : undefined;
    const timeoutError = () =>
        silent && firstOutputTimeoutMs !== undefined
            ? new ModelProducedNoOutputError(firstOutputTimeoutMs)
            : new Error(`prompt timed out after ${timeoutMs}ms`);

    // Link external signal to internal controller so external abort cancels the fetch
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
        const request = { ...args, signal: controller.signal };
        if (transport) await raceWithSignal(transport(request), controller.signal);
        else {
            if (!client) throw new Error("Hidden completion transport is unavailable");
            await raceWithSignal<unknown>(
                client.session.prompt(request as Parameters<typeof client.session.prompt>[0]),
                controller.signal,
            );
        }
    } catch (error) {
        if (signal?.aborted) {
            // External abort (e.g. dreamer lease loss): the child run loop is an
            // independent SERVER-SIDE fiber — cancelling our client fetch alone
            // leaves it looping the LLM forever (issue #154). Force-stop it.
            if (!transport || transport.childSessionId) {
                await abortChildRun(client, transport?.childSessionId ?? args.path.id);
            }
            throw new Error(externalAbortMessage(signal));
        }
        if (controller.signal.aborted) {
            // Our timeout fired. Same problem: abort the server-side run loop, not
            // just our fetch, or the child keeps re-calling the LLM past the
            // timeout (uncancellable by the user's ESC — issue #154).
            if (!transport || transport.childSessionId) {
                await abortChildRun(client, transport?.childSessionId ?? args.path.id);
            }
            throw timeoutError();
        }
        if (isHostTimeoutError(error)) {
            // The host client's own request timer fired. Only our side of the
            // request ended: the child's run loop is still going on the server and
            // would keep calling the model, so stop it the same way as above. The
            // original error is kept so the ledger still shows which timer fired.
            if (!transport || transport.childSessionId) {
                await abortChildRun(client, transport?.childSessionId ?? args.path.id);
            }
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        if (firstOutputTimer) clearTimeout(firstOutputTimer);
        signal?.removeEventListener("abort", onExternalAbort);
    }
    // Some transports resolve with an error result when their fetch is aborted.
    // A resolved fetch does not mean the server-side child run has stopped.
    if (signal?.aborted || controller.signal.aborted) {
        if (!transport || transport.childSessionId) {
            await abortChildRun(client, transport?.childSessionId ?? args.path.id);
        }
        throw signal?.aborted ? new Error(externalAbortMessage(signal)) : timeoutError();
    }
}

/**
 * Force-stop a spawned child session's server-side run loop. `controller.abort()`
 * on the prompt signal only cancels OUR client fetch; the run loop is a separate
 * instance-scoped fiber that `POST /session/{id}/abort` interrupts. Best-effort —
 * a failure here must not mask the original timeout/abort error.
 */
export async function abortChildRun(client: Client, sessionId: string): Promise<void> {
    if (!client) return;
    try {
        // Bound the abort call: it's best-effort cleanup, and if the abort
        // endpoint itself stalls (the runner is wedged) an unbounded await here
        // would hang the caller and MASK the original timeout/abort error that we
        // still need to surface. Race against a short timer; the abort keeps
        // running server-side regardless of whether we wait for its response.
        await Promise.race([
            client.session.abort({ path: { id: sessionId } }),
            new Promise<void>((resolve) => setTimeout(resolve, ABORT_CALL_TIMEOUT_MS)),
        ]);
    } catch (error) {
        log(`[model-retry] child session abort failed for ${sessionId}: ${String(error)}`);
    }
}

/**
 * Returns true if the error indicates a NON-RETRYABLE condition where iterating
 * to a fallback model would be pointless or harmful:
 *
 *   - External abort (user cancellation, lease loss, etc.) — caller wants to
 *     stop, not retry.
 *   - Context overflow — same prompt will overflow on any reasonably-sized
 *     model. Caller has its own emergency-recovery path for this.
 *   - Timeout — same wall-clock budget on the same prompt is unlikely to
 *     succeed on another model. Caller decides whether to retry at a higher
 *     level (e.g. historian's MAX_HISTORIAN_RETRIES loop). This covers an
 *     attempt that ran out its whole time, whether or not the model answered.
 *
 * A `ModelProducedNoOutputError` is the exception: no output was observed
 * before the first-output deadline, which points at the model rather than the
 * prompt, so the chain gives the next model the time that is left.
 *
 * Everything else (auth errors, ProviderModelNotFoundError without suggestion,
 * rate limits, transient network failures, etc.) is considered retryable on a
 * different model.
 */
function isNonRetryable(error: unknown, externalSignal?: AbortSignal): boolean {
    if (
        externalSignal?.aborted ||
        (error instanceof HiddenCompletionRefusal && error.terminal) ||
        error instanceof HiddenAgentStepLimit ||
        error instanceof DreamTokenBudgetExceeded
    )
        return true;

    if (error instanceof ModelProducedNoOutputError) return false;

    if (error instanceof Error) {
        if (error.name === "AbortError") return true;
        // promptWithTimeout wraps both abort cases in plain `Error` with a
        // recognizable message.
        if (error.message === "prompt aborted by external signal") return true;
        if (/^prompt timed out after \d+ms$/.test(error.message)) return true;
    }
    // A host request timer is a timeout too. Retrying would send the next model
    // into the same child session, where it meets the same timer.
    if (isHostTimeoutError(error)) return true;

    if (detectOverflow(error).isOverflow) return true;

    return false;
}

function shortErr(error: unknown): string {
    if (error instanceof Error) {
        return error.name && error.name !== "Error"
            ? `${error.name}: ${error.message}`
            : error.message;
    }
    return extractMessage(error);
}

type PromptFailurePhase = "prompt" | "output" | "validation";

interface FailedAttempt {
    error: unknown;
    failureClass: PromptFailureClass;
    attempt: PromptAttemptInfo;
}

function classifyPromptFailure(
    error: unknown,
    phase: PromptFailurePhase,
    externalSignal?: AbortSignal,
): PromptFailureClass {
    const message = extractMessage(error);
    if (error instanceof HiddenCompletionRefusal) return "local_refusal";
    if (error instanceof HiddenAgentStepLimit) return "step_limit";
    if (error instanceof DreamTokenBudgetExceeded) return "token_budget";
    if (externalSignal?.aborted || message === "prompt aborted by external signal") {
        return "child_aborted";
    }
    if (
        error instanceof ModelProducedNoOutputError ||
        /^prompt timed out after \d+ms$/.test(message) ||
        isHostTimeoutError(error)
    ) {
        return "provider_timeout";
    }
    if (phase === "validation") {
        if (/returned no (?:assistant )?output|no assistant output/i.test(message)) {
            return "empty_completion";
        }
        if (error instanceof Error && error.name === "DreamerProviderOutputFailureError") {
            return "provider_error";
        }
        return "parse_failed";
    }
    return phase === "prompt" || phase === "output" ? "provider_error" : "unknown";
}

function throwWithPromptFailure(
    legacyError: unknown,
    failedAttempts: FailedAttempt[],
    args: PromptArgs,
    timeoutMs: number,
    transport?: PromptTransport,
): never {
    const error =
        legacyError instanceof Error ? legacyError : new Error(extractMessage(legacyError));
    const last = failedAttempts.at(-1);
    const failureClass = last?.failureClass ?? "unknown";
    const quota = failedAttempts.find(
        (failure) =>
            failure.error instanceof DreamerProviderOutputFailureError &&
            failure.error.quotaResetAt !== undefined,
    )?.error as DreamerProviderOutputFailureError | undefined;
    if (quota && error !== quota && !error.message.includes(quota.message))
        error.message = `${quota.message}; ${error.message}`;
    const providerError =
        failureClass === "provider_error" || quota
            ? sanitizeDiagnosticText(
                  `${quota ? `${quota.message}; ` : ""}${shortErr(last?.error ?? legacyError)}`,
              ).slice(0, 500)
            : null;
    promptFailureDetails.set(error, {
        failureClass,
        modelAttempted: last?.attempt.label ?? null,
        modelsTried: failedAttempts
            .filter((failure) => !failure.attempt.skipped)
            .map((failure) => failure.attempt.label),
        providerError,
        timeoutMs: failureClass === "provider_timeout" ? timeoutMs : null,
        childSessionId: transport ? (transport.childSessionId ?? null) : args.path.id || null,
        ...(last?.error instanceof HiddenCompletionRefusal
            ? {
                  refusalReason: sanitizeDiagnosticText(last.error.message).slice(0, 500),
              }
            : {}),
    });
    throw error;
}

/**
 * Try a single prompt attempt against the supplied body, with the existing
 * single-suggestion retry layered inside (so "did you mean X?" still self-heals
 * per attempt). Throws on failure; returns on success.
 */
async function attemptOnce(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callContext: string,
    label: string,
    transport?: PromptTransport,
    allowModelSuggestions = true,
    firstOutputTimeoutMs?: number,
): Promise<void> {
    // Keep this snapshot separate from the object passed to the client. A
    // failed prompt facade may rewrite its request body before rejecting; the
    // model-suggestion retry still needs the original system prompt.
    const originalBody = { ...args.body };
    const attemptArgs = copyPromptArgs(args, originalBody);
    try {
        await promptWithTimeout(
            client,
            attemptArgs,
            timeoutMs,
            signal,
            transport,
            firstOutputTimeoutMs,
        );
        return;
    } catch (error) {
        // Non-retryable failures and callers with model suggestions disabled
        // must surface the original error without accepting a provider suggestion.
        if (isNonRetryable(error, signal) || !allowModelSuggestions) throw error;

        const suggestion = parseModelSuggestion(error);
        if (!suggestion || !originalBody.model) {
            // No suggestion available — caller's fallback loop will decide
            // whether to try the next chain entry.
            throw error;
        }

        log(`[${callContext}] ${label}: model not found, retrying with suggestion`, {
            original: `${suggestion.providerID}/${suggestion.modelID}`,
            suggested: suggestion.suggestion,
        });

        await promptWithTimeout(
            client,
            copyPromptArgs(args, {
                ...originalBody,
                model: {
                    providerID: suggestion.providerID,
                    modelID: suggestion.suggestion,
                },
            }),
            timeoutMs,
            signal,
            transport,
            firstOutputTimeoutMs,
        );
    }
}

/**
 * Per-attempt timing across one model chain. An attempt cut by the first-output
 * deadline has the time it used taken out of every later attempt's timeout, so
 * a silent model never stretches the caller's overall wait past `timeoutMs`.
 * Attempts that fail for other reasons keep the existing full per-attempt budget.
 */
function createChainClock(options: PromptRetryOptions, timeoutMs: number) {
    const fallbacks = options.fallbackModels ?? [];
    const hasValidFallbackFrom = (index: number) =>
        fallbacks.slice(index).some((fallback) => {
            const entry = toModelEntry(fallback);
            return entry ? parseProviderModel(entry.model) !== null : false;
        });
    let silentSpentMs = 0;
    return {
        /** Budget for an attempt whose next candidate is `fallbacks[nextFallbackIndex]`. */
        budget(nextFallbackIndex: number): { timeoutMs: number; firstOutputTimeoutMs?: number } {
            const attemptTimeoutMs = Math.max(1, timeoutMs - silentSpentMs);
            // The last model in the chain has nothing to move to, so it keeps the
            // plain timeout rather than being cut short for no benefit.
            if (
                options.firstOutputTimeoutMs === undefined ||
                !hasValidFallbackFrom(nextFallbackIndex)
            )
                return { timeoutMs: attemptTimeoutMs };
            const bound = Math.min(options.firstOutputTimeoutMs, Math.floor(attemptTimeoutMs / 2));
            return bound > 0
                ? { timeoutMs: attemptTimeoutMs, firstOutputTimeoutMs: bound }
                : { timeoutMs: attemptTimeoutMs };
        },
        settle(error: unknown, startedAt: number): void {
            if (error instanceof ModelProducedNoOutputError)
                silentSpentMs += Date.now() - startedAt;
        },
    };
}

/**
 * Run an OpenCode subagent prompt with model fallback support.
 *
 * Attempts the configured primary model first (whatever `args.body.model` or
 * the registered agent default resolves to), then iterates through
 * `options.fallbackModels` if provided. Each attempt internally retries once on
 * the SDK's "model not found, did you mean X?" suggestion. Aborts, timeouts,
 * and context-overflow errors short-circuit the fallback loop because retrying
 * the same prompt against another model won't help.
 *
 * Behavior with `fallbackModels` empty/undefined is identical to the pre-v0.18
 * single-suggestion retry — fully backward-compatible for callers that haven't
 * been updated to thread a chain.
 */
export async function promptSyncWithModelSuggestionRetry(
    client: Client,
    args: PromptArgs,
    options: PromptRetryOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    // Snapshot the body before the first client call. The Pi facade and the
    // OpenCode SDK both receive this same shape, and either may mutate it while
    // handling a failed request. Fallbacks must never inherit that mutation.
    const baseBody = { ...args.body };
    const baseArgs = copyPromptArgs(args, baseBody);

    // Attempt 0 = whatever the agent or explicit body.model resolves to.
    // Subsequent attempts override body.model with each fallback in order.
    const explicitPrimaryLabel =
        baseBody.model?.providerID && baseBody.model.modelID
            ? `${baseBody.model.providerID}/${baseBody.model.modelID}`
            : "primary";

    let lastError: unknown = null;
    const clock = createChainClock(options, timeoutMs);

    const primaryStartedAt = Date.now();
    try {
        const budget = clock.budget(0);
        await attemptOnce(
            client,
            baseArgs,
            budget.timeoutMs,
            options.signal,
            callContext,
            explicitPrimaryLabel,
            options.transport,
            options.allowModelSuggestions,
            budget.firstOutputTimeoutMs,
        );
        return;
    } catch (error) {
        lastError = error;
        clock.settle(error, primaryStartedAt);
        if (isNonRetryable(error, options.signal)) throw error;

        if (fallbacks.length === 0) {
            // No fallbacks configured — behave exactly like legacy: propagate
            // the original error (which may already have had its suggestion
            // retry attempted inside `attemptOnce`).
            throw error;
        }

        log(
            `[${callContext}] primary (${explicitPrimaryLabel}) failed: ${shortErr(error)}; trying ${fallbacks.length} fallback(s)`,
        );
    }

    // Iterate fallbacks.
    for (let i = 0; i < fallbacks.length; i += 1) {
        const fallback = toModelEntry(fallbacks[i]);
        const parsed = fallback ? parseProviderModel(fallback.model) : null;
        if (!parsed) {
            log(`[${callContext}] skipping invalid fallback spec: ${String(fallbacks[i])}`);
            continue;
        }

        const label = `${parsed.providerID}/${parsed.modelID}`;
        const { variant: _primaryVariant, ...bodyWithoutPrimaryVariant } = baseBody;
        const attemptArgs = copyPromptArgs(baseArgs, {
            ...bodyWithoutPrimaryVariant,
            model: parsed,
            ...(fallback?.qualifier ? { variant: fallback.qualifier } : {}),
        });

        const attemptStartedAt = Date.now();
        try {
            const budget = clock.budget(i + 1);
            await attemptOnce(
                client,
                attemptArgs,
                budget.timeoutMs,
                options.signal,
                callContext,
                label,
                options.transport,
                options.allowModelSuggestions,
                budget.firstOutputTimeoutMs,
            );
            log(
                `[${callContext}] fallback succeeded with ${label} (attempt ${i + 2}/${fallbacks.length + 1})`,
            );
            return;
        } catch (error) {
            lastError = error;
            clock.settle(error, attemptStartedAt);
            if (isNonRetryable(error, options.signal)) throw error;

            const remaining = fallbacks.length - i - 1;
            if (remaining > 0) {
                log(
                    `[${callContext}] ${label} failed: ${shortErr(error)}; ${remaining} fallback(s) left`,
                );
            }
        }
    }

    // All exhausted. Log the full chain and throw the last error so the
    // caller's report (e.g. /ctx-dream tasks_json) still surfaces a real
    // diagnostic.
    log(
        `[${callContext}] all models exhausted; tried: ${[explicitPrimaryLabel, ...fallbacks.map((fallback) => toModelEntry(fallback)?.model ?? String(fallback))].join(", ")}; last error: ${shortErr(lastError)}`,
    );
    throw lastError ?? new Error("All fallback models failed");
}

async function attemptAndValidate<TOutput, TValidated>(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callContext: string,
    attempt: PromptAttemptInfo,
    options: ValidatedPromptRetryOptions<TOutput, TValidated>,
    firstOutputTimeoutMs?: number,
): Promise<ValidatedPromptRetryResult<TOutput, TValidated>> {
    try {
        await attemptOnce(
            client,
            args,
            timeoutMs,
            signal,
            callContext,
            attempt.label,
            options.transport,
            options.allowModelSuggestions,
            firstOutputTimeoutMs,
        );
    } catch (error) {
        throw {
            error,
            failureClass: classifyPromptFailure(error, "prompt", signal),
            attempt,
        } satisfies FailedAttempt;
    }

    let output: TOutput;
    try {
        output = await raceWithSignal(options.fetchOutput(args, attempt), options.signal);
    } catch (error) {
        throw {
            error,
            failureClass: classifyPromptFailure(error, "output", signal),
            attempt,
        } satisfies FailedAttempt;
    }

    try {
        // Only the structured account-pool notice bypasses caller validation.
        // The near-zero-token heuristic remains owned by manifest callers.
        const messages = Array.isArray(output)
            ? output
            : (output as { messages?: unknown } | null)?.messages;
        const text = extractLatestAssistantText(messages);
        if (text) {
            const failure = providerOutputFailureFromInvalidManifest(messages, text);
            if (failure?.quotaResetAt !== undefined) throw failure;
        }
        if (!extractLatestAssistantText(output)) {
            const assistantFailure = extractLatestAssistantFailure(output);
            if (assistantFailure) {
                const error = new Error(
                    `Host recorded assistant error: ${describeAssistantError(assistantFailure.error)}`,
                );
                Object.assign(error, {
                    name: "DreamerProviderOutputFailureError",
                    transient: true,
                });
                throw error;
            }
        }
        const validated = await options.validateOutput(output, attempt);
        return { output, validated, attempt };
    } catch (error) {
        if (error instanceof Error && /no (?:assistant )?output/i.test(error.message)) {
            error.message += ` (${describeAssistantSettlement(output)})`;
        }
        throw {
            error,
            failureClass: classifyPromptFailure(error, "validation", signal),
            attempt,
        } satisfies FailedAttempt;
    }
}

/**
 * Run a prompt across the configured model chain and retain which attempt failed.
 * Output validation remains caller-owned so empty completions and malformed
 * responses can be distinguished from provider transport failures.
 */
export async function promptSyncWithValidatedOutputRetry<TOutput, TValidated = TOutput>(
    client: Client,
    args: PromptArgs,
    options: ValidatedPromptRetryOptions<TOutput, TValidated>,
): Promise<ValidatedPromptRetryResult<TOutput, TValidated>> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    // Snapshot the body before the first client call. The Pi facade and the
    // OpenCode SDK both receive this same shape, and either may mutate it while
    // handling a failed request. Fallbacks must never inherit that mutation.
    const baseBody = { ...args.body };
    const baseArgs = copyPromptArgs(args, baseBody);

    const explicitPrimaryLabel =
        baseBody.model?.providerID && baseBody.model.modelID
            ? `${baseBody.model.providerID}/${baseBody.model.modelID}`
            : "primary";
    const totalAttempts = fallbacks.length + 1;
    const failedAttempts: FailedAttempt[] = [];
    let firstError: unknown = null;
    let lastError: unknown = null;
    const cooledPrimary = primaryQuotaFailure(explicitPrimaryLabel);
    const clock = createChainClock(options, timeoutMs);

    const primaryStartedAt = Date.now();
    try {
        if (cooledPrimary)
            throw {
                error: cooledPrimary,
                failureClass: "provider_error",
                attempt: {
                    label: explicitPrimaryLabel,
                    attemptIndex: 0,
                    isFallback: false,
                    totalAttempts,
                    model: baseBody.model,
                    skipped: true,
                },
            } satisfies FailedAttempt;
        const budget = clock.budget(0);
        return await attemptAndValidate(
            client,
            baseArgs,
            budget.timeoutMs,
            options.signal,
            callContext,
            {
                label: explicitPrimaryLabel,
                attemptIndex: 0,
                isFallback: false,
                totalAttempts,
                model: baseBody.model,
            },
            options,
            budget.firstOutputTimeoutMs,
        );
    } catch (caught) {
        const failure = caught as FailedAttempt;
        failedAttempts.push(failure);
        clock.settle(failure.error, primaryStartedAt);
        firstError = failure.error;
        lastError = failure.error;
        if (
            failure.error instanceof DreamerProviderOutputFailureError &&
            failure.error.quotaResetAt !== undefined
        )
            failure.error.message = failure.error.message.replace(
                /^provider quota exhausted/,
                "primary quota exhausted",
            );
        const quota = !cooledPrimary && rememberPrimaryQuota(explicitPrimaryLabel, failure.error);
        if (quota)
            log(
                `[${callContext}] ${quota.message}; skipping ${explicitPrimaryLabel} for this run until reset`,
            );
        if (isNonRetryable(failure.error, options.signal)) {
            throwWithPromptFailure(
                failure.error,
                failedAttempts,
                args,
                timeoutMs,
                options.transport,
            );
        }

        if (fallbacks.length === 0) {
            throwWithPromptFailure(
                failure.error,
                failedAttempts,
                args,
                timeoutMs,
                options.transport,
            );
        }

        if (!cooledPrimary && !quota)
            log(
                `[${callContext}] primary (${explicitPrimaryLabel}) failed validation/prompt: ${shortErr(failure.error)}; ${fallbacks.length} fallback(s) configured, subject to remaining budget`,
            );
    }

    for (let i = 0; i < fallbacks.length; i += 1) {
        const fallback = toModelEntry(fallbacks[i]);
        const parsed = fallback ? parseProviderModel(fallback.model) : null;
        if (!parsed) {
            log(`[${callContext}] skipping invalid fallback spec: ${String(fallbacks[i])}`);
            continue;
        }

        const label = `${parsed.providerID}/${parsed.modelID}`;
        const { variant: _primaryVariant, ...bodyWithoutPrimaryVariant } = baseBody;
        const attemptArgs = copyPromptArgs(baseArgs, {
            ...bodyWithoutPrimaryVariant,
            model: parsed,
            ...(fallback?.qualifier ? { variant: fallback.qualifier } : {}),
        });
        const attempt: PromptAttemptInfo = {
            label,
            attemptIndex: i + 1,
            isFallback: true,
            totalAttempts,
            model: parsed,
        };

        const attemptStartedAt = Date.now();
        try {
            const budget = clock.budget(i + 1);
            const result = await attemptAndValidate(
                client,
                attemptArgs,
                budget.timeoutMs,
                options.signal,
                callContext,
                attempt,
                options,
                budget.firstOutputTimeoutMs,
            );
            log(
                `[${callContext}] fallback succeeded with ${label} (attempt ${i + 2}/${fallbacks.length + 1})`,
            );
            return result;
        } catch (caught) {
            const failure = caught as FailedAttempt;
            failedAttempts.push(failure);
            clock.settle(failure.error, attemptStartedAt);
            lastError = failure.error;
            if (isNonRetryable(failure.error, options.signal)) {
                throwWithPromptFailure(
                    failure.error,
                    failedAttempts,
                    args,
                    timeoutMs,
                    options.transport,
                );
            }

            const remaining = fallbacks.length - i - 1;
            if (remaining > 0) {
                log(
                    `[${callContext}] ${label} failed validation/prompt: ${shortErr(failure.error)}; ${remaining} fallback(s) left`,
                );
            }
        }
    }

    log(
        `[${callContext}] all models exhausted; tried: ${failedAttempts.map((failure) => failure.attempt.label).join(", ")}; original error: ${shortErr(firstError)}; last error: ${shortErr(lastError)}`,
    );
    const cause = lastError ?? firstError;
    const exhausted =
        cause instanceof Error
            ? cause
            : new Error(String(cause ?? "All fallback models failed validation"));
    exhausted.message = `All models exhausted (${failedAttempts.map((failure) => failure.attempt.label).join(", ")}): ${exhausted.message}`;
    throwWithPromptFailure(exhausted, failedAttempts, args, timeoutMs, options.transport);
}
