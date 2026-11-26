/// <reference types="bun-types" />

/**
 * Issue 860 through the real OpenCode 1 transform. Near the limit the
 * emergency tool drop infers the fixed part of the request (what no tool drop
 * can remove) as a size of the whole request minus our count of its active
 * tags. With the provider's reading as that size, every token by which the
 * provider counts the request higher than we do lands in the fixed part; in
 * the reported session that made the drop skip with most of the request
 * droppable. The planner now caps that size by our own count of the last
 * request served (served-request-count.ts).
 *
 * The session: a `litellm/proxy-model` route configured at 60,000 tokens
 * (usable 45,000, reduction from 29,250), a measured system prompt and tool
 * definitions, one summary covering the first five turns and a tail of tool
 * steps. Every scenario is compared with the 0.49.81 planner, run on the same
 * pass inputs: the new selection must contain the release's.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { sessionEmergencyCalibration } from "../../features/magic-context/session-decision-calibration";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    addProcessedImageStrippedIds,
    resetEmergencyRecoveryRegistryForTest,
    setEmergencyDropSample,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    getMeasuredToolDefinitionTokens,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { releasePlanEmergencyDrop } from "./__fixtures__/emergency-drop-release-0.49.81";
import * as incremental from "./compartment-runner-incremental";
import * as emergencyDrop from "./emergency-drop";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";

const PROVIDER = "litellm";
const MODEL = "proxy-model";
const AGENT = "build";
/** The reporter's measured system prompt. */
const SYSTEM_PROMPT_TOKENS = 6_062;
/** 60,000 × 65% of the usable 45,000: where reduction starts. */
const CEILING = 29_250;
const WINDOW = 45_000;
/** Summarized turns, then tail turns. */
const SUMMARIZED_TURNS = 5;

const sentence =
    "drwxr-xr-x  4 build staff  128 Nov 26 14:17 src/features/magic-context/storage-meta-persisted.ts ok\n";

let dir: string;
const saved = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

