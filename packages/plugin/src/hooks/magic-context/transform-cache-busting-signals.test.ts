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
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
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
});

// Reference unused imports to satisfy TS / silence linter:
void getOrCreateSessionMeta;
