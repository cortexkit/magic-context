/// <reference types="bun-types" />

/**
 * Witnesses for the overflow and model-shrink recovery refusal (issue 889) on
 * OpenCode 1. Each test states a property recovery is meant to hold; at commit
 * 121dd7acd7 every one of them fails:
 *
 * - A recovery request over the 95% line is never sent. A historian
 *   publication clears the recovery latch (the session flag that keeps the
 *   next passes in recovery), and only the recovery refusal arms it again.
 *   When the pass ends on another fail-closed path instead (the bounded
 *   historian join timing out), or a timed-out run publishes in the
 *   background after the pass, the next turn is no longer a recovery pass and
 *   its request goes out over the window.
 * - A recovery request that fits the window but cannot be brought under the
 *   95% line, because nothing older is left for the historian to summarize, is
 *   refused on every turn. Nothing lets that request through, so the session
 *   cannot continue on this model.
 *
 * The historian's model call is stubbed as in issue-889-recovery-admission.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getOverflowState,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { getActiveCompartmentRun } from "./compartment-runner";
import * as incremental from "./compartment-runner-incremental";
import { resolveContextWindowGeometry } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createTransform } from "./transform";

const LARGE = { providerID: "openai", modelID: "large-window" };
const SMALL = { providerID: "openai", modelID: "small-window" };
const LARGE_KEY = `${LARGE.providerID}/${LARGE.modelID}`;
const prose = "Review the records and verify each one carefully before the next deployment step. ";

let dir: string;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    dir = createTestTempDirFromPath(join(tmpdir(), "issue-889-review-"));
    process.env.XDG_DATA_HOME = dir;
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "openai",
                            models: {
                                [LARGE.modelID]: { limit: { context: 1_000_000, output: 32_000 } },
                                [SMALL.modelID]: { limit: { context: 24_000, output: 2_000 } },
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
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
    ids: string[];
    text: (id: string) => string;
}

/** Eight large user turns with short replies, then a short prompt. */
function eightTurns(): Fixture {
    const ids: string[] = [];
    for (let turn = 0; turn < 8; turn++) ids.push(`u${turn}`, `a${turn}`);
    ids.push("u-next");
    return {
        ids,
        text: (id) => {
            if (id === "u-next") return "Continue with the next step.";
            if (id.startsWith("u")) return `Turn ${id.slice(1)}: ${prose.repeat(250)}`;
            return `Reply ${id.slice(1)}: done.`;
        },
    };
}

function writeOpenCodeDb(sessionId: string, fixture: Fixture): void {
    const dbPath = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    try {
        raw.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        fixture.ids.forEach((id, index) => {
            const role = id.startsWith("u") ? "user" : "assistant";
            raw.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
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
                JSON.stringify({ type: "text", text: fixture.text(id) }),
            );
        });
    } finally {
        closeQuietly(raw);
    }
}

function hostMessages(sessionId: string, fixture: Fixture, model: typeof LARGE) {
    return fixture.ids.map((id) => {
        const user = id.startsWith("u");
        return {
            info: user
                ? {
                      id,
                      role: "user",
                      sessionID: sessionId,
                      ...(id === "u-next" ? { model } : {}),
                  }
                : { id, role: "assistant", sessionID: sessionId, ...LARGE },
            parts: [{ type: "text", text: fixture.text(id) }],
        };
    });
}

/**
 * Each historian run publishes the next user turn and its reply, the way the
 * real runner publishes: the callback, with the recovery latch left armed (a
 * publication no longer ends recovery; only a recovery pass whose request fits
 * does). A run whose index is in `holdRuns` waits for `release()` before it
 * publishes.
 */
