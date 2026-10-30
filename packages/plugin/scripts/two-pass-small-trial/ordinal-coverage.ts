export interface OrdinalRange {
    start: number;
    end: number;
}

/** Numeric projection of a rendered input; no conversation text is needed to check coverage. */
export interface OrdinalCoverageProjection {
    caseId: number;
    expectedOrdinals: number[];
    header: OrdinalRange | null;
    ranges: OrdinalRange[];
}

export function projectOrdinalCoverage(
    caseId: number,
    expectedOrdinals: number[],
    input: string,
): OrdinalCoverageProjection {
    const section = input.match(/^<new_messages>\s*\n([\s\S]*?)^<\/new_messages>/m)?.[1] ?? input;
    const headers = [...section.matchAll(/^Messages (\d+)-(\d+):[ \t]*$/gm)];
    return {
        caseId,
        expectedOrdinals,
        header:
            headers.length === 1
                ? { start: Number(headers[0][1]), end: Number(headers[0][2]) }
                : null,
        ranges: [...section.matchAll(/^\[(\d+)(?:-(\d+))?\] /gm)].map((match) => ({
            start: Number(match[1]),
            end: Number(match[2] ?? match[1]),
        })),
    };
}

/** Compare displayed intervals with the supplied expected ordinals, not the Messages header. */
export function ordinalCoverageProblems(input: OrdinalCoverageProjection): string[] {
    const issues: string[] = [];
    const expected = new Set(input.expectedOrdinals);
    const valid = (range: OrdinalRange) =>
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        range.start >= 1 &&
        range.end >= range.start;
    if (
        expected.size === 0 ||
        expected.size !== input.expectedOrdinals.length ||
        input.expectedOrdinals.some((n) => !Number.isSafeInteger(n) || n < 1)
    )
        return ["invalid expected ordinal set"];
    if (!input.header || !valid(input.header)) issues.push("missing or invalid Messages header");
    const first = input.ranges[0];
    const last = input.ranges.at(-1);
    if (!first || !last) issues.push("no displayed ranges");
    else if (input.header && (input.header.start !== first.start || input.header.end !== last.end))
        issues.push(
            `header ${input.header.start}-${input.header.end} differs from displayed bounds ${first.start}-${last.end}`,
        );
    const counts = new Map<number, number>();
    for (const range of input.ranges) {
        if (!valid(range)) {
            issues.push("invalid displayed range");
            continue;
        }
        const members = [...expected].filter((n) => n >= range.start && n <= range.end);
        if (members.length !== range.end - range.start + 1)
            issues.push(`range ${range.start}-${range.end} includes unexpected ordinals`);
        for (const ordinal of members) counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1);
    }
    const missing = [...expected].filter((n) => !counts.has(n));
    const overlap = [...counts].filter(([, count]) => count > 1).map(([n]) => n);
    if (missing.length) issues.push(`missing expected ordinals: ${missing.join(",")}`);
    if (overlap.length) issues.push(`overlapping ordinals: ${overlap.join(",")}`);
    return issues;
}

export function assertOrdinalCoverage(input: OrdinalCoverageProjection): void {
    const issues = ordinalCoverageProblems(input);
    if (issues.length)
        throw new Error(`ordinal_coverage_case_${input.caseId}: ${issues.join("; ")}`);
}
