import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import { updateSessionMeta } from "../../features/magic-context/storage";
import {
    incrementHistorianFailure,
    markProtectedTailPolicyV3Seeded,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import * as storageTags from "../../features/magic-context/storage-tags";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import * as finalWire from "../../hooks/magic-context/final-wire-token-estimate";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import * as tagOwnerWarmup from "../../hooks/magic-context/tag-owner-warmup";
import { setOutputReserveConfig } from "../../shared/models-dev-cache";
import { oc2ContextFixture as fixture, prose } from "./__tests__/oc2-context.fixture";

// Issue 886, second part: why an OpenCode 2 session with a 250,000-token
// execute threshold sits at 85-87% and why summaries and drops do not bring it
// under. The session below has the reporter's settings and shape: model
// `opencode-go/deepseek-v4.1-flash` with `limit.input` 302,222 inside a
// 1,000,000-token context, `execute_threshold_tokens` 250,000,
// `history_budget_percentage` 0.1, `protected_tokens` 16,000, a summarized
// history head, four OpenCode 2 instruction-update rows inside the summarized
// range, and one batch turn of 80 shell steps with reasoning and short output.

const LIMIT = { context: 1_000_000, input: 302_222, output: 65_536 };
/** The window provider readings are a percentage of: the model's input limit. */
const INPUT_WINDOW = 302_222;
/** An output reserve that narrows that window below the hard wall. */
const RESERVE = 100_000;
const SETTINGS = {
    execute_threshold_tokens: { default: 250_000 },
    execute_threshold_percentage: 80,
    history_budget_percentage: 0.1,
};
const STEPS = 80;

interface Composition {
    /** The two history messages Magic Context puts at the head of the request (m[0] and m[1]). */
    head: number;
    /** OpenCode 2 instruction-update rows (id-less system messages). */
    instructions: number;
    text: number;
    reasoning: number;
    toolInput: number;
    toolOutput: number;
    messages: number;
}

function count(value: unknown): number {
    if (typeof value === "string") return estimateTokens(value);
    return value === undefined ? 0 : estimateTokens(JSON.stringify(value));
}

/** Tokens per kind of content in a transform-side message array. */
function composition(messages: readonly MessageLike[]): Composition {
    const out: Composition = {
        head: 0,
        instructions: 0,
        text: 0,
        reasoning: 0,
        toolInput: 0,
        toolOutput: 0,
        messages: messages.length,
    };
    for (const message of messages) {
        const head = (message.info as { syntheticHead?: boolean }).syntheticHead === true;
        for (const raw of message.parts) {
            const part = raw as {
                type?: string;
                text?: string;
                state?: { input?: unknown; output?: unknown };
            };
            if (head) out.head += count(part.text);
            else if (message.info.role === "system") out.instructions += count(part.text);
            else if (part.type === "text") out.text += count(part.text);
            else if (part.type === "reasoning") out.reasoning += count(part.text);
            else if (part.type === "tool") {
                out.toolInput += count(part.state?.input);
                out.toolOutput += count(part.state?.output);
            }
        }
    }
    return out;
}

/** A shell step of the batch turn: a short command, a few hundred tokens of output, some reasoning. */
const shellStep = (n: number) => ({
    name: "shell",
    input: { command: `cd /srv/bridge && sed -n '1,40p' records/record-${n}.json` },
    output: prose.repeat(6 + (n % 5)),
});

async function reporterSession(seed: number, inputTokens: number) {
    const f = await fixture(seed, {
        area: "issue-886-threshold",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
        historian: true,
        instructions: false,
        protectedTokens: 16_000,
        configOverrides: SETTINGS,
    });
    // A long-lived session had its protected-tail policy seeded long ago; mark it
    // seeded so the trigger reads the tail the same way.
    markProtectedTailPolicyV3Seeded(f.db, f.session, 1);
    // Instruction updates the host stored during earlier batches (about 3k tokens each).
    for (let n = 0; n < 4; n++)
        f.instruction(`Instructions from AGENTS.md (revision ${n}):\n${prose.repeat(150)}`);
    f.user("Earlier batch.", 60_000);
    f.respond(3);
    // Earlier batches are summarized into twelve compartments of about 3k tokens.
    const served = f.rows.flatMap((row, index) => (row.type === "system" ? [] : [index]));
    const last = f.rows.length - 1;
    appendCompartments(
        f.db,
        f.session,
        Array.from({ length: 12 }, (_, n) => {
            const start = served[Math.floor((n * served.length) / 12)]!;
            const end = n === 11 ? last : served[Math.floor(((n + 1) * served.length) / 12) - 1]!;
            return {
                sequence: n,
                startMessage: start + 1,
                endMessage: end + 1,
                startMessageId: f.rows[start]!.id,
                endMessageId: f.rows[end]!.id,
                title: `Batch ${n}`,
                content: prose.repeat(110),
                p1: prose.repeat(80),
                p2: prose.repeat(40),
                p3: prose.repeat(6),
                p4: "Processed a batch.",
            };
        }),
    );
    f.user("Process the next batch of records, following the playbook.", 60_000);
    for (let step = 0; step < STEPS; step++)
        f.respondWithTool(shellStep(step), inputTokens, `${step}: ${prose.repeat(10)}`);
    return f;
}

type BoundarySnapshot = Parameters<typeof incremental.runCompartmentAgent>[0]["boundarySnapshot"];

/**
 * Run `body` with the historian's model call stubbed out (a run only clears the
 * in-progress flag, as the real runner does when it ends) and with the real
 * protected-tail boundary: under NODE_ENV=test the trigger uses a canned one.
 */
async function withSession<T>(
    f: Awaited<ReturnType<typeof reporterSession>>,
    body: (runs: BoundarySnapshot[]) => Promise<T>,
): Promise<T> {
    const runs: BoundarySnapshot[] = [];
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        runs.push(deps.boundarySnapshot);
        updateSessionMeta(f.db, deps.sessionId, { compartmentInProgress: false });
    });
    const previousNodeEnv = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = "production";
        return await body(runs);
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        agent.mockRestore();
        await f.cleanup();
    }
}