function stubHistorian(
    db: ReturnType<typeof openDatabase>,
    fixture: Fixture,
    options: { publishing: number; holdRuns?: number[] },
) {
    let runs = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const spy = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        runs += 1;
        const run = runs;
        if (options.holdRuns?.includes(run)) await released;
        updateSessionMeta(db, deps.sessionId, { compartmentInProgress: false });
        const snapshot = deps.boundarySnapshot;
        if (run > options.publishing || !snapshot) return;
        const start = snapshot.offset;
        const end = start + 1;
        if (end >= snapshot.eligibleEndOrdinal) return;
        appendCompartments(db, deps.sessionId, [
            {
                sequence: getCompartments(db, deps.sessionId).length,
                startMessage: start,
                endMessage: end,
                startMessageId: fixture.ids[start - 1]!,
                endMessageId: fixture.ids[end - 1]!,
                title: `Turn ${start}`,
                content: "Reviewed the earlier records.",
            },
        ]);
        deps.onCompartmentStatePublished?.(deps.sessionId);
    });
    return { spy, runs: () => runs, release };
}

function newTransform(args: {
    db: ReturnType<typeof openDatabase>;
    live: Map<string, typeof LARGE>;
    onRefuse: () => void;
    historianTimeoutMs?: number;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map(),
        db: args.db,
        liveModelBySession: args.live,
        getModelKey: (id: string) => {
            const model = args.live.get(id);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        storeGeneration: "v1",
        directory: dir,
        historianTimeoutMs: args.historianTimeoutMs,
        client: {
            session: { abort: mock(async () => ({ data: true })), prompt: mock(async () => ({})) },
        } as unknown as PluginContext["client"],
        hostRefusalNotice: async () => {},
        hostRefuse: async () => {
            args.onRefuse();
        },
    });
}

async function captureLogs(sessionId: string, run: () => Promise<unknown>) {
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === sessionId) lines.push(rest.map(String).join(" "));
    });
    let error: unknown;
    try {
        await run();
    } catch (caught) {
        error = caught;
    } finally {
        spy.mockRestore();
    }
    return { lines, error };
}

function smallGeometry(db: ReturnType<typeof openDatabase>, sessionId: string) {
    const usableHard = resolveContextWindowGeometry(SMALL.providerID, SMALL.modelID, {
        db,
        sessionID: sessionId,
    })!.usableHard;
    return { usableHard, line: Math.floor((usableHard * 95) / 100) };
}

function servedTokens(messages: unknown[], sessionId: string): number {
    return estimateFinalWireInputTokens({
        messages: messages as never,
        systemPromptTokens: 0,
        providerID: SMALL.providerID,
        modelID: SMALL.modelID,
        sessionId,
    }).pressureTokens;
}

async function settleHistorian(sessionId: string): Promise<void> {
    for (let i = 0; i < 200 && getActiveCompartmentRun(sessionId); i++) {
        await getActiveCompartmentRun(sessionId)?.promise.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
}

/**
 * A session measured on the large model at well over the small model's window,
 * then switched to the small model. Returns the transform and fixture state.
 */
async function switchedSession(
    sessionId: string,
    fixture: Fixture,
    options: { historianTimeoutMs?: number } = {},
) {
    writeOpenCodeDb(sessionId, fixture);
    const db = openDatabase();
    const live = new Map([[sessionId, LARGE]]);
    const counters = { refused: 0 };
    const transform = newTransform({
        db,
        live,
        onRefuse: () => counters.refused++,
        historianTimeoutMs: options.historianTimeoutMs,
    });
    await transform({}, { messages: hostMessages(sessionId, fixture, LARGE) } as never);
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: 3.5,
        lastInputTokens: 35_000,
        lastObservedModelKey: LARGE_KEY,
        lastUsageContextLimit: 968_000,
    });
    live.set(sessionId, SMALL);
    return { db, transform, counters };
}

