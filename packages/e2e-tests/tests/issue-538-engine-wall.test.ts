/// <reference types="bun-types" />

/**
 * Issue 538 follow-up reproduction: a warm-cache session whose inference engine
 * rejects oversized prompts before any model call.
 *
 * Reporter shape: the historian keeps publishing compartments, yet the history
 * baseline never moves, raw history is never trimmed, and context grows until
 * the engine's own `max_context` pre-check rejects every request. The published
 * compartments only reach the prompt on a cache-busting pass (scheduler execute
 * or the force band), and those passes are driven by provider-reported usage.
 *
 * Each case runs a real OpenCode 1.x host against the mock provider. The mock
 * plays the engine: a main-agent request larger than WALL_TOKENS (measured from
 * the request bytes) is rejected with an error body and no usage; smaller ones
 * are answered and report their real size as usage.
 *
 *   A. Host (and Magic Context) believe the model has a larger window than the
 *      engine serves; the engine's rejection text is not a known overflow text.
 *   B. Same window mismatch; the rejection text is llama.cpp's overflow text.
 *   E. Same mismatch; ninfer's prepared-prompt rejection arms recovery.
 *   C. The configured window equals the engine wall; usage is reported normally
 *      until the wall.
 *   D. As A, with a short cache TTL and an idle past it after the first
 *      rejection.
 *
 * Run by hand from packages/e2e-tests, with TMPDIR pointing at a throwaway root:
 *   TMPDIR=$TMPDIR/magic-context/issue-538 bun test tests/issue-538-engine-wall.test.ts
 * Every case checks with lsof that the host holds only databases under its
 * throwaway data directory.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";
const WALL_TOKENS = 40_000;
const TURNS = 18;

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function approxTokens(body: Record<string, unknown>): number {
    return Math.floor(JSON.stringify(body).length / 4);
}

function replyText(turn: number, targetBytes: number): string {
    const records: string[] = [];
    let length = 0;
    for (let record = 0; length < targetBytes; record++) {
        const text = `Record ${turn}-${record}: inspected boundary ${record * 7919} and kept decision ${record * 104729}.\n`;
        records.push(text);
        length += text.length;
    }
    return records.join("").slice(0, targetBytes);
}

interface TurnRecord {
    turn: number;
    mainRequestTokens: number | null;
    rejected: boolean;
    storedPercentage: number;
    storedInputTokens: number;
    needsEmergencyRecovery: number;
    detectedContextLimit: number;
    baselineBoundary: string | null;
    compartments: number;
    executeDecisions: number;
    deferDecisions: number;
    cacheExpired: boolean;
    rewritePermitted: boolean;
    rematerialized: number;
    overflowDetected: number;
    bumpedTo95: number;
}

interface CaseResult {
    turns: TurnRecord[];
    historianCalls: number;
}

/** Every regular-file .db the host process has open must sit under its throwaway data dir. */
function assertOnlyThrowawayDatabases(pid: number, dataDir: string): string[] {
    const root = realpathSync(dataDir);
    const lsof = Bun.spawnSync(["lsof", "-p", String(pid), "-Fn"]).stdout.toString();
    const dbPaths = lsof
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1))
        .filter((path) => /\.db(-wal|-shm)?$/.test(path));
    expect(dbPaths.length).toBeGreaterThan(0);
    for (const path of dbPaths) expect(path.startsWith(root)).toBe(true);
    return dbPaths;
}

function countLines(lines: readonly string[], needle: string): number {
    return lines.filter((line) => line.includes(needle)).length;
}

