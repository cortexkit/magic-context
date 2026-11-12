import { describe, expect, test } from "bun:test";
import { escalationBands, MAX_EXECUTE_THRESHOLD } from "./escalation-bands";

describe("escalationBands", () => {
    test.each([
        [65, 85],
        [80, 85],
        [88, 90],
        [90, 92],
    ])("keeps the force band ordered for threshold %i", (threshold, expectedForce) => {
        const bands = escalationBands(threshold);
        expect(bands.forceMaterializationPercentage).toBe(expectedForce);
        expect(threshold).toBeLessThan(bands.forceMaterializationPercentage);
        expect(bands.forceMaterializationPercentage).toBeGreaterThanOrEqual(85);
        expect(bands.forceMaterializationPercentage).toBeLessThan(95);
        expect(bands.emergencyPercentage).toBe(95);
    });

    test("preserves the exact pre-raise behavior through threshold 80", () => {
        expect(escalationBands(65).forceMaterializationPercentage).toBe(85);
        expect(escalationBands(80).forceMaterializationPercentage).toBe(85);
    });

    // No threshold puts the force band at or above 95%. A pass held for signed
    // thinking therefore never reaches 95% with compaction on (the hold ends in
    // force-band pressure), and neither the OpenCode postprocess phase nor
    // Pi's pipeline has a 95% release for a held turn any more: that removal
    // rests on this bound. Raising the
    // threshold clamp past 92% would let a reading in [95%, threshold + 2%) be
    // held again.
    test("the force band starts below 95% for every threshold", () => {
        expect(escalationBands(Infinity).forceMaterializationPercentage).toBeLessThan(95);
        expect(escalationBands(Number.MAX_VALUE).forceMaterializationPercentage).toBeLessThan(95);
        expect(escalationBands(MAX_EXECUTE_THRESHOLD).forceMaterializationPercentage).toBeLessThan(
            95,
        );
    });
});
