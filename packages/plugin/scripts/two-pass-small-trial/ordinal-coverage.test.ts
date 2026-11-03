import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    readSessionChunk,
    withRawMessageProvider,
} from "../../src/hooks/magic-context/read-session-chunk";
import {
    type OrdinalCoverageProjection,
    ordinalCoverageProblems,
    projectOrdinalCoverage,
} from "./ordinal-coverage";

test("ordinal coverage detects missing, overlapping, extra and mislabelled ranges", () => {
    const project = (lines: string, header = "1-3") =>
        projectOrdinalCoverage(0, [1, 2, 3], `Messages ${header}:\n\n${lines}`);
    expect(ordinalCoverageProblems(project("[1-2] A: first\n[3] U: second"))).toEqual([]);
    expect(ordinalCoverageProblems(project("[1] A: first\n[3] U: second"))).toContain(
        "missing expected ordinals: 2",
    );
    expect(ordinalCoverageProblems(project("[1-2] A: first\n[2-3] U: second"))).toContain(
        "overlapping ordinals: 2",
    );
    expect(ordinalCoverageProblems(project("[1-4] A: first"))).toContain(
        "range 1-4 includes unexpected ordinals",
    );
    expect(ordinalCoverageProblems(project("[1-3] A: first", "2-3"))).toContain(
        "header 2-3 differs from displayed bounds 1-3",
    );
});

test("two-pass hidden ordinals attach to preceding text, with leading noise on the first line", () => {
    const messages = [1, 2, 3, 4, 5, 6].map((ordinal) => ({
        id: `coverage-${ordinal}`,
        ordinal,
        role: ordinal === 2 || ordinal === 4 || ordinal === 5 ? "assistant" : "user",
        parts:
            ordinal === 4
                ? []
                : [
                      {
                          type: "text",
                          text:
                              ordinal === 2
                                  ? "First visible message."
                                  : ordinal === 5
                                    ? "Second visible message."
                                    : "<system-reminder>Background status.</system-reminder>",
                      },
                  ],
    }));
    const chunk = (singleMessageLines: boolean, tokenBudget = 10000) =>
        withRawMessageProvider(
            "coverage",
            { readMessages: () => messages, getMessageCount: () => 6 },
            () => readSessionChunk("coverage", tokenBudget, 1, 7, { singleMessageLines }),
        );
    const result = chunk(true);
    expect(result.text).toBe("[1-4] A: First visible message.\n[5-6] A: Second visible message.");
    expect(result.printedBlocks?.map((block) => [block.startOrdinal, block.endOrdinal])).toEqual([
        [1, 4],
        [5, 6],
    ]);
    expect(result.lines.map((line) => line.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.messageCount).toBe(6);
    expect(result.printedBlocks?.map((block) => block.textEnd)).toEqual([
        result.text.indexOf("\n"),
        result.text.length,
    ]);
    expect(
        ordinalCoverageProblems(
            projectOrdinalCoverage(
                0,
                [1, 2, 3, 4, 5, 6],
                `Messages ${result.startIndex}-${result.endIndex}:\n\n${result.text}`,
            ),
        ),
    ).toEqual([]);
    expect(chunk(false).text).toBe("[1-5] A: First visible message. / Second visible message.");
    const capped = chunk(true, 1);
    expect(capped.text).toBe("[1-4] A: First visible message.");
    expect(capped.lines.map((line) => line.ordinal)).toEqual([1, 2, 3, 4]);
    expect(capped.endIndex).toBe(4);
    expect(capped.hasMore).toBe(true);
});

test("widened two-pass ranges keep tool-preview offsets and metadata aligned", () => {
    const messages = [
        {
            id: "notice-before",
            ordinal: 1,
            role: "user",
            parts: [{ type: "text", text: "<system-reminder>Status.</system-reminder>" }],
        },
        {
            id: "tool",
            ordinal: 2,
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "coverage-tool",
                    state: {
                        status: "completed",
                        input: { command: "echo probe" },
                        title: "Probe command",
                        output: "body ".repeat(200),
                    },
                },
            ],
        },
        {
            id: "notice-after",
            ordinal: 3,
            role: "user",
            parts: [{ type: "text", text: "<system-reminder>Status.</system-reminder>" }],
        },
    ];
    const result = withRawMessageProvider(
        "tool-coverage",
        { readMessages: () => messages, getMessageCount: () => 3 },
        () => readSessionChunk("tool-coverage", 10000, 1, 4, { singleMessageLines: true }),
    );
    expect(result.text.startsWith("[1-3] A: TC:")).toBe(true);
    expect(result.toolResultBoundaries).toHaveLength(1);
    expect(result.toolResultBoundaries?.[0]?.ordinal).toBe(2);
    expect(result.toolResultBoundaries?.[0]?.sourceOffset).toBe(result.text.indexOf("TC:"));
    expect(result.printedBlocks?.[0]?.textEnd).toBe(result.text.length);
});

const projectionPath = process.env.TWO_PASS_COVERAGE_PROJECTION;
test.skipIf(!projectionPath)("all five real rendered inputs have exact ordinal coverage", () => {
    if (!projectionPath) throw new Error("coverage_projection_required");
    const projections = JSON.parse(
        readFileSync(projectionPath, "utf8"),
    ) as OrdinalCoverageProjection[];
    expect(projections.map((input) => input.caseId)).toEqual([0, 8, 10, 12, 35]);
    const issues = projections.flatMap((input) =>
        ordinalCoverageProblems(input).map((issue) => `case ${input.caseId}: ${issue}`),
    );
    for (const input of projections)
        console.log(
            `case=${input.caseId} expected=${input.expectedOrdinals.length} displayed=${input.ranges.length} header=${input.header?.start}-${input.header?.end} problems=${ordinalCoverageProblems(input).length}`,
        );
    expect(issues).toEqual([]);
});
