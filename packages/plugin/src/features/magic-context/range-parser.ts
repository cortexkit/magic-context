/**
 * Parses a range string into a sorted, deduplicated array of integers.
 *
 * Supported syntax:
 * - Single number: "5" → [5]
 * - Range: "3-5" → [3, 4, 5]
 * - Comma-separated: "1,2,9" → [1, 2, 9]
 * - Mixed: "1-5,8,12-15" → [1, 2, 3, 4, 5, 8, 12, 13, 14, 15]
 *
 * @throws {Error} on empty string, non-numeric input, reversed ranges, or ranges exceeding 1000 elements
 */
export function parseRangeString(input: string): number[] {
    const maxRangeElements = 1000;
    const trimmed = input.trim();

    if (trimmed === "") {
        throw new Error("Range string must not be empty");
    }

    const segments = trimmed.split(",");
    const numbers = new Set<number>();

    for (const segment of segments) {
        const part = segment.trim();

        if (part.includes("-")) {
            const dashIndex = part.indexOf("-");
            const startStr = part.slice(0, dashIndex).trim();
            const endStr = part.slice(dashIndex + 1).trim();

            const start = parseInteger(startStr);
            const end = parseInteger(endStr);

            if (start > end) {
                throw new Error(
                    `Invalid range "${part}": start (${start}) must be <= end (${end})`,
                );
            }

            const rangeSize = end - start + 1;
            if (rangeSize > maxRangeElements) {
                throw new Error(
                    `Range "${part}" exceeds maximum size of ${maxRangeElements} elements (got ${rangeSize})`,
                );
            }

            for (let i = start; i <= end; i++) {
                numbers.add(i);
            }
        } else {
            numbers.add(parseInteger(part));
        }
    }

    if (numbers.size > maxRangeElements) {
        throw new Error(
            `Total range size exceeds maximum of ${maxRangeElements} elements (got ${numbers.size})`,
        );
    }

    return Array.from(numbers).sort((a, b) => a - b);
}

function parseInteger(str: string): number {
    if (str === "" || !/^\d+$/.test(str)) {
        throw new Error(`Invalid integer: "${str}"`);
    }

    const n = parseInt(str, 10);

    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid integer: "${str}"`);
    }

    return n;
}
