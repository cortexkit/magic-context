import { z } from "zod";
import type { ManagedCallOptions } from "@cortexkit/subc-client";

const count = z.number().int().nonnegative().optional();
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
    })
    .strip();
export type RunnerFeedRow = z.infer<typeof runnerFeedRow>;
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
