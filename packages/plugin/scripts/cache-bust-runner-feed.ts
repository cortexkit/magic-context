import { z } from "zod";
import type { ManagedCallOptions } from "@cortexkit/subc-client";

const count = z.number().int().nonnegative().optional();
// Runners that report cache facts put them on each step, and Astrocyte compares
// them with the session's previous row to name a rewrite's `cause`. Every one
// is optional: rows from runners that send no facts, and every row Astrocyte
// recorded before runners sent them, carry none.
const stepFactMembers = {
    account_ref: z.string().optional(),
    started_at_ms: count,
    finished_at_ms: count,
    cache_ttl_ms: count,
    view_version: count,
    tools_digest: z.string().optional(),
    system_digest: z.string().optional(),
    signed_floor: z.string().optional(),
};
/** The facts a step keeps so the next step's rewrite can be compared with it. */
export const runnerStepFactsSchema = z.object(stepFactMembers);
export type RunnerStepFacts = z.infer<typeof runnerStepFactsSchema>;
const STEP_FACT_KEYS = Object.keys(stepFactMembers) as (keyof RunnerStepFacts)[];

export const runnerFeedRow = z
    .object({
        cursor: z.string(),
        harness: z.string(),
        source: z.string(),
        step_ref: z.string(),
        session: z.string(),
        occurred_at_ms: z.number().int().nonnegative(),
        verdict: z.string(),
        provider: z.string().optional(),
        model: z.string().optional(),
        input: count,
        cache_read: count,
        cache_write: count,
        output: count,
        prompt: count,
        ...stepFactMembers,
        warm_up: z.boolean().optional(),
        // Astrocyte's explanation of a rewrite. The set of values is open, so
        // an unfamiliar one is kept as received rather than refusing the page.
        cause: z.string().optional(),
    })
    .strip();
export type RunnerFeedRow = z.infer<typeof runnerFeedRow>;

/** A row's cache facts, or undefined when it carries none. */
export function runnerStepFacts(row: RunnerFeedRow): RunnerStepFacts | undefined {
    const facts: Record<string, unknown> = {};
    for (const key of STEP_FACT_KEYS) if (row[key] !== undefined) facts[key] = row[key];
    return Object.keys(facts).length ? (facts as RunnerStepFacts) : undefined;
}
const pageSchema = z.object({
    rows: z.array(runnerFeedRow),
    next: z.string().nullish(),
    through: z.string(),
});
export type RunnerFeedPage = { rows: RunnerFeedRow[]; next: string | null; through: string };

export function decodeRunnerFeedPage(wire: unknown): RunnerFeedPage {
    const envelope = z.object({ result: pageSchema }).parse(wire);
    return { ...envelope.result, next: envelope.result.next ?? null };
}

/** The cursor is opaque; sources own pagination and must honor the remaining call budget. */
export interface RunnerMeterSource {
    id: string;
    read(after: string | undefined, timeoutMs: number): Promise<RunnerFeedPage>;
}

export interface RunnerFeedClient {
    call(
        module: string,
        method: string,
        params: unknown,
        options: ManagedCallOptions,
    ): Promise<unknown>;
}

export class AstrocyteRunnerMeterSource implements RunnerMeterSource {
    readonly id = "astrocyte";
    constructor(private readonly client: () => Promise<RunnerFeedClient>) {}
    async read(after: string | undefined, timeoutMs: number): Promise<RunnerFeedPage> {
        const client = await this.client();
        const wire = await client.call(
            "astrocyte",
            "usage.steps.read",
            { ...(after ? { after } : {}), limit: 1000 },
            {
                identity: {
                    project_root: process.cwd(),
                    harness: "magic-context",
                    session: "health-sentinel-mc",
                },
                consumerIdentity: null,
                timeoutMs,
            },
        );
        return decodeRunnerFeedPage(wire);
    }
}