interface LocalCountPasses {
    /** "unknown provider usage; using wire estimate" on the first, priced pass. */
    sized: { inputTokens: number; percentage: number };
    /** The next pass's reading of the request the first pass served. */
    served: { inputTokens: number; percentage: number };
    /** What the pass counted when it sized itself, and what it then served. */
    countedArray: Composition;
    servedArray: Composition;
    logs: string[];
}

/**
 * A provider that has reported no usage yet: the first pass is priced (it
 * renders the history head) and sizes itself from a local count; the next pass
 * reads the local count of the request the first one served.
 */
async function localCountPasses(seed = 8862): Promise<LocalCountPasses> {
    const f = await reporterSession(seed, 0);
    return withSession(f, async () => {
        const arrays: Array<{ messages: Composition; pressureTokens: number | undefined }> = [];
        const original = finalWire.estimateFinalWireInputTokens;
        const spy = spyOn(finalWire, "estimateFinalWireInputTokens").mockImplementation((input) => {
            const messages = composition(input.messages);
            const result = original(input);
            arrays.push({ messages, pressureTokens: result.pressureTokens });
            return result;
        });
        try {
            const first = await f.pass();
            const firstPassCalls = arrays.slice();
            f.respondWithTool(shellStep(STEPS), 0, prose.repeat(10));
            const second = await f.pass();
            const logs = [...first.logs, ...second.logs];
            const sized =
                /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+).* pressureTokens=(\d+)/.exec(
                    first.logs.join("\n"),
                );
            const served =
                /local count of the last served request percentage=([\d.]+) inputTokens=(\d+)/.exec(
                    second.logs.join("\n"),
                );
            // The count the pass was sized from precedes the postprocess phase;
            // the next call counts the array the pass returns (the final-wire
            // estimate).
            const counted = sized
                ? firstPassCalls
                      .slice(0, -1)
                      .findLast((call) => call.pressureTokens === Number(sized[3]))
                : undefined;
            if (!sized || !served || !counted)
                throw new Error(`expected readings missing:\n${logs.join("\n")}`);
            const countedArray = counted.messages;
            const servedArray = firstPassCalls[firstPassCalls.indexOf(counted) + 1]!.messages;
            return {
                sized: { inputTokens: Number(sized[1]), percentage: Number(sized[2]) },
                served: { inputTokens: Number(served[2]), percentage: Number(served[1]) },
                countedArray,
                servedArray,
                logs,
            };
        } finally {
            spy.mockRestore();
        }
    });
}

let localCount: Promise<LocalCountPasses> | undefined;
const localCountResult = () => {
    localCount ??= localCountPasses();
    return localCount;
};

