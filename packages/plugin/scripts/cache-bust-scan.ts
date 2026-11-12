/** Progress through ordered request groups, with fresh arrivals ahead of backfill. */
export interface CacheBustScanCursor {
    head: string;
    before: string;
    highWaterMarkMs: number | null;
}

export interface CacheBustScanProgress {
    filesExamined?: number;
    scanBounded?: boolean;
    scanCursor?: string;
    pendingFiles?: number;
    oldestPendingTimestampMs?: number;
    notJudged?: { at: string; file: string; reason: string; final?: boolean }[];
    resolvedNotJudged?: string[];
}

export const MAX_SCAN_FILES = 32;

export function parseScanCursor(value: string | undefined): CacheBustScanCursor | undefined {
    if (!value) return undefined;
    try {
        const row = JSON.parse(value);
        if (typeof row.head === "string" && typeof row.before === "string" &&
            (row.highWaterMarkMs === null || (typeof row.highWaterMarkMs === "number" && Number.isFinite(row.highWaterMarkMs)))) return row;
    } catch { /* Non-JSON filename cursors from chronological scans restart at the newest group. */ }
    return undefined;
}

/** Choose newest groups, then read each group and its two predecessors in request order. */
export function selectScanBatch<T extends { timestamp: number }>(
    indexed: readonly T[],
    key: (entry: T) => string,
    options: { sinceExclusiveMs?: number; untilInclusiveMs?: number; scanCursor?: string; scanDeadlineMs: number; scanNow: () => number },
) {
    const prior = parseScanCursor(options.scanCursor);
    const pending = indexed.filter((entry) =>
        entry.timestamp > (options.sinceExclusiveMs ?? -Infinity) &&
        entry.timestamp <= (options.untilInclusiveMs ?? Infinity) &&
        (!prior || key(entry) > prior.head || key(entry) < prior.before));
    const chosen: T[] = [];
    for (const entry of [...pending].reverse()) {
        if (chosen.length && (chosen.length >= MAX_SCAN_FILES || options.scanNow() >= options.scanDeadlineMs)) break;
        chosen.push(entry);
    }
    const chosenKeys = new Set(chosen.map(key));
    const remaining = pending.filter((entry) => !chosenKeys.has(key(entry)));
    const selectedIndices = new Set<number>();
    for (const entry of chosen) {
        const index = indexed.indexOf(entry);
        for (let i = Math.max(0, index - 2); i <= index; i++) selectedIndices.add(i);
    }
    const selected = indexed.filter((_, index) => selectedIndices.has(index));
    const backfill = chosen.filter((entry) => !prior || key(entry) < prior.before);
    const cursor: CacheBustScanCursor | undefined = chosen.length || prior ? {
        head: [prior?.head, ...chosen.map(key)].filter((value): value is string => value !== undefined).sort().at(-1)!,
        before: backfill.length ? key(backfill.at(-1)!) : prior!.before,
        highWaterMarkMs: prior?.highWaterMarkMs ?? null,
    } : undefined;
    return { chosen, chosenKeys, selected, remaining, cursor };
}
