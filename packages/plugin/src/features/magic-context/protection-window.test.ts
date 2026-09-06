/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    computeProtectionWindow,
    getProtectionWindowForSession,
    type ProtectionWindowResult,
    type ProtectionWindowRow,
    readEpochFloorSnapshot,
    rowWindowMass,
} from "./protection-window";
import { insertTag, updateTagTokenCount } from "./storage-tags";

type FixtureRowTuple = [
    kind: string,
    tag_number: number,
    row_identity: number | string,
    token_count: number | null,
];

function rowsFromTuples(tuples: FixtureRowTuple[]): ProtectionWindowRow[] {
    return tuples.map(([kind, tag_number, row_identity, token_count]) => ({
        kind,
        tag_number,
        row_identity,
        token_count,
    }));
}

function assertOracleParity(
    result: ProtectionWindowResult,
    expectedRowKeys: string[],
    expectedTagNumbers: number[],
    expectedCutoff: number | null,
    expectedCount: number,
    expectedMass: number,
    allInputRows: ProtectionWindowRow[],
) {
    // 1. Primary asserted oracle: exact protected ROW set keyed by (tag_number, row_identity)
    expect(Array.from(result.memberRowKeys).sort()).toEqual([...expectedRowKeys].sort());

    // 2. Three consumer projections:
    // Block-id / row-identity projection tagged with coordinate space
    expect(result.rowIdentitySet.coordinateSpace).toBe("row-identity");
    const expectedIdentities = expectedRowKeys.map((k) => {
        const idx = k.indexOf(":");
        const idStr = k.slice(idx + 1);
        const num = Number(idStr);
        return Number.isFinite(num) && !Number.isNaN(num) && String(num) === idStr ? num : idStr;
    });
    expect(Array.from(result.rowIdentitySet.rowIdentities).map(String).sort()).toEqual(
        expectedIdentities.map(String).sort(),
    );

    // Tag-number projection tagged with coordinate space
    expect(result.tagNumberSet.coordinateSpace).toBe("tag-number");
    expect(Array.from(result.tagNumberSet.tagNumbers).sort((a, b) => a - b)).toEqual(
        [...expectedTagNumbers].sort((a, b) => a - b),
    );

    // Ordinal cutoff projection tagged with coordinate space
    expect(result.ordinalCutoff.coordinateSpace).toBe("tag-number");
    if (expectedCutoff === null) {
        expect(result.ordinalCutoff.cutoff).toBeNull();
        expect(result.cutoff).toBeNull();
    } else {
        expect(result.ordinalCutoff.cutoff).toBe(expectedCutoff);
        expect(result.cutoff).toBe(expectedCutoff);
    }

    // 3. Status triple
    expect(result.status.protectedCount).toBe(expectedCount);
    expect(result.status.protectedMass).toBe(expectedMass);

    // 4. Predicate cross-check over all input rows:
    // row.kind == tool && cutoff !== null && row.tag_number >= cutoff
    for (const row of allInputRows) {
        const isTool = (row.kind ?? row.type ?? "").toLowerCase() === "tool";
        const tagNum = row.tag_number ?? row.tagNumber ?? 0;
        const expectedProtected = isTool && expectedCutoff !== null && tagNum >= expectedCutoff;
        expect(result.isProtected(row)).toBe(expectedProtected);
    }
}

