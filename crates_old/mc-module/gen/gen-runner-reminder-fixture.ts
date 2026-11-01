import "./quiet-live-log";
import { writeFileSync } from "node:fs";
import {
    buildChannel1Reminder,
    buildChannel2Reminder,
    type Channel1Level,
} from "../../../packages/plugin/src/hooks/magic-context/ctx-reduce-nudge";
import { temporalMarkerPrefix } from "../../../packages/plugin/src/hooks/magic-context/temporal-awareness";

/** Runner hints intentionally omit tool names; every other byte comes from TS. */
export function runnerReminderFixture() {
    const reduce = [];
    for (const kind of ["gentle", "firm", "urgent", "sticky", "channel2"] as const) {
        for (const count of [0, 1, 7]) {
            for (let hints = 0; hints <= 4; hints++) {
                const tags = Array.from({ length: hints }, (_, i) => 12 + i * 3);
                const input = tags.map((tagNumber) => ({ tagNumber, toolName: "fixture-tool" }));
                const tokens = count === 0 ? 0 : count === 1 ? 25_499 : 50_500;
                const text = kind === "channel2"
                    ? buildChannel2Reminder(tokens, count, input)
                    : buildChannel1Reminder(kind === "sticky" ? "urgent" : kind, tokens, count, input, kind === "sticky");
                reduce.push({ kind, tokens, count, tags, expected: text.replaceAll(" fixture-tool", "") });
            }
        }
    }
    // Sticky copy is level-independent; pin that claim against each TS level too.
    for (const level of ["gentle", "firm", "urgent"] satisfies Channel1Level[]) {
        reduce.push({ kind: "sticky", tokens: 50_000, count: 2, tags: [], expected: buildChannel1Reminder(level, 50_000, 2, [], true) });
    }
    const gaps = [-1, 0, 299, 300, 3599, 3600, 3660, 86399, 86400, 90000, 604799, 604800, 691200, 1209600];
    return { schema: 1, generator: "crates/mc-module/gen/gen-runner-reminder-fixture.ts", reduce, time: gaps.map((seconds) => ({ gap_ms: seconds * 1000, expected: temporalMarkerPrefix(seconds) })) };
}

if (import.meta.main) {
    const fixture = runnerReminderFixture();
    writeFileSync(new URL("../testdata/runner-reminder-fixture.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Generated ${fixture.reduce.length} reduce and ${fixture.time.length} time cases`);
}
