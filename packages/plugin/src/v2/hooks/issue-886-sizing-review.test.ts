import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { updateSessionMeta } from "../../features/magic-context/storage";
import {
    hostInstructionRetentionEnabled,
    setHostInstructionRetentionEnabledForTests,
} from "../../features/magic-context/storage-host-instruction-retention";
import { markProtectedTailPolicyV3Seeded } from "../../features/magic-context/storage-meta-persisted";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import * as finalWire from "../../hooks/magic-context/final-wire-token-estimate";
import * as pricedPassSizing from "../../hooks/magic-context/priced-pass-sizing";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { oc2ContextFixture as fixture, prose } from "./__tests__/oc2-context.fixture";

// A pass that the provider has not measured sizes itself from a local count of
// the request it is about to serve (servedRequestForSizing). The postprocess
// phase decides later what that request holds: it clears reasoning only on a
// pass with rebuild permission whose routine cleanup runs, it removes, on every
// pass, the reasoning that earlier passes removed, and a pass that folds renders
// a new history head. The first two tests compare the sizing count of a later
// priced pass with the count of the request that pass served, in two cases where
// a projection made at the start of the pass would differ from those decisions.
// The third covers the history head the sizing counts on a model switch.
//
// The model reports no usage, so every pass the provider has not measured is
// sized from a local count. A
// 5,000-token execute threshold makes the scheduler decide "execute" from the
// local count of the last served request, so the second pass is priced and
// sized, but it has no rebuild ride (no fold, no history refresh, no flush, no
// force band, no queued drops).
//
// A test whose setup no longer reaches the sized pass fails with its logs.
const LIMIT = { context: 1_000_000, input: 302_222, output: 65_536 };
const SETTINGS = {
    execute_threshold_tokens: { default: 5_000 },
    execute_threshold_percentage: 80,
    history_budget_percentage: 0.1,
};

function reasoningTokens(messages: readonly MessageLike[]): number {
    let total = 0;
    for (const message of messages)
        for (const raw of message.parts) {
            const part = raw as { type?: string; text?: string };
            if (part.type === "reasoning" && typeof part.text === "string")
                total += estimateTokens(part.text);
        }
    return total;
}

/** Tokens of OpenCode 2 instruction-update rows (id-less system messages). */
function instructionTokens(messages: readonly MessageLike[]): number {
    let total = 0;
    for (const message of messages)
        if (message.info.role === "system")
            for (const raw of message.parts) {
                const part = raw as { text?: string };
                if (typeof part.text === "string") total += estimateTokens(part.text);
            }
    return total;
}

const shellStep = (n: number) => ({
    name: "shell",
    input: { command: `cd /srv/bridge && sed -n '1,40p' records/record-${n}.json` },
    output: prose.repeat(20),
});

interface SecondPass {
    sized: number;
    served: number;
    sizedReasoning: number;
    servedReasoning: number;
    sizedInstructions: number;
    servedInstructions: number;
    secondPassLogs: string[];
}

/**
 * Builds the session with `before`, runs the first (first-render) pass, adds
 * `between`, runs the priced second pass, and reads the third pass's local
 * count of the request the second pass served.
 */