beforeEach(async () => {
    dir = createTestTempDirFromPath(join(tmpdir(), "issue-860-measured-"));
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: PROVIDER,
                            models: {
                                [MODEL]: { limit: { context: 60_000, output: 32_000 } },
                                "claude-opus-5": { limit: { context: 60_000, output: 32_000 } },
                                "claude-opus-5-5": { limit: { context: 60_000, output: 32_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(() => {
    resetEmergencyRecoveryRegistryForTest();
    __resetToolDefinitionMeasurements();
    resetLkgSlotsForTest();
    clearModelsDevCache();
    closeDatabase();
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
});

interface Turn {
    user: string;
    assistant: string;
    tool: "bash" | "read";
    callId: string;
    output: string;
}

/** About `tokens` local tokens of shell output. */
function shellOutput(turn: number, tokens: number): string {
    return `$ ls -la run-${turn}\n${sentence.repeat(Math.max(1, Math.round(tokens / 40)))}`;
}

/**
 * The session's turns: five summarized ones, then `tail` tool steps. Every
 * tenth tail step is a small `read` (tier 1, dropped last); the rest are
 * `bash` steps (tier 3, dropped first).
 */
function sessionTurns(tail: number, bashTokens = 6_700): Turn[] {
    const turns: Turn[] = [];
    for (let i = 0; i < SUMMARIZED_TURNS + tail; i++) {
        const read = i >= SUMMARIZED_TURNS && (i - SUMMARIZED_TURNS) % 10 === 9;
        turns.push({
            user: `u${i}`,
            assistant: `a${i}`,
            tool: read ? "read" : "bash",
            callId: `call-${i}`,
            output: read ? `1: const x${i} = ${i};\n`.repeat(25) : shellOutput(i, bashTokens),
        });
    }
    return turns;
}

/** The array OpenCode 1 hands the transform, ending on a new prompt. */
function hostMessages(
    sessionId: string,
    turns: Turn[],
    model = MODEL,
    reasoning: ReadonlyMap<string, string> = new Map(),
) {
    const messages: Array<{
        info: Record<string, unknown>;
        parts: Array<Record<string, unknown>>;
    }> = [];
    for (const [index, turn] of turns.entries()) {
        messages.push({
            info: { id: turn.user, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: index === 0 ? "Inspect the build output." : "go on" }],
        });
        messages.push({
            info: {
                id: turn.assistant,
                role: "assistant",
                sessionID: sessionId,
                providerID: PROVIDER,
                modelID: model,
            },
            parts: [
                ...(reasoning.has(turn.assistant)
                    ? [{ type: "reasoning", text: reasoning.get(turn.assistant) }]
                    : []),
                {
                    type: "tool",
                    tool: turn.tool,
                    callID: turn.callId,
                    state: {
                        status: "completed",
                        input: turn.tool === "read" ? { filePath: "src/a.ts" } : { command: "ls" },
                        output: turn.output,
                    },
                },
            ],
        });
    }
    messages.push({
        info: {
            id: "u-next",
            role: "user",
            sessionID: sessionId,
            model: { providerID: PROVIDER, modelID: model },
        },
        parts: [{ type: "text", text: "continue" }],
    });
    return messages;
}

/** The host's own store, which the summary boundary reads. */
function writeOpenCodeDb(sessionId: string, turns: Turn[]): void {
    const dbPath = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    try {
        raw.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        const ids = [...turns.flatMap((turn) => [turn.user, turn.assistant]), "u-next"];
        ids.forEach((id, index) => {
            const role = id.startsWith("u") ? "user" : "assistant";
            raw.prepare(
                "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                sessionId,
                index + 1,
                index + 1,
                JSON.stringify({ id, role, sessionID: sessionId }),
            );
            raw.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                sessionId,
                index + 1,
                index + 1,
                JSON.stringify({ type: "text", text: role === "user" ? "go on" : "done" }),
            );
        });
    } finally {
        closeQuietly(raw);
    }
}

/** About `tokens` local tokens of tool definitions for the route, as OpenCode reports them. */
function measureToolDefinitions(tokens: number, model = MODEL): void {
    const tools = Math.max(1, Math.round(tokens / 1_500));
    for (let i = 0; i < tools; i++) {
        recordToolDefinition(
            PROVIDER,
            model,
            AGENT,
            `tool_${i}`,
            `Tool ${i}. ${"Runs a command in the workspace and returns its output. ".repeat(130)}`,
            { type: "object", properties: { command: { type: "string" } } },
        );
    }
}

interface Session {
    /** What the scheduler answers on the next pass. */
    decision: "execute" | "defer";
    sessionId: string;
    db: ReturnType<typeof openDatabase>;
    turns: Turn[];
    usage: Map<string, { usage: ContextUsage; updatedAt: number }>;
    transform: ReturnType<typeof createTransform>;
    refused: () => number;
}

/**
 * A session whose first five turns are summarized, with the given tail and
 * a provider reading of `reading` tokens.
 */
function openSession(
    sessionId: string,
    options: {
        tail: number;
        reading: number;
        systemPromptTokens?: number;
        model?: string;
        bashTokens?: number;
        subagent?: boolean;
        decision?: "execute" | "defer";
        systemPromptHash?: string;
    },
): Session {
    const model = options.model ?? MODEL;
    const turns = sessionTurns(options.tail, options.bashTokens);
    writeOpenCodeDb(sessionId, turns);
    const db = openDatabase();
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: SUMMARIZED_TURNS * 2,
            startMessageId: turns[0]!.user,
            endMessageId: turns[SUMMARIZED_TURNS - 1]!.assistant,
            title: "Earlier build inspection",
            content: "Listed the build output of the first five runs.",
        },
    ]);
    if (options.systemPromptTokens !== 0)
        updateSessionMeta(db, sessionId, {
            systemPromptTokens: options.systemPromptTokens ?? SYSTEM_PROMPT_TOKENS,
        });
    if (options.subagent) updateSessionMeta(db, sessionId, { isSubagent: true });
    // OpenCode reports the system prompt's hash with its size; the transform
    // saves a copy of a served request only when it has one.
    if (options.systemPromptHash)
        updateSessionMeta(db, sessionId, { systemPromptHash: options.systemPromptHash });
    const usage = new Map<string, { usage: ContextUsage; updatedAt: number }>();
    usage.set(sessionId, {
        usage: { inputTokens: options.reading, percentage: (options.reading / 45_000) * 100 },
        updatedAt: Date.now(),
    });
    let refused = 0;
    const session = { decision: options.decision ?? "execute" } as Session;
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => session.decision) },
        contextUsageMap: usage,
        db,
        liveModelBySession: new Map([[sessionId, { providerID: PROVIDER, modelID: model }]]),
        getModelKey: () => `${PROVIDER}/${model}`,
        getNotificationParams: () => ({ agent: AGENT, providerId: PROVIDER, modelId: model }),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        storeGeneration: "v1",
        directory: dir,
        client: {
            session: {
                abort: mock(async () => ({ data: true })),
                prompt: mock(async () => ({})),
                // The session's own directory, as OpenCode answers it; a
                // failed lookup marks the pass degraded and saves no copy.
                get: mock(async () => ({ data: { id: sessionId, directory: dir } })),
            },
        } as unknown as PluginContext["client"],
        hostRefusalNotice: async () => {},
        hostRefuse: async () => {
            refused++;
        },
    });
    return Object.assign(session, {
        sessionId,
        db,
        turns,
        usage,
        transform,
        refused: () => refused,
    });
}

