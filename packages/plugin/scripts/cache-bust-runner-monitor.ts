import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
    classifyRunnerStep,
    type RunnerClassification,
    type RunnerMeterStep,
} from "./cache-bust-runner-classification";
import {
    runnerFeedRow,
    type RunnerFeedRow,
    type RunnerMeterSource,
} from "./cache-bust-runner-feed";
import { parseRunnerDecision, type RunnerDecision } from "./cache-bust-runner-log";

const HOUR = 3_600_000;
const RETENTION = 30 * HOUR;
export interface RunnerHeadFacts {
    harness: string;
    decisions: RunnerDecision[];
    lastLogAt?: number;
}
export type RunnerHeads = Map<string, RunnerHeadFacts>;

export function loadRunnerHeads(
    root: string,
    now: number,
    logPath?: string,
    clock = Date.now,
    deadline = Infinity,
): RunnerHeads {
    const directory = join(root, "magic-context/logs");
    const firstDate = new Date(now - 7 * 24 * HOUR).toISOString().slice(0, 10);
    const lastDate = new Date(now).toISOString().slice(0, 10);
    const files = logPath
        ? existsSync(logPath)
            ? [logPath]
            : []
        : !existsSync(directory)
          ? []
          : readdirSync(directory)
                .filter((name) => {
                    const date = /^magic-context\.(\d{4}-\d\d-\d\d)\.log$/.exec(name)?.[1];
                    return date && date >= firstDate && date <= lastDate;
                })
                .sort()
                .map((name) => join(directory, name));
    const facts = new Map<string, RunnerHeadFacts>();
    const heads = new Set<string>();
    for (const file of files) {
        if (clock() >= deadline) throw new Error("runner log scan exhausted its budget");
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (clock() >= deadline) throw new Error("runner log scan exhausted its budget");
            const session = /ck-mc: session (\S+): /.exec(line)?.[1];
            if (!session) continue;
            const at = Date.parse(
                line.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/)?.[1] ?? "",
            );
            if (!Number.isFinite(at) || at < now - 7 * 24 * HOUR || at > now) continue;
            const event = parseRunnerDecision(line, session);
            const fact: RunnerHeadFacts = facts.get(session) ?? {
                harness: "unknown",
                decisions: [],
            };
            fact.lastLogAt = Math.max(fact.lastLogAt ?? 0, at);
            if (event) fact.decisions.push(event);
            if (event?.kind === "setup") {
                const setup = /^setup \(([^,]+), preset ([^,]+),/.exec(event.detail);
                if (setup?.[2] === "head") {
                    heads.add(session);
                    fact.harness = setup[1]!;
                }
            }
            facts.set(session, fact);
        }
    }
    return new Map(
        [...facts]
            .filter(([session]) => heads.has(session))
            .map(([session, fact]) => [
                session,
                { ...fact, decisions: fact.decisions.sort((a, b) => a.at - b.at) },
            ]),
    );
}

