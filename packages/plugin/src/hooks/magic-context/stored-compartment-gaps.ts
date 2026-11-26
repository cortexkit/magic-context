import {
    type InheritedCoordinateGap,
    readCoordinateRebaseNotice,
} from "../../features/magic-context/store-generation-rebase";
import type { Database } from "../../shared/sqlite";
import { readRawSessionMessageRange } from "./read-session-chunk";
import {
    areRustHistorianSyntheticParts,
    isStrictGapHealingMessage,
    type RawMessage,
} from "./read-session-raw";

/** @param onConversionGap Called for an accepted gap that needed the OpenCode 1→2 conversion record. */
export function nonNarrativeStoredGapRanges(
    db: Database,
    sessionId: string,
    compartments: ReadonlyArray<{ startMessage: number; endMessage: number }>,
    readRange: (start: number, end: number) => Iterable<RawMessage> = (start, end) =>
        readRawSessionMessageRange(sessionId, start, end),
    onConversionGap?: (gap: InheritedCoordinateGap) => void,
): Array<{ start: number; end: number }> {
    const notice = readCoordinateRebaseNotice(db, sessionId);
    const safeRanges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < compartments.length; index += 1) {
        const previous = compartments[index - 1];
        const current = compartments[index];
        if (!current) continue;
        const start = previous ? previous.endMessage + 1 : 1;
        const end = current.startMessage - 1;
        if (end < start) continue;
        const ordinals = new Set<number>();
        let valid = true;
        let needsConversion = false;
        for (const message of readRange(start, end)) {
            const { ordinal } = message;
            if (ordinal < start || ordinal > end) {
                valid = false;
                break;
            }
            if (!areRustHistorianSyntheticParts(message.parts)) {
                const insideInheritedGap = notice?.inheritedGaps?.some(
                    (gap) => gap.start <= ordinal && ordinal <= gap.end,
                );
                if (
                    index === 0 ||
                    notice?.generation !== "v2" ||
                    insideInheritedGap === false ||
                    !isStrictGapHealingMessage(message)
                ) {
                    valid = false;
                    break;
                }
                needsConversion = true;
            }
            ordinals.add(ordinal);
        }
        if (valid && ordinals.size === end - start + 1) {
            const gap = { start, end };
            safeRanges.push(gap);
            if (needsConversion) onConversionGap?.(gap);
        }
    }
    return safeRanges;
}
