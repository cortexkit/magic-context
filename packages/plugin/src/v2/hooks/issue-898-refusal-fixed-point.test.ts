import { describe, expect, spyOn, test } from "bun:test";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta, updateSessionMeta } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { queuePendingOp } from "../../features/magic-context/storage-ops";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import { UnresolvedHistoryBoundaryError } from "../../hooks/magic-context/unresolved-history-boundary";
import { type Oc2ContextFixture, oc2ContextFixture, prose } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// Issue 898: an OpenCode 2 session over its model's window was refused on every
// turn with MC-H04 ("The boundary row is present in the host store but out of
// order relative to the loaded history"), and /ctx-recomp could not help. The
// history boundary row existed and the newest summary ended on it.
//
// Before cutting the summarized history out of a request, the transform
// records the order of the host's messages by id. One message without an id
// anywhere after the first stored row (a reminder another plugin's context
// hook adds, the host's own step-limit message, or the checkpoint a
// provider-native compaction serves) made that order unusable, and the cut was
// then refused outright, even with the boundary in plain sight or the host's
// window starting after it. A refused cut on a request over the window raised
// MC-H04, and nothing a later pass did changed that input or the boundary, so
// the same refusal came back on every turn.
//
// The cut now falls back to the boundary's place in the live messages when the
// recorded order cannot be used. A cut that still cannot be made on a request
// over the window arms the overflow recovery a provider rejection arms, so the
// next pass summarizes and drops before it sizes the request again, and a
// recovery that cannot make room is not repeated on the same state.

type Fixture = Oc2ContextFixture;

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

/** Insert the reminder just before the newest user message, as a turn-start reminder does. */
const withReminder = (draft: SessionContext) => {
    let index = draft.messages.length - 1;
    while (index >= 0 && draft.messages[index]?.role !== "user") index -= 1;
    draft.messages.splice(Math.max(0, index), 0, structuredClone(REMINDER));
};

type Outcome = { error: unknown; logs: string[]; ids: (string | undefined)[] };

async function run(f: Fixture, edit?: (draft: SessionContext) => void): Promise<Outcome> {
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
const trimRefusals = (outcome: { logs: string[] }) =>
    outcome.logs.filter((line) =>
        /prefix trim: boundary \S+(?: absent from current messages)?; pass=\w+; no in-pass trim applied/.test(
            line,
        ),
    );

function refusal(error: unknown): UnresolvedHistoryBoundaryError | undefined {
    const cause = (error as { cause?: unknown } | undefined)?.cause ?? error;
    return cause instanceof UnresolvedHistoryBoundaryError ? cause : undefined;
}

/** Everything a later pass would need to change for the trim to behave differently. */
function trimState(f: Fixture) {
    const meta = getOrCreateSessionMeta(f.db, f.session);
    const boundary = f.db
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
        )
        .get(f.session) as { id: string | null };
    return {
        boundary: boundary.id,
        compartments: getCompartments(f.db, f.session).map((c) => [c.sequence, c.endMessageId]),
        lastTransformError: meta.lastTransformError ?? null,
        compartmentInProgress: meta.compartmentInProgress,
    };
}

// ── Part 1: the cut is placed by the live messages when the recorded order is unusable ──

const TOOL_WINDOW = 12_000;
const STEPS = 28;

const toolStep = (n: number) => ({
    name: "read",
    input: { path: `src/module-${n}.ts` },
    output: `export const value${n} = "${"module contents ".repeat(220)}";\n`,
});

/** Raw history over the window; the summary ends on a tool step well inside the loaded rows. */
async function toolSession(seed: number) {
    const f = await oc2ContextFixture(seed, {
        area: "issue-898",
        instructions: false,
        temporal: false,
        cacheTtl: "5m",
        limit: { context: TOOL_WINDOW },
    });
    f.user("Read every module and report back.", 60_000);
    for (let n = 0; n < STEPS; n++) f.respondWithTool(toolStep(n), 3_000);
    f.respond(1, 3_000);
    const toolRows = f.rows.flatMap((row, index) => (row.tool ? [index] : []));
    const boundaryIndex = toolRows[toolRows.length - 4]!;
    f.compartment(boundaryIndex);
    return {
        f,
        boundaryId: f.rows[boundaryIndex]!.id,
        firstCovered: f.rows[toolRows[0]!]!.id,
    };
}

