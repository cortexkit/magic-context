import type { CandidateCompartment } from "./compartment-runner-types";
import { getRawSessionMessageIdsThrough } from "./read-session-chunk";

export function mapParsedCompartmentsToChunk(
    compartments: Array<{
        startMessage: number;
        endMessage: number;
        title: string;
        content: string;
    }>,
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    },
    sequenceOffset: number,
): { ok: true; compartments: CandidateCompartment[] } | { ok: false; error: string } {
    const mapped: CandidateCompartment[] = [];
    for (const [index, compartment] of compartments.entries()) {
        const startLine = chunk.lines.find((line) => line.ordinal === compartment.startMessage);
        const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
        if (!startLine || !endLine) {
            return {
                ok: false,
                error: `Compartment range ${compartment.startMessage}-${compartment.endMessage} does not map to raw session lines ${chunk.startIndex}-${chunk.endIndex}`,
            };
        }
        mapped.push({
            sequence: sequenceOffset + index,
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
            startMessageId: startLine.messageId,
            endMessageId: endLine.messageId,
            title: compartment.title,
            content: compartment.content,
        });
    }

    return { ok: true, compartments: mapped };
}

export function mapParsedCompartmentsToSession(
    compartments: Array<{
        startMessage: number;
        endMessage: number;
        title: string;
        content: string;
    }>,
    sessionId: string,
): { ok: true; compartments: CandidateCompartment[] } | { ok: false; error: string } {
    const maxEndMessage = compartments.reduce(
        (max, compartment) => Math.max(max, compartment.endMessage),
        0,
    );
    const rawMessageIds = getRawSessionMessageIdsThrough(sessionId, maxEndMessage);
    const mapped: CandidateCompartment[] = [];

    for (const [index, compartment] of compartments.entries()) {
        const startMessageId = rawMessageIds[compartment.startMessage - 1];
        const endMessageId = rawMessageIds[compartment.endMessage - 1];
        if (!startMessageId || !endMessageId) {
            return {
                ok: false,
                error: `Compartment range ${compartment.startMessage}-${compartment.endMessage} does not map to raw session history`,
            };
        }

        mapped.push({
            sequence: index,
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
            startMessageId,
            endMessageId,
            title: compartment.title,
            content: compartment.content,
        });
    }

    return { ok: true, compartments: mapped };
}
