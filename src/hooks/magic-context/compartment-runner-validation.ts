import { parseCompartmentOutput } from "./compartment-parser";
import {
    mapParsedCompartmentsToChunk,
    mapParsedCompartmentsToSession,
} from "./compartment-runner-mapping";
import type {
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";

const MIN_RECOMP_CHUNK_TOKEN_BUDGET = 20;

export function validateHistorianOutput(
    text: string,
    sessionId: string,
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

    const mode = parsed.compartments.some(
        (compartment) => compartment.startMessage < chunk.startIndex,
    )
        ? "full"
        : "chunk";

    const mapped =
        mode === "full"
            ? mapParsedCompartmentsToSession(parsed.compartments, sessionId)
            : mapParsedCompartmentsToChunk(parsed.compartments, chunk, sequenceOffset);
    if (!mapped.ok) {
        return {
            ok: false,
            error: `Historian returned invalid compartment output: ${mapped.error}`,
        };
    }

    const parsedValidationError = validateParsedCompartments(
        parsed.compartments,
        mode === "full" ? 1 : chunk.startIndex,
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
        mode,
        compartments: mapped.compartments,
        facts: parsed.facts,
        notes: parsed.notes,
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