interface PendingRow {
    row: RunnerFeedRow;
    firstRun: number;
}
export interface RunnerObservation extends RunnerClassification {
    step: string;
    at: number;
    read: number;
    written: number;
    model: string;
    feedVerdict: string;
}
interface HeadState {
    last?: RunnerMeterStep;
    seen: Record<string, { at: number; read: number; write: number; cursor: string }>;
    pending: Record<string, PendingRow>;
    summary: RunnerObservation[];
    updatedAt: number;
    lastFeedAt?: number;
}
interface RateSample {
    at: number;
    healthy: boolean;
}
interface RateState {
    buckets: Record<string, RateSample[]>;
    episode?: number;
    updatedAt: number;
}
export interface RunnerMonitorState {
    run: number;
    cursor?: string;
    gaps: number;
    lastGapAt?: number;
    failures: number;
    blindSince?: number;
    blindNotified?: boolean;
    heads: Record<string, HeadState>;
    rates: Record<string, RateState>;
    plans: { session: string; at: number; observation: RunnerObservation; harness: string }[];
    planEpisode?: number;
    sent: Record<string, number>;
}
export const emptyRunnerState = (): RunnerMonitorState => ({
    run: 0,
    gaps: 0,
    failures: 0,
    heads: {},
    rates: {},
    plans: [],
    sent: {},
});
const nonnegative = z.number().finite().nonnegative();
const meterStepSchema = z.object({
    at: nonnegative,
    model: z.string(),
    read: nonnegative,
    write: nonnegative,
});
const observationSchema = z.object({
    healthy: z.boolean(),
    class: z
        .enum([
            "scope_changed",
            "view",
            "plan_changed",
            "provider_forgot",
            "expired",
            "unexplained",
        ])
        .optional(),
    rewrittenTokens: nonnegative,
    previousTotal: nonnegative,
    evidence: z.string(),
    afterRestart: z.boolean(),
    step: z.string(),
    at: nonnegative,
    read: nonnegative,
    written: nonnegative,
    model: z.string(),
    feedVerdict: z.string(),
});
const monitorSchema = z.object({
    run: nonnegative,
    cursor: z.string().optional(),
    gaps: nonnegative,
    lastGapAt: nonnegative.optional(),
    failures: nonnegative,
    blindSince: nonnegative.optional(),
    blindNotified: z.boolean().optional(),
    heads: z.record(
        z.string(),
        z.object({
            last: meterStepSchema.optional(),
            seen: z
                .record(
                    z.string(),
                    z.object({
                        at: nonnegative,
                        read: nonnegative,
                        write: nonnegative,
                        cursor: z.string(),
                    }),
                )
                .default({}),
            pending: z.record(z.string(), z.object({ row: runnerFeedRow, firstRun: nonnegative })),
            summary: z.array(observationSchema),
            updatedAt: nonnegative,
            lastFeedAt: nonnegative.optional(),
        }),
    ),
    rates: z.record(
        z.string(),
        z.object({
            buckets: z.record(
                z.string(),
                z.array(z.object({ at: nonnegative, healthy: z.boolean() })),
            ),
            episode: nonnegative.optional(),
            updatedAt: nonnegative,
        }),
    ),
    plans: z.array(
        z.object({
            session: z.string(),
            at: nonnegative,
            observation: observationSchema,
            harness: z.string(),
        }),
    ),
    planEpisode: nonnegative.optional(),
    sent: z.record(z.string(), nonnegative),
});
export function parseRunnerMonitorState(value: unknown): RunnerMonitorState {
    return monitorSchema.parse(value);
}
export interface RunnerAlert {
    id: string;
    session: string;
    at: number;
    class: string;
    rewrittenTokens: number;
    detail: string;
    analyzer: string;
    urgency: "normal" | "high";
}
export interface RunnerRunSummary {
    judged: number;
    not_metered: number;
    skipped: number;
    bounded: boolean;
    gaps: number;
    failure?: string;
    heads_without_meter: { harness: string; session: string }[];
    late_revisions: number;
    late_token_revisions: number;
}

export function headsWithoutMeter(
    state: RunnerMonitorState,
    heads: RunnerHeads,
    now: number,
): RunnerRunSummary["heads_without_meter"] {
    return [...heads]
        .filter(
            ([session, facts]) =>
                (facts.lastLogAt ?? -Infinity) >= now - 24 * HOUR &&
                !Object.entries(state.heads).some(
                    ([key, head]) =>
                        JSON.parse(key)[1] === session &&
                        (head.lastFeedAt ?? -Infinity) >= now - 24 * HOUR,
                ),
        )
        .map(([session, facts]) => ({ harness: facts.harness, session }));
}

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
function alertFor(
    row: RunnerFeedRow,
    observation: RunnerObservation,
    harness: string,
    root: string,
): RunnerAlert {
    const analyzer = `bun packages/plugin/scripts/analyze-cache-busts.ts --session ${quote(row.session)} --source astrocyte --runner-data-dir ${quote(root)} --since ${quote(new Date(row.occurred_at_ms - 60_000).toISOString())}`;
    return {
        id: `runner-step:${row.harness}:${row.step_ref}`,
        session: row.session,
        at: observation.at,
        class: observation.class!,
        rewrittenTokens: observation.rewrittenTokens,
        analyzer,
        urgency: "high",
        detail: `session=${row.session}; harness=${row.harness}; runner=${harness}; model=${row.model}; UTC=${new Date(observation.at).toISOString()}; read=${observation.read}; written=${observation.written}; previous_total=${observation.previousTotal}; class=${observation.class}; ${observation.evidence}`,
    };
}

