import { describe, expect, test } from "bun:test";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import {
    buildHistorianFailureNotice,
    buildHistorianRepairPrompt,
    HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
    shouldDiscardLastHistorianCompartment,
    validateHistorianOutput,
} from "./compartment-runner-validation";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";

test("issue 774: split compartments retain only their own raw commit hashes at every tier", () => {
    const sessionId = "ses-hash-provenance";
    const later = "402da536440123456789abcdef0123456789abcd";
    expect(later).toHaveLength(40);
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [
            {
                id: "m1",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "Review the fix." }],
            },
            {
                id: "m2",
                ordinal: 2,
                role: "assistant",
                parts: [{ type: "text", text: "Committed\nd3714d6a9b." }],
            },
            {
                id: "m3",
                ordinal: 3,
                role: "assistant",
                parts: [{ type: "text", text: `Committed ${later}.` }],
            },
            { id: "m4", ordinal: 4, role: "user", parts: [{ type: "text", text: "Accepted." }] },
        ],
    });
    try {
        const chunk = readSessionChunk(sessionId, 10_000, 1);
        const xml = `<output>
<compartment start="1" end="2" title="fix ${later}"><p1>Committed \`d3714d6a9b\`; later \`${later}\`; typo \`d3714a6a9b\`.</p1><p2>Own D3714D6A9B; later ${later}.</p2><p3>Own d3714d6; later ${later}.</p3><p4>fix ${later}</p4></compartment>
<compartment start="3" end="4" title="later ${later}"><p1>Committed \`${later}\`.</p1><p2>${later}</p2><p3>${later}</p3><p4>${later}</p4></compartment>
</output>`;
        const result = validateHistorianOutput(xml, sessionId, chunk, [], 0);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.compartments[0]).toMatchObject({
            title: "fix ",
            content: "Committed `d3714d6a9b`; later ; typo .",
            p1: "Committed `d3714d6a9b`; later ; typo .",
            p2: "Own D3714D6A9B; later .",
            p3: "Own d3714d6; later .",
            p4: "fix ",
        });
        expect(result.compartments[1]).toMatchObject({
            title: `later ${later}`,
            content: `Committed \`${later}\`.`,
            p1: `Committed \`${later}\`.`,
            p2: later,
            p3: later,
            p4: later,
        });
    } finally {
        unregister();
    }
});

test("issue 774: validation leaves text without hashes byte-identical", () => {
    const xml = `<output><compartment start="1" end="2" title="ordinary prose"><p1>U: Keep 128.68 s.\nA: Done; no hashes.</p1><p2>Keep 128.68 s.</p2><p3>Done.</p3><p4/></compartment></output>`;
    const result = validateHistorianOutput(xml, "ses-plain", buildChunk(1, 2), [], 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.compartments[0]).toMatchObject({
            title: "ordinary prose",
            content: "U: Keep 128.68 s.\nA: Done; no hashes.",
            p1: "U: Keep 128.68 s.\nA: Done; no hashes.",
            p2: "Keep 128.68 s.",
            p3: "Done.",
            p4: "",
        });
    }
});

