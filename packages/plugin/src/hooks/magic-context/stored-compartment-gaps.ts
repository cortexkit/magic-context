import { readCoordinateRebaseNotice } from "../../features/magic-context/store-generation-rebase";
import type { Database } from "../../shared/sqlite";
import { readRawSessionMessageRange } from "./read-session-chunk";
import {
    areRustHistorianSyntheticParts,
    isStrictGapHealingMessage,
    type RawMessage,
} from "./read-session-raw";

export function nonNarrativeStoredGapRanges(
    db: Database,
    sessionId: string,
    compartments: ReadonlyArray<{ startMessage: number; endMessage: number }>,
    readRange: (start: number, end: number) => RawMessage[] = (start, end) =>
        readRawSessionMessageRange(sessionId, start, end),
): Array<{ start: number; end: number }> {
    const rebasedToV2 = readCoordinateRebaseNotice(db, sessionId)?.generation === "v2";
    const safeRanges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < compartments.length; index += 1) {
        const previous = compartments[index - 1];
        const current = compartments[index];
        if (!current) continue;
        const start = previous ? previous.endMessage + 1 : 1;
        const end = current.startMessage - 1;
        if (end < start) continue;
        const messages = readRange(start, end);
        const ordinals = new Set(messages.map((message) => message.ordinal));
        const complete =
            ordinals.size === end - start + 1 &&
            messages.every(
                (message) =>
                    message.ordinal >= start &&
                    message.ordinal <= end &&
                    (areRustHistorianSyntheticParts(message.parts) ||
                        (index > 0 && rebasedToV2 && isStrictGapHealingMessage(message))),
            );
        if (complete) safeRanges.push({ start, end });
    }
    return safeRanges;
}
