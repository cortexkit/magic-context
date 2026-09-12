import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STRUCTURAL_PART_TYPES = new Set(["meta", "step-start", "step-finish", "reasoning"]);

function isStructuralNoisePart(part: unknown): boolean {
    if (!isRecord(part) || typeof part.type !== "string") {
        return false;
    }

    if (!STRUCTURAL_PART_TYPES.has(part.type)) {
        return false;
    }

    if (part.type === "reasoning" && typeof part.text === "string" && part.text !== "[cleared]") {
        return false;
    }

    return true;
}

/**
 * Replace structural/cleared parts with empty-text sentinels instead of removing
 * them. Preserves message.parts length between passes so Anthropic prompt-cache
 * prefixes stay byte-stable while OpenCode filters the empty text parts before
 * the wire.
 *
 * Caller contract: run only when the pass's resolved `acceptsEmptySentinels` is true.
 * Non-Anthropic adapters can forward empty text parts as real wire content.
 *
 * Idempotent: sentinels are themselves recognized on subsequent passes and
 * skipped (not re-mutated, not re-counted).
 */
export function stripStructuralNoise(messages: MessageLike[]): number {
    let strippedParts = 0;

    for (const message of messages) {
        if (!Array.isArray(message.parts)) {
            continue;
        }

        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            if (isSentinel(part)) continue;
            if (!isStructuralNoisePart(part)) continue;
            message.parts[i] = makeSentinel(part);
            strippedParts++;
        }
    }

    return strippedParts;
}
