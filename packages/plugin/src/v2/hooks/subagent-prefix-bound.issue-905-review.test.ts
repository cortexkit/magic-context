// Review witnesses for the change that ends the signed-thinking hold where
// force-band pressure begins (issue 905). Each test states a property the
// change claims or relies on and is expected to FAIL while the defect it names
// is present; see .cortexkit/internal-docs/audits/issue-905-hold-review.md.
//
// The session is the issue 905 subagent (see __tests__/issue-905-subagent.fixture.ts)
// at the default 65% execute threshold, on a provider that reports no input
// usage. Every pass then starts with no usage reading: the hold is decided from
// that empty reading, and a priced pass is sized from a local count of its own
// request afterwards.
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
    test("the run is at the default threshold and reaches the 95% local-count line", () => {
        expect(new Set(run.passes.map((pass) => pass.threshold))).toEqual(new Set([65]));
        expect(run.passes.some((pass) => (localReading(pass) ?? 0) >= 95)).toBe(true);
    });

    // The change claims that at the default threshold every decision is
    // unchanged, because the hold's cap (75%) ends a hold before the force band
    // (85%) can. That holds for one reading, but the cap is judged on the
    // reading the pass starts with and the re-check after sizing judges the
    // force band on the sized reading. A pass that starts with no reading is
    // held, and the re-check then ends the hold at the sized reading: a decision
    // that did not exist before the change.
    test("WITNESS: at the default threshold no hold is ended by the force band", () => {
        const endedByForceBand = run.passes.filter((pass) =>
            pass.logs.some((line) =>
                line.includes("signed thinking hold: held=false reason=force_band"),
            ),
        );
        expect(
            endedByForceBand.map((pass) => ({ step: pass.step, localReading: localReading(pass) })),
        ).toEqual([]);
    });

    // The cap reads only the reading the pass starts with, so on a provider that
    // reports no usage it never ends a hold, and a held pass can be served far
    // above the cap.
    test("WITNESS: no pass is held above the cap of its sized reading", () => {
        const heldAboveCap = run.passes.filter(
            (pass) => pass.thinkingHold === true && (localReading(pass) ?? 0) >= CAP,
        );
        expect(
            heldAboveCap.map((pass) => ({ step: pass.step, localReading: localReading(pass) })),
        ).toEqual([]);
    });
});
