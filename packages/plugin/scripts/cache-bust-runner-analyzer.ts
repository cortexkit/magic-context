import {
    classifyRunnerStep,
    formatRunnerStepTiming,
    type RunnerClassification,
    type RunnerMeterStep,
} from "./cache-bust-runner-classification";
import type { RunnerFeedRow, RunnerMeterSource } from "./cache-bust-runner-feed";
import type { RunnerHeads } from "./cache-bust-runner-monitor";

export interface RunnerFeedAnalysisRow {
    row: RunnerFeedRow;
    classification?: RunnerClassification;
    note?: string;
}

export async function analyzeRunnerFeed(
    source: RunnerMeterSource,
    heads: RunnerHeads,
    session: string,
    options: { since?: number; until?: number; deadline?: number; clock?: () => number } = {},
): Promise<RunnerFeedAnalysisRow[]> {
    const clock = options.clock ?? Date.now;
    const deadline = options.deadline ?? clock() + 30_000;
    const latest = new Map<string, RunnerFeedRow>();
    let after: string | undefined;
    do {
        if (clock() >= deadline)
            throw new Error(
                "usage feed analysis exceeded 30-second budget; narrow the feed at the service",
            );
        const page = await source.read(after, Math.max(1, Math.min(2000, deadline - clock())));
        for (const row of page.rows)
            if (row.session === session)
                latest.set(JSON.stringify([row.harness, row.step_ref]), row);
        if (page.next === null) break;
        if (page.next === after) throw new Error("usage feed cursor did not advance");
        after = page.next;
    } while (true);
    const previous = new Map<string, RunnerMeterStep>();
    const rows: RunnerFeedAnalysisRow[] = [];
    for (const row of [...latest.values()].sort((a, b) => a.occurred_at_ms - b.occurred_at_ms)) {
        if (row.occurred_at_ms > (options.until ?? Infinity)) continue;
        const selected = row.occurred_at_ms > (options.since ?? -Infinity);
        const note = !row.prompt
            ? "not a metered step (no positive prompt)"
            : row.provider !== "anthropic"
              ? "not_metered (provider outside Anthropic scope)"
              : row.cache_read === undefined || row.cache_write === undefined || !row.model
                ? "not a metered step (missing counts or model)"
                : undefined;
        if (note) {
            if (selected) rows.push({ row, note });
            continue;
        }
        const step = {
            at: row.occurred_at_ms,
            model: row.model!,
            read: row.cache_read!,
            write: row.cache_write!,
        };
        const prior = previous.get(row.harness);
        previous.set(row.harness, step);
        const classification = prior
            ? classifyRunnerStep(prior, step, heads.get(session)?.decisions ?? [])
            : undefined;
        if (selected)
            rows.push({
                row,
                classification,
                ...(!prior ? { note: "BASE (no earlier metered step in 24-hour feed)" } : {}),
            });
    }
    return rows;
}

export function printRunnerFeedAnalysis(
    rows: readonly RunnerFeedAnalysisRow[],
    print = console.log,
): void {
    print(
        "time(UTC) | harness | model | read | written | previous total | class | idle / previous step | evidence | feed verdict",
    );
    for (const { row, classification, note } of rows) {
        print(
            `${new Date(row.occurred_at_ms).toISOString()} | ${row.harness} | ${row.model ?? "—"} | ${row.cache_read ?? "—"} | ${row.cache_write ?? "—"} | ${classification?.previousTotal ?? "—"} | ${classification?.class ?? (classification?.healthy ? "healthy" : note)} | ${formatRunnerStepTiming(classification)} | ${classification?.evidence ?? note} | ${row.verdict}`,
        );
    }
    print(
        `${rows.length} step row(s), ${rows.filter((row) => row.classification && !row.classification.healthy).length} short read(s); source=astrocyte, at most 24h of history; no request bytes, account, completion or keep-warm facts.`,
    );
}