/** Run one pass; the historian is stubbed to publish nothing. */
async function runPass(
    session: Session,
    model = MODEL,
    reasoning: ReadonlyMap<string, string> = new Map(),
    augment?: (messages: ReturnType<typeof hostMessages>) => void,
) {
    const lines: string[] = [];
    const log = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === session.sessionId) lines.push(rest.map(String).join(" "));
    });
    const historian = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        updateSessionMeta(session.db, deps.sessionId, { compartmentInProgress: false });
    });
    const output = { messages: hostMessages(session.sessionId, session.turns, model, reasoning) };
    augment?.(output.messages);
    let error: unknown;
    try {
        await session.transform({}, output as never);
    } catch (caught) {
        error = caught;
    } finally {
        log.mockRestore();
        historian.mockRestore();
    }
    return { lines, log: lines.join("\n"), output, error };
}

/** Which tail tool results still carry their output after the pass. */
function toolOutcomes(session: Session, served: { messages: unknown[] }) {
    const byCall = new Map<string, string>();
    for (const message of served.messages as Array<{ parts: Array<Record<string, unknown>> }>) {
        for (const part of message.parts) {
            if (part.type !== "tool" || typeof part.callID !== "string") continue;
            byCall.set(part.callID, String((part.state as { output?: unknown }).output ?? ""));
        }
    }
    const kept: string[] = [];
    const removed: string[] = [];
    for (const turn of session.turns.slice(SUMMARIZED_TURNS)) {
        const output = byCall.get(turn.callId);
        // A result that keeps its content may carry its tag prefix.
        if (output?.endsWith(turn.output)) kept.push(`${turn.tool}:${turn.callId}`);
        else removed.push(`${turn.tool}:${turn.callId}`);
    }
    return { kept, removed };
}

/** Magic Context's own count of the messages a pass served (neutral ratios on this route). */
function servedMessageTokens(served: { messages: unknown[] }): number {
    let total = 0;
    for (const message of served.messages as never[]) {
        const counted = estimateMessageTokens(message);
        total += counted.conversation + counted.toolCall;
    }
    return total;
}

function setReading(session: Session, inputTokens: number, window = WINDOW) {
    session.usage.set(session.sessionId, {
        usage: { inputTokens, percentage: (inputTokens / window) * 100 },
        updatedAt: Date.now(),
    });
}

function appendBashStep(session: Session, tokens: number) {
    const index = session.turns.length;
    session.turns.push({
        user: `u${index}`,
        assistant: `a${index}`,
        tool: "bash",
        callId: `call-${index}`,
        output: shellOutput(index, tokens),
    });
}

const currentPlanner = emergencyDrop.planEmergencyDrop;
type PlannerInput = Parameters<typeof currentPlanner>[0];
type Plan = ReturnType<typeof currentPlanner>;
interface PlannerCall {
    input: PlannerInput;
    current: Plan;
    release: Plan;
}
/** Planner calls checked against the 0.49.81 planner, over every scenario in this file. */
let differentialCases = 0;

/**
 * Run the planner the pass calls next to the 0.49.81 planner on the same
 * inputs (the release had no count of the served request), recording both.
 * `serve` chooses which plan the pass applies, so a scenario can be replayed
 * as the release would have played it.
 */
function plannerSpy(serve: "current" | "release") {
    const calls: PlannerCall[] = [];
    const spy = spyOn(emergencyDrop, "planEmergencyDrop").mockImplementation((input) => {
        const { servedCountTokens: _count, ...releaseInput } = input;
        const release = releasePlanEmergencyDrop(releaseInput);
        const current = currentPlanner(input);
        calls.push({ input, current, release });
        return serve === "current" ? current : release;
    });
    return { calls, restore: () => spy.mockRestore() };
}

