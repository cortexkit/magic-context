import { expect, spyOn, test } from "bun:test";
import * as nativeReplay from "../fold/native-replay";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;

// Native input copies made by each of consecutive passes. The first pass of a
// new session runs before the transform has stored the session's cache lifetime.
// `change` may alter the host state or the draft of a given pass.
async function copiesPerPass(
    seed: number,
    cacheTtl: string,
    passes = 2,
    change?: (pass: number, fixture: Fixture) => ((draft: SessionContext) => void) | undefined,
): Promise<number[]> {
    const fixture = await oc2ContextFixture(seed, { area: "issue-834", cacheTtl, temporal: false });
    const copy = spyOn(nativeReplay, "copyNativeInput");
    try {
        const counts: number[] = [];
        for (let pass = 0; pass < passes; pass++) {
            const before = copy.mock.calls.length;
            fixture.respond();
            fixture.user(`Continue, step ${pass}.`, 1000);
            const { logs } = await fixture.pass(change?.(pass, fixture));
            expect(logs.some((line) => line.includes("transform completed"))).toBe(true);
            counts.push(copy.mock.calls.length - before);
        }
        return counts;
    } finally {
        copy.mockRestore();
        await fixture.cleanup();
    }
}

test("a session whose cache never expires stops copying the native input once its lifetime is stored", async () => {
    const [, second, third] = await copiesPerPass(834, "never", 3);
    expect(second).toBe(0);
    expect(third).toBe(0);
}, 30000);

test("a session with an expiring cache keeps copying the native input for the idle fold", async () => {
    expect(await copiesPerPass(835, "5m")).toEqual([1, 1]);
}, 30000);

test("a never-expiring session copies again when an effort control changes", async () => {
    const counts = await copiesPerPass(836, "never", 4, (pass) =>
        pass === 3
            ? (draft) => {
                  draft.messages.push({
                      role: "system",
                      content: [{ type: "effort", effort: "low", previous: "high" }],
                  });
              }
            : undefined,
    );
    expect(counts[2]).toBe(0);
    expect(counts[3]).toBe(1);
}, 30000);

test("a never-expiring session copies again when the model changes", async () => {
    const counts = await copiesPerPass(837, "never", 4, (pass, fixture) => {
        if (pass === 3) fixture.setModel("claude-other");
        return undefined;
    });
    expect(counts[2]).toBe(0);
    expect(counts[3]).toBe(1);
}, 30000);

// Copies on each pass after a host fold and a new plugin process. The process
// has no capture record, and the capture does not run (as when a served
// checkpoint stops it), so no pass gives a current capture.
async function copiesAfterFold(
    seed: number,
    compartment = false,
): Promise<{
    counts: number[];
    logs: string[];
    current: unknown[];
    fixture: Awaited<ReturnType<typeof oc2ContextFixture>>;
}> {
    const fixture = await oc2ContextFixture(seed, {
        area: "issue-834",
        cacheTtl: "never",
        temporal: false,
    });
    if (compartment) fixture.compartment(4);
    for (let pass = 0; pass < 2; pass++) {
        fixture.respond();
        fixture.user(`Before the fold, step ${pass}.`, 1000);
        await fixture.pass();
    }
    await fixture.fold();
    await fixture.restart();
    const noCapture = spyOn(nativeReplay.NativeFoldReplay.prototype, "capture").mockImplementation(
        async () => {},
    );
    const copy = spyOn(nativeReplay, "copyNativeInput");
    const note = spyOn(nativeReplay.NativeFoldReplay.prototype, "noteSkippedCapture");
    try {
        const counts: number[] = [];
        const lines: string[] = [];
        for (let pass = 0; pass < 3; pass++) {
            const before = copy.mock.calls.length;
            fixture.respond();
            fixture.user(`After the fold, step ${pass}.`, 1000);
            const { logs } = await fixture.pass();
            expect(logs.some((line) => line.includes("transform completed"))).toBe(true);
            lines.push(...logs.filter((line) => line.includes("v2 native input:")));
            counts.push(copy.mock.calls.length - before);
        }
        return { counts, logs: lines, current: note.mock.calls.map((call) => call[2]), fixture };
    } finally {
        copy.mockRestore();
        note.mockRestore();
        noCapture.mockRestore();
    }
}

test("a never-expiring session whose capture cannot become current copies once, not on every pass", async () => {
    const { counts, logs, fixture } = await copiesAfterFold(838);
    try {
        expect(counts).toEqual([1, 0, 0]);
        expect(logs).toHaveLength(3);
        expect(logs[0]).toContain("v2 native input: copied reason=capture");
        for (const line of logs.slice(1))
            expect(line).toContain("v2 native input: skipped reason=capture-unavailable");
    } finally {
        await fixture.cleanup();
    }
}, 60000);

test("a manual compaction after a never-expiring session's capture is unproven still gets a history summary", async () => {
    const { current, fixture } = await copiesAfterFold(840, true);
    try {
        expect(current.at(-1)).toBe(false);
        await fixture.fold();
        const text = fixture.checkpoint?.content.find((part) => part.type === "text");
        const summary = text && "text" in text ? String(text.text) : "";
        expect(summary).toContain("Review history 0");
    } finally {
        await fixture.cleanup();
    }
}, 60000);

test("a never-expiring session with an effort control after an instruction row stops copying", async () => {
    const fixture = await oc2ContextFixture(841, {
        area: "issue-834",
        cacheTtl: "never",
        instructions: false,
        temporal: false,
    });
    const copy = spyOn(nativeReplay, "copyNativeInput");
    try {
        fixture.instruction("AUTHORED_INSTRUCTION");
        fixture.user("after the instruction", 1000);
        const effort = (draft: SessionContext) => {
            const at = draft.messages.findIndex(
                (message) =>
                    message.role === "system" &&
                    message.content.some((part) => part.text === "AUTHORED_INSTRUCTION"),
            );
            draft.messages.splice(at + 1, 0, {
                role: "system",
                content: [{ type: "effort", effort: "low", previous: "high" }],
            });
        };
        const counts: number[] = [];
        for (let pass = 0; pass < 4; pass++) {
            const before = copy.mock.calls.length;
            fixture.respond();
            fixture.user(`Continue, step ${pass}.`, 1000);
            await fixture.pass(effort);
            counts.push(copy.mock.calls.length - before);
        }
        expect(counts.slice(2)).toEqual([0, 0]);
    } finally {
        copy.mockRestore();
        await fixture.cleanup();
    }
}, 60000);

test("a never-expiring session whose copy throws does not try the copy on every pass", async () => {
    const fixture = await oc2ContextFixture(842, {
        area: "issue-834",
        cacheTtl: "never",
        temporal: false,
    });
    const copy = spyOn(nativeReplay, "copyNativeInput").mockImplementation(() => {
        throw new Error("copy failed");
    });
    try {
        const counts: number[] = [];
        for (let pass = 0; pass < 4; pass++) {
            const before = copy.mock.calls.length;
            fixture.respond();
            fixture.user(`Continue, step ${pass}.`, 1000);
            const { logs } = await fixture.pass();
            expect(logs.some((line) => line.includes("transform completed"))).toBe(true);
            counts.push(copy.mock.calls.length - before);
        }
        expect(counts.slice(2)).toEqual([0, 0]);
    } finally {
        copy.mockRestore();
        await fixture.cleanup();
    }
}, 60000);