describe("issue 898: a message without an id does not stop the history cut", () => {
    test("a preceding plugin's reminder after the boundary: cut on every pass and after a head rebuild", async () => {
        const { f, boundaryId, firstCovered } = await toolSession(89_801);
        try {
            const healthy = await run(f);
            expect(healthy.error).toBeUndefined();
            expect(trimRefusals(healthy)).toEqual([]);
            expect(healthy.ids).not.toContain(firstCovered);
            expect(trimState(f).boundary).toBe(boundaryId);

            f.user("Continue with the next module.", 60_000);
            // A pass that cut correctly keeps its bytes: the same input with the
            // reminder serves the request it serves without it, plus the
            // reminder in its place. The cut placed by the live messages is the
            // cut the recorded order makes.
            const plain = await f.pass();
            const reminded = await f.pass(withReminder);
            const isReminder = (message: SessionContext["messages"][number]) =>
                message.id === undefined &&
                JSON.stringify(message.content).includes("operational mode has changed");
            expect(reminded.draft.messages.filter(isReminder)).toHaveLength(1);
            expect(
                JSON.stringify({
                    system: reminded.draft.system,
                    messages: reminded.draft.messages.filter((message) => !isReminder(message)),
                }),
            ).toBe(plain.bytes);

            const passes: Outcome[] = [];
            for (let attempt = 0; attempt < 3; attempt++) passes.push(await run(f, withReminder));
            // What /ctx-recomp leaves behind when the summaries are healthy: the
            // same compartments and the cached head cleared.
            clearCachedM0M1(f.db, f.session);
            passes.push(await run(f, withReminder));
            for (const pass of passes) {
                expect(pass.error).toBeUndefined();
                expect(trimRefusals(pass)).toEqual([]);
                expect(pass.ids).not.toContain(firstCovered);
                // The reminder is another party's content: it is served, never cut.
                expect(pass.ids).toContain(undefined);
            }
            expect(trimState(f).boundary).toBe(boundaryId);
        } finally {
            await f.cleanup();
        }
    }, 120_000);

    test("OpenCode 2's own step-limit message after the boundary: cut", async () => {
        const { f, firstCovered } = await toolSession(89_802);
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

    test("a boundary the host serves under an earlier id, a reminder after it and queued drops: cut and sent", async () => {
        // The state closest to the reporter's that the adapter can produce: the
        // summary ends on a stored step the host renders no message for (it
        // produced no content), so the request carries it under the nearest
        // earlier served row; a reminder without an id sits after it; drops
        // are queued for summarized tool output; the raw history is over the
        // window.
        const f = await oc2ContextFixture(89_803, {
            area: "issue-898",
            instructions: false,
            temporal: false,
            cacheTtl: "5m",
            limit: { context: TOOL_WINDOW },
        });
        try {
            f.user("Read every module and report back.", 60_000);
            for (let n = 0; n < STEPS; n++) f.respondWithTool(toolStep(n), 3_000);
            f.respond(1, 3_000);
            const unserved = f.rows.at(-1)!;
            unserved.text = "";
            for (let n = STEPS; n < STEPS + 3; n++) f.respondWithTool(toolStep(n), 3_000);
            f.respond(1, 3_000);
            f.compartment(f.rows.indexOf(unserved));
            const firstCovered = f.rows.find((row) => row.tool)!.id;
            // OpenCode 2 sends no message for a stored assistant step without content.
            const host = (draft: SessionContext) => {
                draft.messages = draft.messages.filter((message) => message.id !== unserved.id);
            };
            expect((await run(f, host)).error).toBeUndefined();
            const covered = f.db
                .prepare(
                    "SELECT tag_number AS tag FROM tags WHERE session_id = ? ORDER BY tag_number LIMIT 3",
                )
                .all(f.session) as Array<{ tag: number }>;
            expect(covered.length).toBeGreaterThan(0);
            for (const { tag } of covered) queuePendingOp(f.db, f.session, tag, "drop");

            f.user("Continue with the next module.", 60_000);
            for (let attempt = 0; attempt < 2; attempt++) {
                const pass = await run(f, (draft) => {
                    host(draft);
                    withReminder(draft);
                });
                expect(pass.error).toBeUndefined();
                expect(trimRefusals(pass)).toEqual([]);
                expect(pass.ids).not.toContain(firstCovered);
                expect(pass.ids).toContain(undefined);
            }
        } finally {
            await f.cleanup();
        }
    }, 120_000);

    test("a provider checkpoint before a boundary the host serves: never refused as unplaceable", async () => {
        const f = await oc2ContextFixture(89_810, {
            area: "issue-898",
            instructions: false,
            temporal: false,
            cacheTtl: "never",
            limit: { context: 30_000 },
        });
        try {
            // The host compacted with the model's native compaction (its
            // compaction hook got no answer, as with Magic Context's compaction
            // off). Every later request starts with the newest kept user messages
            // and the provider's checkpoint, an assistant message without an id
            // (OpenCode 2.0.22 SessionCompaction, `cn.assistant(checkpoint)`).
            f.providerFold(2);
            for (let turn = 0; turn < 3; turn++) {
                f.user(`Turn ${turn}: ${prose.repeat(20)}`, 60_000);
                f.respond(20);
            }
            // The summary ends on the reply of turn 2, a row the host serves.
            const boundaryIndex = f.rows.length - 1;
            const boundaryId = f.rows[boundaryIndex]!.id;
            f.compartment(boundaryIndex);
            for (let turn = 3; turn < 12; turn++) {
                f.user(`Turn ${turn}: ${prose.repeat(120)}`, 60_000);
                f.respond(120);
            }
            const outcomes: Array<{ unplaceable: boolean; served: boolean; logs: string[] }> = [];
            for (let pass = 0; pass < 4; pass++) {
                f.user(`Pass ${pass}: please continue with the review.`, 60_000);
                const attempt = await f.attempt();
                if (attempt.error && !refusal(attempt.error))
                    throw new Error(
                        `pass ${pass}: unexpected failure ${String(attempt.error)}\n${attempt.logs.join("\n")}`,
                    );
                outcomes.push({
                    unplaceable: refusal(attempt.error) !== undefined,
                    served: attempt.inputIds.includes(boundaryId),
                    logs: attempt.logs,
                });
            }
            expect(trimState(f).compartments.at(-1)?.[1]).toBe(boundaryId);
            for (const outcome of outcomes) {
                expect(outcome.served).toBe(true);
                expect(outcome.unplaceable).toBe(false);
                expect(trimRefusals(outcome)).toEqual([]);
            }
        } finally {
            await f.cleanup();
        }
    }, 120_000);

    test("a boundary before the host's window: nothing to cut, never refused as unplaceable", async () => {
        const f = await oc2ContextFixture(89_811, {
            area: "issue-898",
            instructions: false,
            temporal: false,
            cacheTtl: "never",
            limit: { context: 30_000 },
        });
        try {
            // The summary covers rows the host no longer serves: it compacted
            // natively after the historian published, so its window starts after
            // the boundary.
            const boundaryIndex = f.rows.findLastIndex((row) => row.type === "assistant");
            const boundaryId = f.rows[boundaryIndex]!.id;
            f.compartment(boundaryIndex);
            f.providerFold(1);
            for (let turn = 0; turn < 12; turn++) {
                f.user(`Turn ${turn}: ${prose.repeat(120)}`, 60_000);
                f.respond(120);
            }
            for (let pass = 0; pass < 3; pass++) {
                f.user(`Pass ${pass}: please continue with the review.`, 60_000);
                const attempt = await f.attempt();
                if (attempt.error && !refusal(attempt.error))
                    throw new Error(
                        `pass ${pass}: unexpected failure ${String(attempt.error)}\n${attempt.logs.join("\n")}`,
                    );
                expect(attempt.inputIds).not.toContain(boundaryId);
                // Nothing the summary covers is in the request, so being over the
                // window is not a boundary problem.
                expect(refusal(attempt.error)).toBeUndefined();
                expect(trimRefusals(attempt)).toEqual([]);
            }
            expect(trimState(f).boundary).toBe(boundaryId);
        } finally {
            await f.cleanup();
        }
    }, 120_000);
});

// ── Part 2: a cut that still cannot be made takes the overflow-recovery road ──

const RECOVERY_WINDOW = 30_000;

/**
 * A session whose cut genuinely cannot be placed. The host compacted natively
 * and keeps the two newest user messages ahead of its id-less checkpoint; the
 * older kept message comes before the summary boundary, and the boundary row
 * itself is not served. The live window therefore starts before a boundary it
 * does not contain, and the id-less checkpoint keeps the store's order from
 * placing it. The rows after the checkpoint put the request over the window.
 */
async function uncutSession(seed: number) {
    const f = await oc2ContextFixture(seed, {
        area: "issue-898",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
        historian: true,
        limit: { context: RECOVERY_WINDOW },
    });
    f.user(`Turn A: ${prose.repeat(10)}`, 60_000);
    f.respond(10);
    const boundaryIndex = f.rows.length - 1;
    const boundaryId = f.rows[boundaryIndex]!.id;
    f.compartment(boundaryIndex);
    f.user(`Turn B: ${prose.repeat(10)}`, 60_000);
    f.providerFold(2);
    // Turns served while the request still fits measure the system prompt and
    // the route's tool definitions, so later passes size the request with a
    // trusted estimate, as on the reporter's long-running session.
    f.respond(10);
    f.user(`Turn C: ${prose.repeat(10)}`, 60_000);
    await f.pass();
    f.respond(10);
    f.user(`Turn D: ${prose.repeat(10)}`, 60_000);
    await f.pass();
    const replies: number[] = [];
    for (let turn = 0; turn < 9; turn++) {
        f.user(`Turn ${turn}: ${prose.repeat(120)}`, 60_000);
        f.respond(120);
        replies.push(f.rows.length - 1);
    }
    return { f, boundaryId, replies };
}

/**
 * Stub the historian's model call. Each run publishes the next compartment
 * from `ends` (fixture row indexes), the way the real runner publishes, and
 * returns without publishing once they run out.
 */
function stubHistorian(f: Fixture, ends: number[]) {
    let runs = 0;
    const spy = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        runs += 1;
        updateSessionMeta(f.db, deps.sessionId, { compartmentInProgress: false });
        const end = ends.shift();
        if (end === undefined) return;
        f.compartment(end);
        deps.onCompartmentStatePublished?.(deps.sessionId);
    });
    return { spy, runs: () => runs };
}