/** Never fewer drops than the release: its selection, or an extension of it in order. */
function expectExtendsRelease(calls: readonly PlannerCall[]) {
    for (const { current, release } of calls) {
        differentialCases++;
        if (release.shouldDrop) {
            expect(current.shouldDrop).toBe(true);
            expect(current.tagNumbers.slice(0, release.tagNumbers.length)).toEqual(
                release.tagNumbers,
            );
        }
        expect(current.reclaimTokens).toBeGreaterThanOrEqual(release.reclaimTokens);
    }
}

/** Run `play` twice on fresh sessions: as this build serves it, and as the release would. */
async function againstRelease<T>(play: (serve: "current" | "release") => Promise<T>) {
    const result: Partial<Record<"current" | "release", T>> = {};
    let currentCalls: PlannerCall[] = [];
    for (const serve of ["release", "current"] as const) {
        const spy = plannerSpy(serve);
        try {
            result[serve] = await play(serve);
        } finally {
            spy.restore();
        }
        if (serve === "current") currentCalls = spy.calls;
        expectExtendsRelease(spy.calls);
        resetEmergencyRecoveryRegistryForTest();
        resetLkgSlotsForTest();
    }
    return { current: result.current as T, release: result.release as T, calls: currentCalls };
}

const tailCalls = (turns: Turn[], tool: "bash" | "read") =>
    turns
        .slice(SUMMARIZED_TURNS)
        .filter((turn) => turn.tool === tool)
        .map((turn) => `${tool}:${turn.callId}`);

/** Our count of a served request's messages plus its system prompt and tool definitions. */
function requestTokens(session: Session, served: { messages: unknown[] }, system: number) {
    const tools =
        getMeasuredToolDefinitionTokens(PROVIDER, MODEL, AGENT, session.sessionId) ??
        getMeasuredToolDefinitionTokens(PROVIDER, MODEL, AGENT) ??
        0;
    return servedMessageTokens(served) + system + tools;
}

describe("issue 860: the reporter's session through the transform", () => {
    test("after one counted pass the drop runs where the release skips", async () => {
        measureToolDefinitions(15_134);
        expect(getMeasuredToolDefinitionTokens(PROVIDER, MODEL, AGENT)).toBeGreaterThan(14_000);
        const { current, release, calls } = await againstRelease(async (serve) => {
            // 818.7% of the usable 45,000: the reading the reported session worked from.
            const session = openSession(`ses-860-reporter-${serve}`, {
                tail: 42,
                reading: 368_415,
                systemPromptHash: "system-prompt-v1",
            });
            // The first pass has no count of an earlier request: the
            // release's arithmetic, so the same skip.
            const first = await runPass(session);
            const second = await runPass(session);
            return { session, first, second, outcome: toolOutcomes(session, second.output) };
        });
        for (const run of [current, release]) {
            expect(run.first.error).toBeUndefined();
            expect(run.first.log).toMatch(
                /emergency tiered drop skipped: fixed floor ≈\d+ already exceeds ceiling 29250/,
            );
        }
        expect(calls[0]?.input.servedCountTokens).toBeUndefined();
        // The second pass has our count of the first pass's request.
        const count = calls[1]?.input.servedCountTokens;
        expect(count).toBeDefined();
        const served = requestTokens(current.session, current.first.output, SYSTEM_PROMPT_TOKENS);
        expect(Math.abs((count ?? 0) - served) / served).toBeLessThan(0.02);
        expect(release.second.log).toContain("already exceeds ceiling 29250");
        expect(release.outcome.removed).toEqual([]);
        // The fixed part comes out as the system prompt, tool definitions and
        // the history head: under the reduction point.
        const floor = Number(/floor≈(\d+)/.exec(calls[1]?.current.reason ?? "")?.[1]);
        expect(floor).toBeGreaterThan(SYSTEM_PROMPT_TOKENS + 14_000);
        expect(floor).toBeLessThan(CEILING);
        expect(current.second.log).toMatch(/emergency tiered drop: tiered drop: \d+ tags/);
        // At 818.7% against a reading the drop cannot bring down, the planner
        // takes every shell result (tier 3) before any read (tier 1); whatever
        // stays is a read.
        for (const call of tailCalls(current.session.turns, "bash"))
            expect(current.outcome.removed).toContain(call);
        for (const call of current.outcome.kept)
            expect(tailCalls(current.session.turns, "read")).toContain(call);
        console.log(
            `ISSUE860 reporter: count=${Math.round(count ?? 0)} floor=${floor} removed=${current.outcome.removed.length} kept=${current.outcome.kept.join(",")} servedAfter=${requestTokens(current.session, current.second.output, SYSTEM_PROMPT_TOKENS)}`,
        );
    }, 120_000);
});

