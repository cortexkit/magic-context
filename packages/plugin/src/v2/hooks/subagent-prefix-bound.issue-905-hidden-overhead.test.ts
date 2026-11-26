/// <reference types="bun-types" />
// The issue 905 OpenCode 2 subagent session with system prompt and tool
// definitions the provider counts but Magic Context never sees: a plugin that
// adds tools after Magic Context's hook, or a provider that counts text of its
// own. Magic Context's count of the last request is then lower than the
// provider's reading by that hidden amount, and the emergency drop, which
// infers the part of the request no tool drop can remove from the smaller of
// the two, understates that part by as much. These tests pin what the drop
// does there, against the planner of the last release (0.49.81, kept frozen
// in __fixtures__ as the reference) on the same inputs:
//   - with the fixture's 27,000 hidden tokens, the release never finds that
//     part over the reduction point;
//   - with 268,000 hidden tokens (more than the 250,000 where reduction
//     starts), the release does on almost every pass and never drops.
// Each scenario runs twice: serving this build's plans, and serving the
// release's plans, so the two sessions can be compared.

import { describe, expect, spyOn, test } from "bun:test";
import { releasePlanEmergencyDrop } from "../../hooks/magic-context/__fixtures__/emergency-drop-release-0.49.81";
import * as emergencyDrop from "../../hooks/magic-context/emergency-drop";
import {
    ISSUE_905_CONTEXT,
    type Issue905Run,
    runIssue905Session,
} from "./__tests__/issue-905-subagent.fixture";

type Plan = ReturnType<typeof emergencyDrop.planEmergencyDrop>;
interface Played {
    run: Issue905Run;
    /** Every planner call: this build's plan and the release's on the same inputs. */
    calls: Array<{ current: Plan; release: Plan }>;
}

const currentPlanner = emergencyDrop.planEmergencyDrop;

async function play(overheadTokens: number, serve: "current" | "release"): Promise<Played> {
    const calls: Played["calls"] = [];
    const spy = spyOn(emergencyDrop, "planEmergencyDrop").mockImplementation((input) => {
        const { servedCountTokens: _count, ...releaseInput } = input;
        const release = releasePlanEmergencyDrop(releaseInput);
        const current = currentPlanner(input);
        calls.push({ current, release });
        return serve === "current" ? current : release;
    });
    try {
        const run = await runIssue905Session({ seed: 905, steps: 70, overheadTokens });
        return { run, calls };
    } finally {
        spy.mockRestore();
    }
}

const OVER_CEILING = "already exceeds ceiling";
const batches = (run: Issue905Run) =>
    run.passes.filter((pass) =>
        /emergency tiered drop: tiered drop: \d+ tags/.test(pass.emergency ?? ""),
    );
const refusals = (run: Issue905Run) =>
    run.passes.filter((pass) => pass.logs.some((line) => line.includes("EMERGENCY: fail-closed")));
const overWindow = (run: Issue905Run) =>
    run.passes.filter((pass) => pass.served.total > ISSUE_905_CONTEXT);
function longestBatchRun(run: Issue905Run): number {
    let current = 0;
    let longest = 0;
    for (const pass of run.passes) {
        current = /tiered drop: \d+ tags/.test(pass.emergency ?? "") ? current + 1 : 0;
        longest = Math.max(longest, current);
    }
    return longest;
}

for (const overheadTokens of [27_000, 268_000]) {
    describe(`issue 905 with ${overheadTokens.toLocaleString("en-US")} tokens Magic Context does not see`, () => {
        let played: Record<"current" | "release", Played>;
        const both = async () => {
            played ??= {
                current: await play(overheadTokens, "current"),
                release: await play(overheadTokens, "release"),
            };
            return played;
        };

        test("every plan is the release's plan on the same inputs or extends it", async () => {
            const { current, release } = await both();
            for (const { calls } of [current, release]) {
                expect(calls.length).toBeGreaterThan(0);
                for (const call of calls) {
                    if (call.release.shouldDrop) {
                        expect(call.current.shouldDrop).toBe(true);
                        expect(
                            call.current.tagNumbers.slice(0, call.release.tagNumbers.length),
                        ).toEqual(call.release.tagNumbers);
                    }
                    expect(call.current.reclaimTokens).toBeGreaterThanOrEqual(
                        call.release.reclaimTokens,
                    );
                }
            }
        }, 600_000);

        test("where the release finds the fixed part over the reduction point, this build drops or has nothing to drop", async () => {
            const { current, release } = await both();
            const skipped = current.calls.filter((call) =>
                call.release.reason.includes(OVER_CEILING),
            );
            console.log(
                `ISSUE905-HIDDEN ${overheadTokens}: planner calls ${current.calls.length}, release over the reduction point on ${skipped.length}; batches this build ${batches(current.run).length}, release-served ${batches(release.run).length}; longest run of batch passes ${longestBatchRun(current.run)}`,
            );
            for (const call of skipped) {
                expect(call.current.reason).not.toContain(OVER_CEILING);
                expect(
                    call.current.shouldDrop ||
                        /no-candidates|pressure-episode-latched|reclaim<=min/.test(
                            call.current.reason,
                        ),
                ).toBe(true);
            }
            if (overheadTokens < 250_000) {
                // The hidden part alone is under the reduction point: the
                // release never skips for it.
                expect(skipped.length).toBe(0);
            } else {
                // The hidden part alone is over it: the release skips on most
                // planned passes and never drops; this build drops instead.
                expect(skipped.length).toBeGreaterThan(current.calls.length / 2);
                expect(batches(release.run).length).toBe(0);
                expect(batches(current.run).length).toBeGreaterThan(0);
            }
        }, 600_000);

        test("the session ends as the release's does, with no refusal, and this build serves nothing over the window", async () => {
            const { current, release } = await both();
            // Neither session is refused by Magic Context: its own estimate of
            // the request never sees the hidden part.
            expect(refusals(current.run)).toEqual([]);
            expect(refusals(release.run)).toEqual([]);
            // This build serves no request the provider counts over the window.
            expect(overWindow(current.run)).toEqual([]);
            if (overheadTokens >= 250_000) {
                // Serving the release's plans, the same session goes over the
                // window, where a real provider would refuse it.
                expect(overWindow(release.run).length).toBeGreaterThan(0);
                // The batches do not repeat on every pass: a batch pass is
                // followed by at least one pass without one.
                expect(longestBatchRun(current.run)).toBe(1);
            } else expect(overWindow(release.run)).toEqual([]);
        }, 600_000);
    });
}
