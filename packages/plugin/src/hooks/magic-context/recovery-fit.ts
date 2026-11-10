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
 * Shown when a pass in overflow or model-shrink recovery refuses its turn
 * because the request still does not fit. Recovery stays armed and continues
 * on the next turn, so the person only needs to send again; clearing the
 * session would discard the history recovery is summarizing.
 */
export const RECOVERY_REFUSAL_NOTICE =
    "Magic Context is still summarizing older history so this conversation fits the model's context window. Send your message again to continue.";

/**
 * The 95% line of a usable window, the same line as the emergency band. A
 * recovery request above it is not sent: the historian keeps summarizing
 * within the turn, and otherwise the turn is refused.
 */
export function recoveryLineTokens(windowTokens: number): number {
    return Math.floor((windowTokens * BLOCK_UNTIL_DONE_PERCENTAGE) / 100);
}