describe("protection-window", () => {
    describe("#given canonical walk fixtures F1-F9 at floor 16,000", () => {
        it("#F1 exhausted history — 20 tool rows each 250 (5,000 total)", () => {
            const floor = 16_000;
            const tuples: FixtureRowTuple[] = [];
            for (let i = 1; i <= 20; i++) {
                tuples.push(["tool", i, `r${i}`, 250]);
            }
            const rows = rowsFromTuples(tuples);
            const result = computeProtectionWindow(rows, floor);

            const expectedKeys = tuples.map((t) => `${t[1]}:${t[2]}`);
            const expectedTagNumbers = tuples.map((t) => t[1]);

            assertOracleParity(result, expectedKeys, expectedTagNumbers, 1, 20, 5_000, rows);
        });

        it("#F2 single large read — rows 1..9 each 2,000, row 10 is 40,000", () => {
            const floor = 16_000;
            const tuples: FixtureRowTuple[] = [];
            for (let i = 1; i <= 9; i++) {
                tuples.push(["tool", i, `r${i}`, 2_000]);
            }
            tuples.push(["tool", 10, "r10", 40_000]);
            const rows = rowsFromTuples(tuples);
            const result = computeProtectionWindow(rows, floor);

            // Row 10 crosses floor alone -> mass window {10}.
            // Unioned with newest-3 minimum {8, 9, 10} -> protected {8, 9, 10}, cutoff 8.
            const expectedKeys = ["8:r8", "9:r9", "10:r10"];
            const expectedTagNumbers = [8, 9, 10];

            assertOracleParity(result, expectedKeys, expectedTagNumbers, 8, 3, 44_000, rows);

            // Pin status triple by value
            expect(result.status).toEqual({
                floor: 16_000,
                protectedCount: 3,
                protectedMass: 44_000,
            });
        });

        it("#F3 exact equality — rows 1..10 each 4,000", () => {
            const floor = 16_000;
            const tuples: FixtureRowTuple[] = [];
            for (let i = 1; i <= 10; i++) {
                tuples.push(["tool", i, `r${i}`, 4_000]);
            }
            const rows = rowsFromTuples(tuples);
            const result = computeProtectionWindow(rows, floor);

            // Reverse walk: 10 (4k), 9 (8k), 8 (12k), 7 (16k == floor -> crossing row included).
            // Mass window {7, 8, 9, 10}, newest-3 {8, 9, 10}, cutoff = min(7, 8) = 7.
            const expectedKeys = ["7:r7", "8:r8", "9:r9", "10:r10"];
            const expectedTagNumbers = [7, 8, 9, 10];

            assertOracleParity(result, expectedKeys, expectedTagNumbers, 7, 4, 16_000, rows);
        });

        it("#F4 tie-group-atomic stop — opposed-tie fixture pins tie groups are selected whole", () => {
            const floor = 16_000;
            // Deliberately opposing tie order:
            // Two rows share tag_number 9 with distinct identities 'a' and 'b'.
            // TS order: a < b. Reverse visit visits b, then a.
            // Tags 10, 11, 12 each 4,000 (total 12,000 < 16,000).
            // When visiting tag 9, first visited member adds 10,000 -> 22,000 >= 16,000.
            // Floor is crossed by the first-visited member of the tie.
            // Because the stop is TIE-GROUP ATOMIC, BOTH tied rows are included!
            const tuples: FixtureRowTuple[] = [
                ["tool", 7, "r7", 4_000],
                ["tool", 8, "r8", 4_000],
                ["tool", 9, "a", 10_000],
                ["tool", 9, "b", 10_000],
                ["tool", 10, "r10", 4_000],
                ["tool", 11, "r11", 4_000],
                ["tool", 12, "r12", 4_000],
            ];
            const rows = rowsFromTuples(tuples);
            const result = computeProtectionWindow(rows, floor);

            const expectedKeys = ["9:a", "9:b", "10:r10", "11:r11", "12:r12"];
            const expectedTagNumbers = [9, 10, 11, 12];

            assertOracleParity(result, expectedKeys, expectedTagNumbers, 9, 5, 32_000, rows);

            // Negative assertion: a partial tie group (either tied row present without the other) FAILS
            expect(result.memberRowKeys.has("9:a")).toBe(true);
            expect(result.memberRowKeys.has("9:b")).toBe(true);
            expect(result.status.protectedCount).toBe(5); // 5 rows, not 4!
            expect(result.tagNumberSet.tagNumbers.size).toBe(4); // 4 distinct tag numbers
        });

        it("#F5 invisible mass — edit_marker and dropped rows occupy mass; NULL token_count contributes 0", () => {
            const floor = 16_000;
            const rows: ProtectionWindowRow[] = [
                {
                    kind: "tool",
                    tag_number: 1,
                    row_identity: "r1",
                    token_count: 1_000,
                    status: "active",
                },
                {
                    kind: "tool",
                    tag_number: 2,
                    row_identity: "r2",
                    token_count: null,
                    status: "active",
                },
                {
                    kind: "tool",
                    tag_number: 3,
                    row_identity: "r3",
                    token_count: 2_000,
                    status: "dropped",
                },
                {
                    kind: "tool",
                    tag_number: 4,
                    row_identity: "r4",
                    token_count: 30_000,
                    status: "dropped",
                },
            ];

            const result = computeProtectionWindow(rows, floor);

            // Row 4 (edit_marker/dropped with 30,000) crosses floor alone -> mass_cutoff = 4.
            // Newest 3 tool tags are tags 4, 3, 2 -> newest3_cutoff = 2.
            // Cutoff = min(4, 2) = 2.
            // Member rows: tag 2 (NULL tokens -> 0 mass), tag 3 (dropped 2,000), tag 4 (dropped 30,000).
            expect(result.cutoff).toBe(2);
            expect(result.status.protectedCount).toBe(3);
            expect(result.status.protectedMass).toBe(32_000);
            expect(result.memberRowKeys).toEqual(new Set(["2:r2", "3:r3", "4:r4"]));
        });

        it("#F6 disjoint coordinate spaces — cutoff lives in tag-number space only", () => {
            const floor = 16_000;
            const tuples: FixtureRowTuple[] = [
                ["tool", 1, "r1", 4_000],
                ["tool", 7, "r7", 4_000],
                ["tool", 8, "r8", 4_000],
                ["tool", 9, "r9", 4_000],
                ["tool", 10, "r10", 4_000],
            ];
            const rows = rowsFromTuples(tuples);
            const result = computeProtectionWindow(rows, floor);

            // Cutoff in TAG-NUMBER space is 7
            expect(result.ordinalCutoff.coordinateSpace).toBe("tag-number");
            expect(result.ordinalCutoff.cutoff).toBe(7);

            // Row-identity set is the mandated form for consumers in external projection block space
            expect(result.rowIdentitySet.coordinateSpace).toBe("row-identity");
            expect(result.rowIdentitySet.rowIdentities).toEqual(new Set(["r7", "r8", "r9", "r10"]));

            // Negative assertion: comparing tag-number scalar 7 against block ordinals (70, 80, 90, 100)
            // would incorrectly select all blocks if interpreted as block ordinal <= 7.
            // The coordinateSpace tags enforce domain separation.
            expect(result.ordinalCutoff.coordinateSpace).not.toBe("row-identity");
        });

        it("#F7 minimum extends past the mass boundary with open invocation and boundary tie group", () => {
            const floor = 16_000;
            // Mass window covers only the newest tool tag (tag 12, mass 20,000).
            // Newest 3 tool tags reach older:
            // tag 11 is an OPEN invocation (0 / null tokens),
            // tag 10 is a tie group at the added boundary (10a and 10b).
            // Non-tool rows are interleaved.
            const rows: ProtectionWindowRow[] = [
                { kind: "tool", tag_number: 1, row_identity: "r1", token_count: 500 },
                { kind: "tool", tag_number: 10, row_identity: "10a", token_count: 500 },
                { kind: "tool", tag_number: 10, row_identity: "10b", token_count: 500 },
                { kind: "message", tag_number: 11, row_identity: "m1", token_count: 2_000 },
                { kind: "tool", tag_number: 11, row_identity: "11_open", token_count: null },
                { kind: "file", tag_number: 11, row_identity: "f1", token_count: 1_000 },
                { kind: "tool", tag_number: 12, row_identity: "12_mass", token_count: 20_000 },
            ];

            const result = computeProtectionWindow(rows, floor);

            // mass_cutoff = 12 (tag 12 alone crosses floor 16,000).
            // Tool tag numbers descending: 12, 11, 10, 1.
            // Newest 3 tool tags: 12, 11, 10 -> newest3_cutoff = 10.
            // Cutoff = min(12, 10) = 10 (< mass_cutoff).
            expect(result.cutoff).toBe(10);

            // Includes open invocation (11_open) and BOTH members of boundary tie group (10a, 10b).
            expect(result.memberRowKeys).toEqual(
                new Set(["10:10a", "10:10b", "11:11_open", "12:12_mass"]),
            );
            expect(result.status.protectedCount).toBe(4);
            expect(result.status.protectedMass).toBe(21_000);

            // Interleaved non-tool rows are NEVER members
            expect(result.isProtected(rows[3])).toBe(false); // message
            expect(result.isProtected(rows[5])).toBe(false); // file
        });

        it("#F8 empty window — zero tool rows yields cutoff: null and empty sets", () => {
            const floor = 16_000;

            // Variant (a): no tags at all
            const emptyResult = computeProtectionWindow([], floor);
            expect(emptyResult.cutoff).toBeNull();
            expect(emptyResult.memberRows).toEqual([]);
            expect(emptyResult.memberRowKeys.size).toBe(0);
            expect(emptyResult.tagNumberSet.tagNumbers.size).toBe(0);
            expect(emptyResult.rowIdentitySet.rowIdentities.size).toBe(0);
            expect(emptyResult.status).toEqual({
                floor: 16_000,
                protectedCount: 0,
                protectedMass: 0,
            });

            // Variant (b): 6 message/file tags, 0 tool tags
            const nonToolRows: ProtectionWindowRow[] = [
                { kind: "message", tag_number: 1, row_identity: "m1", token_count: 500 },
                { kind: "message", tag_number: 2, row_identity: "m2", token_count: 500 },
                { kind: "file", tag_number: 3, row_identity: "f1", token_count: 1_000 },
                { kind: "message", tag_number: 4, row_identity: "m3", token_count: 500 },
                { kind: "file", tag_number: 5, row_identity: "f2", token_count: 1_000 },
                { kind: "message", tag_number: 6, row_identity: "m4", token_count: 500 },
            ];
            const nonToolResult = computeProtectionWindow(nonToolRows, floor);
            expect(nonToolResult.cutoff).toBeNull();
            expect(nonToolResult.memberRows).toEqual([]);
            expect(nonToolResult.memberRowKeys.size).toBe(0);
            expect(nonToolResult.tagNumberSet.tagNumbers.size).toBe(0);
            expect(nonToolResult.rowIdentitySet.rowIdentities.size).toBe(0);
            expect(nonToolResult.status).toEqual({
                floor: 16_000,
                protectedCount: 0,
                protectedMass: 0,
            });

            // Negative assertions: cutoff is NEVER encoded as 0, -1, MAX_SAFE_INTEGER, or non-tool tag
            expect(nonToolResult.cutoff).not.toBe(0);
            expect(nonToolResult.cutoff).not.toBe(-1);
            expect(nonToolResult.cutoff).not.toBe(Number.MAX_SAFE_INTEGER);
            expect(nonToolResult.cutoff).not.toBe(1); // lowest non-tool tag_number
        });

        it("#F9 short history (degenerate minimum) — fewer than 3 tool tags", () => {
            const floor = 16_000;
            // Two tool rows with non-tool rows interleaved
            const rows: ProtectionWindowRow[] = [
                { kind: "message", tag_number: 1, row_identity: "m1", token_count: 100 },
                { kind: "tool", tag_number: 4, row_identity: "r1", token_count: 500 },
                { kind: "message", tag_number: 6, row_identity: "m2", token_count: 200 },
                { kind: "tool", tag_number: 9, row_identity: "r2", token_count: 500 },
                { kind: "file", tag_number: 11, row_identity: "f1", token_count: 300 },
            ];

            const result = computeProtectionWindow(rows, floor);
            // Mass walk exhausts at 1,000 < 16,000.
            // Minimum degenerates to min(3, 2) = 2 tool tags -> cutoff 4.
            expect(result.cutoff).toBe(4);
            expect(result.memberRowKeys).toEqual(new Set(["4:r1", "9:r2"]));
            expect(result.status.protectedCount).toBe(2);
            expect(result.status.protectedMass).toBe(1_000);

            // One-row variant
            const oneRow: ProtectionWindowRow[] = [
                { kind: "tool", tag_number: 4, row_identity: "r1", token_count: 500 },
            ];
            const oneResult = computeProtectionWindow(oneRow, floor);
            expect(oneResult.cutoff).toBe(4);
            expect(oneResult.status.protectedCount).toBe(1);
            expect(oneResult.status.protectedMass).toBe(500);
        });

        it("#F9S append-only growth SEQUENCE — monotonic widening under MAX-guarded append", () => {
            const floor = 16_000;

            // Step 0: no tool rows -> empty window state
            const step0 = computeProtectionWindow([], floor);
            expect(step0.cutoff).toBeNull();
            expect(step0.status).toEqual({ floor: 16_000, protectedCount: 0, protectedMass: 0 });

            // Step 1: append (tool, 4, r1, 500)
            const rowsStep1: ProtectionWindowRow[] = [
                { kind: "tool", tag_number: 4, row_identity: "r1", token_count: 500 },
            ];
            const step1 = computeProtectionWindow(rowsStep1, floor);
            expect(step1.cutoff).toBe(4);
            expect(step1.memberRowKeys).toEqual(new Set(["4:r1"]));
            expect(step1.status.protectedCount).toBe(1);
            expect(step1.status.protectedMass).toBe(500);

            // Step 2: append (tool, 9, r2, 500)
            const rowsStep2: ProtectionWindowRow[] = [
                ...rowsStep1,
                { kind: "tool", tag_number: 9, row_identity: "r2", token_count: 500 },
            ];
            const step2 = computeProtectionWindow(rowsStep2, floor);
            expect(step2.cutoff).toBe(4);
            expect(step2.memberRowKeys).toEqual(new Set(["4:r1", "9:r2"]));
            expect(step2.status.protectedCount).toBe(2);
            expect(step2.status.protectedMass).toBe(1_000);
            // Superset check
            expect(step2.memberRowKeys.isSupersetOf(step1.memberRowKeys)).toBe(true);

            // Step 3: append 18 further tool rows (tag 10..27, r3..r20, 250)
            const rowsStep3 = [...rowsStep2];
            for (let i = 10; i <= 27; i++) {
                rowsStep3.push({
                    kind: "tool",
                    tag_number: i,
                    row_identity: `r${i - 7}`,
                    token_count: 250,
                });
            }
            const step3 = computeProtectionWindow(rowsStep3, floor);
            // Cumulative mass = 1,000 + 18 * 250 = 5,500 < 16,000 -> all 20 rows protected, cutoff 4
            expect(step3.cutoff).toBe(4);
            expect(step3.status.protectedCount).toBe(20);
            expect(step3.status.protectedMass).toBe(5_500);
            expect(step3.memberRowKeys.isSupersetOf(step2.memberRowKeys)).toBe(true);
        });
    });

    describe("#given window mass unit", () => {
        it("#then window mass is COALESCE(token_count, 0) and input_token_count is excluded", () => {
            const floor = 16_000;
            // Row with input_token_count = 30,000 and token_count = 200.
            // If input tokens were included: 30,200 >= 16,000 -> would cross floor alone!
            // With output tokens only: 200 < 16,000 -> walk exhausts, protecting all rows.
            const rows: ProtectionWindowRow[] = [
                {
                    kind: "tool",
                    tag_number: 1,
                    row_identity: "r1",
                    token_count: 200,
                    input_token_count: 30_000,
                },
                {
                    kind: "tool",
                    tag_number: 2,
                    row_identity: "r2",
                    token_count: 200,
                    input_token_count: 0,
                },
                {
                    kind: "tool",
                    tag_number: 3,
                    row_identity: "r3",
                    token_count: 200,
                    input_token_count: 0,
                },
                {
                    kind: "tool",
                    tag_number: 4,
                    row_identity: "r4",
                    token_count: 200,
                    input_token_count: 0,
                },
            ];

            const result = computeProtectionWindow(rows, floor);
            // Walk exhausts with mass 800 < 16,000 -> all 4 rows protected, cutoff = 1
            expect(result.cutoff).toBe(1);
            expect(result.status.protectedCount).toBe(4);
            expect(result.status.protectedMass).toBe(800);

            // Verify helper directly
            expect(rowWindowMass(rows[0])).toBe(200);
            expect(rowWindowMass({ token_count: null, input_token_count: 50_000 })).toBe(0);
        });
    });

    describe("#given monotonicity within an epoch mutation cases (from F3)", () => {
        const floor = 16_000;

        function makeF3Rows(): ProtectionWindowRow[] {
            const rows: ProtectionWindowRow[] = [];
            for (let i = 1; i <= 10; i++) {
                rows.push({
                    kind: "tool",
                    tag_number: i,
                    row_identity: `r${i}`,
                    token_count: 4_000,
                });
            }
            return rows;
        }

        it("#case 1: guaranteed contraction — raise member newer than boundary row by enough to move crossing", () => {
            const rows = makeF3Rows();
            const before = computeProtectionWindow(rows, floor);
            expect(before.cutoff).toBe(7);
            expect(before.status.protectedCount).toBe(4);
            expect(before.status.protectedMass).toBe(16_000);

            // Row 10 raised 4,000 -> 8,000.
            // Rows 10 (8k), 9 (4k), 8 (4k) total 16,000 -> mass_cutoff moves 7 -> 8.
            // newest3_cutoff is 8 -> cutoff moves 7 -> 8.
            const mutated = rows.map((r) =>
                r.tag_number === 10 ? { ...r, token_count: 8_000 } : r,
            );
            const after = computeProtectionWindow(mutated, floor);

            expect(after.cutoff).toBe(8);
            expect(after.status.protectedCount).toBe(3);
            expect(after.status.protectedMass).toBe(16_000);
            expect(after.memberRowKeys).toEqual(new Set(["8:r8", "9:r9", "10:r10"]));
        });

        it("#case 2: small-newer-raise HOLD — raise member newer below threshold leaves cutoff unchanged", () => {
            const rows = makeF3Rows();
            // Row 10 goes 4,000 -> 4,001.
            // Rows 10, 9, 8 total 12,001 < 16,000 -> still needs row 7!
            const mutated = rows.map((r) =>
                r.tag_number === 10 ? { ...r, token_count: 4_001 } : r,
            );
            const after = computeProtectionWindow(mutated, floor);

            expect(after.cutoff).toBe(7);
            expect(after.status.protectedCount).toBe(4);
            expect(after.status.protectedMass).toBe(16_001);
            expect(after.memberRowKeys).toEqual(new Set(["7:r7", "8:r8", "9:r9", "10:r10"]));
        });

        it("#case 3: boundary-row HOLD — raise boundary row leaves cutoff unchanged", () => {
            const rows = makeF3Rows();
            // Row 7 goes 4,000 -> 8,000.
            // Rows 10, 9, 8 total 12,000 < 16,000 -> still must visit row 7 to reach floor.
            const mutated = rows.map((r) =>
                r.tag_number === 7 ? { ...r, token_count: 8_000 } : r,
            );
            const after = computeProtectionWindow(mutated, floor);

            expect(after.cutoff).toBe(7);
            expect(after.status.protectedCount).toBe(4);
            expect(after.status.protectedMass).toBe(20_000);
            expect(after.memberRowKeys).toEqual(new Set(["7:r7", "8:r8", "9:r9", "10:r10"]));
        });

        it("#case 4: non-member HOLD — raise row older than cutoff leaves cutoff AND protectedMass unchanged", () => {
            const rows = makeF3Rows();
            // Row 6 (not a member) goes 4,000 -> 8,000.
            const mutated = rows.map((r) =>
                r.tag_number === 6 ? { ...r, token_count: 8_000 } : r,
            );
            const after = computeProtectionWindow(mutated, floor);

            expect(after.cutoff).toBe(7);
            expect(after.status.protectedCount).toBe(4);
            // Mass is summed over member rows of resulting union only!
            expect(after.status.protectedMass).toBe(16_000);
            expect(after.memberRowKeys).toEqual(new Set(["7:r7", "8:r8", "9:r9", "10:r10"]));
        });

        it("#case 5: minimum-bounded HOLD — raise row 10 to 80,000 is bounded by newest-3 structural minimum", () => {
            const rows = makeF3Rows();
            // From contracted state {8, 9, 10}, raise row 10 to 80,000.
            // mass_cutoff moves to 10, but newest3_cutoff is 8.
            // Effective cutoff min(mass_cutoff, newest3_cutoff) stays 8!
            const mutated = rows.map((r) =>
                r.tag_number === 10 ? { ...r, token_count: 80_000 } : r,
            );
            const after = computeProtectionWindow(mutated, floor);

            expect(after.cutoff).toBe(8);
            expect(after.status.protectedCount).toBe(3);
            expect(after.status.protectedMass).toBe(88_000);
            expect(after.memberRowKeys).toEqual(new Set(["8:r8", "9:r9", "10:r10"]));
        });

        it("#case 6: NULL-backfill case (F3N) and never-re-expand MAX-guard rejection", () => {
            // NULL-backfill fixture: identical to exact equality except row 9 has token_count NULL
            const f3nRows = makeF3Rows().map((r) =>
                r.tag_number === 9 ? { ...r, token_count: null } : r,
            );
            const beforeBackfill = computeProtectionWindow(f3nRows, floor);
            // Walk: row 10 (4k), row 9 (0), row 8 (4k, sum 8k), row 7 (4k, sum 12k), row 6 (4k, sum 16k -> stop)
            // Cutoff is 6, protected {6, 7, 8, 9, 10}, protectedCount 5, protectedMass 16,000
            expect(beforeBackfill.cutoff).toBe(6);
            expect(beforeBackfill.status.protectedCount).toBe(5);
            expect(beforeBackfill.status.protectedMass).toBe(16_000);
            expect(beforeBackfill.memberRowKeys).toEqual(
                new Set(["6:r6", "7:r7", "8:r8", "9:r9", "10:r10"]),
            );

            // Backfill row 9 to 4,000 -> contracts cutoff 6 -> 7
            const afterBackfill = computeProtectionWindow(
                f3nRows.map((r) => (r.tag_number === 9 ? { ...r, token_count: 4_000 } : r)),
                floor,
            );
            expect(afterBackfill.cutoff).toBe(7);
            expect(afterBackfill.status.protectedCount).toBe(4);
            expect(afterBackfill.status.protectedMass).toBe(16_000);
            expect(afterBackfill.memberRowKeys).toEqual(
                new Set(["7:r7", "8:r8", "9:r9", "10:r10"]),
            );
        });
    });

    describe("#given database integration and epoch floor snapshot read", () => {
        function makeDb(): Database {
            const db = new Database(":memory:");
            db.exec(`
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    message_id TEXT,
                    type TEXT,
                    status TEXT DEFAULT 'active',
                    drop_mode TEXT DEFAULT 'full',
                    tool_name TEXT,
                    input_byte_size INTEGER DEFAULT 0,
                    byte_size INTEGER,
                    tag_number INTEGER NOT NULL,
                    reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
                    caveman_depth INTEGER NOT NULL DEFAULT 0,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    tool_owner_message_id TEXT DEFAULT NULL,
                    entry_fingerprint TEXT,
                    token_count INTEGER,
                    input_token_count INTEGER,
                    reasoning_token_count INTEGER,
                    UNIQUE(session_id, id)
                );
                CREATE TABLE IF NOT EXISTS session_meta (
                    session_id TEXT PRIMARY KEY,
                    protected_tokens_effective INTEGER
                );
            `);
            return db;
        }

        it("#when reading epoch floor snapshot #then reads stored value and never recomputes", () => {
            const db = makeDb();
            db.prepare(
                "INSERT INTO session_meta (session_id, protected_tokens_effective) VALUES (?, ?)",
            ).run("ses-1", 32_000);

            const floor = readEpochFloorSnapshot(db, "ses-1");
            expect(floor).toBe(32_000);
        });

        it("#when computing protection window for session #then reads persisted tool rows", () => {
            const db = makeDb();
            const sessionId = "ses-test";
            db.prepare(
                "INSERT INTO session_meta (session_id, protected_tokens_effective) VALUES (?, ?)",
            ).run(sessionId, 16_000);

            for (let i = 1; i <= 10; i++) {
                insertTag(db, sessionId, `call-${i}`, "tool", 100, i, 0, "read", 50, null, null, {
                    tokenCount: 4_000,
                    inputTokenCount: 0,
                    reasoningTokenCount: 0,
                });
            }

            const result = getProtectionWindowForSession(db, sessionId);
            expect(result.cutoff).toBe(7);
            expect(result.status.protectedCount).toBe(4);
            expect(result.status.protectedMass).toBe(16_000);

            // Test downward update rejection via MAX-guard in database
            updateTagTokenCount(db, sessionId, 9, 1_000);
            // Stored value remains 4,000 -> window unchanged!
            const resultAfterDownward = getProtectionWindowForSession(db, sessionId);
            expect(resultAfterDownward.cutoff).toBe(7);
            expect(resultAfterDownward.status.protectedCount).toBe(4);
            expect(resultAfterDownward.status.protectedMass).toBe(16_000);
        });
    });
});