async function secondPricedPass(
    seed: number,
    before: (f: Awaited<ReturnType<typeof fixture>>) => void,
    between: (f: Awaited<ReturnType<typeof fixture>>) => void,
): Promise<SecondPass> {
    const f = await fixture(seed, {
        area: "issue-886-sizing-review",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
        historian: true,
        instructions: false,
        protectedTokens: 16_000,
        configOverrides: SETTINGS,
    });
    markProtectedTailPolicyV3Seeded(f.db, f.session, 1);
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        updateSessionMeta(f.db, deps.sessionId, { compartmentInProgress: false });
    });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        before(f);
        await f.pass();
        between(f);
        // Counted when each call is made: the postprocess phase later edits the
        // same message objects in place.
        const calls: Array<{
            reasoning: number;
            instructions: number;
            pressureTokens: number | undefined;
        }> = [];
        const original = finalWire.estimateFinalWireInputTokens;
        const spy = spyOn(finalWire, "estimateFinalWireInputTokens").mockImplementation((input) => {
            const reasoning = reasoningTokens(input.messages);
            const instructions = instructionTokens(input.messages);
            const result = original(input);
            calls.push({ reasoning, instructions, pressureTokens: result.pressureTokens });
            return result;
        });
        let second: Awaited<ReturnType<typeof f.pass>>;
        try {
            second = await f.pass();
        } finally {
            spy.mockRestore();
        }
        f.respondWithTool(shellStep(999), 0, "ok");
        const third = await f.pass();
        const sized =
            /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+).* pressureTokens=(\d+)/.exec(
                second.logs.join("\n"),
            );
        const served =
            /local count of the last served request percentage=([\d.]+) inputTokens=(\d+)/.exec(
                third.logs.join("\n"),
            );
        // The count the pass was sized from; the last call counts the request it returns.
        const sizing = sized
            ? calls.slice(0, -1).findLast((call) => call.pressureTokens === Number(sized[3]))
            : undefined;
        if (!sized || !served || !sizing || calls.length < 2) {
            throw new Error(
                `setup: the second pass was not sized from a local count:\n${[...second.logs, ...third.logs].join("\n")}`,
            );
        }
        return {
            sized: Number(sized[1]),
            served: Number(served[2]),
            sizedReasoning: sizing.reasoning,
            servedReasoning: calls.at(-1)!.reasoning,
            sizedInstructions: sizing.instructions,
            servedInstructions: calls.at(-1)!.instructions,
            secondPassLogs: second.logs,
        };
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        agent.mockRestore();
        await f.cleanup();
    }
}

// A priced pass with no rebuild ride clears no reasoning, so the request it
// serves still carries every step's reasoning. A count that left out everything
// past the 10,000-token keep budget would read low.
test("a priced pass that clears no reasoning is sized with the reasoning it serves", async () => {
    const result = await secondPricedPass(
        8886,
        (f) => {
            f.user("Process the next batch of records, following the playbook.", 60_000);
            for (let step = 0; step < 10; step++) f.respondWithTool(shellStep(step), 0, "ok");
        },
        (f) => {
            // Thirty reasoning-heavy steps (about 1,000 tokens of reasoning each).
            for (let step = 10; step < 40; step++)
                f.respondWithTool(shellStep(step), 0, `${step}: ${prose.repeat(50)}`);
        },
    );
    console.log(
        `ISSUE886_REVIEW_UNCLEARED ${JSON.stringify({ ...result, secondPassLogs: result.secondPassLogs.filter((line) => /rewrite permission|priced pass|reasoning (removal|cleanup)/.test(line)) })}`,
    );
    expect(result.sizedReasoning).toBe(result.servedReasoning);
    const ratio = result.sized / result.served;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
}, 300_000);

// On a provider other than canonical Anthropic, reasoning is removed by
// message id, and every later pass removes the same ids again at the end of
// its postprocess phase. When the reasoning that is left fits the keep budget,
// the keep-budget projection finds no step to clear (its cutoff is tag 0), so
// the count must take the removed reasoning out by id, or it reads high.
test("a priced pass is sized without the reasoning earlier passes removed", async () => {
    const result = await secondPricedPass(
        8887,
        (f) => {
            f.user("Process the next batch of records, following the playbook.", 60_000);
            // Twenty steps of about 3,000 tokens of reasoning: the first pass keeps
            // the newest three and removes the rest.
            for (let step = 0; step < 20; step++)
                f.respondWithTool(shellStep(step), 0, `${step}: ${prose.repeat(150)}`);
        },
        (f) => {
            // One more step with almost no reasoning: what is left still fits.
            f.respondWithTool(shellStep(20), 0, "ok");
        },
    );
    console.log(
        `ISSUE886_REVIEW_REMOVED ${JSON.stringify({ ...result, secondPassLogs: result.secondPassLogs.filter((line) => /rewrite permission|priced pass|reasoning (removal|cleanup)/.test(line)) })}`,
    );
    expect(result.sizedReasoning).toBe(result.servedReasoning);
    const ratio = result.sized / result.served;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
}, 300_000);

