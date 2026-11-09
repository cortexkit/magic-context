import {
    hostInstructionRetentionEnabled,
    isHostInstructionRetentionOn,
} from "../../features/magic-context/storage-host-instruction-retention";
import { TagOwnerSummaryNotReady } from "../../features/magic-context/storage-tags";
import type { Database } from "../../shared/sqlite";
import { headMessagesForSizing, type M0M1RenderOptions } from "./inject-compartments";
import { projectOpencodeReasoningBudgetCutoff } from "./reasoning-budget";
import type { MessageLike } from "./tag-messages";

const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

export interface PricedPassSizingInput {
    db: Database;
    sessionId: string;
    /** The pass's message array as it stands before the postprocess phase. */
    messages: readonly MessageLike[];
    messageTagNumbers: ReadonlyMap<MessageLike, number>;
    /** How the pass renders its history head, or undefined when it serves none. */
    head?: M0M1RenderOptions;
    /**
     * OpenCode 2 instruction rows the history summary covers, which the pass
     * took out of the array when it started. Empty on every other host.
     */
    coveredInstructions: readonly MessageLike[];
    /** Whether the pass may rewrite its whole prefix (it then starts serving covered rows). */
    mayEditWholePrefix: boolean;
    /** The reasoning keep budget, or undefined when the pass clears no reasoning. */
    reasoning?: { keepTokens: number; clearedThroughTag: number; proseRatio: number };
}

/**
 * The request a priced pass sizes itself from when the provider has reported
 * no usage for it.
 *
 * The pass is sized before its postprocess phase, which changes the request:
 * it puts the history head (m[0]/m[1]) in front, serves the covered OpenCode 2
 * instruction rows again, and clears reasoning beyond the keep budget. A count
 * of the array as it stands misses the head and those rows and still holds
 * that reasoning, so it can read a fraction of the request the pass then
 * sends. This returns the array to count instead.
 *
 * The result is for counting only. A message whose reasoning the pass will
 * clear appears as a shallow copy without its reasoning parts; no message the
 * pass serves is changed.
 */
export function servedRequestForSizing(input: PricedPassSizingInput): MessageLike[] {
    const head = input.head ? headMessagesForSizing(input.head) : [];
    // The postprocess phase serves covered rows once the session's retention
    // switch is on, and turns it on itself on a pass that may rewrite the
    // whole prefix.
    const instructions =
        input.coveredInstructions.length > 0 &&
        hostInstructionRetentionEnabled() &&
        (input.mayEditWholePrefix || isHostInstructionRetentionOn(input.db, input.sessionId))
            ? input.coveredInstructions
            : [];
    // The same projection of the keep budget the summary trigger reads: the
    // reasoning of every message tagged at or below the cutoff leaves the request.
    const cutoff = input.reasoning ? clearedReasoningCutoff(input, input.reasoning) : 0;
    const conversation =
        cutoff > 0
            ? input.messages.map((message) => withoutClearedReasoning(message, input, cutoff))
            : input.messages;
    return [...head, ...instructions, ...conversation];
}

function clearedReasoningCutoff(
    input: PricedPassSizingInput,
    reasoning: NonNullable<PricedPassSizingInput["reasoning"]>,
): number {
    try {
        return projectOpencodeReasoningBudgetCutoff(
            input.db,
            input.sessionId,
            [...input.messages],
            reasoning.keepTokens,
            reasoning.clearedThroughTag,
            reasoning.proseRatio,
        );
    } catch (error) {
        // While the session's tag ownership summary is still being built, the
        // postprocess phase clears no reasoning, so the request keeps all of it.
        if (error instanceof TagOwnerSummaryNotReady) return 0;
        throw error;
    }
}

function withoutClearedReasoning(
    message: MessageLike,
    input: PricedPassSizingInput,
    cutoff: number,
): MessageLike {
    const tag = input.messageTagNumbers.get(message) ?? 0;
    if (tag === 0 || tag > cutoff) return message;
    const parts = message.parts.filter((part) => !isReasoningPart(part));
    return parts.length === message.parts.length ? message : { ...message, parts };
}

function isReasoningPart(part: unknown): boolean {
    return (
        typeof part === "object" &&
        part !== null &&
        REASONING_PART_TYPES.has(String((part as { type?: unknown }).type))
    );
}
