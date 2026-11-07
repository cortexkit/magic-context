import { isRecord } from "../../shared/record-type-guard";
import { isSentinel, makeSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const STRUCTURAL_PART_TYPES = new Set(["meta", "step-start", "step-finish", "reasoning"]);
const structuralSentinels = new WeakSet<object>();

/** Distinguish our placeholders from empty text supplied by the host. */
export function isStructuralNoiseSentinel(part: unknown): boolean {
    return isRecord(part) && structuralSentinels.has(part);
}

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
 * them. Preserves message.parts length so source part indices stay stable
 * while later mutations run. Final projection can omit
 * these placeholders beside signed thinking: OpenCode turns empty text there
 * into a space instead of filtering it out.
 *
 * Caller contract: run only when `modelAcceptsEmptyContent(providerID)` is true.
 * Non-Anthropic adapters can forward empty text parts as real wire content.
 *
 * Idempotent: sentinels are themselves recognized on subsequent passes and
 * skipped (not re-mutated, not re-counted).
 */
export function stripStructuralNoise(
    messages: MessageLike[],
    options: { preserveNativeSteps?: boolean } = {},
): number {
    let strippedParts = 0;

    for (const message of messages) {
        if (!Array.isArray(message.parts)) {
            continue;
        }

        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i];
            // OpenCode serializes an empty-text sentinel as a space on signed-reasoning
            // assistants. Native step markers serialize to nothing, so keep them rather
            // than manufacturing a new block before the provider's signed thinking.
            if (
                options.preserveNativeSteps &&
                isRecord(part) &&
                (part.type === "step-start" || part.type === "step-finish")
            )
                continue;
            if (isSentinel(part)) continue;
            if (!isStructuralNoisePart(part)) continue;
            message.parts[i] = makeSentinel(part);
            if (isRecord(part) && part.type !== "reasoning") {
                structuralSentinels.add(message.parts[i] as object);
            }
            strippedParts++;
        }
    }

    return strippedParts;
}