test("a pass sized from a local count counts the history head, the instruction rows and the reasoning it serves", async () => {
    const result = await localCountResult();
    console.log(
        `ISSUE886_LOCAL_COUNT ${JSON.stringify({ sized: result.sized, served: result.served, countedArray: result.countedArray, servedArray: result.servedArray, sizing: result.logs.filter((line) => /priced pass|priced-pass sizing/.test(line)) })}`,
    );
    // The pass is sized before it puts the two history messages at the head
    // (m[0] and m[1]), serves the covered instruction rows again and clears old
    // reasoning. The count that sizes it includes the head and those rows, and
    // leaves out the reasoning the pass then clears.
    expect(result.servedArray.head).toBeGreaterThan(15_000);
    expect(result.servedArray.instructions).toBeGreaterThan(10_000);
    expect(result.countedArray.head).toBe(result.servedArray.head);
    expect(result.countedArray.instructions).toBe(result.servedArray.instructions);
    expect(result.countedArray.reasoning).toBe(result.servedArray.reasoning);
}, 300_000);

// A provider reading is a percentage of the window the model's limits leave
// for input, so a local count of the same request reads against that window
// too, not against the hard wall the two 95% lines read. A configured output
// reserve makes the two differ on the input-limit model: readings are a share
// of 302,222 less the 100,000-token reserve, while the hard wall stays at the
// input limit.
test("a pass sized from a local count reads it against the window provider readings use, not the hard wall", async () => {
    const f = await fixture(8868, {
        area: "issue-886-threshold",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
        configOverrides: { output_reserve: RESERVE },
    });
    try {
        f.user(`Review these records:\n${prose.repeat(300)}`, 60_000);
        f.respond(1, 0);
        const first = await f.pass();
        const sized =
            /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                first.logs.join("\n"),
            );
        if (!sized) throw new Error(`no local count:\n${first.logs.join("\n")}`);
        const tokens = Number(sized[1]);
        const percentage = Number(sized[2]);
        expect(Math.abs(percentage - (tokens / (INPUT_WINDOW - RESERVE)) * 100)).toBeLessThan(0.1);
        // Read against the hard wall it would be a third lower.
        expect(Math.abs(percentage - (tokens / INPUT_WINDOW) * 100)).toBeGreaterThan(0.5);
    } finally {
        setOutputReserveConfig(undefined);
        await f.cleanup();
    }
}, 300_000);

// The sizing count is within ten percent of the next pass's count of the
// request the pass served.
test("a pass sized from a local count counts the request it serves", async () => {
    const result = await localCountResult();
    const ratio = result.sized.inputTokens / result.served.inputTokens;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
}, 300_000);

// A session's tag ownership summary can still be in preparation off-thread
// when the pass is sized, and ready by the time the postprocess phase clears
// reasoning. The count projects that clearing from the pass's own tags.
test("a pass sized while the tag ownership summary is being prepared leaves out the reasoning the pass clears", async () => {
    // Only the sizing sees the summary as not ready; the postprocess phase,
    // later in the same pass, reads it ready. That phase waits only 250 ms for
    // the off-thread preparation and clears nothing when it is not done by then,
    // which a loaded test host can hit; here it waits until the preparation is
    // done, so the pass always clears.
    const realEstimates = storageTags.getReasoningTokenEstimatesByMessage;
    let sizingReads = 0;
    const estimates = spyOn(storageTags, "getReasoningTokenEstimatesByMessage").mockImplementation(
        (...args) => {
            if (new Error().stack?.includes("priced-pass-sizing")) {
                sizingReads += 1;
                throw new storageTags.TagOwnerSummaryNotReady();
            }
            return realEstimates(...args);
        },
    );
    const realWait = tagOwnerWarmup.waitForTagOwners;
    const wait = spyOn(tagOwnerWarmup, "waitForTagOwners").mockImplementation(
        (db, sessionId, ratio) => realWait(db, sessionId, ratio, 120_000),
    );
    try {
        const result = await localCountPasses(8869);
        expect(sizingReads).toBeGreaterThan(0);
        expect(result.servedArray.head).toBeGreaterThan(15_000);
        // The pass cleared the reasoning past the keep budget (17,040 tokens
        // before it).
        expect(result.servedArray.reasoning).toBeLessThan(12_000);
        expect(result.countedArray.head).toBe(result.servedArray.head);
        expect(result.countedArray.instructions).toBe(result.servedArray.instructions);
        expect(result.countedArray.reasoning).toBe(result.servedArray.reasoning);
        const ratio = result.sized.inputTokens / result.served.inputTokens;
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
    } finally {
        wait.mockRestore();
        estimates.mockRestore();
    }
}, 300_000);

