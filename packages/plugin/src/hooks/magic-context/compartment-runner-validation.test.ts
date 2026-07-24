import { describe, expect, test } from "bun:test";
import {
    buildHistorianFailureNotice,
    buildHistorianRepairPrompt,
    HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
    shouldDiscardLastHistorianCompartment,
    validateHistorianOutput,
} from "./compartment-runner-validation";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";

describe("buildHistorianFailureNotice", () => {
    test("frames a low failure count as transient + reassuring (no alarm, no action ask)", () => {
        const notice = buildHistorianFailureNotice(1, "Historian returned no assistant output.");
        expect(notice.toLowerCase()).toContain("transient");
        expect(notice.toLowerCase()).toContain("retry automatically");
        // Must NOT alarm the user or ask them to act on a single transient blip.
        expect(notice).not.toContain("magic-context.jsonc");
        expect(notice).not.toContain("needs attention");
        // The raw error is internal noise for the transient case — not surfaced.
        expect(notice).not.toContain("no assistant output");
    });

    test("escalates at the persistent threshold with the actionable next step + last error", () => {
        const notice = buildHistorianFailureNotice(
            HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
            "ProviderModelNotFoundError: historian-model",
        );
        expect(notice).toContain("needs attention");
        expect(notice).toContain("magic-context.jsonc");
        expect(notice).toContain(String(HISTORIAN_PERSISTENT_FAILURE_THRESHOLD));
        // The persistent case surfaces the real error so the user can diagnose.
        expect(notice).toContain("ProviderModelNotFoundError");
        // Still reassures that the conversation keeps working.
        expect(notice.toLowerCase()).toContain("keeps working");
    });
});

describe("buildHistorianRepairPrompt", () => {
    test("appends the language directive last when configured", () => {
        const prompt = buildHistorianRepairPrompt("base", "<bad />", "bad xml", "tr");
        expect(prompt).toContain("Your previous XML response was invalid");
        expect(
            prompt.trim().endsWith("write the surrounding summary prose in Turkish (Türkçe)."),
        ).toBe(true);
    });
});

/**
 * Gap healing is intentionally proof-based: only a range classified as tool-only by
 * the chunk reader can be absorbed. An unclassified gap may contain narrative and must
 * reject so the runner can re-read it without advancing the durable boundary.
 */

/** Build a minimal valid historian XML output from compartment specs. */
function buildXml(
    compartments: Array<{ start: number; end: number; title?: string }>,
    unprocessedFrom: number | null = null,
): string {
    const blocks = compartments.map(
        (c) =>
            `<compartment start="${c.start}" end="${c.end}" title="${c.title ?? "t"}"><p1>summary</p1></compartment>`,
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
    completedToolArcs: Array<{ start: number; end: number }> = [],
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
        completedToolArcs,
    };
}

describe("healCompartmentGaps via validateHistorianOutput", () => {
    describe("tool-only gap healing (any size)", () => {
        test("heals a 20-message tool-only gap", () => {
            const xml = buildXml([
                { start: 1, end: 10, title: "work A" },
                { start: 31, end: 40, title: "work B" },
            ]);
            const chunk = buildChunk(1, 40, [{ start: 11, end: 30 }]);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0].endMessage).toBe(30);
                expect(result.compartments[1].startMessage).toBe(31);
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

    describe("non-tool-only gaps reject at every size", () => {
        test("rejects a 5-message narrative gap", () => {
            const xml = buildXml([
                { start: 1, end: 10, title: "work A" },
                { start: 16, end: 20, title: "work B" },
            ]);
            const chunk = buildChunk(1, 20, []);
            const result = validateHistorianOutput(xml, "ses-test", chunk, [], 0);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain("gap");
            }
        });

        test("rejects a gap only partially covered by a tool-only range", () => {
            // Partial overlap cannot prove that the remaining messages are safe to absorb.
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

describe("completed tool arc terminal boundaries", () => {
    test("heals the terminal compartment through a result inside the chunk", () => {
        const chunk = buildChunk(98, 128, [], [{ start: 123, end: 124 }]);
        const result = validateHistorianOutput(
            buildXml([{ start: 98, end: 123 }], 124),
            "ses-heal-arc",
            chunk,
            [],
            0,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.compartments[0]).toMatchObject({
                endMessage: 124,
                endMessageId: "msg-124",
            });
        }
    });

    test("rejects the exact Rust error when the completed result is beyond the chunk", () => {
        const chunk = buildChunk(1, 2, [], [{ start: 2, end: 3 }]);
        const result = validateHistorianOutput(
            buildXml([{ start: 1, end: 2 }], 3),
            "ses-reject-arc",
            chunk,
            [],
            0,
        );

        expect(result).toEqual({
            ok: false,
            error: "Historian terminal boundary splits a completed tool invocation/result arc",
        });
    });

    test("derives the real adjacent invocation/result shape and heals a boundary proposed at the invocation", () => {
        const sessionId = "ses-real-tool-arc-shape";
        const messages = [
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "Inspect the file." }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "call-1",
                        state: { input: { path: "src/index.ts" } },
                    },
                ],
            },
            {
                ordinal: 3,
                id: "m3",
                role: "user",
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "call-1",
                        state: { output: "file contents" },
                    },
                ],
            },
        ];
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => messages,
            getMessageCount: () => messages.length,
        });
        try {
            const chunk = readSessionChunk(sessionId, 10_000, 1);
            expect(chunk.completedToolArcs).toEqual([{ start: 2, end: 3 }]);

            const result = validateHistorianOutput(
                buildXml([{ start: 1, end: 2 }], 3),
                sessionId,
                chunk,
                [],
                0,
            );
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.compartments[0]).toMatchObject({
                    endMessage: 3,
                    endMessageId: "m3",
                });
            }
        } finally {
            unregister();
        }
    });
});

