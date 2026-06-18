import type { createOpencodeClient } from "@opencode-ai/sdk";

import { detectOverflow } from "../features/magic-context/overflow-detection";
import { log } from "./logger";
import { parseProviderModel } from "./resolve-fallbacks";

type Client = ReturnType<typeof createOpencodeClient>;

type PromptBody = {
    model?: { providerID: string; modelID: string };
    [key: string]: unknown;
};

type PromptArgs = {
    path: { id: string };
    body: PromptBody;
    signal?: AbortSignal;
    [key: string]: unknown;
};

export interface PromptRetryOptions {
    timeoutMs?: number;
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
     *     to handle these.
     *   - On all-failed, the LAST error is thrown (matches legacy behavior when
     *     `fallbackModels` is empty).
     */
    fallbackModels?: readonly string[];
    /**
     * Identifier for structured logging (e.g. "dreamer:consolidate",
     * "historian", "compressor", "sidekick"). Helps correlate fallback
     * attempts to a specific call site in `magic-context.log`. Defaults to
     * "subagent" if not provided.
     */
    callContext?: string;
    /**
     * Optional validator invoked after each successful prompt attempt (both
     * the primary and every fallback). If it throws, the error is treated as
     * retryable — the next fallback model is tried (or the error propagates
     * if no fallbacks remain).
     *
     * Use this to detect "empty response" conditions where the model API
     * returns HTTP 200 with zero output tokens instead of a proper error
     * (e.g. shared-quota providers that return empty bodies on quota
     * exhaustion). Without this validator, such responses are indistinguishable
     * from success and the fallback chain is never activated — the task
     * silently fails and only surfaces a post-hoc "no assistant output" error
     * in the caller's catch block, after the fallback opportunity is lost.
     *
     * The validator receives the client and the session ID so it can fetch
     * messages and inspect the model's output.
     */
    validateResponse?: (client: Client, sessionId: string) => Promise<void>;
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

async function promptWithTimeout(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<void> {
    // Bail immediately if the caller's signal is already aborted (e.g.
    // lease loss before this attempt was scheduled). Per spec
    // `addEventListener('abort', ...)` on an already-aborted signal fires
    // synchronously in modern Node/Bun, but an explicit guard is clearer
    // and avoids one wasted upstream `client.session.prompt` round-trip
    // before `isNonRetryable` catches the cancellation at the chain loop.
    if (signal?.aborted) {
        throw new Error("prompt aborted by external signal");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Link external signal to internal controller so external abort cancels the fetch
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
        await client.session.prompt({
            ...args,
            signal: controller.signal,
        } as Parameters<typeof client.session.prompt>[0]);
    } catch (error) {
        if (signal?.aborted) {
            // External abort (e.g. dreamer lease loss): the child run loop is an
            // independent SERVER-SIDE fiber — cancelling our client fetch alone
            // leaves it looping the LLM forever (issue #154). Force-stop it.
            await abortChildRun(client, args.path.id);
            throw new Error("prompt aborted by external signal");
        }
        if (controller.signal.aborted) {
            // Our timeout fired. Same problem: abort the server-side run loop, not
            // just our fetch, or the child keeps re-calling the LLM past the
            // timeout (uncancellable by the user's ESC — issue #154).
            await abortChildRun(client, args.path.id);
            throw new Error(`prompt timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onExternalAbort);
    }
}

/**
 * Force-stop a spawned child session's server-side run loop. `controller.abort()`
 * on the prompt signal only cancels OUR client fetch; the run loop is a separate
 * instance-scoped fiber that `POST /session/{id}/abort` interrupts. Best-effort —
 * a failure here must not mask the original timeout/abort error.
 */
async function abortChildRun(client: Client, sessionId: string): Promise<void> {
    try {
        await client.session.abort({ path: { id: sessionId } });
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
 *     level (e.g. historian's MAX_HISTORIAN_RETRIES loop).
 *
 * Everything else (auth errors, ProviderModelNotFoundError without suggestion,
 * rate limits, transient network failures, etc.) is considered retryable on a
 * different model.
 */
function isNonRetryable(error: unknown, externalSignal?: AbortSignal): boolean {
    if (externalSignal?.aborted) return true;

    if (error instanceof Error) {
        if (error.name === "AbortError") return true;
        // promptWithTimeout wraps both abort cases in plain `Error` with a
        // recognizable message.
        if (error.message === "prompt aborted by external signal") return true;
        if (/^prompt timed out after \d+ms$/.test(error.message)) return true;
    }

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
): Promise<void> {
    try {
        await promptWithTimeout(client, args, timeoutMs, signal);
        return;
    } catch (error) {
        // If non-retryable (abort, overflow, timeout), bubble up immediately.
        // Don't even try suggestion retry — caller needs the original error.
        if (isNonRetryable(error, signal)) throw error;

        const suggestion = parseModelSuggestion(error);
        if (!suggestion || !args.body.model) {
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
            {
                ...args,
                body: {
                    ...args.body,
                    model: {
                        providerID: suggestion.providerID,
                        modelID: suggestion.suggestion,
                    },
                },
            },
            timeoutMs,
            signal,
        );
    }
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

    // Attempt 0 = whatever the agent or explicit body.model resolves to.
    // Subsequent attempts override body.model with each fallback in order.
    const explicitPrimaryLabel =
        args.body.model?.providerID && args.body.model.modelID
            ? `${args.body.model.providerID}/${args.body.model.modelID}`
            : "primary";

    let lastError: unknown = null;

    try {
        await attemptOnce(
            client,
            args,
            timeoutMs,
            options.signal,
            callContext,
            explicitPrimaryLabel,
        );
        if (options.validateResponse) {
            await options.validateResponse(client, args.path.id);
        }
        return;
    } catch (error) {
        lastError = error;
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
        const parsed = parseProviderModel(fallbacks[i]);
        if (!parsed) {
            log(`[${callContext}] skipping invalid fallback spec: ${fallbacks[i]}`);
            continue;
        }

        const label = `${parsed.providerID}/${parsed.modelID}`;
        const attemptArgs: PromptArgs = {
            ...args,
            body: { ...args.body, model: parsed },
        };

        try {
            await attemptOnce(client, attemptArgs, timeoutMs, options.signal, callContext, label);
            if (options.validateResponse) {
                await options.validateResponse(client, args.path.id);
            }
            log(
                `[${callContext}] fallback succeeded with ${label} (attempt ${i + 2}/${fallbacks.length + 1})`,
            );
            return;
        } catch (error) {
            lastError = error;
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
        `[${callContext}] all models exhausted; tried: ${[explicitPrimaryLabel, ...fallbacks].join(", ")}; last error: ${shortErr(lastError)}`,
    );
    throw lastError ?? new Error("All fallback models failed");
}
