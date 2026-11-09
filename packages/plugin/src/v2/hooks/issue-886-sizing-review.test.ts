import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { updateSessionMeta } from "../../features/magic-context/storage";
import { markProtectedTailPolicyV3Seeded } from "../../features/magic-context/storage-meta-persisted";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import * as finalWire from "../../hooks/magic-context/final-wire-token-estimate";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { oc2ContextFixture as fixture, prose } from "./__tests__/oc2-context.fixture";

// A pass that the provider has not measured sizes itself from a local count of
// the request it is about to serve (servedRequestForSizing). That projection
// leaves out the reasoning past the keep budget on every priced pass. The
// postprocess phase decides separately what it clears: it clears reasoning only
// on a pass with rebuild permission whose routine cleanup runs, and it removes,
// on every pass, the reasoning that earlier passes removed. The first two tests
// compare the sizing count of a later priced pass with the count of the request
// that pass served, in two cases where the two decisions differ. The third
// covers the history head the sizing counts on a model switch.
//
// The model reports no usage, so every pass the provider has not measured is
// sized from a local count. A
// 5,000-token execute threshold makes the scheduler decide "execute" from the
// local count of the last served request, so the second pass is priced and
// sized, but it has no rebuild ride (no fold, no history refresh, no flush, no
// force band, no queued drops).
//
// Each test is expected to fail until the sizing counts what its pass serves;
// a fix flips it to `test`. A test whose setup no longer reaches the sized pass
// returns without failing, so `test.failing` reports it too.

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
): Promise<SecondPass | undefined> {
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
        const calls: Array<{ reasoning: number }> = [];
        const original = finalWire.estimateFinalWireInputTokens;
        const spy = spyOn(finalWire, "estimateFinalWireInputTokens").mockImplementation((input) => {
            calls.push({ reasoning: reasoningTokens(input.messages) });
            return original(input);
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
            /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                second.logs.join("\n"),
            );
        const served =
            /local count of the last served request percentage=([\d.]+) inputTokens=(\d+)/.exec(
                third.logs.join("\n"),
            );
        if (!sized || !served || calls.length < 2) {
            console.error(
                `setup: the second pass was not sized from a local count:\n${[...second.logs, ...third.logs].join("\n")}`,
            );
            return undefined;
        }
        return {
            sized: Number(sized[1]),
            served: Number(served[2]),
            // The first call sizes the pass; the last counts the request it returns.
            sizedReasoning: calls[0]!.reasoning,
            servedReasoning: calls.at(-1)!.reasoning,
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
// serves still carries every step's reasoning. The sizing count leaves out
// everything past the 10,000-token keep budget anyway and reads low.
test.failing("a priced pass that clears no reasoning is sized with the reasoning it serves", async () => {
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
    if (!result) return;
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
// its postprocess phase. The sizing array still holds that reasoning. When the
// reasoning that is left fits the keep budget, the projection finds no step to
// clear (its keep-budget cutoff is tag 0), so the count keeps every removed
// step and reads high.
test.failing("a priced pass is sized without the reasoning earlier passes removed", async () => {
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
    if (!result) return;
    console.log(
        `ISSUE886_REVIEW_REMOVED ${JSON.stringify({ ...result, secondPassLogs: result.secondPassLogs.filter((line) => /rewrite permission|priced pass|reasoning (removal|cleanup)/.test(line)) })}`,
    );
    expect(result.sizedReasoning).toBe(result.servedReasoning);
    const ratio = result.sized / result.served;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
}, 300_000);

// A model switch clears the provider reading, so the switch pass is sized from
// a local count. The pass folds (model change), and the fold renders m[0] at
// the new model's history budget. The sizing counts the persisted head, which
// was rendered at the old model's budget. Switching to a smaller window
// therefore counts a head several times the one the pass serves.
test.failing("a model switch to a smaller window is sized with the head the switch pass serves", async () => {
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
            console.error(
                `setup: the switch pass was not sized from a local count:\n${[...onBig.logs, ...switched.logs, ...next.logs].join("\n")}`,
            );
            return;
        }
        console.log(
            `ISSUE886_REVIEW_SWITCH ${JSON.stringify({
                sized: { tokens: Number(sized[1]), percentage: Number(sized[2]) },
                served: { tokens: Number(served[2]), percentage: Number(served[1]) },
                sizedHead: heads[0],
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