describe("issue 889 review: recovery stays armed until the request fits", () => {
    it("a chained historian run that outlives the join budget does not let the next turn send over the window", async () => {
        const sessionId = "ses-889-review-chain-timeout";
        const fixture = eightTurns();
        const { db, transform, counters } = await switchedSession(sessionId, fixture, {
            historianTimeoutMs: 400,
        });
        // The first run publishes at once; the first chained run is still
        // running when the join budget ends, and publishes later.
        const historian = stubHistorian(db, fixture, { publishing: 2, holdRuns: [2] });
        const { line, usableHard } = smallGeometry(db, sessionId);
        try {
            const first = await captureLogs(sessionId, () =>
                transform({}, { messages: hostMessages(sessionId, fixture, SMALL) } as never),
            );
            const firstLog = first.lines.join("\n");
            expect(firstLog).toContain(
                "arming overflow recovery proactively for the shrinking switch",
            );
            expect(firstLog).toContain("blocking for historian run 2 on the next chunk");
            expect(firstLog).toContain("compartment await timed out");
            // The pass is not sent (the bounded-join refusal), as intended.
            const firstNotSent = first.error !== undefined || counters.refused === 1;
            expect(firstNotSent).toBe(true);
            const latchAfterFirst = getOverflowState(db, sessionId).needsEmergencyRecovery;

            // The chained run finishes in the background and publishes.
            historian.release();
            await settleHistorian(sessionId);
            expect(getCompartments(db, sessionId)).toHaveLength(2);

            // The person sends the message again.
            const refusedBefore = counters.refused;
            const output = { messages: hostMessages(sessionId, fixture, SMALL) };
            const second = await captureLogs(sessionId, () => transform({}, output as never));
            const sent = second.error === undefined && counters.refused === refusedBefore;
            const served = servedTokens(output.messages, sessionId);
            console.log(
                `ISSUE889_REVIEW chain-timeout: latchAfterFirstPass=${latchAfterFirst} latchBeforeSecondPass=false secondPassSent=${sent} served=${served} line=${line} usableHard=${usableHard} firstError=${first.error instanceof Error ? first.error.message : String(first.error)}`,
            );
            // The property the change claims: a recovery request over the
            // line is never sent.
            expect(sent && served > line).toBe(false);
        } finally {
            historian.release();
            historian.spy.mockRestore();
        }
    });

    it("a first historian run that outlives the join budget and publishes in the background does not let the next turn send over the window", async () => {
        const sessionId = "ses-889-review-first-timeout";
        const fixture = eightTurns();
        const { db, transform, counters } = await switchedSession(sessionId, fixture, {
            historianTimeoutMs: 300,
        });
        const historian = stubHistorian(db, fixture, { publishing: 1, holdRuns: [1] });
        const { line, usableHard } = smallGeometry(db, sessionId);
        try {
            const first = await captureLogs(sessionId, () =>
                transform({}, { messages: hostMessages(sessionId, fixture, SMALL) } as never),
            );
            expect(first.lines.join("\n")).toContain("compartment await timed out");
            expect(first.error !== undefined || counters.refused === 1).toBe(true);
            // Still armed here: the run has not published yet.
            expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(true);

            historian.release();
            await settleHistorian(sessionId);
            expect(getCompartments(db, sessionId)).toHaveLength(1);

            const refusedBefore = counters.refused;
            const output = { messages: hostMessages(sessionId, fixture, SMALL) };
            const second = await captureLogs(sessionId, () => transform({}, output as never));
            const sent = second.error === undefined && counters.refused === refusedBefore;
            const served = servedTokens(output.messages, sessionId);
            console.log(
                `ISSUE889_REVIEW first-timeout: latchBeforeSecondPass=${getOverflowState(db, sessionId).needsEmergencyRecovery} secondPassSent=${sent} served=${served} line=${line} usableHard=${usableHard}`,
            );
            expect(sent && served > line).toBe(false);
        } finally {
            historian.release();
            historian.spy.mockRestore();
        }
    });
});

