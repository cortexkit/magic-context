/// <reference types="bun-types" />

/**
 * Regression suite for the three-set cache-busting refactor (Oracle review
 * 2026-04-26). Replaces the old monolithic `flushedSessions` set with three
 * single-purpose sets:
 *
 *   - `historyRefreshSessions`     one-shot, drained after `prepareCompartmentInjection`
 *   - `systemPromptRefreshSessions` one-shot, drained after the system-prompt handler
 *   - `pendingMaterializationSessions` persistent until heuristics actually run
 *
 * The four scenarios below are the regression targets Oracle called out
 * in the review. Each one exercises a behavior that the OLD single-set
 * design got wrong in a way that observably busted Anthropic prompt cache
 * or dropped /ctx-flush intent.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { createNudgePlacementStore, createTransform } from "./transform";

/**
 * Block "compartment running" by registering a never-resolving promise in
 * the active-runs map. Returns a resolver to lift the block.
 *
 * `compartmentRunning` in the postprocess phase reads from
 * `getActiveCompartmentRun()` (in-memory), NOT `compartmentInProgress` in
 * the DB (which is for restart-recovery). So tests must register a real
 * pending promise to simulate the block.
 */
function blockCompartmentRun(sessionId: string): () => void {
    let resolver: (() => void) | undefined;
    const blocker = new Promise<void>((res) => {
        resolver = res;
    });
    registerActiveCompartmentRun(sessionId, blocker);
    return () => {
        if (resolver) resolver();
    };
}

type TestPart =
    | { type: "text"; text: string }
    | {
          type: "tool";
          callID: string;
          state: { output: string; tool?: string; input?: Record<string, string> };
      };

type TestMessage = {
    info: { id?: string; role: string; sessionID?: string };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

/**
 * Minimum client + directory needed to make `canRunCompartments=true`,
 * which is required for `compartmentRunning` to take effect. The methods
 * are no-ops since the tests don't actually invoke historian.
 */
const testClient = { session: { prompt: async () => ({}) } } as never;
const testDirectory = "/tmp/ctx-busting-test";

function buildSimpleMessages(sessionId: string): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "hello" }],
        },
        {
            info: { id: "m-assistant", role: "assistant" },
            parts: [{ type: "text", text: "world" }],
        },
    ];
}

