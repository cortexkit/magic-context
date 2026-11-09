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
 * The 95% line of a usable window, the same line as the emergency band. A
 * recovery request above it is not sent: the historian keeps summarizing
 * within the turn, and otherwise the turn is refused.
 */
export function recoveryLineTokens(windowTokens: number): number {
    return Math.floor((windowTokens * BLOCK_UNTIL_DONE_PERCENTAGE) / 100);
}
