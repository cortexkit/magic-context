import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    buildChannel1Reminder,
    buildChannel2Reminder,
    CHANNEL1_FLOOR_TOKENS,
    CHANNEL1_MIN_TOKENS,
    CHANNEL2_FLOOR_TOKENS,
    CHANNEL2_SEVERITY_THRESHOLD,
    type Channel1Level,
    channel1RefireTokens,
    decideChannel1,
    evaluateChannel2,
    shouldUseStickyChannel1Reminder,
} from "./ctx-reduce-nudge";

describe("decideChannel1 — agent-tail hygiene ratio", () => {
    const base = {
        baselineU: 0,
        baselineT: 100_000,
        turnDeltaU: 0,
        turnDeltaT: 0,
        lastNudgeUndropped: 0,
        lastNudgeLevel: "" as const,
        hasRecentReduce: false,
        evaluable: true,
    };

    it("uses the four owner-set bands without wall-pressure input", () => {
        expect(decideChannel1({ ...base, baselineU: 20_000 }).level).toBe("gentle");
        expect(decideChannel1({ ...base, baselineU: 40_000 }).level).toBe("firm");
        expect(decideChannel1({ ...base, baselineU: 55_000 }).level).toBe("firm");
        expect(decideChannel1({ ...base, baselineU: 60_000 }).level).toBe("urgent");
    });

    it("is window-size invariant for proportional tail states", () => {
        const sol = decideChannel1({ ...base, baselineU: 39_600, baselineT: 72_000 });
        const fable = decideChannel1({ ...base, baselineU: 119_900, baselineT: 218_000 });
        expect(sol.fire).toBe(true);
        expect(fable.fire).toBe(true);
        expect(sol.level).toBe("firm");
        expect(fable.level).toBe(sol.level);
    });

    it("fires for the flagship 162k/249k rendered-tail incident", () => {
        const decision = decideChannel1({ ...base, baselineU: 162_000, baselineT: 249_000 });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("urgent");
    });

    it("fires at low total-window usage because the pressure gate is deleted", () => {
        const decision = decideChannel1({ ...base, baselineU: 140_000, baselineT: 200_000 });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("urgent");
    });

    it("holds a generation-invalidated baseline", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 70_000,
            generationInvalidated: true,
            evaluable: false,
        });
        expect(decision.fire).toBe(false);
    });

    it("guards T=0 and U=0", () => {
        expect(decideChannel1({ ...base, baselineU: 0, baselineT: 0 }).fire).toBe(false);
        expect(decideChannel1({ ...base, baselineU: 0 }).fire).toBe(false);
    });

    it("uses max(T,1) and clamps a defensive U>T ratio", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 100_000,
            baselineT: 60_000,
        });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("urgent");
        expect(decision.severity).toBe(1);
    });

    it("MIN_T keeps a 59k tail quiet and allows a 61k tail", () => {
        const under = decideChannel1({ ...base, baselineU: 55_000, baselineT: 59_000 });
        const over = decideChannel1({ ...base, baselineU: 55_000, baselineT: 61_000 });
        expect(CHANNEL1_MIN_TOKENS).toBe(60_000);
        expect(under.fire).toBe(false);
        expect(over.fire).toBe(true);
        expect(over.level).toBe("urgent");
    });

    it("prevents a post-fold first-read spike", () => {
        const decision = decideChannel1({ ...base, baselineU: 30_000, baselineT: 35_000 });
        expect(decision.fire).toBe(false);
    });

    it("uses the 25k U floor", () => {
        expect(CHANNEL1_FLOOR_TOKENS).toBe(25_000);
        expect(decideChannel1({ ...base, baselineU: 24_000 }).fire).toBe(false);
        expect(decideChannel1({ ...base, baselineU: 26_000 }).fire).toBe(true);
    });

    it("combines persisted baseline and typed turn deltas", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 20_000,
            baselineT: 55_000,
            turnDeltaU: 10_000,
            turnDeltaT: 10_000,
        });
        expect(decision.undroppedTokens).toBe(30_000);
        expect(decision.tailTokens).toBe(65_000);
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("firm");
    });

    it("suppresses same-band noise until the rebased cadence interval", () => {
        const quiet = decideChannel1({
            ...base,
            baselineU: 48_000,
            baselineT: 120_000,
            lastNudgeUndropped: 40_000,
            lastNudgeLevel: "firm",
        });
        const refire = decideChannel1({
            ...base,
            baselineU: 65_000,
            baselineT: 140_000,
            lastNudgeUndropped: 40_000,
            lastNudgeLevel: "firm",
        });
        expect(quiet.fire).toBe(false);
        expect(refire.fire).toBe(true);
        expect(refire.level).toBe("firm");
    });

    it("fires an escalation before cadence is reached", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 60_000,
            baselineT: 100_000,
            lastNudgeUndropped: 50_000,
            lastNudgeLevel: "firm",
        });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("urgent");
    });

    it("uses max(25k, 0.08 × T) cadence", () => {
        expect(channel1RefireTokens(60_000)).toBe(25_000);
        expect(channel1RefireTokens(100_000)).toBe(25_000);
        expect(channel1RefireTokens(1_000_000)).toBe(80_000);
    });

    it("post-reduce suppression clears cadence and band state", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 70_000,
            lastNudgeUndropped: 60_000,
            lastNudgeLevel: "urgent",
            hasRecentReduce: true,
        });
        expect(decision.fire).toBe(false);
        expect(decision.nextLastNudge).toBe(0);
        expect(decision.nextLastNudgeLevel).toBe("");
    });

    it("a measured U collapse re-arms the cycle", () => {
        const decision = decideChannel1({
            ...base,
            baselineU: 30_000,
            baselineT: 100_000,
            lastNudgeUndropped: 80_000,
            lastNudgeLevel: "urgent",
        });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("gentle");
    });
});

