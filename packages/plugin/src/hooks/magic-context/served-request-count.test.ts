/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { resolveDecisionCalibration } from "./decision-calibration";
import { createServedRequestCounts } from "./served-request-count";

const neutral = resolveDecisionCalibration(undefined, undefined);
const components = { system: 1_000, tools: 2_000, prose: 3_000 };

describe("our count of the last request served", () => {
    it("a pass reads the count recorded by the pass before it", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s");
        expect(counts.tokens("s", "p/m", neutral)).toBeUndefined();
        counts.record("s", { modelKey: "p/m", components });
        // Not readable during the pass that recorded it.
        expect(counts.tokens("s", "p/m", neutral)).toBeUndefined();
        counts.passStarted("s");
        expect(counts.tokens("s", "p/m", neutral)).toBe(6_000);
    });

    it("a pass that records nothing leaves the next pass with no count, not an older one", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s");
        counts.record("s", { modelKey: "p/m", components });
        counts.passStarted("s");
        counts.passStarted("s");
        expect(counts.tokens("s", "p/m", neutral)).toBeUndefined();
    });

    it("a count made for another model is no count", () => {
        const counts = createServedRequestCounts();
        counts.record("s", { modelKey: "p/m", components });
        counts.passStarted("s");
        expect(counts.tokens("s", "p/other", neutral)).toBeUndefined();
        expect(counts.tokens("s", undefined, neutral)).toBeUndefined();
    });

    it("a count that is not finite or not above zero is no count", () => {
        const counts = createServedRequestCounts();
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
            counts.record("s", {
                modelKey: "p/m",
                components: { system: bad, tools: 0, prose: 0 },
            });
            counts.passStarted("s");
            expect(counts.tokens("s", "p/m", neutral)).toBeUndefined();
        }
    });

    it("prices with the caller's ratios and adds what the host adds", () => {
        const counts = createServedRequestCounts();
        counts.record("s", { modelKey: "p/m", components, hostAddedTokens: 500 });
        counts.passStarted("s");
        const doubled = { ...neutral, systemRatio: 2, toolsRatio: 2, proseRatio: 2 };
        expect(counts.tokens("s", "p/m", doubled)).toBe(12_500);
    });

    it("counts a saved copy once, on demand, and takes the model from it", () => {
        const counts = createServedRequestCounts();
        let counted = 0;
        counts.record("s", {
            modelKey: "p/m",
            saved: {
                count() {
                    counted++;
                    return { modelKey: "p/m", components };
                },
            },
        });
        counts.passStarted("s");
        expect(counted).toBe(0);
        expect(counts.tokens("s", "p/m", neutral)).toBe(6_000);
        expect(counts.tokens("s", "p/m", neutral)).toBe(6_000);
        expect(counted).toBe(1);
    });
});

describe("the recorded tool set of the request a pass serves (OpenCode 2)", () => {
    const set = (request: number) => ({ request, total: 4_698 });

    it("a set recorded after the previous pass started is this pass's request's", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s", set(1));
        expect(counts.requestToolSet("s", set(1))).toEqual(set(1));
        counts.passStarted("s", set(2));
        expect(counts.requestToolSet("s", set(2))).toEqual(set(2));
    });

    it("a set a previous pass already started with belongs to an earlier request", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s", set(1));
        counts.passStarted("s", set(1));
        expect(counts.requestToolSet("s", set(1))).toBeUndefined();
        // A pass with no set recorded since keeps the earlier number in mind.
        counts.passStarted("s");
        counts.passStarted("s", set(1));
        expect(counts.requestToolSet("s", set(1))).toBeUndefined();
    });

    it("a set recorded while the pass ran is another request's", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s", set(1));
        expect(counts.requestToolSet("s", set(2))).toBeUndefined();
        expect(counts.requestToolSet("s", undefined)).toBeUndefined();
    });

    it("no set at the start of the pass is no set", () => {
        const counts = createServedRequestCounts();
        counts.passStarted("s");
        expect(counts.requestToolSet("s", set(1))).toBeUndefined();
        // Another session's set is not this session's.
        counts.passStarted("t", set(3));
        expect(counts.requestToolSet("s", set(3))).toBeUndefined();
    });
});