// OpenCode 2 serves instruction rows that the history summary covers once the
// session's retention switch is on, and a pass turns the switch on only when it
// may rewrite its whole prefix. A session served before the switch existed has
// it off; its next priced pass without a rebuild ride (here an execute pass)
// still serves no covered rows, so its count must not include them.
test("a priced pass that may not rewrite its prefix is sized without the covered instruction rows it does not serve", async () => {
    // The covered rows each sizing is given once the switch is available.
    const coveredRows: number[] = [];
    const realSizing = pricedPassSizing.servedRequestForSizing;
    const sizing = spyOn(pricedPassSizing, "servedRequestForSizing").mockImplementation(
        (input, plan) => {
            if (hostInstructionRetentionEnabled())
                coveredRows.push(input.coveredInstructions.length);
            return realSizing(input, plan);
        },
    );
    try {
        const result = await secondPricedPass(
            8889,
            (f) => {
                // Serve the first pass as releases before the switch did.
                setHostInstructionRetentionEnabledForTests(false);
                for (let n = 0; n < 4; n++)
                    f.instruction(
                        `Instructions from AGENTS.md (revision ${n}):\n${prose.repeat(150)}`,
                    );
                f.user("Earlier batch.", 60_000);
                f.respond(3);
                const served = f.rows.flatMap((row, index) =>
                    row.type === "system" ? [] : [index],
                );
                const last = f.rows.length - 1;
                appendCompartments(
                    f.db,
                    f.session,
                    Array.from({ length: 4 }, (_, n) => {
                        const start = served[Math.floor((n * served.length) / 4)]!;
                        const end =
                            n === 3 ? last : served[Math.floor(((n + 1) * served.length) / 4) - 1]!;
                        return {
                            sequence: n,
                            startMessage: start + 1,
                            endMessage: end + 1,
                            startMessageId: f.rows[start]!.id,
                            endMessageId: f.rows[end]!.id,
                            title: `Batch ${n}`,
                            content: prose.repeat(60),
                            p1: prose.repeat(40),
                            p2: prose.repeat(20),
                            p3: prose.repeat(6),
                            p4: "Processed a batch.",
                        };
                    }),
                );
                f.user("Process the next batch of records, following the playbook.", 60_000);
                for (let step = 0; step < 10; step++) f.respondWithTool(shellStep(step), 0, "ok");
            },
            (f) => {
                setHostInstructionRetentionEnabledForTests(true);
                for (let step = 10; step < 20; step++) f.respondWithTool(shellStep(step), 0, "ok");
            },
        );
        console.log(
            `ISSUE886_REVIEW_COVERED_ROWS ${JSON.stringify({ ...result, secondPassLogs: result.secondPassLogs.filter((line) => /rewrite permission|priced pass/.test(line)) })}`,
        );
        expect(
            result.secondPassLogs.some((line) => /rewrite permission: allowed=false/.test(line)),
        ).toBe(true);
        // The summary covers the four instruction rows, and the pass leaves them out.
        expect(coveredRows.some((count) => count === 4)).toBe(true);
        expect(result.servedInstructions).toBe(0);
        expect(result.sizedInstructions).toBe(result.servedInstructions);
        const ratio = result.sized / result.served;
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
    } finally {
        sizing.mockRestore();
        setHostInstructionRetentionEnabledForTests(true);
    }
}, 300_000);

