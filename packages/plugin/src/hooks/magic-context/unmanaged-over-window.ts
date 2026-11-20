import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import { wireContentBytes } from "./final-wire-token-estimate";
import type { MessageLike } from "./tag-messages";

/**
 * How far over the model's context window a session's history has to be
 * before a pass with no other evidence of its size is treated as over the
 * window. The comparison uses the local token count of the request (system
 * prompt, tool definitions and messages, without the provider-specific
 * scaling the fit checks apply), and that count can be a few percent off the
 * provider's own. The margin keeps a session that is close to the window, and
 * may well fit, on the ordinary path: it is served as before, and the
 * provider's own answer (and the overflow recovery that follows a rejection)
 * decides. Only a history clearly larger than the window is handled here.
 */
export const UNMANAGED_OVER_WINDOW_FACTOR = 1.1;

/**
 * True when a request of `tokens` local tokens is clearly larger than a
 * context window of `contextLimit` tokens. An unknown or non-positive limit,
 * or a count that is not a finite positive number, proves nothing.
 */
export function isClearlyOverWindow(tokens: number, contextLimit: number | undefined): boolean {
    if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit) || contextLimit <= 0)
        return false;
    if (!Number.isFinite(tokens) || tokens <= 0) return false;
    return tokens > contextLimit * UNMANAGED_OVER_WINDOW_FACTOR;
}

/** Sample only user input after the last assistant. In-turn tool results are
 * handled by the normal tool-loop fit and provider recovery paths. */
export function appendedTailMayExceedWindow(
    messages: readonly MessageLike[],
    previousInputTokens: number,
    limit: number,
): boolean {
    let remainingBytes = (limit - previousInputTokens) / 2;
    for (let i = messages.length - 1; i >= 0; --i) {
        const message = messages[i];
        if (!message) continue;
        if (message.info.role === "assistant") break;
        if (message.info.role !== "user") continue;
        const size = wireContentBytes([message], remainingBytes, 0.5);
        if (!size || size.bytes >= remainingBytes) return true;
        remainingBytes -= size.bytes;
    }
    return false;
}

/**
 * A pass started with a history clearly larger than the model's context
 * window and no Magic Context state to send in its place (a session Magic
 * Context has never seen, or a fork whose parent left nothing to inherit),
 * and the reductions this pass could make did not bring the request under the
 * window. Sending it would earn a provider rejection, or on a provider that
 * accepts it, a silently degraded and expensive turn, so the pass stops here:
 * the messages wrapper replays the last good request when it can and
 * otherwise refuses the turn with this message.
 */
export class UnmanagedOverWindowError extends Error {
    readonly code = "UNMANAGED_OVER_WINDOW";
    readonly recoverable = true;

    constructor(
        readonly estimatedTokens: number,
        readonly contextLimitTokens: number,
    ) {
        super(renderUserFacingFailure("history_over_window_unmanaged", "plain"));
        this.name = "UnmanagedOverWindowError";
    }
}
