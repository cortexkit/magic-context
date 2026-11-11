import { describe, expect, test } from "bun:test";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { type Oc2ContextFixture, oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// A long OpenCode 2 session over the model's window, whose history summary ends
// on a row well inside the loaded history. Every pass must cut the summarized
// rows. The transform freezes the order of the request's messages by id before
// it edits them, and today one message without an id anywhere after the first
// stored row makes that whole order unusable: the cut at the summary boundary
// is refused even though the id-less message comes after the boundary and has
// no bearing on what the summary covers.

const WINDOW = 12_000;
const STEPS = 28;

const toolStep = (n: number) => ({
    name: "read",
    input: { path: `src/module-${n}.ts` },
    output: `export const value${n} = "${"module contents ".repeat(220)}";\n`,
});

// The text a preceding plugin's context hook adds to the shared draft. OpenCode 2
// hands one draft to every plugin's context hook in turn
// (session/model-request.ts, `agentHook`), so a message such a hook adds without
// an id reaches Magic Context like a host message.
const REMINDER = {
    role: "user",
    content: [
        {
            type: "text",
            text: "<system-reminder>\nYour operational mode has changed from plan to build.\n</system-reminder>",
        },
    ],
} as SessionContext["messages"][number];

// OpenCode 2 appends this id-less assistant message itself when the agent
// reaches its step limit (session/runner/llm.ts, `MAX_STEPS_PROMPT`).
const MAX_STEPS = {
    role: "assistant",
    content: [{ type: "text", text: "Maximum steps reached. Summarize your progress." }],
} as SessionContext["messages"][number];

const withReminder = (draft: SessionContext) => {
    let index = draft.messages.length - 1;
    while (index >= 0 && draft.messages[index]?.role !== "user") index -= 1;
    draft.messages.splice(Math.max(0, index), 0, structuredClone(REMINDER));
};

type Outcome = { error: unknown; logs: string[]; ids: (string | undefined)[] };

async function run(f: Oc2ContextFixture, edit?: (draft: SessionContext) => void): Promise<Outcome> {
    const start = f.sessionLogs().length;
    let error: unknown;
    let ids: (string | undefined)[] = [];
    try {
        ids = (await f.pass(edit)).draft.messages.map((message) => message.id);
    } catch (caught) {
        error = caught;
    }
    return { error, logs: f.sessionLogs().slice(start), ids };
}

/** The trim refusals a pass logged; the cut at the summary boundary was not made. */
const trimRefusals = (outcome: Outcome) =>
    outcome.logs.filter((line) =>
        /prefix trim: boundary \S+; pass=\w+; no in-pass trim applied/.test(line),
    );

/** The persisted state a pass could change: the history boundary, the summaries, the error flag. */
function boundaryState(f: Oc2ContextFixture) {
    return {
        meta: f.db
            .prepare(
                "SELECT cached_m0_last_baseline_end_message_id AS boundary, last_transform_error AS error FROM session_meta WHERE session_id = ?",
            )
            .get(f.session),
        compartments: f.db
            .prepare(
                "SELECT sequence, start_message, end_message, end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence",
            )
            .all(f.session),
    };
}

async function overWindowSession(seed: number) {
    const f = await oc2ContextFixture(seed, {
        area: "issue-898",
        instructions: false,
        temporal: false,
        cacheTtl: "5m",
        limit: { context: WINDOW },
    });
    f.user("Read every module and report back.", 60_000);
    for (let n = 0; n < STEPS; n++) f.respondWithTool(toolStep(n), 3_000);
    f.respond(1, 3_000);
    // The summary ends on the last tool step but three, well inside the loaded rows.
    const toolRows = f.rows.flatMap((row, index) => (row.tool ? [index] : []));
    const boundaryIndex = toolRows[toolRows.length - 4]!;
    f.compartment(boundaryIndex);
    return {
        f,
        boundaryId: f.rows[boundaryIndex]!.id,
        firstCovered: f.rows[toolRows[0]!]!.id,
    };
}

describe("issue 898: an id-less message after the summary boundary", () => {
    test("does not refuse the cut, on any pass or after a head rebuild", async () => {
        const { f, boundaryId, firstCovered } = await overWindowSession(89_801);
        try {
            const healthy = await run(f);
            expect(healthy.error).toBeUndefined();
            expect(trimRefusals(healthy)).toEqual([]);
            expect(healthy.ids).not.toContain(firstCovered);
            const settled = boundaryState(f);
            expect((settled.meta as { boundary: string }).boundary).toBe(boundaryId);

            f.user("Continue with the next module.", 60_000);
            const passes: Outcome[] = [];
            for (let attempt = 0; attempt < 3; attempt++) passes.push(await run(f, withReminder));
            // What /ctx-recomp leaves behind when the summaries are healthy: the
            // same compartments and the cached head cleared, so the next pass
            // renders the head afresh.
            clearCachedM0M1(f.db, f.session);
            passes.push(await run(f, withReminder));
            for (const pass of passes) {
                expect(pass.error).toBeUndefined();
                expect(trimRefusals(pass)).toEqual([]);
                expect(pass.ids).not.toContain(firstCovered);
            }
            expect((boundaryState(f).meta as { boundary: string }).boundary).toBe(boundaryId);
        } finally {
            await f.cleanup();
        }
    }, 120_000);

    test("from OpenCode 2's own step-limit message does not refuse the cut", async () => {
        const { f, firstCovered } = await overWindowSession(89_802);
        try {
            expect((await run(f)).error).toBeUndefined();
            f.respondWithTool(toolStep(STEPS), 3_000);
            const pass = await run(f, (draft) => {
                draft.messages.push(structuredClone(MAX_STEPS));
            });
            expect(pass.error).toBeUndefined();
            expect(trimRefusals(pass)).toEqual([]);
            expect(pass.ids).not.toContain(firstCovered);
        } finally {
            await f.cleanup();
        }
    }, 120_000);
});