export async function scanRunnerFeed(args: {
    state: RunnerMonitorState;
    source: RunnerMeterSource;
    heads: RunnerHeads;
    root: string;
    now: number;
    clock: () => number;
    deadline: number;
    wakeAge: number;
    emit: (alert: RunnerAlert) => Promise<void>;
}): Promise<RunnerRunSummary> {
    const { state, source, heads, now, clock, deadline } = args;
    const summary: RunnerRunSummary = {
        judged: 0,
        not_metered: 0,
        skipped: 0,
        bounded: false,
        gaps: 0,
        heads_without_meter: [],
        late_revisions: 0,
        late_token_revisions: 0,
    };
    state.run++;
    let drained = false;
    while (clock() < deadline) {
        let page;
        try {
            page = await source.read(state.cursor, Math.max(1, Math.min(2000, deadline - clock())));
        } catch (error) {
            if (
                (error as { code?: string }).code === "cursor_expired" &&
                state.cursor !== undefined
            ) {
                delete state.cursor;
                state.gaps++;
                state.lastGapAt = now;
                summary.gaps++;
                // The missing interval cannot supply a trustworthy predecessor.
                for (const head of Object.values(state.heads)) {
                    delete head.last;
                    head.pending = {};
                }
                continue;
            }
            throw error;
        }
        for (const row of page.rows) {
            if (!heads.has(row.session)) continue;
            const key = JSON.stringify([row.harness, row.session]);
            const head = (state.heads[key] ??= {
                pending: {},
                seen: {},
                summary: [],
                updatedAt: now,
            });
            head.updatedAt = now;
            head.lastFeedAt = Math.max(head.lastFeedAt ?? 0, row.occurred_at_ms);
            const id = JSON.stringify([row.harness, row.step_ref]);
            const seen = head.seen[id];
            if (seen !== undefined) {
                // One complete run is the stabilization period. Revisions after
                // judgment are observable, but cannot retroactively send wakes.
                if (seen.cursor !== row.cursor) {
                    summary.late_revisions++;
                    if (seen.read !== row.cache_read || seen.write !== row.cache_write)
                        summary.late_token_revisions++;
                }
                continue;
            }
            if (head.last && row.occurred_at_ms <= head.last.at) continue;
            head.pending[id] = { row, firstRun: head.pending[id]?.firstRun ?? state.run };
        }
        if (page.next !== null && page.next === state.cursor)
            throw new Error("usage feed cursor did not advance");
        state.cursor = page.next ?? page.through;
        if (page.next === null) {
            drained = true;
            break;
        }
    }
    summary.heads_without_meter = headsWithoutMeter(state, heads, now);
    if (!drained) {
        summary.bounded = true;
        return summary;
    }
    const ready = Object.entries(state.heads)
        .flatMap(([key, head]) => {
            const ordered = Object.entries(head.pending).sort(
                (a, b) => a[1].row.occurred_at_ms - b[1].row.occurred_at_ms,
            );
            const barrier = ordered.findIndex(([, pending]) => pending.firstRun >= state.run);
            return ordered
                .slice(0, barrier < 0 ? ordered.length : barrier)
                .map(([id, pending]) => ({ key, id, head, row: pending.row }));
        })
        .sort((a, b) => a.row.occurred_at_ms - b.row.occurred_at_ms);
    for (const { id, head, row } of ready) {
        if (clock() >= deadline) {
            summary.bounded = true;
            break;
        }
        const facts = heads.get(row.session);
        if (!facts || row.occurred_at_ms > now) continue;
        delete head.pending[id];
        if (!row.prompt) {
            summary.skipped++;
            continue;
        }
        if (row.provider !== "anthropic") {
            summary.not_metered++;
            continue;
        }
        if (row.cache_read === undefined || row.cache_write === undefined || !row.model) {
            summary.skipped++;
            continue;
        }
        const step = {
            at: row.occurred_at_ms,
            model: row.model,
            read: row.cache_read,
            write: row.cache_write,
        };
        const previous = head.last;
        if (previous && step.at <= previous.at) continue;
        head.last = step;
        head.seen[id] = { at: step.at, read: step.read, write: step.write, cursor: row.cursor };
        if (!previous) continue;
        const classified = classifyRunnerStep(previous, step, facts.decisions);
        const observation: RunnerObservation = {
            ...classified,
            step: row.step_ref,
            at: step.at,
            read: step.read,
            written: step.write,
            model: step.model,
            feedVerdict: row.verdict,
        };
        summary.judged++;
        const fresh = now - step.at <= args.wakeAge;
        if (fresh) head.summary.push(observation);
        const alert = alertFor(row, observation, facts.harness, args.root);
        const emit = async (event: RunnerAlert): Promise<void> => {
            if (!fresh || state.sent[event.id]) return;
            state.sent[event.id] = step.at;
            await args.emit(event);
        };
        if (classified.class === "unexplained" && classified.rewrittenTokens >= 20_000)
            await emit(alert);
        if (classified.class === "plan_changed" && fresh) {
            state.plans = state.plans.filter((plan) => plan.at >= step.at - 600_000);
            if (!state.plans.length) delete state.planEpisode;
            state.plans.push({
                session: row.session,
                at: step.at,
                observation,
                harness: row.harness,
            });
            if (
                new Set(state.plans.map((plan) => plan.session)).size >= 3 &&
                state.planEpisode === undefined
            ) {
                state.planEpisode = step.at;
                await emit({
                    ...alert,
                    id: `runner-plan:${step.at}`,
                    urgency: "normal",
                    detail: `${alert.detail}; simultaneous plan changes: ${state.plans.map((plan) => `${plan.harness}/${plan.session}`).join(", ")}`,
                });
            }
        }
        const idle = step.at - previous.at;
        if (idle > HOUR && idle < 20 * HOUR) {
            const key = JSON.stringify([source.id, row.harness, row.provider]);
            const rate = (state.rates[key] ??= { buckets: {}, updatedAt: now });
            rate.updatedAt = now;
            (rate.buckets[String(Math.floor(step.at / HOUR))] ??= []).push({
                at: step.at,
                healthy: classified.healthy,
            });
            const samples = Object.values(rate.buckets).flat();
            const current = samples.filter(
                (sample) => sample.at > step.at - 3 * HOUR && sample.at <= step.at,
            );
            const baseline = samples.filter(
                (sample) => sample.at > step.at - 27 * HOUR && sample.at <= step.at - 3 * HOUR,
            );
            const share = (items: RateSample[]): number =>
                items.filter((sample) => sample.healthy).length / items.length;
            if (current.length >= 8 && share(current) > 0.8) delete rate.episode;
            if (
                rate.episode === undefined &&
                current.length >= 8 &&
                share(current) < 0.5 &&
                baseline.length >= 8 &&
                share(baseline) >= 0.8
            ) {
                rate.episode = step.at;
                await emit({
                    ...alert,
                    id: `runner-rate:${key}:${step.at}`,
                    class: "rate_break",
                    detail: `${alert.detail}; rate_break source=${source.id} harness=${row.harness} provider=${row.provider}; 3h warm=${current.filter((sample) => sample.healthy).length}/${current.length}; previous 24h warm=${baseline.filter((sample) => sample.healthy).length}/${baseline.length}`,
                });
            }
        }
    }
    pruneRunnerState(state, now);
    return summary;
}

export function pruneRunnerState(state: RunnerMonitorState, now: number): void {
    for (const [key, head] of Object.entries(state.heads)) {
        if (head.updatedAt < now - 7 * 24 * HOUR) {
            delete state.heads[key];
            continue;
        }
        head.summary = head.summary.filter((row) => row.at >= now - RETENTION);
        for (const [id, seen] of Object.entries(head.seen))
            if (seen.at < now - RETENTION) delete head.seen[id];
        for (const [id, pending] of Object.entries(head.pending))
            if (pending.row.occurred_at_ms < now - RETENTION) delete head.pending[id];
    }
    for (const [key, rate] of Object.entries(state.rates)) {
        if (rate.updatedAt < now - RETENTION) {
            delete state.rates[key];
            continue;
        }
        for (const hour of Object.keys(rate.buckets))
            if (Number(hour) * HOUR < now - RETENTION) delete rate.buckets[hour];
    }
    state.plans = state.plans.filter((plan) => plan.at >= now - 600_000);
    if (!state.plans.length) delete state.planEpisode;
    for (const [id, at] of Object.entries(state.sent))
        if (at < now - RETENTION) delete state.sent[id];
}