async function runCase(args: {
    label: string;
    modelContextLimit: number;
    wallTokens?: number;
    turns?: number;
    userBallastTokens?: number;
    replyBytes?: number;
    /** Extra Magic Context config merged over the case defaults. */
    extraConfig?: Record<string, unknown>;
    /** Idle this long once, before the turn after the first rejected one. */
    idleAfterFirstRejectionMs?: number;
    wallErrorMessage: (tokens: number) => string;
}): Promise<CaseResult> {
    const wallTokens = args.wallTokens ?? WALL_TOKENS;
    const h = await TestHarness.create({
        modelContextLimit: args.modelContextLimit,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            dreamer: { disable: true },
            memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
            embedding: { provider: "off" },
            ...(args.extraConfig ?? {}),
        },
    });
    disposers.push(() => h.dispose());
    const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    const dbPaths = assertOnlyThrowawayDatabases(h.opencode.pid, h.dataDir);
    console.log(`[issue-538 ${args.label}] host pid ${h.opencode.pid} databases: ${dbPaths.join(", ")}`);

    let historianCalls = 0;
    h.mock.addMatcher((body) => {
        if (!isHistorian(body)) return null;
        historianCalls++;
        const flat = JSON.stringify(body.messages ?? []);
        const range = flat.match(/Messages (\d+)-(\d+):/);
        return {
            text: buildMockHistorianPayload({
                start: range ? Number(range[1]) : 0,
                end: range ? Number(range[2]) : 0,
                title: "Engine wall",
                body: "Summary.",
            }),
            usage: {
                input_tokens: 500,
                output_tokens: 50,
                cache_creation_input_tokens: 500,
                cache_read_input_tokens: 0,
            },
        };
    });
    let mainCalls = 0;
    h.mock.addMatcher((body) => {
        if (isHistorian(body)) return null;
        mainCalls++;
        const tokens = approxTokens(body);
        if (tokens > wallTokens) {
            return {
                error: {
                    status: 400,
                    type: "invalid_request_error",
                    message: args.wallErrorMessage(tokens),
                },
            };
        }
        const reply = replyText(mainCalls, args.replyBytes ?? 6_000);
        return {
            text: reply,
            usage: {
                input_tokens: tokens,
                output_tokens: Math.floor(reply.length / 4),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        };
    });

    const sessionId = await h.createSession();
    const turns: TurnRecord[] = [];
    let idled = false;
    for (let turn = 1; turn <= (args.turns ?? TURNS); turn++) {
        if (args.idleAfterFirstRejectionMs && !idled && turns.at(-1)?.rejected) {
            idled = true;
            await Bun.sleep(args.idleAfterFirstRejectionMs);
        }
        const logBefore = readLog(logPath).length;
        const requestsBefore = h.mock.requests().length;
        let rejected = false;
        try {
            await h.sendPrompt(sessionId, `user turn ${turn}: continue. ${h.ballast(args.userBallastTokens ?? 1_500)}`, {
                timeoutMs: 90_000,
            });
        } catch {
            rejected = true;
        }
        await h.waitForMockQuiescence({ quietMs: 500, label: `turn ${turn} quiescence` });
        const main = h.mock
            .requests()
            .slice(requestsBefore)
            .filter(
                (request) =>
                    !isHistorian(request.body) &&
                    JSON.stringify(request.body.messages ?? []).includes(`user turn ${turn}:`),
            )
            .at(-1);
        const lines = readLog(logPath)
            .slice(logBefore)
            .split("\n")
            .filter((line) => line.includes(sessionId));
        const meta = h
            .contextDb()
            .prepare(
                "SELECT last_context_percentage, last_input_tokens, needs_emergency_recovery, detected_context_limit, cached_m0_last_baseline_end_message_id FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as Record<string, number | string | null> | null;
        turns.push({
            turn,
            mainRequestTokens: main ? approxTokens(main.body) : null,
            rejected,
            storedPercentage: Math.round(Number(meta?.last_context_percentage ?? 0) * 10) / 10,
            storedInputTokens: Number(meta?.last_input_tokens ?? 0),
            needsEmergencyRecovery: Number(meta?.needs_emergency_recovery ?? 0),
            detectedContextLimit: Number(meta?.detected_context_limit ?? 0),
            baselineBoundary: (meta?.cached_m0_last_baseline_end_message_id as string | null) ?? null,
            compartments: h.countCompartments(sessionId),
            executeDecisions: countLines(lines, "decision=execute"),
            deferDecisions: countLines(lines, "decision=defer"),
            cacheExpired: lines.some((line) => line.includes("cache_expired=true")),
            rewritePermitted: lines.some((line) => line.includes("rewrite permission: allowed=true")),
            rematerialized: countLines(lines, "rematerialized=true"),
            overflowDetected: countLines(lines, "overflow detected"),
            bumpedTo95: countLines(lines, "bumping percentage to 95%"),
        });
    }
    assertOnlyThrowawayDatabases(h.opencode.pid, h.dataDir);
    console.log(`[issue-538 ${args.label}] historian calls ${historianCalls}`);
    console.table(turns);
    return { turns, historianCalls };
}

function readLog(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
});

const firstRejected = (turns: readonly TurnRecord[]) => turns.find((turn) => turn.rejected)?.turn;

