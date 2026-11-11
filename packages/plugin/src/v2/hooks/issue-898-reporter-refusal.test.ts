import { describe, expect, test } from "bun:test";
import { type Oc2ContextFixture, oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// Issue 898, the reporter's refusal on the real OpenCode 2 adapter. A priced
// pass renders a newer history summary than the one the last served request
// carried. The compartment injection earlier in the pass still cuts at the
// boundary that request was built on, so the rows between that boundary and
// the newer one are only removed by the prefix trim at the end of the pass. A
// message without an id near the tail of the request used to make the trim
// refuse that cut outright ("source message at index N has no stable id
// outside the synthetic head"), and the uncut request, over the model's
// window, was refused before it was sent (MC-H04), on every later pass too.

const WINDOW = 12_000;

const toolStep = (n: number) => ({
    name: "read",
    input: { path: `src/module-${n}.ts` },
    output: `export const value${n} = "${"module contents ".repeat(220)}";\n`,
});

// OpenCode 2 appends this id-less assistant message itself when the agent
// reaches its step limit (session/runner/llm.ts, `MAX_STEPS_PROMPT`). It lasts
// one pass.
const STEP_LIMIT_TEXT = "Maximum steps reached. Summarize your progress.";
const withStepLimit = (draft: SessionContext) => {
    draft.messages.push({
        role: "assistant",
        content: [{ type: "text", text: STEP_LIMIT_TEXT }],
    } as SessionContext["messages"][number]);
};
const isStepLimit = (message: SessionContext["messages"][number]) =>
    message.id === undefined && JSON.stringify(message.content).includes(STEP_LIMIT_TEXT);

type Pass = {
    error: unknown;
    logs: string[];
    ids: (string | undefined)[];
    stepLimitServed: boolean;
    bytes?: string;
};

async function run(f: Oc2ContextFixture, edit?: (draft: SessionContext) => void): Promise<Pass> {
    const start = f.sessionLogs().length;
    try {
        const served = await f.pass(edit);
        return {
            error: undefined,
            logs: f.sessionLogs().slice(start),
            ids: served.draft.messages.map((message) => message.id),
            stepLimitServed: served.draft.messages.some(isStepLimit),
            bytes: JSON.stringify({
                system: served.draft.system,
                messages: served.draft.messages.filter((message) => !isStepLimit(message)),
            }),
        };
    } catch (error) {
        return { error, logs: f.sessionLogs().slice(start), ids: [], stepLimitServed: false };
    }
}

/** The lines a refused cut or an unsent request leaves. */
const refusalLines = (pass: Pass) =>
    pass.logs.filter(
        (line) =>
            line.includes("no in-pass trim applied") ||
            line.includes("history boundary unresolved"),
    );

/**
 * A session whose last served request was built on an older summary boundary,
 * with a newer summary published since and many large rows between the two.
 */
async function reporterSession(seed: number) {
    const f = await oc2ContextFixture(seed, {
        area: "issue-898-reporter",
        instructions: false,
        temporal: false,
        cacheTtl: "5m",
        limit: { context: WINDOW },
    });
    f.user("Read every module and report back.", 60_000);
    for (let n = 0; n < 8; n++) f.respondWithTool(toolStep(n), 3_000);
    const toolRows = () => f.rows.flatMap((row, index) => (row.tool ? [index] : []));
    // The summary the last served request carried ends on the fourth step.
    f.compartment(toolRows()[3]!);
    const served = await run(f);
    expect(served.error).toBeUndefined();
    // The agent goes on, and the historian publishes a newer summary that
    // ends three steps before the newest one.
    for (let n = 8; n < 30; n++) f.respondWithTool(toolStep(n), 3_000);
    const steps = toolRows();
    const newer = steps[steps.length - 4]!;
    f.compartment(newer);
    return {
        f,
        newerBoundary: f.rows[newer]!.id,
        // Rows only the newer summary covers: past the injection's cut, before the trim's.
        coveredByNewer: steps.slice(4, steps.length - 4).map((index) => f.rows[index]!.id),
    };
}

describe("issue 898: the reporter's refusal on OpenCode 2", () => {
    test("a priced pass whose boundary lies past the injection cut, with a message without an id at the tail, is cut by the trim and sent", async () => {
        const { f, newerBoundary, coveredByNewer } = await reporterSession(89_830);
        try {
            // The provider reports the last request near the execute threshold,
            // so the next pass is priced and renders the newer summary.
            f.respondWithTool(toolStep(30), 9_000);
            const priced = await run(f, withStepLimit);
            expect(refusalLines(priced)).toEqual([]);
            expect(priced.error).toBeUndefined();
            // The trim cut through the newer boundary: nothing it covers is
            // sent, and the step-limit notice is.
            for (const id of coveredByNewer) expect(priced.ids).not.toContain(id);
            expect(priced.ids).not.toContain(newerBoundary);
            expect(priced.stepLimitServed).toBe(true);
        } finally {
            await f.cleanup();
        }
    }, 120_000);

    test("a cache-preserving pass before, during and after a one-pass notice serves the same bytes apart from the notice", async () => {
        const { f } = await reporterSession(89_831);
        try {
            f.idle(1);
            f.respondWithTool(toolStep(30), 3_000);
            expect((await run(f)).error).toBeUndefined();
            const before = await run(f);
            const during = await run(f, withStepLimit);
            const after = await run(f);
            for (const pass of [before, during, after]) {
                expect(pass.error).toBeUndefined();
                expect(refusalLines(pass)).toEqual([]);
            }
            expect(during.stepLimitServed).toBe(true);
            expect(during.bytes).toBe(before.bytes);
            expect(after.bytes).toBe(before.bytes);
        } finally {
            await f.cleanup();
        }
    }, 120_000);
});