test("first pass after a restart and 1h41m idle with a saved 83.9% reading", async () => {
    const saved = 253_564; // 83.9% of 302,222
    const f = await reporterSession(8863, saved);
    await withSession(f, async () => {
        await f.pass();
        f.respondWithTool(shellStep(STEPS), saved, prose.repeat(3));
        const before = await f.pass();
        f.respond(2, saved);
        f.idle(101 / 60);
        await f.restart();
        f.user("Process the next batch of records, following the playbook.", 1000);
        const first = await f.pass();
        const unchangedPrefix = before.draft.messages.every(
            (message, index) =>
                JSON.stringify(message) === JSON.stringify(first.draft.messages[index]),
        );
        console.log(
            `ISSUE886_RESTART ${JSON.stringify({ unchangedPrefix, logs: first.logs.filter((line) => !line.includes("transform stages")) })}`,
        );
        // 0.49.44 decides "execute" from the saved reading (issue 882); every
        // other pressure check on the pass keeps the cleared reading.
        expect(first.logs.some((line) => /saved reading 83\.9% is at or above/.test(line))).toBe(
            true,
        );
        expect(
            first.logs.some((line) => /transform scheduler: .*decision=execute/.test(line)),
        ).toBe(true);
    });
}, 300_000);

test("force band in the reporter's shape: what the summary tail and the drop protection window measure", async () => {
    const f = await reporterSession(8864, 262_504); // 86.9% of 302,222
    await withSession(f, async (runs) => {
        // At 86.9% (the force band starts at 85%) the trigger starts a summary run
        // in the background. The first pass after the hook starts may still be
        // numbering the stored messages and skip the trigger, so take a few steps
        // until a run reaches the historian.
        const passLogs: string[] = [];
        for (let step = 0; step < 4 && runs.length === 0; step++) {
            if (step > 0) f.respondWithTool(shellStep(STEPS + step), 262_504, prose.repeat(10));
            passLogs.push(...(await f.pass()).logs);
            for (let attempt = 0; attempt < 400 && runs.length === 0; attempt++) await Bun.sleep(5);
        }
        const first = { logs: passLogs };
        const window = getProtectionWindowForSession(f.db, f.session, 16_000);
        const tools = f.db
            .prepare(
                "SELECT tag_number AS tag, token_count AS output, input_token_count AS input FROM tags WHERE session_id = ? AND type = 'tool'",
            )
            .all(f.session) as Array<{ tag: number; output: number; input: number }>;
        const snapshot = runs[0];
        console.log(
            `ISSUE886_FORCE ${JSON.stringify({
                tail: {
                    N: snapshot?.N,
                    offset: snapshot?.offset,
                    protectedTailStart: snapshot?.protectedTailStart,
                    rawMessages: snapshot?.rawMessageCountAtTrigger,
                    eligibleTokens: snapshot?.trueRawEligibleTokens,
                    eligibleTextAndInputs: snapshot?.summaryRemovedEligibleTokens,
                    target: snapshot?.diagnostics?.tailTarget,
                },
                protection: {
                    cutoff: window.cutoff,
                    protectedTools: window.status.protectedCount,
                    toolTags: tools.length,
                    protectedOutputs: window.status.protectedMass,
                    allOutputs: tools.reduce((sum, row) => sum + row.output, 0),
                    allInputs: tools.reduce((sum, row) => sum + (row.input ?? 0), 0),
                },
                logs: first.logs.filter(
                    (line) =>
                        /trigger|emergency|scheduler|saved provider reading/.test(line) &&
                        !line.includes("transform stages"),
                ),
            })}`,
        );
        // The summary tail keeps the newest 12,000 tokens (the floor at 86.9%);
        // its size walk counts tool output and reasoning, while the per-run cap
        // counts only text and tool inputs.
        expect(snapshot?.N).toBe(12_000);
        expect(snapshot!.trueRawEligibleTokens).toBeGreaterThan(
            5 * snapshot!.summaryRemovedEligibleTokens,
        );
        // `protected_tokens` is a mass of tool output alone: with short shell
        // output, 16,000 tokens of it protect every tool call of the turn.
        expect(window.status.protectedCount).toBe(tools.length);
        expect(
            first.logs.some((line) => /emergency tiered drop skipped: no-candidates/.test(line)),
        ).toBe(true);
    });
}, 300_000);