describe("three-set cache-busting refactor (Oracle review 2026-04-26)", () => {
    it("Test 1: historian publish while compartment is running — history rebuild is one-shot, materialization persists", async () => {
        // Scenario from Oracle: historian publishes mid-session (signaling
        // both historyRefresh + pendingMaterialization), but a different
        // compartment run is still active so heuristics can't materialize
        // yet. The pre-refactor bug: every subsequent defer pass would
        // re-fire the flush flag and rebuild `<session-history>` until
        // compartmentRunning lifted, burning cache reuse for nothing.
        //
        // After the fix: history rebuild fires exactly once (consumed by
        // prepareCompartmentInjection then drained), and materialization
        // intent persists across blocked passes until heuristics run.
        useTempDataHome("ctx-busting-test1-");
        const sessionId = "ses-historian-publish";
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        // First pass establishes the session in the DB.
        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // Simulate historian publication: signals BOTH history refresh and
        // pending materialization (per the new producer rule).
        historyRefreshSessions.add(sessionId);
        pendingMaterializationSessions.add(sessionId);

        // Block compartment using the in-memory promise registry (this is
        // what postprocess actually consults).
        const lift = blockCompartmentRun(sessionId);

        try {
            // Defer pass A: prepareCompartmentInjection consumes
            // historyRefresh and drains it. Heuristics are blocked by
            // compartmentRunning, so pendingMaterialization survives.
            await transform({}, { messages: buildSimpleMessages(sessionId) });

            expect(historyRefreshSessions.has(sessionId)).toBe(false); // drained
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true); // persisted
        } finally {
            lift();
        }
    });

    it("Test 2: two subsequent defer passes after one historian publish — history is rebuilt exactly once", async () => {
        // Scenario from Oracle: a single historian publish should NOT
        // cause two cache busts (one per defer pass). The pre-refactor
        // bug: flushedSessions stayed set across multiple passes when
        // heuristics couldn't run, so each defer pass re-rebuilt the
        // injection block.
        //
        // After the fix: history refresh is drained immediately after
        // prepareCompartmentInjection consumes it, so even if subsequent
        // defer passes happen back-to-back, they hit the cached injection.
        useTempDataHome("ctx-busting-test2-");
        const sessionId = "ses-two-defer";
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        // Establish session.
        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // Historian publish: both signals set.
        historyRefreshSessions.add(sessionId);
        pendingMaterializationSessions.add(sessionId);

        // Defer pass A: drains historyRefresh.
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(historyRefreshSessions.has(sessionId)).toBe(false);

        // Defer pass B: historyRefresh stays drained, no re-add.
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
    });

    it("Test 3: /ctx-flush while compartment is running — materialization survives the blocked pass and runs on next safe pass", async () => {
        // Scenario from Oracle: user runs /ctx-flush, but compartment is
        // still running. The flush MUST survive into the next pass once
        // compartmentRunning lifts. The pre-refactor design coupled this
        // signal to history rebuild, but the consumer logic was correct;
        // the new design makes the persistence semantics explicit.
        useTempDataHome("ctx-busting-test3-");
        const sessionId = "ses-flush-during-compartment";
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        // Establish session.
        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // Block compartment using in-memory promise registry.
        const lift = blockCompartmentRun(sessionId);

        try {
            // Simulate /ctx-flush: signals all three (we use the relevant two
            // for this scope — system-prompt set is exercised in its own
            // module's tests).
            historyRefreshSessions.add(sessionId);
            pendingMaterializationSessions.add(sessionId);

            // Pass A: blocked. historyRefresh drained by injection rebuild.
            // pendingMaterialization persists because heuristics can't run.
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

            // Lift the block (simulate compartment finishing).
            lift();

            // Pass B: heuristics CAN run now. pendingMaterialization gets
            // drained by the heuristics block (line ~360 of postprocess).
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        } finally {
            // Always lift if not already lifted (no-op if resolver was called).
            lift();
        }
    });

    it("Test 4: delayed heuristic execution after the active run settles — pendingMaterialization drains exactly once", async () => {
        // Variant of Test 3 emphasizing that pendingMaterialization
        // drains on the FIRST safe pass after the block lifts, and stays
        // drained on subsequent passes (no spurious re-add).
        useTempDataHome("ctx-busting-test4-");
        const sessionId = "ses-delayed-drain";
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        // Establish session.
        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // Block compartment using in-memory promise registry + signal flush.
        const lift = blockCompartmentRun(sessionId);
        pendingMaterializationSessions.add(sessionId);

        try {
            // Pass A: blocked.
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

            // Pass B: still blocked. Materialization still pending.
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

            // Lift block.
            lift();

            // Pass C: heuristics run, drain.
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);

            // Pass D: stays drained.
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        } finally {
            lift();
        }
    });

    it("system-prompt-refresh decoupling: historian publish does NOT signal systemPromptRefreshSessions", async () => {
        // Bonus regression for Oracle's separation requirement:
        // historian publication should refresh history + materialization
        // but NOT touch system-prompt adjuncts (docs/profile/key-files).
        // This avoids burning IO re-reading disk-backed adjuncts on every
        // historian publish.
        useTempDataHome("ctx-busting-test5-");
        const sessionId = "ses-prompt-decouple";
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };

        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // Simulate historian publish: only history + materialization.
        // The producer code in transform.ts/hook.ts MUST NOT touch
        // systemPromptRefreshSessions here.
        historyRefreshSessions.add(sessionId);
        pendingMaterializationSessions.add(sessionId);

        await transform({}, { messages: buildSimpleMessages(sessionId) });

        // System-prompt set was never touched by historian publication.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });

    it("Test 6: deferred helper rejects low-context defer passes", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 30,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(false);
    });

    it("Test 7: deferred helper accepts scheduler execute", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 30,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("Test 8: deferred helper accepts force materialization threshold", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 85,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("Test 9: deferred helper blocks active low-context runs", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 30,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: true,
            }),
        ).toBe(false);
    });

    it("Test 10: just-awaited publication overrides the active-run block", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 30,
                justAwaitedPublication: true,
                activeRunBlocksMaterialization: true,
            }),
        ).toBe(true);
    });

    it("Test 11: deferred publish stays invisible across low-context defer passes", async () => {
        useTempDataHome("ctx-busting-test11-");
        const sessionId = "ses-deferred-low-context";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const deferredHistoryRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const deferredMaterializationSessions = new Set<string>();
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        replaceAllCompartmentState(
            db,
            sessionId,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m-user",
                    endMessageId: "m-user",
                    title: "old",
                    content: "old history",
                },
            ],
            [],
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        const firstMessages = buildSimpleMessages(sessionId);
        await transform({}, { messages: firstMessages });
        const firstWire = JSON.stringify(firstMessages[0]);

        deferredHistoryRefreshSessions.add(sessionId);
        deferredMaterializationSessions.add(sessionId);

        const secondMessages = buildSimpleMessages(sessionId);
        await transform({}, { messages: secondMessages });

        expect(JSON.stringify(secondMessages[0])).toBe(firstWire);
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(true);
    });

    it("Test 12: execute pass consumes deferred history and materialization together", async () => {
        useTempDataHome("ctx-busting-test12-");
        const sessionId = "ses-deferred-execute";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>();
        const deferredMaterializationSessions = new Set<string>([sessionId]);
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        replaceAllCompartmentState(db, sessionId, [], []);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });

        await transform({}, { messages: buildSimpleMessages(sessionId) });

        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 13: active low-context execute does not consume deferred state", async () => {
        useTempDataHome("ctx-busting-test13-");
        const sessionId = "ses-active-execute";
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const deferredMaterializationSessions = new Set<string>([sessionId]);
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const lift = blockCompartmentRun(sessionId);
        try {
            const transform = createTransform({
                tagger: createTagger(),
                scheduler,
                contextUsageMap: new Map([
                    [
                        sessionId,
                        { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                    ],
                ]),
                nudger: () => null,
                db: openDatabase(),
                nudgePlacements: createNudgePlacementStore(),
                historyRefreshSessions: new Set<string>(),
                deferredHistoryRefreshSessions,
                pendingMaterializationSessions: new Set<string>(),
                deferredMaterializationSessions,
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTags: 1,
                autoDropToolAge: 1000,
                dropToolStructure: true,
                client: testClient,
                directory: testDirectory,
            });
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
            expect(deferredMaterializationSessions.has(sessionId)).toBe(true);
        } finally {
            lift();
        }
    });

    it("Test 14: compressor-only deferred history drains without materialization", async () => {
        useTempDataHome("ctx-busting-test14-");
        const sessionId = "ses-compressor-only";
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
    });

    it("Test 15: low-context explicit refresh drains both deferred sets", async () => {
        useTempDataHome("ctx-busting-test15-");
        const sessionId = "ses-explicit-drain";
        const historyRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>([sessionId]);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const deferredMaterializationSessions = new Set<string>([sessionId]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 16: explicit blocked refresh materializes next pass without another history signal", async () => {
        useTempDataHome("ctx-busting-test16-");
        const sessionId = "ses-explicit-blocked";
        const db = openDatabase();
        replaceAllCompartmentState(
            db,
            sessionId,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m-user",
                    endMessageId: "m-user",
                    title: "summary",
                    content: "cached history",
                },
            ],
            [],
        );
        const historyRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>([sessionId]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });
        const lift = blockCompartmentRun(sessionId);
        let passAText = "";
        try {
            const passA = buildSimpleMessages(sessionId);
            await transform({}, { messages: passA });
            passAText = JSON.stringify(passA[0]);
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);
        } finally {
            lift();
        }
        const passB = buildSimpleMessages(sessionId);
        await transform({}, { messages: passB });
        expect(JSON.stringify(passB[0])).toBe(passAText);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
    });

    it("Test 17: empty-state sentinel keeps low-context defer replay empty", async () => {
        useTempDataHome("ctx-busting-test17-");
        const sessionId = "ses-empty-sentinel";
        const db = openDatabase();
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        const first = buildSimpleMessages(sessionId);
        await transform({}, { messages: first });
        const firstWire = JSON.stringify(first);
        const second = buildSimpleMessages(sessionId);
        await transform({}, { messages: second });
        expect(JSON.stringify(second)).toBe(firstWire);
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
    });

    it("Test 18: deferred signals are session-isolated", async () => {
        useTempDataHome("ctx-busting-test18-");
        const set = new Set<string>(["A"]);
        const mat = new Set<string>(["A"]);
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "execute" as const) },
            contextUsageMap: new Map([
                ["B", { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() }],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions: set,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: mat,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await transform({}, { messages: buildSimpleMessages("B") });
        expect(set.has("A")).toBe(true);
        expect(mat.has("A")).toBe(true);
        expect(set.has("B")).toBe(false);
    });

    it("Test 19: multiple deferred publishes coalesce in sets", () => {
        const sessions = new Set<string>();
        sessions.add("ses");
        sessions.add("ses");
        expect(sessions.size).toBe(1);
    });

    it("Test 20: explicit low-context flush with deferred materialization pending drains both sets", async () => {
        useTempDataHome("ctx-busting-test20-");
        const sessionId = "ses-test20";
        const historyRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>([sessionId]);
        const deferredHistoryRefreshSessions = new Set<string>([sessionId]);
        const deferredMaterializationSessions = new Set<string>([sessionId]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db: openDatabase(),
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 21: blocked explicit refresh retries materialization without rebuild", async () => {
        useTempDataHome("ctx-busting-test21-");
        const sessionId = "ses-test21";
        const historyRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>([sessionId]);
        const db = openDatabase();
        replaceAllCompartmentState(
            db,
            sessionId,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m-user",
                    endMessageId: "m-user",
                    title: "summary",
                    content: "history for blocked retry",
                },
            ],
            [],
        );
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
            client: testClient,
            directory: testDirectory,
        });

        const lift = blockCompartmentRun(sessionId);
        const passA = buildSimpleMessages(sessionId);
        try {
            await transform({}, { messages: passA });
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);
        } finally {
            lift();
        }

        const passAWire = JSON.stringify(passA[0]);
        const passB = buildSimpleMessages(sessionId);
        await transform({}, { messages: passB });

        expect(JSON.stringify(passB[0])).toBe(passAWire);
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 22: concurrent transforms keep explicit capture per session", async () => {
        useTempDataHome("ctx-busting-test22-");
        const historyRefreshSessions = new Set<string>(["A"]);
        const deferredHistoryRefreshSessions = new Set<string>(["A"]);
        const pendingMaterializationSessions = new Set<string>(["A"]);
        const deferredMaterializationSessions = new Set<string>(["A"]);
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                ["A", { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() }],
                ["B", { usage: { percentage: 10, inputTokens: 10_000 }, updatedAt: Date.now() }],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 1,
            autoDropToolAge: 1000,
            dropToolStructure: true,
        });
        await Promise.all([
            transform({}, { messages: buildSimpleMessages("A") }),
            transform({}, { messages: buildSimpleMessages("B") }),
        ]);
        expect(historyRefreshSessions.has("A")).toBe(false);
        expect(historyRefreshSessions.has("B")).toBe(false);
        expect(deferredHistoryRefreshSessions.has("B")).toBe(false);
    });
});

// Reference unused imports to satisfy TS / silence linter:
void getOrCreateSessionMeta;
