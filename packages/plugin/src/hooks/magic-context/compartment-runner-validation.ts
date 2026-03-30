import { parseCompartmentOutput } from "./compartment-parser";
import { mapParsedCompartmentsToChunk } from "./compartment-runner-mapping";
import type {
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";

const MIN_RECOMP_CHUNK_TOKEN_BUDGET = 20;

/**
 * Heal small gaps between adjacent compartments by expanding the previous compartment's
 * endMessage forward to meet the next compartment's startMessage.
 *
 * The historian sometimes skips noise-only message ranges (tool calls, dropped placeholders,
 * system reminders) which produces valid summaries but non-contiguous ranges. Instead of
 * rejecting the output and burning a repair retry, we absorb the gap into the preceding
 * compartment's range — the skipped messages were noise anyway.
 *
 * Gaps larger than MAX_HEALABLE_GAP are left untouched and will fail validation,
 * since large gaps likely indicate a real historian problem rather than skipped noise.
 *
 * Mutates the compartments array in place.
 */
function healCompartmentGaps(
    compartments: Array<{ startMessage: number; endMessage: number }>,
): void {
    const MAX_HEALABLE_GAP = 15;

    for (let i = 1; i < compartments.length; i++) {
        const prev = compartments[i - 1];
        const curr = compartments[i];
        const expectedStart = prev.endMessage + 1;
        const gapSize = curr.startMessage - expectedStart;

        if (gapSize > 0 && gapSize <= MAX_HEALABLE_GAP) {
            // Small gap — expand previous compartment to fill it
            prev.endMessage = curr.startMessage - 1;
        }
    }
}

export function validateHistorianOutput(
    text: string,
    _sessionId: string,
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    },
    _priorCompartments: StoredCompartmentRange[],
    sequenceOffset: number,
): ValidatedHistorianPassResult {
    const parsed = parseCompartmentOutput(text);
    if (parsed.compartments.length === 0) {
        return {
            ok: false,
            error: "Historian returned no usable compartments.",
        };
    }

    // Heal gaps between compartments by expanding the previous compartment's endMessage.
    // The historian sometimes skips noise-only message ranges (tool calls, dropped placeholders)
    // which produces valid summaries but invalid contiguous ranges.
    healCompartmentGaps(parsed.compartments);

    const mapped = mapParsedCompartmentsToChunk(parsed.compartments, chunk, sequenceOffset);
    if (!mapped.ok) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${mapped.error}`,
        };
    }

    const parsedValidationError = validateParsedCompartments(
        parsed.compartments,
        chunk.startIndex,
        chunk.endIndex,
        parsed.unprocessedFrom,
    );
    if (parsedValidationError) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${parsedValidationError}`,
        };
    }

    return {
        ok: true,
        compartments: mapped.compartments,
        facts: parsed.facts,
    };
}

export function buildHistorianRepairPrompt(
    originalPrompt: string,
    previousOutput: string,
    validationError: string,
): string {
    return [
        originalPrompt,
        "",
        "Your previous XML response was invalid and cannot be persisted.",
        `Validation error: ${validationError}`,
        "Return a corrected full XML response for the same existing state and new messages.",
        "Do not skip any displayed raw ordinal or displayed raw range, even if the message looks trivial.",
        "Every displayed message range must belong to exactly one compartment unless it is intentionally left in one trailing suffix marked by <unprocessed_from>.",
        "",
        "Previous invalid XML:",
        previousOutput,
    ].join("\n");
}

export function validateStoredCompartments(
    compartments: Array<{ startMessage: number; endMessage: number }>,
): string | null {
    if (compartments.length === 0) {
        return null;
    }

    let expectedStart = 1;
    for (const compartment of compartments) {
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    return null;
}

function validateParsedCompartments(
    compartments: Array<{ startMessage: number; endMessage: number }>,
    chunkStart: number,
    chunkEnd: number,
    unprocessedFrom: number | null,
): string | null {
    let expectedStart = chunkStart;

    for (const compartment of compartments) {
        if (compartment.endMessage < compartment.startMessage) {
            return `invalid range ${compartment.startMessage}-${compartment.endMessage}`;
        }
        if (compartment.startMessage < chunkStart || compartment.endMessage > chunkEnd) {
            return `range ${compartment.startMessage}-${compartment.endMessage} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (compartment.startMessage !== expectedStart) {
            if (compartment.startMessage < expectedStart) {
                return `overlap before message ${expectedStart} (saw ${compartment.startMessage}-${compartment.endMessage})`;
            }
            return `gap before message ${compartment.startMessage} (expected ${expectedStart})`;
        }
        expectedStart = compartment.endMessage + 1;
    }

    if (unprocessedFrom !== null) {
        // Treat unprocessed_from === chunkEnd + 1 as "fully processed" —
        // historian consumed all messages and reported the next ordinal.
        if (unprocessedFrom === chunkEnd + 1) {
            return null;
        }
        if (unprocessedFrom < chunkStart || unprocessedFrom > chunkEnd) {
            return `<unprocessed_from> ${unprocessedFrom} is outside chunk ${chunkStart}-${chunkEnd}`;
        }
        if (unprocessedFrom !== expectedStart) {
            return `<unprocessed_from> ${unprocessedFrom} does not match next uncovered message ${expectedStart}`;
        }
        return null;
    }

    if (expectedStart <= chunkEnd) {
        return `output left uncovered messages ${expectedStart}-${chunkEnd} without <unprocessed_from>`;
    }

    return null;
}

export function validateChunkCoverage(chunk: {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number }>;
}): string | null {
    if (chunk.lines.length === 0) {
        return null;
    }

    let expectedOrdinal = chunk.startIndex;
    for (const line of chunk.lines) {
        if (line.ordinal !== expectedOrdinal) {
            return `chunk omits raw message ${expectedOrdinal} while still claiming coverage through ${chunk.endIndex}`;
        }
        expectedOrdinal += 1;
    }

    if (expectedOrdinal - 1 !== chunk.endIndex) {
        return `chunk coverage ends at ${expectedOrdinal - 1} but chunk end is ${chunk.endIndex}`;
    }

    return null;
}

export function getReducedRecompTokenBudget(currentBudget: number): number | null {
    const reducedBudget = Math.max(MIN_RECOMP_CHUNK_TOKEN_BUDGET, Math.floor(currentBudget / 2));
    return reducedBudget < currentBudget ? reducedBudget : null;
}