describe("issue 538: engine rejects oversized prompts before any model call", () => {
    it(
        "A: window mismatch with an unrecognised rejection text stays stuck",
        async () => {
            const { turns, historianCalls } = await runCase({
                label: "A",
                modelContextLimit: 200_000,
                wallErrorMessage: (tokens) =>
                    `prompt has ${tokens} tokens, which exceeds max_context ${WALL_TOKENS}`,
            });
            const wallTurn = firstRejected(turns);
            expect(wallTurn).toBeDefined();
            const afterWall = turns.filter((turn) => turn.turn >= (wallTurn ?? TURNS + 1));
            // The historian publishes, but pressure never reaches the execute
            // threshold, so no pass busts and nothing recovers: every request
            // from the wall on is rejected and the stored pressure is frozen at
            // the last served request.
            expect(historianCalls).toBeGreaterThan(0);
            expect(turns.every((turn) => turn.executeDecisions === 0)).toBe(true);
            expect(afterWall.every((turn) => turn.rejected)).toBe(true);
            expect(afterWall.every((turn) => turn.needsEmergencyRecovery === 0)).toBe(true);
            expect(new Set(afterWall.map((turn) => turn.storedInputTokens)).size).toBe(1);
        },
        900_000,
    );

    it(
        "D: a confirmed cache expiry neither rebuilds nor recovers from an unrecognised engine rejection",
        async () => {
            const { turns } = await runCase({
                label: "D",
                modelContextLimit: 200_000,
                turns: 12,
                extraConfig: { cache_ttl: "20s" },
                idleAfterFirstRejectionMs: 25_000,
                wallErrorMessage: (tokens) =>
                    `prompt has ${tokens} tokens, which exceeds max_context ${WALL_TOKENS}`,
            });
            const wallTurn = firstRejected(turns);
            expect(wallTurn).toBeDefined();
            const wall = turns.find((turn) => turn.turn === wallTurn)!;
            const expired = turns.find((turn) => turn.turn === wall.turn + 1);
            // The rejected request did not supply an overflow signal or refresh
            // the clock. An expired provider cache alone is no reason to change the
            // part of the request the provider had cached: resending the same bytes
            // costs the same and keeps signed thinking valid.
            expect(expired).toMatchObject({
                cacheExpired: true,
                executeDecisions: 0,
                deferDecisions: 1,
                rewritePermitted: false,
                rematerialized: 0,
                rejected: true,
                storedInputTokens: wall.storedInputTokens,
                needsEmergencyRecovery: 0,
            });
        },
        900_000,
    );

    it(
        "B: window mismatch with a recognised overflow text arms emergency recovery",
        async () => {
            const { turns } = await runCase({
                label: "B",
                modelContextLimit: 200_000,
                wallErrorMessage: (tokens) =>
                    `request (${tokens} tokens) exceeds the available context size (${WALL_TOKENS} tokens), try increasing it`,
            });
            const wallTurn = firstRejected(turns);
            expect(wallTurn).toBeDefined();
            expect(turns.some((turn) => turn.detectedContextLimit === WALL_TOKENS)).toBe(true);
            expect(turns.some((turn) => turn.overflowDetected > 0)).toBe(true);
            // The next pass is bumped to 95% and recovers: its request is served.
            const next = turns.find((turn) => turn.turn === (wallTurn ?? 0) + 1);
            expect(next?.bumpedTo95).toBe(1);
            expect(next?.rejected).toBe(false);
        },
        900_000,
    );

    it(
        "E: ninfer prepared-prompt overflow arms emergency recovery",
        async () => {
            const { turns } = await runCase({
                label: "E",
                modelContextLimit: 200_000,
                wallErrorMessage: () =>
                    "AI_APICallError: prepared prompt exceeds Engine max_context 262144",
            });
            const wallTurn = firstRejected(turns);
            expect(wallTurn).toBeDefined();
            expect(turns.some((turn) => turn.detectedContextLimit === 262144)).toBe(true);
            expect(turns.some((turn) => turn.overflowDetected > 0)).toBe(true);
            const next = turns.find((turn) => turn.turn === (wallTurn ?? 0) + 1);
            expect(next?.bumpedTo95).toBe(1);
            expect(next?.rejected).toBe(false);
        },
        900_000,
    );

    it(
        "C: window equal to the wall with normal usage busts before the wall",
        async () => {
            // A larger window than cases A and B: the historian runs on the same
            // mock model, and on a 40K window its own prompt does not fit.
            const wall = 100_000;
            const { turns } = await runCase({
                label: "C",
                modelContextLimit: wall,
                wallTokens: wall,
                turns: 20,
                userBallastTokens: 3_000,
                replyBytes: 12_000,
                wallErrorMessage: (tokens) =>
                    `prompt has ${tokens} tokens, which exceeds max_context ${wall}`,
            });
            expect(turns.some((turn) => turn.executeDecisions > 0)).toBe(true);
            expect(turns.some((turn) => turn.rejected)).toBe(false);
        },
        900_000,
    );
});