/** Older turns already summarized; the newest prompt alone is near the small window. */
function summarizedWithLargePrompt(promptRepeats: number): Fixture {
    const ids: string[] = [];
    for (let turn = 0; turn < 4; turn++) ids.push(`u${turn}`, `a${turn}`);
    ids.push("u-next");
    return {
        ids,
        text: (id) => {
            if (id === "u-next") return `Please review: ${prose.repeat(promptRepeats)}`;
            if (id.startsWith("u")) return `Turn ${id.slice(1)}: ${prose.repeat(40)}`;
            return `Reply ${id.slice(1)}: done.`;
        },
    };
}

/** Prose repeats for a prompt whose own count is about `target` tokens. */
function repeatsForTokens(target: number, sessionId: string): number {
    const count = (repeats: number) =>
        servedTokens(
            [
                {
                    info: { id: "probe", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: `Please review: ${prose.repeat(repeats)}` }],
                },
            ],
            sessionId,
        );
    const low = count(100);
    const high = count(200);
    return Math.round(100 + ((target - low) * 100) / (high - low));
}

describe("issue 889 review: a fitting recovery request with nothing left to summarize", () => {
    it("is not refused on every turn: the session can continue", async () => {
        const sessionId = "ses-889-review-wedge";
        const probeDb = openDatabase();
        const { line, usableHard } = smallGeometry(probeDb, sessionId);
        // Aim the newest prompt between the 95% line and the window, leaving
        // room for the rendered history head.
        const repeats = repeatsForTokens(line + Math.floor((usableHard - line) / 3), sessionId);
        const fixture = summarizedWithLargePrompt(repeats);
        writeOpenCodeDb(sessionId, fixture);
        const db = openDatabase();
        // Every turn before the newest prompt is already summarized.
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 8,
                startMessageId: "u0",
                endMessageId: "a3",
                title: "Earlier turns",
                content: "Reviewed the earlier records.",
            },
        ]);
        const live = new Map([[sessionId, LARGE]]);
        let refused = 0;
        const transform = newTransform({ db, live, onRefuse: () => refused++ });
        await transform({}, { messages: hostMessages(sessionId, fixture, LARGE) } as never);
        updateSessionMeta(db, sessionId, {
            lastContextPercentage: 3.5,
            lastInputTokens: 35_000,
            lastObservedModelKey: LARGE_KEY,
            lastUsageContextLimit: 968_000,
        });
        const historian = stubHistorian(db, fixture, { publishing: 0 });
        live.set(sessionId, SMALL);
        const TURNS = 4;
        const refusedCounts: number[] = [];
        let sentServed: number | undefined;
        try {
            for (let turn = 0; turn < TURNS; turn++) {
                const output = { messages: hostMessages(sessionId, fixture, SMALL) };
                const before = refused;
                const pass = await captureLogs(sessionId, () => transform({}, output as never));
                const log = pass.lines.join("\n");
                if (turn === 0)
                    expect(log).toContain(
                        "arming overflow recovery proactively for the shrinking switch",
                    );
                const match = log.match(
                    /recovery request still over the window: about (\d+) tokens/,
                );
                if (match) refusedCounts.push(Number(match[1]));
                if (pass.error === undefined && refused === before) {
                    sentServed = servedTokens(output.messages, sessionId);
                    break;
                }
            }
            console.log(
                `ISSUE889_REVIEW wedge: refusedTurns=${refused} of ${TURNS} refusedCounts=${refusedCounts.join(",")} line=${line} usableHard=${usableHard} sentServed=${sentServed} historianRuns=${historian.runs()} latch=${getOverflowState(db, sessionId).needsEmergencyRecovery}`,
            );
            // Every refused request fits the window it was refused for.
            for (const tokens of refusedCounts) {
                expect(tokens).toBeGreaterThan(line);
                expect(tokens).toBeLessThanOrEqual(usableHard);
            }
            // The session continues within a few turns.
            expect(refused).toBeLessThan(TURNS);
        } finally {
            historian.spy.mockRestore();
        }
    });
});