function recoveryArmed(f: Fixture) {
    const state = getOverflowState(f.db, f.session);
    return state.needsEmergencyRecovery ? state.emergencyRecoveryOrigin : null;
}

describe("issue 898: a cut that cannot be made over the window is never a fixed point", () => {
    test("the refusal arms recovery, and the next pass summarizes past the old boundary and is sent", async () => {
        const { f, boundaryId, replies } = await uncutSession(89_820);
        // The historian summarizes through the reply of the seventh turn after
        // the checkpoint, a row the host serves.
        const historian = stubHistorian(f, [replies[6]!]);
        try {
            f.user("Please continue with the review.", 60_000);
            const first = await f.attempt();
            const firstRefusal = refusal(first.error);
            expect(firstRefusal?.message).toContain("message without an id");
            expect(firstRefusal?.message).toContain("Send your message again");
            expect(firstRefusal?.message).toEndWith("(MC-H08)");
            expect(
                first.logs.some((line) =>
                    line.includes(
                        "history boundary unresolved: prefix trim refused (unidentified-message)",
                    ),
                ),
            ).toBe(true);
            expect(recoveryArmed(f)).toBe("history_boundary_over_window");
            expect(trimState(f).boundary).toBe(boundaryId);
            expect(historian.runs()).toBe(0);

            // The person sends again: this pass is a recovery pass.
            f.user("Please continue.", 60_000);
            const second = await f.attempt();
            expect(second.error).toBeUndefined();
            expect(historian.runs()).toBe(1);
            // The newer summary moved the boundary into the request, and the
            // cut removed everything it covers, the id-less checkpoint included.
            expect(trimState(f).boundary).toBe(f.rows[replies[6]!]!.id);
            expect(second.draft.messages.map((message) => message.id)).not.toContain(
                f.rows[replies[0]!]!.id,
            );
            expect(second.logs.some((line) => line.includes("recovery request admitted"))).toBe(
                true,
            );
            expect(recoveryArmed(f)).toBeNull();
        } finally {
            historian.spy.mockRestore();
            await f.cleanup();
        }
    }, 120_000);

    test("when recovery cannot make room, identical sends stop calling the historian and are refused for good", async () => {
        const { f, boundaryId } = await uncutSession(89_821);
        const historian = stubHistorian(f, []);
        try {
            f.user("Please continue with the review.", 60_000);
            const outcomes: Array<{ message: string | undefined; state: unknown }> = [];
            for (let pass = 0; pass < 6; pass++) {
                const attempt = await f.attempt();
                if (attempt.error && !refusal(attempt.error))
                    throw new Error(
                        `pass ${pass}: unexpected failure ${String(attempt.error)}\n${attempt.logs.join("\n")}`,
                    );
                outcomes.push({
                    message: refusal(attempt.error)?.message,
                    state: trimState(f),
                });
            }
            // The first refusal arms recovery; the second pass runs it once.
            expect(outcomes[0]!.message).toEndWith("(MC-H08)");
            expect(historian.runs()).toBe(1);
            // From then on every identical send is refused with a remedy that
            // changes the state, and no further summarizer call is made.
            for (const outcome of outcomes.slice(1)) {
                expect(outcome.message).toContain("/ctx-flush");
                expect(outcome.message).toEndWith("(MC-H04)");
            }
            expect(
                new Set(outcomes.slice(1).map((outcome) => JSON.stringify(outcome.state))).size,
            ).toBe(1);
            expect(trimState(f).boundary).toBe(boundaryId);

            // Something changes (a new message): recovery is worth one more run.
            f.user("One more thing to review.", 60_000);
            await f.attempt();
            expect(historian.runs()).toBe(2);
        } finally {
            historian.spy.mockRestore();
            await f.cleanup();
        }
    }, 120_000);
});