describe("discard-last completed tool arc guard", () => {
    test("keeps k=1, allows an ordinary k=2 discard, and blocks a split-reopening discard", () => {
        expect(
            shouldDiscardLastHistorianCompartment([{ endMessage: 4 }], {
                endIndex: 4,
                completedToolArcs: [],
            }),
        ).toBe(false);
        expect(
            shouldDiscardLastHistorianCompartment([{ endMessage: 2 }, { endMessage: 4 }], {
                endIndex: 4,
                completedToolArcs: [],
            }),
        ).toBe(true);
        expect(
            shouldDiscardLastHistorianCompartment([{ endMessage: 123 }, { endMessage: 128 }], {
                endIndex: 128,
                completedToolArcs: [{ start: 123, end: 124 }],
            }),
        ).toBe(false);
    });
});

describe("tiered historian output validation", () => {
    test("rejects flat v1 compartments with actionable tier feedback", () => {
        const flatXml = `<output><compartment start="1" end="2" title="flat">flat summary</compartment></output>`;

        const result = validateHistorianOutput(flatXml, "ses-test", buildChunk(1, 2), [], 0);

        expect(result).toEqual({
            ok: false,
            error: expect.stringContaining(
                "compartment 1 is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers",
            ),
        });
    });

    test("accepts P1-only output by filling the softer missing tiers", () => {
        const p1OnlyXml = `<output><compartment start="1" end="2" title="partial"><p1>full summary</p1></compartment></output>`;

        const result = validateHistorianOutput(p1OnlyXml, "ses-test", buildChunk(1, 2), [], 0);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.compartments[0]).toMatchObject({
                p1: "full summary",
                p2: "full summary",
                p3: "full summary",
                p4: "",
            });
        }
    });

    test("accepts a mismatched-close compartment (issue #246) that strict parsing stranded as tierless", () => {
        // The lenient parser runs FIRST: <p1> closed by </p2> now yields a real
        // p1, so validation passes (legacy=0 path) instead of retrying forever.
        const mangledXml = `<output><compartment start="1" end="2" title="mangled" importance="55"><p1>\nfull narrative\n</p2>\n<p2>condensed</p2><p3>outcome</p3><p4/></compartment></output>`;

        const result = validateHistorianOutput(mangledXml, "ses-test", buildChunk(1, 2), [], 0);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.compartments[0]).toMatchObject({
                p1: "full narrative",
                p2: "condensed",
                p3: "outcome",
                p4: "",
            });
        }
    });
});

describe("validateHistorianOutput primer candidate contract", () => {
    test("keeps at most one primer candidate per historian pass", () => {
        const xml = `
<output>
<compartments>
<compartment start="1" end="2" title="cache" episode_type="debug" importance="50">
<p1>Cache work.</p1><p2>Cache.</p2><p3>Cache.</p3><p4>cache</p4>
</compartment>
</compartments>
<primer_candidates>
<primer at_compartment="1">How does the cache materialization flow work?</primer>
<primer at_compartment="1">How does ctx_search combine result types?</primer>
</primer_candidates>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;

        const result = validateHistorianOutput(xml, "ses-test", buildChunk(1, 2), [], 0);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.primerCandidates?.map((candidate) => candidate.question)).toEqual([
                "How does the cache materialization flow work?",
            ]);
        }
    });
});

describe("validateHistorianOutput — skillObservations", () => {
    test("validated pass surfaces skillObservations when present", () => {
        const xml = `<output>
<compartments>
<compartment start="1" end="2" title="t"><p1>summary</p1></compartment>
</compartments>
<skill_observations>
* council | gotcha | use a fast aggregator
</skill_observations>
<meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta>
</output>`;
        const result = validateHistorianOutput(xml, "ses-test", buildChunk(1, 2), [], 0);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.skillObservations).toEqual([
                { skillId: "council", kind: "gotcha", lesson: "use a fast aggregator" },
            ]);
        }
    });
});
