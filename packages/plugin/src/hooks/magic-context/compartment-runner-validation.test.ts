import { describe, expect, test } from "bun:test";
import { validateHistorianOutput } from "./compartment-runner-validation";

/**
 * Regression tests for the "gap before message X (expected Y)" failure mode
 * caused by historian skipping tool-only blocks.
 *
 * Root cause: `read-session-chunk.ts` compacts consecutive tool-only assistant turns
 * into one visible block (e.g., `[12223-12238] A: TC: bash / TC: read / ...`).
 * Historian often classifies such blocks as pure noise and skips them entirely,
 * creating a gap between compartments. The old heal window of 15 messages was
 * undersized — real debug/build-test tool chains commonly span 16–30+ messages.
 *
 * Fix: chunk exposes `toolOnlyRanges` and validator heals gaps of any size that
 * fall fully within one of those ranges. Gaps outside tool-only ranges still heal
 * only up to the 15-message safety net.
 */

/** Build a minimal valid historian XML output from compartment specs. */
function buildXml(
    compartments: Array<{ start: number; end: number; title?: string }>,
    unprocessedFrom: number | null = null,
): string {
    const blocks = compartments.map(
        (c) =>
            `<compartment start="${c.start}" end="${c.end}" title="${c.title ?? "t"}">summary</compartment>`,
    );
    const inner = blocks.join("\n");
    const meta =
        unprocessedFrom !== null ? `<unprocessed_from>${unprocessedFrom}</unprocessed_from>` : "";
    return `<output>\n${inner}\n${meta}\n</output>`;
}

/** Minimal chunk stub with ordinal metadata. */
function buildChunk(
    startIndex: number,
    endIndex: number,
    toolOnlyRanges: Array<{ start: number; end: number }> = [],
) {
    const lines: Array<{ ordinal: number; messageId: string }> = [];
    for (let i = startIndex; i <= endIndex; i++) {
        lines.push({ ordinal: i, messageId: `msg-${i}` });
    }
    return {
        startIndex,
        endIndex,
        lines,
        toolOnlyRanges,
    };
}

describe("healCompartmentGaps via validateHistorianOutput", () => {
    describe("tool-only gap healing (any size)", () => {
        test("heals 16-message tool-only gap (the original bug — one over old 15-msg limit)", () => {
            // Historian skipped messages 12223-12238 because they were all tool calls.
            // Chunk marks that range as tool-only. Heal should absorb it even though > 15.
            const xml = buildXml([
                { start: 11323, end: 12222, title: "work A" },
                { start: 12239, end: 12498, title: "work B" },
            ]);
            const chunk = buildChunk(11323, 12498, [{ start: 12223, end: 12238 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                // Previous compartment extended to absorb the gap
                expect(result.compartments[0].endMessage).toBe(12238);
                expect(result.compartments[1].startMessage).toBe(12239);
            }
        });

        test("heals 50-message tool-only gap (long debug-loop chain)", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 151, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, [{ start: 101, end: 150 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0].endMessage).toBe(150);
            }
        });

        test("heals 200-message tool-only gap (extreme autonomous loop)", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 301, end: 400, title: "work B" },
            ]);
            const chunk = buildChunk(1, 400, [{ start: 101, end: 300 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0].endMessage).toBe(300);
            }
        });
    });

    describe("non-tool-only gaps still fail when larger than safety net", () => {
        test("rejects 16-msg narrative gap (historian dropped real content)", () => {
            // No tool-only range covers the gap — historian skipped user/assistant text.
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 117, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain("gap");
            }
        });

        test("rejects 16-msg gap partially covered by tool-only range", () => {
            // Gap spans 101-116 (16 msgs); tool-only covers only 101-108. Partial overlap means
            // real narrative content (109-116) was dropped too.
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 117, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, [{ start: 101, end: 108 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain("gap");
            }
        });

        test("rejects 30-msg gap with no tool-only coverage", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 131, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(false);
        });
    });

    describe("safety net still heals small non-tool-only gaps", () => {
        test("heals 5-msg gap outside any tool-only range (boundary noise)", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 106, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0].endMessage).toBe(105);
            }
        });

        test("heals exactly 15-msg gap outside any tool-only range (safety net boundary)", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 116, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
        });
    });

    describe("no-gap cases stay valid", () => {
        test("contiguous compartments pass without any healing", () => {
            const xml = buildXml([
                { start: 1, end: 100, title: "work A" },
                { start: 101, end: 200, title: "work B" },
            ]);
            const chunk = buildChunk(1, 200, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0].endMessage).toBe(100);
                expect(result.compartments[1].startMessage).toBe(101);
            }
        });

        test("single compartment covering full chunk passes", () => {
            const xml = buildXml([{ start: 1, end: 200, title: "single" }]);
            const chunk = buildChunk(1, 200, [{ start: 50, end: 100 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
        });
    });
});
