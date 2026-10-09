import { describe, expect, test } from "bun:test";
import type { StatusDetail } from "./rpc-types";
import {
    buildStatusView,
    distributeBarWidths,
    STATUS_COLUMN_GAP,
    type StatusViewSource,
    statusColumnsFor,
    statusSectionWidth,
} from "./status-view";
import { checkStatusViewSource } from "./status-view-check";

const NOW = 1_730_000_000_000;

/**
 * A snapshot with every optional block present, so a row that disappears from
 * the view shows up as a failure here rather than as an empty section.
 */
const SOURCE: StatusViewSource = {
    usagePercentage: 71.4,
    inputTokens: 623_000,
    contextLimit: 872_000,
    executeThreshold: 75,
    executeThresholdClamped: false,
    windowGeometry: {
        usableSoft: 872_000,
        usableHard: 900_000,
        geometry: "shared_upfront",
        derivation: {
            window: 904_000,
            reserve: 32_000,
            reserveSource: "output_catalog",
            geometry: "shared_upfront",
            windowSource: "catalog",
            absoluteWall: 904_000,
        },
    },
    tailHygiene: {
        u: 14_400,
        t: 48_000,
        severity: 0.3,
        evaluable: true,
        reclaimableToolOutputCount: 3,
    },
    systemPromptTokens: 12_000,
    docsTokens: 4_000,
    compartmentTokens: 80_000,
    compartmentCount: 12,
    factTokens: 0,
    memoryTokens: 6_000,
    memoryBlockCount: 3,
    profileTokens: 1_000,
    conversationTokens: 400_000,
    toolCallTokens: 100_000,
    toolDefinitionTokens: 20_000,
    activeTags: 4,
    droppedTags: 1,
    totalTags: 5,
    activeBytes: 48_000,
    lastNudgeTokens: 512_000,
    pendingOpsCount: 2,
    protectedTagCount: 3,
    isSubagent: false,
    cacheTtl: "1h",
    cacheTtlSource: "config",
    cacheTtlModelKey: "anthropic/claude-opus-5",
    lastResponseTime: NOW - 42_000,
    cacheRemainingMs: 252_000,
    cacheExpired: false,
    historyBlockTokens: 80_000,
    compressionBudget: 120_000,
    compressionUsage: "66%",
    lastDreamerRunAt: NOW - 3 * 3_600_000,
    memoryCount: 8,
    sessionNoteCount: 2,
    readySmartNoteCount: 1,
    configParseFailures: [],
    warnings: [],
};

function view(overrides: Partial<StatusViewSource> = {}) {
    // buildStatusView only accepts a checked snapshot; a fixture the check
    // rejects is a broken fixture, so say which fields rather than draw nothing.
    const checked = checkStatusViewSource({ ...SOURCE, ...overrides });
    if (!checked.ok) throw new Error(`fixture rejected: ${checked.fields.join(", ")}`);
    return buildStatusView(checked.source, { version: "1.2.3", now: NOW });
}

function rowLabels(sectionTitle: string, overrides: Partial<StatusViewSource> = {}): string[] {
    const section = view(overrides).sections.find((entry) => entry.title === sectionTitle);
    if (!section) throw new Error(`missing section: ${sectionTitle}`);
    return section.rows.map((row) => row.label);
}