describe("issue 860: one very large tool result, then a reading of 800%", () => {
    /**
     * A session well below the threshold gets one result of about 300,000
     * tokens. The pass that sends it is below the band and makes no count of
     * its own; the next reading is 360,000 (800% of the usable window), with
     * the provider counting about 20% higher than we do.
     */
    async function jump(serve: string, systemPromptHash: string | undefined) {
        measureToolDefinitions(15_134);
        const session = openSession(`ses-860-jump-${serve}-${systemPromptHash ?? "none"}`, {
            tail: 10,
            reading: 13_500,
            bashTokens: 1_350,
            decision: "defer",
            systemPromptHash,
        });
        appendBashStep(session, 300_000);
        const sends = await runPass(session);
        setReading(session, 360_000);
        session.decision = "execute";
        const first = await runPass(session);
        const second = await runPass(session);
        return {
            session,
            sends,
            first,
            second,
            firstOutcome: toolOutcomes(session, first.output),
            secondOutcome: toolOutcomes(session, second.output),
        };
    }
    const huge = (session: Session) => `bash:${session.turns.at(-1)?.callId}`;

    test("with a saved copy of the request that carried it, the first force-band pass drops it", async () => {
        const { current, release, calls } = await againstRelease((serve) =>
            jump(serve, "system-prompt-v1"),
        );
        // The pass that sent the result made no count of its own: its final
        // check stopped at a byte bound once the request was over the window.
        expect(current.sends.log).toMatch(
            /final-wire telemetry estimate=\d+ trusted=false conversation=0 tools=0/,
        );
        expect(current.sends.log).not.toContain("emergency tiered drop");
        const count = calls[0]?.input.servedCountTokens;
        expect(count).toBeGreaterThan(300_000);
        expect(count).toBeLessThan(360_000);
        expect(release.first.log).toContain("already exceeds ceiling");
        expect(release.firstOutcome.removed).toEqual([]);
        expect(current.first.log).toMatch(/emergency tiered drop: tiered drop: \d+ tags/);
        expect(current.firstOutcome.removed).toContain(huge(current.session));
        console.log(
            `ISSUE860 jump (saved copy): count=${Math.round(count ?? 0)} first=${current.first.lines.find((l) => l.startsWith("emergency tiered drop"))} servedAfter=${requestTokens(current.session, current.first.output, SYSTEM_PROMPT_TOKENS)}`,
        );
    }, 120_000);

    test("pin: without a saved copy no pass over the window has a count, so each skips as the release does", async () => {
        const { current, release, calls } = await againstRelease((serve) => jump(serve, undefined));
        // No saved copy (OpenCode reported no system prompt hash), and every
        // pass over the window stops its own count at a byte bound.
        expect(calls[0]?.input.servedCountTokens).toBeUndefined();
        expect(calls[1]?.input.servedCountTokens).toBeUndefined();
        for (const run of [current, release]) {
            expect(run.first.log).toContain("already exceeds ceiling");
            expect(run.second.log).toContain("already exceeds ceiling");
            expect(run.secondOutcome.removed).toEqual([]);
        }
        console.log(
            `ISSUE860 jump (no saved copy): first=${current.first.lines.find((l) => l.startsWith("emergency tiered drop"))} second=${current.second.lines.find((l) => l.startsWith("emergency tiered drop"))}`,
        );
    }, 120_000);
});

