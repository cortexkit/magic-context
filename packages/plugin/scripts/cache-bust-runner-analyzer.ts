import {
    classifyRunnerStep,
    extendRunnerRebuildChain,
    formatRunnerStepTiming,
    type RunnerClassification,
    type RunnerMeterStep,
    type RunnerViewRewrite,
} from "./cache-bust-runner-classification";
import type { RunnerFeedRow, RunnerMeterSource } from "./cache-bust-runner-feed";
import type { RunnerHeads } from "./cache-bust-runner-monitor";
import { emptyRunnerViewAttribution, type RunnerViewAttributionState } from "./cache-bust-runner-views";
import { advanceRunnerWave, attributeRunnerWave, emptyRunnerWaveState, observeRunnerWave } from "./cache-bust-runner-wave";

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
            if (row.session === session || heads.has(row.session))
                latest.set(JSON.stringify([row.session, row.harness, row.step_ref]), row);
        if (page.next === null) break;
        if (page.next === after) throw new Error("usage feed cursor did not advance");
        after = page.next;
    } while (true);
    const previous = new Map<string, RunnerMeterStep>();
    const views = new Map<string, RunnerViewAttributionState>();
    const chains = new Map<string, { rewrites: RunnerViewRewrite[]; classes: RunnerClassification[] }>();
    const rows: RunnerFeedAnalysisRow[] = [];
    const wave = emptyRunnerWaveState();
    const waveClasses = new Map<string, RunnerClassification>();
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
            if (selected && row.session === session) rows.push({ row, note });
            continue;
        }
        const step = {
            at: row.occurred_at_ms,
            model: row.model!,
            read: row.cache_read!,
            write: row.cache_write!,
            prompt: row.prompt,
        };
        const key = JSON.stringify([row.harness, row.session]);
        const prior = previous.get(key);
        previous.set(key, step);
        const viewAttribution = views.get(key) ?? emptyRunnerViewAttribution();
        views.set(key, viewAttribution);
        const classification: RunnerClassification | undefined = prior
            ? classifyRunnerStep(prior, step, heads.get(row.session)?.decisions ?? [], { viewAttribution })
            : undefined;
        if (selected && prior && classification) {
            advanceRunnerWave(wave, step.at);
            waveClasses.set(JSON.stringify([row.session, step.at]), classification);
            const result = observeRunnerWave(wave, row, prior, step, classification);
            if (result.member) attributeRunnerWave(classification, wave.open!.startedAt);
            if (result.opened) for (const member of result.opened.members) {
                const initial = waveClasses.get(JSON.stringify([member.session, member.at]));
                if (initial) attributeRunnerWave(initial, result.opened.startedAt);
            }
        }
        if (classification?.class === "view") {
            const priorChain = chains.get(key);
            const rewrites = extendRunnerRebuildChain(priorChain?.rewrites ?? [], step, classification);
            const classes = rewrites.length > 1 ? [...(priorChain?.classes ?? []), classification] : [classification];
            chains.set(key, { rewrites, classes });
            if (rewrites.length >= 2)
                for (const member of classes) member.class = "double_rebuild";
        }
        if (selected && row.session === session)
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
