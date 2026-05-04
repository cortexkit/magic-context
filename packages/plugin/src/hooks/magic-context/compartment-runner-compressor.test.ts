/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import {
    findOldestContiguousSameDepthBand,
    selectCompressionBand,
} from "./compartment-runner-compressor";

// Minimal shape for the test — the selector only reads averageDepth and index.
// We use `as unknown as Parameters<typeof findOldestContiguousSameDepthBand>[0][number]`
// to satisfy the ScoredCompartment interface without pulling in the full type.
function scored(...depths: number[]) {
    return depths.map(
        (d, i) =>
            ({
                compartment: { sequence: i } as unknown,
                index: i,
                tokenEstimate: 100,
                averageDepth: d,
                score: 1,
            }) as Parameters<typeof findOldestContiguousSameDepthBand>[0][number],
    );
}

describe("findOldestContiguousSameDepthBand — band-boundary regression", () => {
    it("returns the oldest same-depth run ≥ 2 when it starts at the anchor", () => {
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);
    });

    it("does NOT skip element j when the singleton-run at i ends because of a depth mismatch", () => {
        // This was the bug: with [0, 1, 1, 1], maxPickable=2, the old code did
        // `i = max(j+1, i+1)` when runLen<2 at i=0. That advanced i to 2
        // instead of 1, losing the chance to pick [scored[1], scored[2]] as
        // the first depth-1 band. The fix advances to `j` (which is 1 here)
        // so scored[1] can anchor the next run.
        const band = findOldestContiguousSameDepthBand(scored(0, 1, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        // Must pick the band starting at index 1, not skip to index 2.
        expect(band.map((b) => b.index)).toEqual([1, 2]);
    });

    it("skips past an always-max-depth element without stalling", () => {
        // [d=0, d=max, d=1, d=1] — the middle element is skipped because it's
        // at max depth. After that, scored[2] and scored[3] form a band.
        // Progress guarantee: the outer loop uses `continue` on max-depth and
        // advances i by 1 via `i++`, not via `i = max(j, i+1)`. So this test
        // verifies the skip branch stays separate and functional.
        const band = findOldestContiguousSameDepthBand(scored(0, 5, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([2, 3]);
    });

    it("honors the grace period and never considers the newest compartments", () => {
        // [0, 0, 1, 1], graceCompartments=2 → scope shrinks to [0, 0]; depth-0
        // band there is valid.
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 2,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);

        // Pull grace too tight → no band possible.
        const empty = findOldestContiguousSameDepthBand(scored(0, 0, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 3,
            floorHeadroom: 10,
        });
        expect(empty).toEqual([]);
    });

    it("caps the band at maxPickable regardless of longer runs", () => {
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 0, 0), {
            maxPickable: 3,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1, 2]);
    });

    it("caps the band at floorHeadroom when it is tighter than maxPickable", () => {
        // floorHeadroom < maxPickable — floor wins.
        const band = findOldestContiguousSameDepthBand(scored(0, 0, 0, 0), {
            maxPickable: 4,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 2,
        });
        expect(band.map((b) => b.index)).toEqual([0, 1]);
    });

    it("returns [] when no same-depth run ≥ 2 exists in scope", () => {
        // Every compartment has a distinct rounded depth.
        const band = findOldestContiguousSameDepthBand(scored(0, 1, 2, 3), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band).toEqual([]);
    });

    it("returns [] when hardMaxPick is below 2", () => {
        expect(
            findOldestContiguousSameDepthBand(scored(0, 0, 0), {
                maxPickable: 1,
                maxMergeDepth: 5,
                graceCompartments: 0,
                floorHeadroom: 10,
            }),
        ).toEqual([]);

        expect(
            findOldestContiguousSameDepthBand(scored(0, 0, 0), {
                maxPickable: 5,
                maxMergeDepth: 5,
                graceCompartments: 0,
                floorHeadroom: 1,
            }),
        ).toEqual([]);
    });
});