describe("issue 860: our count of the whole and our count of its tags agree", () => {
    const image = {
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${"A".repeat(4_096)}`,
    };
    const variants = {
        "tool results and text": { reasoning: false, images: false },
        "with reasoning and images": { reasoning: true, images: true },
    };
    for (const [name, variant] of Object.entries(variants))
        test(`${name}: on a served request, the whole minus the active tags is within 5% of an independent count of the rest`, async () => {
            measureToolDefinitions(15_134);
            const session = openSession(`ses-860-agree-${variant.reasoning}`, {
                tail: 42,
                reading: 368_415,
                systemPromptHash: "system-prompt-v1",
            });
            // The first pass has no count, so its planner skips and nothing is
            // dropped: what it measured is what it served. The second pass's
            // planner gets our count of that request.
            const reasoning = variant.reasoning
                ? new Map(
                      session.turns
                          .slice(5, 20)
                          .map((turn, i) => [
                              turn.assistant,
                              `${i}: ${"reason about this command before sending the answer. ".repeat(80)}`,
                          ]),
                  )
                : new Map<string, string>();
            const augment = variant.images
                ? (messages: ReturnType<typeof hostMessages>) => {
                      messages
                          .find((message) => message.info.id === "u12")
                          ?.parts.push(...Array.from({ length: 6 }, () => ({ ...image })));
                  }
                : undefined;
            const spy = plannerSpy("current");
            let served: Awaited<ReturnType<typeof runPass>>;
            try {
                served = await runPass(session, MODEL, reasoning, augment);
                expect(served.error).toBeUndefined();
                expect(served.log).toContain("already exceeds ceiling");
                expect((await runPass(session, MODEL, reasoning, augment)).error).toBeUndefined();
            } finally {
                spy.restore();
            }
            expect(spy.calls.length).toBe(2);
            const floorTags = spy.calls[0]!.input.floorTags.filter(
                (tag) => tag.status === "active",
            );
            const tagTokens = floorTags.reduce((sum, tag) => sum + (tag.servedTokens ?? 0), 0);
            const count = spy.calls[1]!.input.servedCountTokens;
            expect(count).toBeDefined();
            // The witness: one walk over the served messages, each part assigned
            // by the tag prefix an active tag's content carries.
            const active = new Set(floorTags.map((tag) => tag.tagNumber));
            const owner = (part: Record<string, unknown>) => {
                const text =
                    part.type === "tool"
                        ? String((part.state as { output?: unknown } | undefined)?.output ?? "")
                        : typeof part.text === "string"
                          ? part.text
                          : "";
                const tag = /^§(\d+)§/.exec(text)?.[1];
                return tag !== undefined && active.has(Number(tag));
            };
            const activeTagParts = new Set(
                (served!.output.messages as Array<{ parts: Array<Record<string, unknown>> }>)
                    .flatMap((message) => message.parts)
                    .filter(owner),
            );
            const witness = emergencyDrop.measureEmergencyRequest({
                messages: served!.output.messages as never,
                activeTagParts,
                systemPromptTokens: SYSTEM_PROMPT_TOKENS,
                toolDefinitionTokens: getMeasuredToolDefinitionTokens(PROVIDER, MODEL, AGENT) ?? 0,
                calibration: sessionEmergencyCalibration(session.db, session.sessionId),
            });
            const inferred = (count ?? 0) - tagTokens;
            const difference = inferred - witness.fixedTokens;
            console.log(
                `ISSUE860 agree (${name}): count=${Math.round(count ?? 0)} tags=${Math.round(tagTokens)} (${floorTags.length} active, ${activeTagParts.size} owned parts) inferredFixed=${Math.round(inferred)} witnessFixed=${Math.round(witness.fixedTokens)} witnessTags=${Math.round(witness.tagTokens)} witnessTotal=${Math.round(witness.totalTokens)} difference=${Math.round(difference)} (${((difference / (count ?? 1)) * 100).toFixed(2)}% of the request)`,
            );
            expect(Math.abs(difference)).toBeLessThanOrEqual(0.05 * (count ?? 0));
        }, 120_000);
});

describe("issue 860: the reviewed regressions, compared with the release", () => {
    const reasoningBlocks = (session: Session) =>
        new Map(
            session.turns
                .slice(5, 20)
                .map((turn, i) => [
                    turn.assistant,
                    `${i}: ${"reason about this command before sending the answer. ".repeat(650)}`,
                ]),
        );

    for (const reading of [40_050, 43_200]) {
        test(`first reasoning clearance at ${((reading / WINDOW) * 100).toFixed(0)}%: at least the release's drops, and the next pass changes nothing`, async () => {
            const { current, release } = await againstRelease(async (serve) => {
                measureToolDefinitions(15_134);
                const session = openSession(`ses-860-reasoning-${reading}-${serve}`, {
                    tail: 42,
                    reading: 4_500,
                    bashTokens: 520,
                });
                expect((await runPass(session)).error).toBeUndefined();
                setReading(session, reading);
                const blocks = reasoningBlocks(session);
                const first = await runPass(session, MODEL, blocks);
                const second = await runPass(session, MODEL, blocks);
                return {
                    session,
                    first,
                    second,
                    removed: toolOutcomes(session, first.output).removed,
                    size: requestTokens(session, first.output, SYSTEM_PROMPT_TOKENS),
                };
            });
            for (const call of release.removed) expect(current.removed).toContain(call);
            expect(current.size).toBeLessThanOrEqual(release.size);
            expect(current.first.error).toBeUndefined();
            expect(JSON.stringify(current.second.output.messages)).toBe(
                JSON.stringify(current.first.output.messages),
            );
            console.log(
                `ISSUE860 reasoning ${reading}: release removed=${release.removed.length} size=${release.size}; current removed=${current.removed.length} size=${current.size}`,
            );
        }, 120_000);
    }

    test("images stripped on an earlier pass: at least the release's drops", async () => {
        const image = {
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${"A".repeat(512)}`,
        };
        const withImages = (messages: ReturnType<typeof hostMessages>) => {
            messages
                .find((message) => message.info.id === "u5")
                ?.parts.push(...Array.from({ length: 24 }, () => ({ ...image })));
        };
        const { current, release } = await againstRelease(async (serve) => {
            measureToolDefinitions(15_134);
            const session = openSession(`ses-860-images-${serve}`, {
                tail: 47,
                reading: 4_500,
                bashTokens: 650,
            });
            expect(
                addProcessedImageStrippedIds(
                    session.db,
                    session.sessionId,
                    ["u5"],
                    "[image stripped]",
                ),
            ).toBe(true);
            expect((await runPass(session, MODEL, new Map(), withImages)).error).toBeUndefined();
            setReading(session, 42_000);
            const pass = await runPass(session, MODEL, new Map(), withImages);
            return {
                pass,
                removed: toolOutcomes(session, pass.output).removed,
                size: requestTokens(session, pass.output, SYSTEM_PROMPT_TOKENS),
            };
        });
        expect(release.removed.length).toBeGreaterThan(0);
        for (const call of release.removed) expect(current.removed).toContain(call);
        expect(current.size).toBeLessThanOrEqual(release.size);
        expect(current.size).toBeLessThan(WINDOW);
        console.log(
            `ISSUE860 images: release removed=${release.removed.length} size=${release.size}; current removed=${current.removed.length} size=${current.size}`,
        );
    }, 120_000);

    test("a prefix-bound model with an earlier batch, reading 96%: at least the release's drops, and the request fits", async () => {
        const model = "claude-opus-5-5";
        const { current, release } = await againstRelease(async (serve) => {
            measureToolDefinitions(8_000, model);
            const session = openSession(`ses-860-latched-thinking-${serve}`, {
                tail: 18,
                reading: 4_500,
                bashTokens: 1_000,
                model,
                systemPromptTokens: 2_000,
            });
            expect((await runPass(session, model)).error).toBeUndefined();
            setReading(session, 43_200);
            setEmergencyDropSample(session.db, session.sessionId, 40_000);
            const blocks = new Map([
                [
                    "a5",
                    `1: ${"reason about this command before sending the answer. ".repeat(1000)}`,
                ],
            ]);
            const pass = await runPass(session, model, blocks);
            const tools = getMeasuredToolDefinitionTokens(PROVIDER, model, AGENT) ?? 0;
            return {
                pass,
                refused: session.refused(),
                removed: toolOutcomes(session, pass.output).removed,
                size: servedMessageTokens(pass.output) + 2_000 + tools,
            };
        });
        expect(release.removed.length).toBeGreaterThan(0);
        for (const call of release.removed) expect(current.removed).toContain(call);
        expect(current.size).toBeLessThanOrEqual(release.size);
        expect(current.size).toBeLessThan(WINDOW);
        expect(current.refused).toBe(release.refused);
        console.log(
            `ISSUE860 prefix-bound 96%: release removed=${release.removed.length} size=${release.size}; current removed=${current.removed.length} size=${current.size}`,
        );
    }, 120_000);
});

describe("issue 860: the differential over this file's scenarios", () => {
    test("every planner call above was checked against the release", () => {
        console.log(`ISSUE860 differential: ${differentialCases} planner calls`);
        expect(differentialCases).toBeGreaterThan(10);
    });
});
