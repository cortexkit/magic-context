import { isRecord } from "../../shared/record-type-guard";
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

export function stripStructuralNoise(messages: MessageLike[]): number {
    let strippedParts = 0;

    for (const message of messages) {
        if (!Array.isArray(message.parts)) {
            continue;
        }

        const originalLength = message.parts.length;
        const keptParts = message.parts.filter((part) => !isStructuralNoisePart(part));
        if (keptParts.length < originalLength && keptParts.length > 0) {
            message.parts.length = 0;
            message.parts.push(...keptParts);
            strippedParts += originalLength - keptParts.length;
        }
    }

    return strippedParts;
}
