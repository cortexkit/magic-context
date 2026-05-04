import { parseCompartmentOutput } from "./compartment-parser";
import { mapParsedCompartmentsToChunk } from "./compartment-runner-mapping";
import type {
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";

const MIN_RECOMP_CHUNK_TOKEN_BUDGET = 20;

/**
 * Heal gaps between adjacent compartments by expanding the previous compartment's
 * endMessage forward to meet the next compartment's startMessage.
 *
 * Historian frequently skips tool-only blocks — blocks whose visible chunk content
 * is TC: lines with no narrative text. That's a safe skip: no durable signal is lost.
 * When we know (from the chunk's `toolOnlyRanges`) that a gap falls entirely within
 * one of those tool-only ranges, we heal it regardless of size. This catches the common
 * failure case of a 16–30+ message debug/build-test tool chain that historian correctly
 * identified as pure noise.
 *
 * For gaps not covered by tool-only ranges, we still apply a small safety net (≤15
 * messages) for edge cases like boundary noise or dropped placeholders. Larger
 * non-tool-only gaps likely indicate historian dropped real narrative and should
 * fail validation to trigger a repair retry.
 *
 * Mutates the compartments array in place.
 */
function healCompartmentGaps(
    compartments: Array<{ startMessage: number; endMessage: number }>,
    toolOnlyRanges: ReadonlyArray<{ start: number; end: number }> = [],
): void {
    const SAFETY_HEAL_GAP = 15;

    for (let i = 1; i < compartments.length; i++) {
        const prev = compartments[i - 1];
        const curr = compartments[i];
        const gapStart = prev.endMessage + 1;
        const gapEnd = curr.startMessage - 1;
        const gapSize = gapEnd - gapStart + 1;

        if (gapSize <= 0) continue;

        // Heal if gap is fully within a single tool-only range (any size — the skipped
        // messages were TC-only noise, no narrative lost).
        const fullyInsideToolOnly = toolOnlyRanges.some(
            (range) => range.start <= gapStart && range.end >= gapEnd,
        );

        // Or heal small gaps as a safety net for edge cases (boundary noise,
        // dropped placeholders, or rare sub-threshold non-tool skips).
        if (fullyInsideToolOnly || gapSize <= SAFETY_HEAL_GAP) {
            prev.endMessage = gapEnd;
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
        /** Optional — when provided, gaps inside these ranges heal at any size. */
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
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
    // Tool-only ranges heal at any size (historian legitimately skipped pure tool noise);
    // other small gaps heal up to a conservative safety limit.
    healCompartmentGaps(parsed.compartments, chunk.toolOnlyRanges);

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
        userObservations: parsed.userObservations.length > 0 ? parsed.userObservations : undefined,
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