// A pass sized from a local count and a pass with a provider reading of the
// same token total read the same percentage, with and without a declared input
// limit: the execute threshold and the force band are percentages of the
// window provider readings use, so a local count read against a larger window
// executes late on exactly the passes that have no provider reading.
const WINDOW_CASES: Array<{
    name: string;
    provider: string;
    model: string;
    limit: { context: number; input?: number; output: number };
    settings?: Record<string, unknown>;
}> = [
    {
        name: "Anthropic 200k/64k",
        provider: "anthropic",
        model: "claude-sonnet-4",
        limit: { context: 200_000, output: 64_000 },
    },
    {
        name: "Codex 272k/128k",
        provider: "openai",
        model: "gpt-5-codex",
        limit: { context: 272_000, output: 128_000 },
    },
    {
        name: "input limit 302,222 in a 1M context",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
    },
    // A configured output reserve narrows the window readings are a share of
    // (202,222) but not the hard wall (the input limit), so this case reads
    // differently against the two.
    {
        name: "input limit 302,222 with a 100,000-token output reserve",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
        settings: { output_reserve: RESERVE },
    },
];
for (const [index, windowCase] of WINDOW_CASES.entries()) {
    test(`a local count and a provider reading of the same request read the same percentage: ${windowCase.name}`, async () => {
        const f = await fixture(8870 + index, {
            area: "issue-886-threshold",
            provider: windowCase.provider,
            model: windowCase.model,
            limit: windowCase.limit,
            ...(windowCase.settings ? { configOverrides: windowCase.settings } : {}),
        });
        try {
            f.user(`Review these records:\n${prose.repeat(300)}`, 60_000);
            // The provider has reported no usage: the first pass is priced (it
            // renders the history head) and sizes itself from a local count.
            f.respond(1, 0);
            const first = await f.pass();
            const sized =
                /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                    first.logs.join("\n"),
                );
            if (!sized) throw new Error(`no local count:\n${first.logs.join("\n")}`);
            // The provider then reports exactly that many input tokens.
            f.respond(1, Number(sized[1]));
            const second = await f.pass();
            const reading = new RegExp(
                `transform scheduler: percentage=([\\d.]+)% inputTokens=${sized[1]} `,
            ).exec(second.logs.join("\n"));
            if (!reading) throw new Error(`no provider reading:\n${second.logs.join("\n")}`);
            console.log(
                `ISSUE886_WINDOW ${JSON.stringify({ case: windowCase.name, tokens: Number(sized[1]), local: Number(sized[2]), provider: Number(reading[1]) })}`,
            );
            // Both are logged to one decimal place.
            expect(Math.abs(Number(sized[2]) - Number(reading[1]))).toBeLessThanOrEqual(0.1);
        } finally {
            setOutputReserveConfig(undefined);
            await f.cleanup();
        }
    }, 300_000);
}

// The two 95% emergency lines read the hard wall, and a declared input limit
// caps it: with 302,222 inside a 1,000,000-token context, a reading of 96% of
// the input limit is an emergency. Against the context less the output cap
// (968,000) the same reading is about 30%.
const EMERGENCY_TOKENS = Math.round(INPUT_WINDOW * 0.96);

test("historian recovery is requested at 95% of the input limit, not of the context", async () => {
    const f = await fixture(8866, {
        area: "issue-886-threshold",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
        historian: true,
    });
    await withSession(f, async () => {
        incrementHistorianFailure(f.db, f.session, "historian failed");
        const requested = (logs: string[]) =>
            logs.some((line) => /EMERGENCY: historian recovery requested at/.test(line));
        f.respond(1, Math.round(INPUT_WINDOW * 0.9));
        const below = await f.pass();
        f.respond(1, EMERGENCY_TOKENS);
        const above = await f.pass();
        expect(requested(below.logs)).toBe(false);
        expect(requested(above.logs)).toBe(true);
    });
}, 300_000);

test("a provider overflow at 95% of the input limit is refused, not sent", async () => {
    const f = await fixture(8867, {
        area: "issue-886-threshold",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        limit: LIMIT,
    });
    try {
        // A first pass renders the history head, so the refused pass below
        // folds nothing.
        await f.pass();
        f.respond(1, EMERGENCY_TOKENS);
        recordOverflowDetected(
            f.db,
            f.session,
            undefined,
            "opencode-go/deepseek-v4.1-flash",
            "provider_overflow",
        );
        const attempt = await f.attempt();
        // The 95% fail-closed line refuses the turn. The fixture's host cannot
        // show the refusal notice, so the refusal surfaces as that step's error.
        expect(attempt.error).toBeInstanceOf(Error);
        expect(
            attempt.logs.some((line) => /v2 refusal: .*EmergencyFailClosedError/.test(line)),
        ).toBe(true);
    } finally {
        resetEmergencyRecoveryRegistryForTest();
        await f.cleanup();
    }
}, 300_000);