describe("buildHistorianFailureNotice", () => {
    test("renders the stable historian code without raw transient detail", () => {
        const raw = "Historian returned no assistant output.";
        const notice = buildHistorianFailureNotice(1, raw);
        expect(notice).toContain("History compression could not finish this turn.");
        expect(notice).toContain("retry automatically");
        expect(notice).toContain("(MC-H01)");
        expect(notice).not.toContain(raw);
    });

    test("keeps persistent provider detail behind the same stable reference", () => {
        const raw = "ProviderModelNotFoundError: historian-model";
        const notice = buildHistorianFailureNotice(HISTORIAN_PERSISTENT_FAILURE_THRESHOLD, raw);
        expect(notice).toContain("History compression");
        expect(notice).toContain("(MC-H01)");
        expect(notice).not.toContain(raw);
        expect(notice).not.toContain(String(HISTORIAN_PERSISTENT_FAILURE_THRESHOLD));
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

    test("includes the full-coverage completion boundary rule", () => {
        expect(buildHistorianRepairPrompt("base", "<bad />", "bad xml")).toContain(
            "If every message in the chunk is covered by a compartment, nothing is unprocessed: set `<unprocessed_from>` to the chunk's last message index + 1.",
        );
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

/**
 * The historian prompt must say what `<unprocessed_from>` holds when nothing is
 * left unprocessed; otherwise small models guess `0` or the last index and an
 * otherwise complete chunk fails validation. The prompt prescribes chunk end + 1,
 * so that exact value must validate, while a chunk that leaves a trailing suffix
 * uncovered must still name that suffix's first message.
 */
describe("<unprocessed_from> completion boundary", () => {
    const FULLY_COVERED_RULE =
        "If every message in the chunk is covered by a compartment, nothing is unprocessed: set `<unprocessed_from>` to the chunk's last message index + 1.";

    test("the historian prompt prescribes chunk end + 1 for a fully covered chunk", () => {
        expect(COMPARTMENT_AGENT_SYSTEM_PROMPT).toContain(FULLY_COVERED_RULE);
    });

    test("a fully covered chunk validates with chunk end + 1", () => {
        const xml = buildXml(
            [
                { start: 54353, end: 54428, title: "work A" },
                { start: 54429, end: 54431, title: "work B" },
            ],
            54432,
        );
        const result = validateHistorianOutput(xml, "ses-test", buildChunk(54353, 54431), [], 0);
        expect(result.ok).toBe(true);
    });

    test("a fully covered chunk rejects 0 and the last index", () => {
        const chunk = buildChunk(1, 10);
        const zero = validateHistorianOutput(
            buildXml([{ start: 1, end: 10 }], 0),
            "ses-test",
            chunk,
            [],
            0,
        );
        expect(zero.ok).toBe(false);
        if (!zero.ok) expect(zero.error).toContain("<unprocessed_from> 0 is outside chunk 1-10");

        const last = validateHistorianOutput(
            buildXml([{ start: 1, end: 10 }], 10),
            "ses-test",
            chunk,
            [],
            0,
        );
        expect(last.ok).toBe(false);
        if (!last.ok) {
            expect(last.error).toContain(
                "<unprocessed_from> 10 does not match completed chunk boundary 11",
            );
        }
    });

    test("an uncovered tail still requires its first message as the boundary", () => {
        const chunk = buildChunk(1, 10);
        const correct = validateHistorianOutput(
            buildXml([{ start: 1, end: 6 }], 7),
            "ses-test",
            chunk,
            [],
            0,
        );
        expect(correct.ok).toBe(true);

        const claimsComplete = validateHistorianOutput(
            buildXml([{ start: 1, end: 6 }], 11),
            "ses-test",
            chunk,
            [],
            0,
        );
        expect(claimsComplete.ok).toBe(false);
        if (!claimsComplete.ok) {
            expect(claimsComplete.error).toContain(
                "<unprocessed_from> 11 does not match next uncovered message 7",
            );
        }
    });

    test("preserves the six synthetic chunk 1902-1938 boundary cases", () => {
        const cases = [
            { label: "full chunk with no marker", end: 1938, marker: null, ok: true },
            { label: "full chunk with next ordinal", end: 1938, marker: 1939, ok: true },
            { label: "full chunk with last ordinal", end: 1938, marker: 1938, ok: false },
            { label: "full chunk with chunk start", end: 1938, marker: 1902, ok: false },
            {
                label: "partial chunk with next uncovered ordinal",
                end: 1910,
                marker: 1911,
                ok: true,
            },
            { label: "partial chunk with no marker", end: 1910, marker: null, ok: false },
        ] as const;
        const chunk = buildChunk(1902, 1938);

        for (const boundary of cases) {
            const result = validateHistorianOutput(
                buildXml([{ start: 1902, end: boundary.end }], boundary.marker),
                "ses-test",
                chunk,
                [],
                0,
            );
            expect(result.ok, boundary.label).toBe(boundary.ok);
        }
    });
});
