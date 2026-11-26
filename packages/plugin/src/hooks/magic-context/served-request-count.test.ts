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
