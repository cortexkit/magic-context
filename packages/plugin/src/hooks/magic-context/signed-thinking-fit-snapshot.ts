import { sessionLog } from "../../shared/logger";
import { cloneKeepingCoveredInstructionMarks } from "./host-served-rows";

/**
 * The largest growth of a request in one step that the copy does not cover.
 * See takeSignedThinkingFitSnapshot.
 */
export const SIGNED_FIT_SNAPSHOT_HEADROOM_TOKENS = 250_000;

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
 *
 * The retry is needed only when one step takes the request over the window.
 * When the last measured input, plus the estimated size of the messages that
 * request did not include, is more than SIGNED_FIT_SNAPSHOT_HEADROOM_TOKENS
 * below the window, no observed step grows that much, so the copy is not made
 * and a held pass that still overflows is refused (see the final fit check).
 * A held pass is always inside an assistant tool loop, so new user content
 * cannot arrive in it. An unknown limit or input keeps the copy.
 */
/**
 * The index of the first message that the last measured request did not
 * include. That request produced the newest assistant message that has parts,
 * so its output and every message after it are new. An assistant step without
 * parts has not answered yet: the output before it is still new input.
 */
export function unmeasuredTailStart(
    entries: readonly { info: { role?: string }; parts?: readonly unknown[] }[],
): number {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.info.role === "assistant" && (entry.parts?.length ?? 0) > 0) return index;
    }
    return 0;
}

export function takeSignedThinkingFitSnapshot<T extends { info: object }>(args: {
    sessionId: string;
    /** The pass's messages in the order the host handed them over. */
    entryOrder: readonly T[];
    /** Whether this pass's signed-thinking hold is active. */
    held: boolean;
    /** Whether the active turn carries Anthropic signed thinking. */
    activeAnthropicThinkingTurn: boolean;
    compactionOff: boolean;
    /** The context limit for this pass, when known. */
    contextLimit?: number;
    /** The input tokens of the last measured request, when known. */
    lastInputTokens?: number;
    /**
     * The estimated tokens of the messages the last measured request did not
     * include. Called only for a held pass with a known limit and input.
     */
    newTailTokens?: () => number;
}): T[] | null {
    let snapshot: T[] | null = null;
    const room =
        args.contextLimit !== undefined &&
        args.contextLimit > 0 &&
        args.lastInputTokens !== undefined &&
        args.lastInputTokens > 0
            ? args.contextLimit - args.lastInputTokens
            : undefined;
    const farFromWindow = () =>
        room !== undefined &&
        room > SIGNED_FIT_SNAPSHOT_HEADROOM_TOKENS &&
        room - (args.newTailTokens?.() ?? 0) > SIGNED_FIT_SNAPSHOT_HEADROOM_TOKENS;
    if (args.held && !args.compactionOff && !farFromWindow()) {
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
