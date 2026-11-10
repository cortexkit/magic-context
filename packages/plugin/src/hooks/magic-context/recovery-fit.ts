import { BLOCK_UNTIL_DONE_PERCENTAGE } from "./compartment-trigger";

/**
 * A request counted for overflow or model-shrink recovery, and the line it must
 * stay under before it may be sent.
 */
export interface RecoveryFitProjection {
    tokens: number;
    lineTokens: number;
}

/**
 * The request a recovery pass is about to send, and the most it may be. While
 * older history is left for the historian to summarize, the limit is the 95%
 * line; with none left it is the whole usable window (see
 * recoveryAdmissionLimitTokens).
 */
export interface RecoveryServedRequest {
    tokens: number;
    lineTokens: number;
    historyRemains: boolean;
}

/**
 * Shown when a pass in overflow or model-shrink recovery refuses its turn
 * because the request still does not fit. Recovery stays armed and continues
 * on the next turn, so the person only needs to send again; clearing the
 * session would discard the history recovery is summarizing.
 */
export const RECOVERY_REFUSAL_NOTICE =
    "Magic Context is still summarizing older history so this conversation fits the model's context window. Send your message again to continue.";

/**
 * Shown when a recovery request is over the model's whole usable window and
 * the historian has no more older history it can summarize (none is left, or
 * no historian can run): sending again or flushing cannot make it fit on this
 * model.
 */
export const RECOVERY_NO_HISTORY_REFUSAL_NOTICE =
    "This conversation no longer fits the model's context window, and Magic Context has no more older history it can summarize. Switch to a model with a larger context window to continue.";

/**
 * The 95% line of a usable window, the same line as the emergency band. A
 * recovery request above it is not sent while the historian can still
 * summarize older history: the historian keeps summarizing within the turn,
 * and otherwise the turn is refused.
 */
export function recoveryLineTokens(windowTokens: number): number {
    return Math.floor((windowTokens * BLOCK_UNTIL_DONE_PERCENTAGE) / 100);
}

/**
 * The most a recovery request may be before it is sent. The 95% line is the
 * target while older history remains for the historian. With none left,
 * refusing a request between the line and the usable window would refuse it on
 * every turn, although it fits: the usable window already leaves room for the
 * reply. So the limit is then the usable window itself.
 */
export function recoveryAdmissionLimitTokens(
    windowTokens: number,
    historyRemains: boolean,
): number {
    return historyRemains ? recoveryLineTokens(windowTokens) : Math.floor(windowTokens);
}

/** The notice for a recovery refusal. */
export function recoveryRefusalNotice(historyRemains: boolean): string {
    return historyRemains ? RECOVERY_REFUSAL_NOTICE : RECOVERY_NO_HISTORY_REFUSAL_NOTICE;
}