describe("status view model", () => {
    test("shows dropped hidden-run variants as warnings", () => {
        expect(
            view({ hiddenVariantWarnings: ["variant 'medium' not offered by example/model"] })
                .warnings,
        ).toContainEqual({
            text: "variant 'medium' not offered by example/model",
            tone: "warning",
        });
    });
    test("names the sections in the order every host draws them", () => {
        expect(view().sections.map((section) => section.title)).toEqual([
            "Tags",
            "Reductions",
            "Pending Queue",
            "Context Details",
            "Cache TTL",
            "History Compression",
            "Memory",
        ]);
    });

    test("carries the section rows the status view is made of", () => {
        expect(rowLabels("Tags")).toEqual(["Active", "Dropped", "Total"]);
        expect(rowLabels("Reductions")).toEqual(["Execute threshold", "Last reduce anchor"]);
        expect(rowLabels("Pending Queue")).toEqual(["Drops", "Marker"]);
        expect(rowLabels("Context Details")).toEqual([
            "Protected tags",
            "Subagent",
            "Denominator",
            "Window source",
        ]);
        expect(rowLabels("Cache TTL")).toEqual([
            "Configured",
            "Last response",
            "Remaining",
            "Auto-execute",
        ]);
        expect(rowLabels("History Compression")).toEqual(["History block", "Budget", "Dreamer"]);
        expect(rowLabels("Memory")).toEqual(["Active", "Injected"]);
    });

    test("shows marker retry health only after the bounded budget is exhausted", () => {
        const healthy = view({
            compactionMarker: {
                code: null,
                attempts: 2,
                lastError: "database is locked",
                pendingSinceMs: NOW - 1_000,
            },
        });
        const healthyMarker = healthy.sections
            .find((section) => section.title === "Pending Queue")
            ?.rows.find((row) => row.label === "Marker");
        expect(healthyMarker).toMatchObject({ value: "healthy", tone: "muted" });
        expect(healthy.warnings).toEqual([]);

        const exhausted = view({
            compactionMarker: {
                code: "MC-C11",
                attempts: 3,
                lastError: "database is locked",
                pendingSinceMs: NOW - 2_000,
            },
            warnings: ["compaction_marker_missing"],
        });
        expect(JSON.stringify(exhausted)).toContain("MC-C11 · 3 attempts · database is locked");
        expect(exhausted.warnings[0]?.text).toContain("3 attempts; last error: database is locked");
    });

    test("drops the rows the single view no longer carries", () => {
        const rendered = JSON.stringify(view());
        // The Diagnostics split, the Logger block, the memory-importance
        // histogram and the breakdown footnote all left with it.
        for (const gone of [
            "Diagnostics",
            "Logger",
            "Swallowed writes",
            "Importance",
            "unclassified of",
            "Boundary",
            "Coverage ordinal",
            "includes reasoning",
        ]) {
            expect(rendered).not.toContain(gone);
        }
    });

    test("gives every row, breakdown row and warning an explicit colour", () => {
        const built = view({ warnings: ["transform_update_failed"] });
        for (const section of built.sections) {
            for (const row of section.rows) {
                expect(typeof row.tone).toBe("string");
                expect(row.tone.length).toBeGreaterThan(0);
            }
        }
        for (const row of built.breakdown) expect(row.color).toMatch(/^#[0-9a-f]{6}$/);
        for (const warning of built.warnings) {
            expect(["warning", "error"]).toContain(warning.tone);
        }
        expect(built.hygiene?.tone).toBe("accent");
        expect(built.headline.left.tone).toBe("warning");
    });

    test("reserves a label column wide enough for the section's longest label", () => {
        for (const section of view().sections) {
            const longest = Math.max(...section.rows.map((row) => row.label.length));
            expect(section.labelWidth).toBeGreaterThanOrEqual(longest);
        }
    });

    test("prints the remaining cache lifetime as one value, and omits it when there is none", () => {
        const remaining = view()
            .sections.find((section) => section.title === "Cache TTL")
            ?.rows.find((row) => row.label === "Remaining");
        expect(remaining?.value).toBe("4m 12s");

        // A cache that never expires has no countdown to print, so the row is
        // absent rather than carrying a sentence about its own absence.
        expect(rowLabels("Cache TTL", { cacheNeverExpires: true, cacheTtl: "never" })).toEqual([
            "Configured",
            "Last response",
            "Auto-execute",
        ]);
        expect(
            rowLabels("Cache TTL", { cacheRemainingMs: Number.POSITIVE_INFINITY }),
        ).not.toContain("Remaining");
    });

    test("marks an expired cache on the Remaining row", () => {
        const section = view({ cacheExpired: true, cacheRemainingMs: 0 }).sections.find(
            (entry) => entry.title === "Cache TTL",
        );
        const remaining = section?.rows.find((row) => row.label === "Remaining");
        expect({ value: remaining?.value, tone: remaining?.tone }).toEqual({
            value: "expired",
            tone: "warning",
        });
    });

    test("headlines pressure against the threshold and the absolute token count", () => {
        const built = view();
        expect(built.headline.left.text).toBe("71.4% / 75%");
        expect(built.headline.right.text).toBe("623K / 872K tokens");
        expect(built.windowLine).toContain("usable");
        expect(built.title).toBe("⚡ Magic Context Status");
        expect(built.version).toBe("v1.2.3");
        expect(built.footer).toBe("Esc to close");
    });

    /**
     * The tokenizer calibration leaves the hygiene masses fractional. A token
     * count is a whole number to the reader, so a raw `63,063.522` beside a
     * `288,527.546` reads as a measurement error rather than as precision.
     */
    test("prints the hygiene masses as whole token counts", () => {
        const built = view({
            tailHygiene: {
                u: 63_063.522,
                t: 288_527.546,
                severity: 0.2186,
                evaluable: true,
                reclaimableToolOutputCount: 3,
            },
        });
        expect(built.hygiene?.value).toBe("21.9% · 63,064 / 288,528 tok");
        // The masses are whole numbers; only the percentage keeps a decimal.
        const masses = (built.hygiene?.value ?? "").split("·")[1] ?? "";
        expect(masses).not.toMatch(/\d\.\d/);
    });

    /**
     * A value never wraps, so a section needs `labelWidth + 1 + longest value`
     * columns. The grid is drawn only when both columns' requirements plus the
     * gap fit; otherwise the caller draws one column.
     */
    test("draws two columns only when both columns' values fit", () => {
        const sections = view({ cacheTtlSource: "default" }).sections;
        for (const section of sections) {
            const longest = Math.max(...section.rows.map((row) => row.value.length));
            expect(statusSectionWidth(section)).toBe(section.labelWidth + 1 + longest);
        }

        // The values the dialog actually prints at ~88 columns: the longest is
        // `~98K tok (100% used)` in History Compression, so both columns fit.
        const narrowValues = view({
            cacheTtl: "never",
            cacheTtlSource: "session",
            compressionBudget: 98_000,
            compressionUsage: "100%",
            lastDreamerRunAt: NOW - 16 * 3_600_000,
            lastNudgeTokens: 495_000,
        }).sections;
        const layout = statusColumnsFor(narrowValues, 84);
        expect(layout.twoColumn).toBe(true);
        expect(layout.leftWidth + layout.rightWidth + STATUS_COLUMN_GAP).toBeLessThanOrEqual(84);
        // The columns are sized from these requirements, so a value in the wider
        // column cannot wrap inside the narrower one.
        expect(layout.leftWidth).toBe(
            Math.max(...narrowValues.filter((_s, i) => i % 2 === 0).map(statusSectionWidth)),
        );
        expect(layout.rightWidth).toBe(
            Math.max(...narrowValues.filter((_s, i) => i % 2 === 1).map(statusSectionWidth)),
        );

        // One column short of the two requirements plus the gap: no grid.
        const needed = layout.leftWidth + layout.rightWidth + STATUS_COLUMN_GAP;
        expect(statusColumnsFor(narrowValues, needed).twoColumn).toBe(true);
        expect(statusColumnsFor(narrowValues, needed - 1).twoColumn).toBe(false);

        // A long value — the frozen-default source on the Configured row — pushes the left
        // column past what the dialog has, so the same sections go one column
        // rather than wrapping that value mid-word.
        expect(statusColumnsFor(sections, 84).twoColumn).toBe(false);
    });

    /**
     * Rounding each segment's share on its own leaves the bar short of its
     * container by up to one column per segment, which paints as blank cells
     * between the coloured runs.
     */
    test("distributes the bar width so the segments sum to the bar with no gap", () => {
        const tokens = view().bar.map((segment) => segment.tokens);
        for (const width of [20, 56, 84, 88, 120]) {
            const widths = distributeBarWidths(tokens, width);
            expect(widths.reduce((sum, value) => sum + value, 0)).toBe(width);
            expect(widths.every((value) => value >= 1)).toBe(true);
        }
        // A category whose share rounds below a column still gets one, so the
        // bar never drops a segment the legend below it lists.
        const tiny = distributeBarWidths([1_000_000, 1], 40);
        expect(tiny.reduce((sum, value) => sum + value, 0)).toBe(40);
        expect(tiny[1]).toBe(1);
        // Narrower than the number of categories: the leftmost ones keep a cell.
        expect(distributeBarWidths([5, 4, 3, 2, 1], 3)).toEqual([1, 1, 1, 0, 0]);
    });

    /**
     * The window line is one line at the dialog's narrowest width and carries no
     * window-geometry vocabulary: the bracketed derivation tag names an internal
     * mode, and the percentage is already on the headline row above it.
     */
    test("prints the window line without the derivation tag or a second percentage", () => {
        const line = view().windowLine ?? "";
        expect(line).toBe("623k / 872k usable · window 904k · 32k output reserve");
        expect(line).not.toContain("[");
        expect(line).not.toContain("%");
        // The narrowest dialog content width is 56 columns (an 88-column dialog
        // less its padding); a longer line wraps onto a second row.
        expect(line.length).toBeLessThanOrEqual(56);
    });

    /**
     * `Last response 180s ago` is a raw stopwatch reading; the sidebar and the
     * Dreamer rows say `3m ago` for the same age.
     */
    test("humanizes the last-response age like the other age rows", () => {
        const row = (lastResponseTime: number) =>
            view({ lastResponseTime })
                .sections.find((section) => section.title === "Cache TTL")
                ?.rows.find((entry) => entry.label === "Last response")?.value;
        expect(row(NOW - 180_000)).toBe("3m ago");
        expect(row(NOW - 42_000)).toBe("just now");
        expect(row(NOW - 2 * 3_600_000)).toBe("2h ago");
        expect(row(0)).toBe("never");
    });

    test("breaks the context down by category, with counts and percentages", () => {
        expect(view().breakdown.map((row) => `${row.label} ${row.value}`)).toEqual([
            "System 12K (1.9%)",
            "Docs 4K (0.6%)",
            "Compartments (12) 80K (12.8%)",
            "Memories (3) 6K (1.0%)",
            "User Profile 1K (0.2%)",
            "Conversation 400K (64.2%)",
            "Tool Calls 100K (16.1%)",
            "Tool Defs 20K (3.2%)",
        ]);
    });

    test("prints config parse failures and failure codes as the warning block", () => {
        const built = view({
            configParseFailures: [
                { kind: "invalid-leaf", path: "/tmp/magic-context.jsonc", detail: "bad" },
            ] as StatusDetail["configParseFailures"],
            warnings: ["transform_update_failed"],
        });
        expect(built.warnings).toHaveLength(2);
        expect(built.warnings[0]?.tone).toBe("error");
        expect(built.warnings[1]?.text).toContain("MC-S02");
    });

    test("replaces the compaction machinery with knowledge counts when compaction is off", () => {
        const built = view({ compactionEnabled: false });
        expect(built.sections.map((section) => section.title)).toEqual(["Knowledge"]);
        expect(built.headline.left.text).toContain("native compaction");
        expect(built.sections[0]?.rows.map((row) => row.label)).toEqual([
            "Memories",
            "Notes",
            "Smart Notes",
            "Dreamer",
        ]);
    });

    /**
     * "Nothing has run lately" and "the background maintenance never got to its
     * work" used to look identical here — both were simply an old Dreamer
     * timestamp. The blocked state gets its own row so they cannot be confused
     * (issue 496).
     */
    describe("blocked background maintenance", () => {
        test("shows a scheduled task's primary quota deadline in the status dialog", () => {
            const error =
                "primary quota exhausted until 2026-10-08T03:40:04.275Z; account=private@example.com";
            const row = view({ dreamerFailures: [{ task: "verify", error }] })
                .sections.find((section) => section.title === "History Compression")
                ?.rows.find((entry) => entry.label === "Dreamer quota");
            expect(row?.value).toBe("primary quota exhausted until 2026-10-08T03:40:04.275Z");
            expect(row?.tone).toBe("warning");
        });
        const failure = {
            at: NOW - 2 * 3_600_000,
            stage: "message-history maintenance",
            message: "orphan sweep cannot read this host store",
        };

        test("has no row while the maintenance passes are completing", () => {
            expect(rowLabels("History Compression")).not.toContain("Dreamer blocked");
            expect(rowLabels("Knowledge", { compactionEnabled: false })).not.toContain(
                "Dreamer blocked",
            );
        });

        test("names the stage that stopped and carries its code", () => {
            const row = view({ dreamerTickFailure: failure })
                .sections.find((section) => section.title === "History Compression")
                ?.rows.find((entry) => entry.label === "Dreamer blocked");
            expect(row?.value).toBe("message-history maintenance failed 2h ago (MC-D09)");
            expect(row?.tone).toBe("error");
        });

        test("is drawn with compaction off too, where the Dreamer row also lives", () => {
            expect(
                rowLabels("Knowledge", { compactionEnabled: false, dreamerTickFailure: failure }),
            ).toContain("Dreamer blocked");
        });
    });
});

test("status displays adopted config generation and last reload failure without disabling the view", () => {
    const result = view({
        configGeneration: 3,
        configAdoptedAt: NOW,
        configReloadFailure: {
            path: "/tmp/project/.cortexkit/magic-context.jsonc",
            message: "invalid JSONC",
        },
    });
    expect(result.sections.find((section) => section.title === "Config")?.rows[0]?.value).toContain(
        "3 · adopted",
    );
    expect(result.warnings).toContainEqual({
        text: "Config reload failed /tmp/project/.cortexkit/magic-context.jsonc: invalid JSONC",
        tone: "error",
    });
});
