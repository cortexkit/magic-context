import { sessionLog } from "../../shared/logger";
import { cloneKeepingCoveredInstructionMarks } from "./host-served-rows";

/**
 * The input the signed-thinking fit retry restarts a pass from.
 *
 * A held signed-thinking turn keeps every signed block, so it cannot reclaim
 * anything. When its final request is over the window, the transform reruns
 * the whole pass from the untouched input with the hold released. The pass
 * edits the host's messages in place, so that input has to be copied before
 * the pass changes it.
 *
 * Copying every message on every pass with a thinking part cost tens of
 * milliseconds per pass on large sessions, and the copy was almost never used.
 * The copy is therefore made only on a pass that can retry: one whose
 * signed-thinking hold is active, outside compaction-off (which never retries).
 * The hold is decided before the pass edits any message or part. Until then the
 * only change is that covered instruction rows are taken out of the array, so
 * the transform keeps the array's entry order (a list of the same message
 * objects) and copies from it once the hold is known. The copy is identical to
 * one taken when the pass started.
 */
export function takeSignedThinkingFitSnapshot<T extends { info: object }>(args: {
    sessionId: string;
    /** The pass's messages in the order the host handed them over. */
    entryOrder: readonly T[];
    /** Whether this pass's signed-thinking hold is active. */
    held: boolean;
    /** Whether the active turn carries Anthropic signed thinking. */
    activeAnthropicThinkingTurn: boolean;
    compactionOff: boolean;
}): T[] | null {
    let snapshot: T[] | null = null;
    if (args.held && !args.compactionOff) {
        try {
            snapshot = cloneKeepingCoveredInstructionMarks(args.entryOrder as T[]);
        } catch (error) {
            // Without a copy the retry cannot run; an over-window held pass is
            // then refused instead (see the transform's final fit check).
            sessionLog(
                args.sessionId,
                `signed thinking fit: could not copy the pass input (${error instanceof Error ? error.message : String(error)}); an over-window held request will be refused rather than retried`,
            );
        }
    }
    snapshotObserver?.({
        sessionId: args.sessionId,
        held: args.held,
        activeAnthropicThinkingTurn: args.activeAnthropicThinkingTurn,
        compactionOff: args.compactionOff,
        snapshot,
    });
    return snapshot;
}

type SnapshotObservation = {
    sessionId: string;
    held: boolean;
    activeAnthropicThinkingTurn: boolean;
    compactionOff: boolean;
    snapshot: readonly unknown[] | null;
};

let snapshotObserver: ((observation: SnapshotObservation) => void) | undefined;

/** Tests only: observe each pass's snapshot decision. Pass undefined to stop. */
export function observeSignedThinkingFitSnapshotForTests(
    observer: ((observation: SnapshotObservation) => void) | undefined,
): void {
    snapshotObserver = observer;
}
