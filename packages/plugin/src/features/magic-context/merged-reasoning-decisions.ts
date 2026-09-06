export const MERGED_REASONING_PARTS_PREFIX = "__merged_reasoning_parts_v1__:";
export type FrozenReasoningPart = string | number;

/** Stable host part ids are preferred; adapters without ids use the part index. */
export function decodeMergedReasoningParts(value: string): [string, FrozenReasoningPart[]] | null {
    if (!value.startsWith(MERGED_REASONING_PARTS_PREFIX)) return null;
    try {
        const record: unknown = JSON.parse(value.slice(MERGED_REASONING_PARTS_PREFIX.length));
        if (!Array.isArray(record) || record.length !== 2) return null;
        const [id, parts] = record;
        if (
            typeof id !== "string" ||
            id.length === 0 ||
            !Array.isArray(parts) ||
            parts.length === 0
        )
            return null;
        if (
            !parts.every(
                (part) =>
                    (typeof part === "string" && part.length > 0) ||
                    (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
            )
        )
            return null;
        return [id, parts];
    } catch {
        // Ignore malformed decisions; interpreting them as removal requests
        // could discard signed reasoning parts that were previously retained.
        return null;
    }
}

export function readFrozenMergedReasoningParts(
    ids: ReadonlySet<string>,
): Map<string, FrozenReasoningPart[]> {
    const decisions = new Map<string, FrozenReasoningPart[]>();
    for (const value of ids) {
        const record = decodeMergedReasoningParts(value);
        if (record && !decisions.has(record[0])) decisions.set(...record);
    }
    return decisions;
}
