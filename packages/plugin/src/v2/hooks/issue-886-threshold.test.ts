import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import { updateSessionMeta } from "../../features/magic-context/storage";
import { markProtectedTailPolicyV3Seeded } from "../../features/magic-context/storage-meta-persisted";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import * as finalWire from "../../hooks/magic-context/final-wire-token-estimate";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
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
async function localCountPasses(): Promise<LocalCountPasses> {
    const f = await reporterSession(8862, 0);
    return withSession(f, async () => {
        const arrays: Array<{ line: string; messages: Composition }> = [];
        const original = finalWire.estimateFinalWireInputTokens;
        const spy = spyOn(finalWire, "estimateFinalWireInputTokens").mockImplementation((input) => {
            const caller = new Error().stack?.split("\n")[3] ?? "";
            arrays.push({ line: caller, messages: composition(input.messages) });
            return original(input);
        });
        try {
            const first = await f.pass();
            f.respondWithTool(shellStep(STEPS), 0, prose.repeat(10));
            const second = await f.pass();
            const logs = [...first.logs, ...second.logs];
            const sized =
                /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                    first.logs.join("\n"),
                );
            const served =
                /local count of the last served request percentage=([\d.]+) inputTokens=(\d+)/.exec(
                    second.logs.join("\n"),
                );
            if (!sized || !served)
                throw new Error(`expected readings missing:\n${logs.join("\n")}`);
            // The sizing call precedes the postprocess phase; the next call
            // counts the array the pass returns (the final-wire estimate).
            const countedArray = arrays[0]!.messages;
            const servedArray = arrays[1]!.messages;
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

test("a pass sized from a local count counts the array before the history head and instruction rows are added", async () => {
    const result = await localCountResult();
    console.log(
        `ISSUE886_LOCAL_COUNT ${JSON.stringify({ sized: result.sized, served: result.served, countedArray: result.countedArray, servedArray: result.servedArray })}`,
    );
    // The count that sizes the pass has neither the two history messages at the
    // head (m[0] and m[1]) nor the instruction rows; the request the pass serves
    // has both.
    expect(result.countedArray.head).toBe(0);
    expect(result.countedArray.instructions).toBe(0);
    expect(result.servedArray.head).toBeGreaterThan(15_000);
    expect(result.servedArray.instructions).toBeGreaterThan(10_000);
    // It also still holds reasoning the same pass then clears from the request.
    expect(result.countedArray.reasoning).toBeGreaterThan(result.servedArray.reasoning);
}, 300_000);

// Expected to fail until the local count is read against the same window as a
// provider reading. A provider reading is a percentage of the input limit
// (302,222 here); the priced-pass sizing divides by the hard window, the
// 1,000,000-token context minus the 32,000-token output cap (968,000), so the
// same request reads about a third as full. A fix flips this to `test`.
test.failing("a pass sized from a local count reads it against the input limit provider readings use", async () => {
    const result = await localCountResult();
    const expected = (result.sized.inputTokens / INPUT_WINDOW) * 100;
    expect(Math.abs(result.sized.percentage - expected)).toBeLessThan(0.1);
}, 300_000);

// Expected to fail until the sizing counts the request the pass serves. Today
// it counts the array before the history head and the instruction rows are
// added and before reasoning is cleared, so it differs from the next pass's
// count of the same request by tens of percent. A fix flips this to `test`.
test.failing("a pass sized from a local count counts the request it serves", async () => {
    const result = await localCountResult();
    const ratio = result.sized.inputTokens / result.served.inputTokens;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
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