type ReminderCopyGolden = {
    schema: number;
    cases: Array<{
        id: string;
        channel: "channel1" | "channel2";
        level?: Channel1Level;
        reclaimable_tool_outputs: number;
        reclaimable_tokens: number;
        sticky?: boolean;
        hint: Array<{ tag_number: number; tool_name: string | null }>;
        expected: string;
    }>;
};

const reminderCopyGolden = JSON.parse(
    readFileSync(
        new URL(
            "../../../../../crates/mc-module/testdata/ctx-reduce-nudge-copy-golden.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as ReminderCopyGolden;

function renderReminderGoldenCase(reminder: ReminderCopyGolden["cases"][number]): string {
    const hint = reminder.hint.map(({ tag_number, tool_name }) => ({
        tagNumber: tag_number,
        toolName: tool_name,
    }));
    if (reminder.channel === "channel2") {
        return buildChannel2Reminder(
            reminder.reclaimable_tokens,
            reminder.reclaimable_tool_outputs,
            hint,
        );
    }
    if (!reminder.level) throw new Error(`${reminder.id} needs a Channel-1 level`);
    return buildChannel1Reminder(
        reminder.level,
        reminder.reclaimable_tokens,
        reminder.reclaimable_tool_outputs,
        hint,
        reminder.sticky,
    );
}

describe("reminder rendering", () => {
    it("matches the TypeScript copy golden for every rendered band", () => {
        expect(reminderCopyGolden.schema).toBe(1);
        for (const reminder of reminderCopyGolden.cases) {
            expect(renderReminderGoldenCase(reminder), reminder.id).toBe(reminder.expected);
        }
    });

    it("never exposes a context-capacity gauge in any rendered band", () => {
        for (const reminder of reminderCopyGolden.cases) {
            const rendered = renderReminderGoldenCase(reminder);
            expect(rendered, `${reminder.id} must not expose a denominator`).not.toContain("of ~");
            expect(rendered, `${reminder.id} must not expose session capacity`).not.toContain(
                "of this session",
            );
            expect(
                rendered.match(/~\d+(?:\.\d+)?k\b/g) ?? [],
                `${reminder.id} must expose only the reclaimable token mass`,
            ).toHaveLength(1);
            expect(rendered, `${reminder.id} must not expose a percentage`).not.toMatch(
                /\b\d+(?:\.\d+)?\s*%/,
            );
            expect(rendered, `${reminder.id} must not expose context capacity`).not.toMatch(
                /\bwindow\b/i,
            );
        }
    });

    it("dampens re-fires in a window with zero real user turns (pure tool stream)", () => {
        // Regression: never-fired is signaled by an empty lastLevel, not by
        // ordinal zero. A conversation whose window is all tool traffic fires
        // at real-user count 0; its same-level re-fire must still collapse.
        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "urgent",
                lastOrdinal: 0,
                level: "urgent",
                currentRealUserTurnCount: 0,
            }),
        ).toBe(true);
        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "",
                lastOrdinal: 0,
                level: "urgent",
                currentRealUserTurnCount: 0,
            }),
        ).toBe(false);
    });

    it("dampens same-level refires before three real user turns but not escalations", () => {
        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "firm",
                lastOrdinal: 10,
                level: "firm",
                currentRealUserTurnCount: 12,
            }),
        ).toBe(true);
        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "firm",
                lastOrdinal: 10,
                level: "firm",
                currentRealUserTurnCount: 13,
            }),
        ).toBe(false);
        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "firm",
                lastOrdinal: 10,
                level: "urgent",
                currentRealUserTurnCount: 11,
            }),
        ).toBe(false);

        expect(
            shouldUseStickyChannel1Reminder({
                lastLevel: "firm",
                lastOrdinal: 160_750,
                level: "firm",
                currentRealUserTurnCount: 12,
            }),
        ).toBe(false);

        const sticky = buildChannel1Reminder("firm", 70_000, 16, undefined, true);
        expect(sticky).toContain(
            "Reminder: 16 spent tool outputs (~70k tokens) are still reclaimable",
        );
        const escalation = buildChannel1Reminder("urgent", 80_000, 16, undefined, false);
        expect(escalation).toContain("Housekeeping backlog: 16 spent tool outputs (~80k tokens)");
    });
});

