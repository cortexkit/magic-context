import type { ThinkingLikePart } from "./tag-messages";

const encoder = new TextEncoder();
const TAG_PREFIX_REGEX = /^§\d+§\s*/;

export function byteSize(value: string): number {
    return encoder.encode(value).length;
}

export function stripTagPrefix(value: string): string {
    return value.replace(TAG_PREFIX_REGEX, "");
}

export function prependTag(tagId: number, value: string): string {
    const stripped = stripTagPrefix(value);
    return `§${tagId}§ ${stripped}`;
}

export function isThinkingPart(part: unknown): part is ThinkingLikePart {
    if (part === null || typeof part !== "object") return false;
    const candidate = part as Record<string, unknown>;
    return candidate.type === "thinking" || candidate.type === "reasoning";
}
