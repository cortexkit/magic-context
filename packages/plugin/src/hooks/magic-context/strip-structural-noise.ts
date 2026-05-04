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
 * them. Preserves message.parts length between passes so providers that hash
 * the serialized message array (proxy providers like Antigravity, some
 * OpenRouter configs) see a stable cache prefix across turns.
 *
 * For Anthropic/Bedrock/Google, OpenCode's provider/transform.ts drops empty
 * text/reasoning parts before the wire, so the sentinel disappears anyway —
 * producing the same wire shape as the previous behavior but avoiding
 * mid-pipeline array mutation.
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
