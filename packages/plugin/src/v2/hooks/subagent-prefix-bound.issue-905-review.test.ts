// Review findings on the change that ends the signed-thinking hold where
// force-band pressure begins (issue 905), pinned as tests; see
// .cortexkit/internal-docs/audits/issue-905-hold-review.md.
//
// The session is the issue 905 subagent (see __tests__/issue-905-subagent.fixture.ts)
// at the default 65% execute threshold, on a provider that reports no input
// usage. Every pass then starts with no usage reading: the hold is decided from
// that empty reading, and a priced pass is sized from a local count of its own
// request afterwards. The hold is judged again on that sized reading: it ends
// at or above its cap and in force-band pressure. Before, such a session stayed
// held at any sized reading and its queued drops waited (in this run from 99%
// to 136% of the window), so the default threshold does change here.
import { beforeAll, describe, expect, test } from "bun:test";
import {
    type Issue905Pass,
    type Issue905Run,
    runIssue905Session,
} from "./__tests__/issue-905-subagent.fixture";

// The default 65% threshold: the hold's cap is 75%, the force band starts at
// 85%, and a reading that only a local count raised counts as force-band
// pressure from 95%.
const CAP = 75;

let run: Issue905Run;

beforeAll(async () => {
    run = await runIssue905Session({
        seed: 9056,
        steps: 80,
        reportUsage: false,
        configOverrides: { execute_threshold_tokens: undefined },
    });
}, 600_000);

// The reading a priced pass took from its own local count, when it took one.
const localReading = (pass: Issue905Pass): number | null => {
    const line = pass.logs.find((entry) =>
        entry.includes("unknown provider usage; using wire estimate for priced pass"),
    );
    const match = line ? / percentage=([\d.]+) /.exec(line) : null;
    return match ? Number(match[1]) : null;
};

describe("issue 905 review, default threshold, no provider usage", () => {
    test("the run is at the default threshold and its sized readings pass the hold's cap", () => {
        expect(new Set(run.passes.map((pass) => pass.threshold))).toEqual(new Set([65]));
        expect(run.passes.some((pass) => (localReading(pass) ?? 0) >= CAP)).toBe(true);
    });

    // The cap is judged on the reading a pass is sized at, not only on the
    // reading it starts with, so a provider that reports no usage is capped too.
    test("no pass is held above the cap of its sized reading", () => {
        const heldAboveCap = run.passes.filter(
            (pass) => pass.thinkingHold === true && (localReading(pass) ?? 0) >= CAP,
        );
        expect(
            heldAboveCap.map((pass) => ({ step: pass.step, localReading: localReading(pass) })),
        ).toEqual([]);
    });

    test("a pass whose sized reading ends the hold lands its queued drops and strips the kept thinking", () => {
        const ended = run.passes.filter((pass) =>
            pass.logs.some((line) =>
                /signed thinking hold: held=false reason=(above_cap|force_band) .*\(sized reading/.test(
                    line,
                ),
            ),
        );
        expect(ended.length).toBeGreaterThanOrEqual(2);
        for (const pass of ended) {
            expect(localReading(pass) ?? 0).toBeGreaterThanOrEqual(CAP);
            expect(pass.thinkingHold).toBe(false);
            expect(pass.pendingQueuedBefore).toBeGreaterThan(0);
            expect(pass.pendingQueuedAfter).toBeLessThan(pass.pendingQueuedBefore);
            expect(pass.served.thinkingBlocks).toBe(0);
        }
    });

    // The session never reaches 95% held: every pass at the local-count line
    // has landed its queued drops.
    test("no pass with a sized reading of 95% or more is held or keeps a queued drop", () => {
        const atLine = run.passes.filter((pass) => (localReading(pass) ?? 0) >= 95);
        for (const pass of atLine) {
            expect(pass.thinkingHold).toBe(false);
            expect(pass.pendingQueuedAfter).toBeLessThan(Math.max(1, pass.pendingQueuedBefore));
        }
    });
});