// A model switch clears the provider reading, so the switch pass is sized from
// a local count. The pass folds (model change), and the fold renders m[0] at
// the new model's history budget, not the persisted head rendered at the old
// model's budget. Switching to a smaller window, a count of the persisted head
// would read a head several times the one the pass serves.
test("a model switch to a smaller window is sized with the head the switch pass serves", async () => {
    const BIG = {
        providerID: "opencode-go",
        id: "big-window",
        limit: { context: 1_000_000, output: 65_536 },
    };
    const SMALL = {
        providerID: "opencode-go",
        id: "small-window",
        limit: { context: 200_000, output: 32_000 },
    };
    const f = await fixture(8888, {
        area: "issue-886-sizing-review",
        provider: BIG.providerID,
        model: BIG.id,
        limit: BIG.limit,
        historian: true,
        instructions: false,
        protectedTokens: 16_000,
        configOverrides: { execute_threshold_percentage: 65, history_budget_percentage: 0.15 },
    });
    markProtectedTailPolicyV3Seeded(f.db, f.session, 1);
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        updateSessionMeta(f.db, deps.sessionId, { compartmentInProgress: false });
    });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        // The seeded history is summarized into twelve large compartments, enough
        // to fill the big model's history budget.
        const last = f.rows.length - 1;
        appendCompartments(
            f.db,
            f.session,
            Array.from({ length: 12 }, (_, n) => {
                const start = Math.floor((n * f.rows.length) / 12);
                const end = n === 11 ? last : Math.floor(((n + 1) * f.rows.length) / 12) - 1;
                return {
                    sequence: n,
                    startMessage: start + 1,
                    endMessage: end + 1,
                    startMessageId: f.rows[start]!.id,
                    endMessageId: f.rows[end]!.id,
                    title: `Batch ${n}`,
                    content: prose.repeat(400),
                    p1: prose.repeat(200),
                    p2: prose.repeat(60),
                    p3: prose.repeat(6),
                    p4: "Processed a batch.",
                };
            }),
        );
        f.user("Process the next batch of records, following the playbook.", 60_000);
        for (let step = 0; step < 64; step++)
            f.respondWithTool({ ...shellStep(step), output: prose.repeat(80) }, 0, "ok");
        const onBig = await f.pass();
        const small = (draft: { model: unknown }) => {
            draft.model = structuredClone(SMALL);
        };
        f.setModel(SMALL.id);
        f.respondWithTool(shellStep(64), 0, "ok");
        const heads: number[] = [];
        const original = finalWire.estimateFinalWireInputTokens;
        const spy = spyOn(finalWire, "estimateFinalWireInputTokens").mockImplementation((input) => {
            let head = 0;
            for (const message of input.messages)
                if ((message.info as { syntheticHead?: boolean }).syntheticHead === true)
                    for (const part of message.parts)
                        head += estimateTokens((part as { text?: string }).text ?? "");
            heads.push(head);
            return original(input);
        });
        let switched: Awaited<ReturnType<typeof f.pass>>;
        try {
            switched = await f.pass(small as never);
        } finally {
            spy.mockRestore();
        }
        f.respondWithTool(shellStep(65), 0, "ok");
        const next = await f.pass(small as never);
        const sized =
            /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                switched.logs.join("\n"),
            );
        const served =
            /local count of the last served request percentage=([\d.]+) inputTokens=(\d+)/.exec(
                next.logs.join("\n"),
            );
        if (!sized || !served || heads.length < 2) {
            throw new Error(
                `setup: the switch pass was not sized from a local count:\n${[...onBig.logs, ...switched.logs, ...next.logs].join("\n")}`,
            );
        }
        console.log(
            `ISSUE886_REVIEW_SWITCH ${JSON.stringify({
                sized: { tokens: Number(sized[1]), percentage: Number(sized[2]) },
                served: { tokens: Number(served[2]), percentage: Number(served[1]) },
                sizedHeads: heads.slice(0, -1),
                servedHead: heads.at(-1),
                decisions: switched.logs.filter(
                    (line) =>
                        !line.includes("transform stages:") &&
                        /injected m\[0\]|emergency|force|rewrite permission|pending ops|dropped|priced pass/i.test(
                            line,
                        ),
                ),
            })}`,
        );
        // Without the stale head the request is about 74% of the new window, under
        // the 95% line a local count needs for the tiered emergency tool drop.
        expect(switched.logs.some((line) => /emergency tiered drop: tiered drop/.test(line))).toBe(
            false,
        );
        const ratio = Number(sized[1]) / Number(served[2]);
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        agent.mockRestore();
        await f.cleanup();
    }
}, 300_000);