describe("evaluateChannel2 — fourth hygiene band", () => {
    const baseline = {
        baselineU: 0,
        baselineT: 100_000,
        turnDeltaU: 0,
        turnDeltaT: 0,
        usableWindow: 128_000,
        evaluable: true,
        generationInvalidated: false,
    };

    it("arms only at severity >= 0.75 with at least 50k reclaimable tokens", () => {
        expect(CHANNEL2_FLOOR_TOKENS).toBe(50_000);
        expect(CHANNEL2_SEVERITY_THRESHOLD).toBe(0.75);
        expect(
            evaluateChannel2({
                ...baseline,
                baselineU: 65_000,
                turnDeltaU: 10_000,
            }).shouldTrigger,
        ).toBe(true);
        expect(
            evaluateChannel2({
                ...baseline,
                baselineU: 49_999,
                baselineT: 80_000,
            }).shouldTrigger,
        ).toBe(false);
        expect(
            evaluateChannel2({
                ...baseline,
                baselineU: 59_999,
            }).shouldTrigger,
        ).toBe(false);
        expect(
            evaluateChannel2({
                ...baseline,
                baselineU: 59_000,
                baselineT: 59_000,
            }).shouldTrigger,
        ).toBe(false);
    });

    it("keeps the 162k/249k flagship incident in the urgent band", () => {
        const evaluation = evaluateChannel2({
            ...baseline,
            baselineU: 162_000,
            baselineT: 249_000,
        });
        expect(evaluation.shouldTrigger).toBe(false);
        expect(evaluation.severity).toBeCloseTo(0.651, 3);

        const decision = decideChannel1({
            ...baseline,
            baselineU: 162_000,
            baselineT: 249_000,
            lastNudgeUndropped: 0,
            lastNudgeLevel: "",
            hasRecentReduce: false,
        });
        expect(decision.fire).toBe(true);
        expect(decision.level).toBe("urgent");
    });

    it("cannot arm below the Channel-1 urgent band", () => {
        for (let tailTokens = 60_000; tailTokens <= 500_000; tailTokens += 10_000) {
            const belowUrgent = Math.floor(tailTokens * 0.59999);
            expect(
                evaluateChannel2({
                    ...baseline,
                    baselineU: belowUrgent,
                    baselineT: tailTokens,
                }).shouldTrigger,
            ).toBe(false);
        }
    });

    it("holds generation-invalidated and unknown baselines", () => {
        expect(evaluateChannel2(undefined).evaluable).toBe(false);
        const invalidated = evaluateChannel2({
            ...baseline,
            baselineU: 70_000,
            generationInvalidated: true,
        });
        expect(invalidated.evaluable).toBe(false);
        expect(invalidated.shouldTrigger).toBe(false);
    });
});
