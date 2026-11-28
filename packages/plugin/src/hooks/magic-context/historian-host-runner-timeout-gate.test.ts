import { describe, expect, it } from "bun:test";

import {
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
    type HiddenRunHandle,
} from "./compartment-runner-types";
import { HistorianHostRunner, type HistorianHostRunnerDeps } from "./historian-host-runner";

/**
 * One queued historian run, claimed by two different hosts in turn.
 *
 * The claim carries the queuing request's per-attempt timeout
 * (`historian_timeout_ms`) next to its model chain and await budget, and the
 * claimant times each model with it rather than with its OWN `historian_timeout_ms`
 * (`attemptTimeoutMs`), exactly as the module's own lane uses the request's timeout.
 * This test claims the same run from a host configured with a short per-attempt
 * timeout and from one with none, lets the first model outlast the request's
 * timeout, and compares what each did inside the same window. It does so for a
 * carrier that waits inside `attempt` (OpenCode 1 and 2) and for one that returns
 * from `attempt` at once and waits inside `collect`.
 *
 * A claim from a module that predates the field carries no timeout, and then each
 * claimant falls back to its own configuration.
 */

function claimOnlyModule(
    reports: string[],
    requestTimeoutMs: number | undefined,
): HistorianHostRunnerDeps["call"] {
    let claimed = false;
    return async ({ method, body }) => {
        switch (method) {
            case "historian.pending":
                return claimed
                    ? { ok: true, runs: [] }
                    : {
                          ok: true,
                          runs: [
                              {
                                  run_id: "run-1",
                                  session_id: "ses-1",
                                  chunk_fingerprint: "fp",
                                  prompt_bytes_len: 10,
                                  deadline_ms: Date.now() + 60_000,
                              },
                          ],
                      };
            case "historian.claim":
                claimed = true;
                return {
                    ok: true,
                    run_id: body.run_id,
                    session_id: "ses-1",
                    attempt: 1,
                    token: "token-1",
                    prompt: { system: "system", user: "user" },
                    // Two models: a first attempt that times out falls through to the second.
                    model_chain: ["prov/first", "prov/second"],
                    // The queuing request's wait: its own per-attempt timeout plus the
                    // module's recovery margin.
                    await_budget_ms: 2_000,
                    ...(requestTimeoutMs === undefined
                        ? {}
                        : { historian_timeout_ms: requestTimeoutMs }),
                    claim_deadline_ms: Date.now() + 60_000,
                    heartbeat_interval_ms: 30_000,
                };
            case "historian.heartbeat":
                return { ok: true, claim_deadline_ms: Date.now() + 60_000 };
            case "historian.complete":
                reports.push(JSON.stringify(body.error ?? body.output ?? null));
                return { ok: true, accepted: true, publish: "immediate" };
        }
    };
}

/**
 * A carrier shaped like the OpenCode 1 child-session one: `attempt` is the
 * synchronous prompt and returns once the model has answered, here after 400ms;
 * `collect` then reads the answer. Each attempt records which model it used.
 */
function slowModelExecutor(
    models: string[],
    waitsIn: "attempt" | "collect",
): HiddenCompletionExecutor {
    return {
        capabilities: { tools: false, harness: "opencode" },
        open: async (): Promise<HiddenRunHandle> => ({ id: "child", childSessionId: "child" }),
        attempt: async (_handle, request) => {
            const body = (request as { body?: { model?: { modelID?: string } } }).body;
            models.push(String(body?.model?.modelID ?? "?"));
            if (waitsIn === "attempt") await Bun.sleep(400);
        },
        collect: async () => {
            if (waitsIn === "collect") await Bun.sleep(400);
            return {
                text: "<compartments/>",
                usage: { input: 0, output: 0, reasoning: 0, cache: 0 },
                lengthCapped: false,
            } as never;
        },
        close: async () => {},
    };
}

async function attemptsWithin(
    windowMs: number,
    attemptTimeoutMs: number | undefined,
    requestTimeoutMs: number | undefined,
    waitsIn: "attempt" | "collect" = "attempt",
) {
    const models: string[] = [];
    const reports: string[] = [];
    const runner = new HistorianHostRunner({
        call: claimOnlyModule(reports, requestTimeoutMs),
        claimantInstanceId: "install",
        openExecutor: () => ({
            executor: slowModelExecutor(models, waitsIn),
            sessionDirectory: "/tmp/p",
        }),
        enabled: () => true,
        attemptTimeoutMs: () => attemptTimeoutMs,
    });
    // The pump is not awaited so the window, not the run, decides what is compared.
    void runner.pump("ses-1");
    await Bun.sleep(windowMs);
    const seen = { models: [...models], reports: [...reports] };
    void runner.stop();
    return seen;
}

describe("historian host runner: per-attempt timeout", () => {
    it("reports a typed setup timeout to the module as a local refusal", async () => {
        const models: string[] = [];
        const reports: string[] = [];
        const done = Promise.withResolvers<void>();
        const call = claimOnlyModule(reports, 1_000);
        const executor = slowModelExecutor(models, "attempt");
        executor.attempt = async (_handle, request) => {
            models.push(request.body.model?.modelID ?? "?");
            throw new HiddenCompletionRefusal(
                "hidden_setup_timeout",
                "Hidden completion setup timed out while switching the child model",
                true,
            );
        };
        const runner = new HistorianHostRunner({
            call: async (input) => {
                const response = await call(input);
                if (input.method === "historian.complete") done.resolve();
                return response;
            },
            claimantInstanceId: "install",
            openExecutor: () => ({ executor, sessionDirectory: "/project" }),
            enabled: () => true,
        });
        try {
            void runner.pump("ses-1");
            await done.promise;
            expect(models).toEqual(["first"]);
            expect(reports.map((report) => JSON.parse(report))).toEqual([
                {
                    code: "local_refusal",
                    message:
                        "hidden_setup_timeout: Hidden completion setup timed out while switching the child model",
                },
            ]);
        } finally {
            await runner.stop();
        }
    });

    it("attempts one claimed run the same way whichever host claims it", async () => {
        const shortHost = await attemptsWithin(1_500, 150, 150);
        const defaultHost = await attemptsWithin(1_500, undefined, 150);
        console.log(
            `models attempted in 1500ms: host with a 150ms attempt timeout=${JSON.stringify(shortHost)} host with none=${JSON.stringify(defaultHost)}`,
        );
        expect(shortHost).toEqual(defaultHost);
    }, 10_000);

    it("holds a carrier that waits inside collect to the same per-attempt timeout", async () => {
        const waitsInAttempt = await attemptsWithin(1_500, undefined, 150, "attempt");
        const waitsInCollect = await attemptsWithin(1_500, undefined, 150, "collect");
        expect(waitsInCollect).toEqual(waitsInAttempt);
        expect(waitsInCollect.reports).toEqual([
            JSON.stringify({ code: "timed_out", message: "prompt timed out after 150ms" }),
        ]);
    }, 10_000);

    it("falls back to the claimant's own timeout when the claim carries none", async () => {
        const shortHost = await attemptsWithin(1_500, 150, undefined);
        const defaultHost = await attemptsWithin(1_500, undefined, undefined);
        expect(shortHost.reports).toEqual([
            JSON.stringify({ code: "timed_out", message: "prompt timed out after 150ms" }),
        ]);
        expect(defaultHost.reports).toEqual([
            JSON.stringify({ text: "<compartments/>", length_capped: false }),
        ]);
    }, 10_000);
});
