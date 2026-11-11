import { describe, expect, test } from "bun:test";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// Review witness, end to end on OpenCode 2: a message without an id that lasts
// one pass still refuses a history cut the store can place.
//
// The summary boundary row is in the host store but not in the request, while
// rows it covers are. On every pass whose messages all carry ids, the cut is
// placed from the store's order and the request fits. On the pass that also
// carries OpenCode 2's one-pass step-limit notice (an assistant message
// without an id), the recorded order is unusable, the fallback places the
// boundary only by its position in the request, finds nothing, and refuses the
// cut. The uncut request is over the window, so the agent's final step is not
// sent (the person is told to send the message again) and the next send runs a
// full overflow-recovery pass that the session never needed.

const TOOL_WINDOW = 12_000;
const STEPS = 28;

const toolStep = (n: number) => ({
    name: "read",
    input: { path: `src/module-${n}.ts` },
    output: `export const value${n} = "${"module contents ".repeat(220)}";\n`,
});

// OpenCode 2 appends this id-less assistant message when the agent reaches its
// step limit (session/runner/llm.ts, `MAX_STEPS_PROMPT`). It lasts one pass.
const MAX_STEPS = {
    role: "assistant",
    content: [{ type: "text", text: "Maximum steps reached. Summarize your progress." }],
} as SessionContext["messages"][number];

describe("issue 898 review: a one-pass message without an id and a boundary the request leaves out", () => {
    test("the step-limit pass is cut like the passes around it and sent, not refused", async () => {
        const f = await oc2ContextFixture(89_890, {
            area: "issue-898-review",
            instructions: false,
            temporal: false,
            cacheTtl: "5m",
            limit: { context: TOOL_WINDOW },
        });
        try {
            f.user("Read every module and report back.", 60_000);
            for (let n = 0; n < STEPS; n++) f.respondWithTool(toolStep(n), 3_000);
            f.respond(1, 3_000);
            const toolRows = f.rows.flatMap((row, index) => (row.tool ? [index] : []));
            const boundaryIndex = toolRows[toolRows.length - 4]!;
            const boundaryId = f.rows[boundaryIndex]!.id;
            const firstCovered = f.rows[toolRows[0]!]!.id;
            f.compartment(boundaryIndex);
            // The store keeps the boundary row (a tool step), but the host's
            // request leaves it and its tool result out.
            const omitBoundary = (draft: SessionContext) => {
                draft.messages = draft.messages.filter(
                    (message) =>
                        message.id !== boundaryId &&
                        !message.content.some(
                            (part) => (part as { id?: unknown }).id === `call-${boundaryId}`,
                        ),
                );
            };

            // Without the notice the store's order places the boundary, the
            // covered rows are cut, and the request is sent.
            const healthy = await f.pass(omitBoundary);
            expect(healthy.draft.messages.map((message) => message.id)).not.toContain(firstCovered);

            // The agent takes one more step and reaches its step limit.
            f.respondWithTool(toolStep(STEPS), 3_000);
            let error: unknown;
            let ids: (string | undefined)[] = [];
            try {
                const limited = await f.pass((draft) => {
                    omitBoundary(draft);
                    draft.messages.push(structuredClone(MAX_STEPS));
                });
                ids = limited.draft.messages.map((message) => message.id);
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeUndefined();
            expect(ids).not.toContain(firstCovered);
        } finally {
            await f.cleanup();
        }
    }, 120_000);
});
