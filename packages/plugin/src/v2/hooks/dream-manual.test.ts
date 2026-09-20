import { expect, test } from "bun:test";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import { resolveManualDreamTask } from "./dream-manual";

test("no argument runs every enabled task", () => {
    expect(resolveManualDreamTask(undefined)).toEqual({});
    expect(resolveManualDreamTask("   ")).toEqual({});
    expect(resolveManualDreamTask(42)).toEqual({});
});

test("accepts a canonical task name", () => {
    expect(resolveManualDreamTask("verify")).toEqual({ task: "verify" });
    expect(resolveManualDreamTask("  map-memories ")).toEqual({ task: "map-memories" });
});

test("rejects an unknown task with the valid list", () => {
    const result = resolveManualDreamTask("nope");
    expect(result.task).toBeUndefined();
    expect(result.error).toContain('Unknown task "nope"');
    expect(result.error).toContain("map-memories");
});

test("summarizes a manual run like the v1 command output", () => {
    const message = summarizeManualDream({
        ran: ["verify"],
        skippedNoWork: ["curate"],
        deferredBusy: ["map-memories"],
        failed: ["retrospective"],
        failureDetails: ["retrospective: model unavailable"],
        details: ["verify: 3 memories checked"],
        backlogBefore: { verify: { pending: 3, total: 3 } },
        backlogAfter: { verify: { pending: 0, total: 3 } },
    });
    expect(message).toContain("Ran: verify");
    expect(message).toContain("Skipped (no work): curate");
    expect(message).toContain("Busy: map-memories");
    expect(message).toContain("Failed: retrospective");
    expect(message).toContain("- retrospective: model unavailable");
    expect(message).toContain("Backlog at run start:");
    expect(message).toContain("- verify: 3 pending / 3 total");
    expect(message).toContain("Backlog at run end:");
});

test("summarizes an idle run", () => {
    const message = summarizeManualDream({
        ran: [],
        skippedNoWork: [],
        deferredBusy: [],
        failed: [],
        failureDetails: [],
        details: [],
        backlogBefore: {},
        backlogAfter: {},
    });
    expect(message).toContain("No enabled dream tasks to run.");
});