describe("selectCompressionBand — depth-first cascade prevention", () => {
    it("prefers a newer depth-0 band over an older depth-1 band", () => {
        // This is the core bug the redesign fixes. Old state:
        //   seq 0-3 at depth 1 (already compressed once)
        //   seq 4-10 at depth 0 (untouched)
        // Old selector (oldest-first, same-depth) would pick seq 0-1 again
        // because they form the oldest same-depth run, cascading the same
        // range to depth 2, 3, 4, 5.
        // New selector picks the depth-0 band instead, spreading compression
        // uniformly across history.
        const band = selectCompressionBand(scored(1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0), {
            maxPickable: 5,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 20,
        });
        expect(band.map((b) => b.index)).toEqual([4, 5, 6, 7, 8]);
    });

    it("picks depth 0 when depth 0 exists, even if depth 1 band is older and longer", () => {
        // [1, 1, 1, 1, 1, 0, 0] — old algorithm: oldest same-depth band = [0..4].
        // New algorithm: minimum depth in scope = 0, so pick depth-0 run at [5, 6].
        const band = selectCompressionBand(scored(1, 1, 1, 1, 1, 0, 0), {
            maxPickable: 10,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 20,
        });
        expect(band.map((b) => b.index)).toEqual([5, 6]);
    });

    it("falls back to next tier when lowest tier has no run of 2", () => {
        // [0, 1, 1, 1] — depth 0 is a singleton at index 0 and can't form a
        // run. Fall back to depth 1, which has a run [1, 2, 3].
        const band = selectCompressionBand(scored(0, 1, 1, 1), {
            maxPickable: 2,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 10,
        });
        expect(band.map((b) => b.index)).toEqual([1, 2]);
    });

    it("ignores compartments at max depth entirely when computing min tier", () => {
        // [5, 5, 5, 5, 2, 2, 0, 0] — depths 5 are maxed out (ignored).
        // Min depth in remaining scope = 0. Pick [6, 7].
        const band = selectCompressionBand(scored(5, 5, 5, 5, 2, 2, 0, 0), {
            maxPickable: 10,
            maxMergeDepth: 5,
            graceCompartments: 0,
            floorHeadroom: 20,
        });
        expect(band.map((b) => b.index)).toEqual([6, 7]);
    });

    it("produces uniform depth-0 coverage over repeated passes before any tier increments", () => {
        // Simulate the full cascade: 20 compartments all at depth 0, grace=5.
        // Selecting once picks seq [0..4] (oldest depth-0 band). After
        // "compression" bumps those to depth 1, selection should pick seq
        // [5..9] next, not revisit seq 0. Repeat until all eligible seq at 1.
        const depths = Array(20).fill(0);
        const maxPickable = 5;
        const graceCompartments = 5;
        const passes: number[][] = [];

        for (let pass = 0; pass < 5; pass++) {
            const band = selectCompressionBand(scored(...depths), {
                maxPickable,
                maxMergeDepth: 5,
                graceCompartments,
                floorHeadroom: 50,
            });
            if (band.length === 0) break;
            passes.push(band.map((b) => b.index));
            // Simulate compression: bump those indexes to depth 1.
            for (const s of band) depths[s.index] = 1;
        }

        // With 20 compartments and grace=5, eligible range is [0, 15). Each
        // pass consumes 5 depth-0 slots. After 3 passes, all 15 eligible
        // slots are at depth 1. The 4th pass then starts the depth-1→2 cycle
        // from seq 0.
        expect(passes.length).toBeGreaterThanOrEqual(3);
        expect(passes[0]).toEqual([0, 1, 2, 3, 4]);
        expect(passes[1]).toEqual([5, 6, 7, 8, 9]);
        expect(passes[2]).toEqual([10, 11, 12, 13, 14]);
        // After all depth-0 bands are compressed, pass 4 returns to oldest
        // depth-1 band (expected tier-upgrade behavior).
        if (passes.length >= 4) {
            expect(passes[3]).toEqual([0, 1, 2, 3, 4]);
        }
    });
});
