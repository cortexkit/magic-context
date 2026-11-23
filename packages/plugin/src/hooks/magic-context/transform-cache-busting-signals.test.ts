/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

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

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    advanceToolReclaimWatermark,
    closeDatabase,
    getHiddenSeamPlaceholderIds,
    getOldestActiveUnprotectedToolTags,
    getOrCreateSessionMeta,
    getPendingOps,
    getStrippedPlaceholderIds,
    getTagsBySession,
    openDatabase,
    queueM0Mutation,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { getTrailingBlankDecisions } from "../../features/magic-context/storage-meta-persisted";
import {
    getTailHygieneTags,
    insertTag,
    markWhitespaceAssistantTagInert,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as decisionLog } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { canConsumeDeferredOnThisPass } from "./cache-busting-signals";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { createChatMessageHook } from "./hook-handlers";
import * as prefixRenderer from "./inject-compartments";
import { requestPendingMaterialization } from "./pending-materialization";
import { createTransform } from "./transform";

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
    | { type: "text"; text: string; ignored?: boolean; synthetic?: boolean }
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
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
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

function serializeProviderWire(messages: TestMessage[], providerID: string): string {
    const grouped: Array<{ role: string; content: TestPart[] }> = [];
    for (const message of messages) {
        const content = message.parts
            .filter(
                (part) => providerID !== "anthropic" || part.type !== "text" || part.text !== "",
            )
            .map((part) => {
                if (part.type !== "text") return structuredClone(part);
                const historyEnd = part.text.indexOf("</session-history>\n\n");
                return historyEnd < 0
                    ? structuredClone(part)
                    : {
                          ...part,
                          text: part.text.slice(historyEnd + "</session-history>\n\n".length),
                      };
            });
        if (content.length === 0) continue;
        const previous = grouped.at(-1);
        if (previous?.role === message.info.role)
            previous.content.push(...structuredClone(content));
        else grouped.push({ role: message.info.role, content: structuredClone(content) });
    }
    return JSON.stringify(grouped);
}

function buildMessagesWithIgnoredCommandOutput(sessionId: string): TestMessage[] {
    return [
        ...buildSimpleMessages(sessionId),
        {
            info: { id: "m-command-output", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "## Magic Status\n\nStable output", ignored: true }],
        },
        {
            info: { id: "m-next-user", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "continue with normal work" }],
        },
    ];
}

describe("three-set cache-busting refactor (Oracle review 2026-04-26)", () => {
    it("Test 1: historian overlap drains an explicit history refresh exactly once", async () => {
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        historyRefreshSessions.add(sessionId);
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
        const lift = blockCompartmentRun(sessionId);

        try {
            await transform({}, { messages: buildSimpleMessages(sessionId) });

            expect(historyRefreshSessions.has(sessionId)).toBe(false); // drained
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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

    it("Test 3: /ctx-flush drains during a historian run without a second pass", async () => {
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        const lift = blockCompartmentRun(sessionId);

        try {
            historyRefreshSessions.add(sessionId);
            requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
            lift();
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        } finally {
            lift();
        }
    });

    it("Test 4: explicit materialization stays drained after the active run settles", async () => {
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        const lift = blockCompartmentRun(sessionId);
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");

        try {
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
            lift();
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
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
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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

    it("Test 9: deferred helper consumes published state during an active run", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 30,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: true,
            }),
        ).toBe(true);
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
            db,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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

    for (const providerID of ["anthropic", "openai"] as const) {
        it(`keeps ${providerID} seam bytes stable through fold, re-exposure, and marker landing`, async () => {
            useTempDataHome(`ctx-busting-marker-seam-${providerID}-`);
            const sessionId = `ses-marker-seam-${providerID}`;
            const db = openDatabase();
            const historyRefreshSessions = new Set<string>();
            const pendingMaterializationSessions = new Set<string>();
            const deferredHistoryRefreshSessions = new Set<string>();
            const deferredMaterializationSessions = new Set<string>();
            let decision: "execute" | "defer" = "execute";
            const sourceMessages = (): TestMessage[] => [
                {
                    info: { id: "hidden-tool-owner", role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "tool",
                            callID: "hidden-tool-call",
                            state: { output: "never served ".repeat(2_000), tool: "read" },
                        },
                    ],
                },
                {
                    info: { id: "marker-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "marker boundary" }],
                },
                {
                    info: { id: "hidden-assistant-a", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "old assistant a" }],
                },
                {
                    info: { id: "hidden-assistant-b", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "old assistant b" }],
                },
                {
                    info: {
                        id: "assistant-compartment-end",
                        role: "assistant",
                        sessionID: sessionId,
                    },
                    parts: [{ type: "text", text: "fold through here" }],
                },
                {
                    info: { id: "retained-head-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retained head" }],
                },
                {
                    info: { id: "retained-user", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "retain me" }],
                },
            ];
            const transform = createTransform({
                tagger: createTagger(),
                scheduler: { shouldExecute: mock(() => decision) },
                contextUsageMap: new Map([
                    [
                        sessionId,
                        { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                    ],
                ]),
                db,
                liveModelBySession: new Map([
                    [sessionId, { providerID, modelID: `${providerID}-test-model` }],
                ]),
                historyRefreshSessions,
                pendingMaterializationSessions,
                deferredHistoryRefreshSessions,
                deferredMaterializationSessions,
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTokens: 0,
            });

            await transform({}, { messages: sourceMessages() });
            const hiddenTags = getTagsBySession(db, sessionId).filter(
                (tag) =>
                    tag.messageId === "hidden-assistant-a:p0" ||
                    tag.messageId === "hidden-assistant-b:p0",
            );
            expect(hiddenTags).toHaveLength(2);
            for (const tag of hiddenTags) queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 1,
                        startMessage: 1,
                        endMessage: 5,
                        startMessageId: "hidden-tool-owner",
                        endMessageId: "assistant-compartment-end",
                        title: "folded prefix",
                        content: "folded content",
                    },
                ],
                [],
            );
            deferredHistoryRefreshSessions.add(sessionId);
            deferredMaterializationSessions.add(sessionId);

            const foldMessages = sourceMessages();
            await transform({}, { messages: foldMessages });
            const foldWire = serializeProviderWire(foldMessages, providerID);
            expect(foldMessages.some((message) => message.info.id === "hidden-assistant-a")).toBe(
                false,
            );
            expect(getStrippedPlaceholderIds(db, sessionId)).toEqual(
                new Set(["hidden-assistant-a", "hidden-assistant-b"]),
            );
            expect(getHiddenSeamPlaceholderIds(db, sessionId)).toEqual(
                new Set(["hidden-assistant-a", "hidden-assistant-b"]),
            );

            const tagsAfterFold = getTagsBySession(db, sessionId);
            const trimmedIds = new Set([
                "hidden-tool-owner",
                "marker-user:p0",
                "hidden-assistant-a:p0",
                "hidden-assistant-b:p0",
                "assistant-compartment-end:p0",
            ]);
            expect(
                tagsAfterFold
                    .filter((tag) => trimmedIds.has(tag.messageId))
                    .every((tag) => tag.status === "compacted"),
            ).toBe(true);
            expect(
                getTailHygieneTags(db, sessionId).some((tag) => trimmedIds.has(tag.messageId)),
            ).toBe(false);
            const hiddenToolTag = tagsAfterFold.find((tag) => tag.type === "tool");
            expect(hiddenToolTag?.status).toBe("compacted");
            expect(
                getOldestActiveUnprotectedToolTags(db, sessionId, new Set(), 10).some(
                    (tag) => tag.tagNumber === hiddenToolTag?.tagNumber,
                ),
            ).toBe(false);

            db.exec("CREATE TEMP TABLE stripped_placeholder_writes (count INTEGER NOT NULL)");
            db.exec("INSERT INTO stripped_placeholder_writes VALUES (0)");
            db.exec(`CREATE TEMP TRIGGER count_stripped_placeholder_writes
                AFTER UPDATE OF stripped_placeholder_ids ON session_meta
                WHEN OLD.stripped_placeholder_ids IS NOT NEW.stripped_placeholder_ids
                BEGIN UPDATE stripped_placeholder_writes SET count = count + 1; END`);

            decision = "defer";
            const replayMessages = sourceMessages().filter(
                (message) =>
                    message.info.id === "retained-head-user" ||
                    message.info.id === "hidden-assistant-a" ||
                    message.info.id === "hidden-assistant-b" ||
                    message.info.id === "retained-user",
            );
            await transform({}, { messages: replayMessages });
            const replayWire = serializeProviderWire(replayMessages, providerID);
            expect(replayWire).toBe(foldWire);

            const markerLandedMessages = sourceMessages().filter(
                (message) =>
                    message.info.id === "retained-head-user" || message.info.id === "retained-user",
            );
            await transform({}, { messages: markerLandedMessages });
            expect(serializeProviderWire(markerLandedMessages, providerID)).toBe(replayWire);
            expect(getStrippedPlaceholderIds(db, sessionId)).toEqual(
                new Set(["hidden-assistant-a", "hidden-assistant-b"]),
            );
            expect(db.prepare("SELECT count FROM stripped_placeholder_writes").get()).toEqual({
                count: 0,
            });

            decision = "execute";
            deferredHistoryRefreshSessions.add(sessionId);
            deferredMaterializationSessions.add(sessionId);
            const repeatedFoldMessages = sourceMessages();
            await transform({}, { messages: repeatedFoldMessages });
            expect(getTagsBySession(db, sessionId)).toHaveLength(tagsAfterFold.length);
        });
    }

    it("keeps a tagged whitespace shell byte-identical after a marker-advance drain", async () => {
        useTempDataHome("ctx-busting-marker-whitespace-shell-");
        const sessionId = "ses-marker-whitespace-shell";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const deferredHistoryRefreshSessions = new Set<string>();
        const deferredMaterializationSessions = new Set<string>();
        let decision: "execute" | "defer" = "execute";
        const sourceMessages = (includeBlank: boolean, includeTool: boolean): TestMessage[] => [
            {
                info: { id: "marker-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "marker boundary" }],
            },
            {
                info: { id: "retained-head-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "retained head" }],
            },
            {
                info: { id: "blank-owner", role: "assistant", sessionID: sessionId },
                parts: [
                    ...(includeBlank ? ([{ type: "text", text: " " }] as TestPart[]) : []),
                    ...(includeTool
                        ? ([
                              {
                                  type: "tool",
                                  callID: "drained-tool",
                                  state: { output: "old tool output", tool: "read" },
                              },
                          ] as TestPart[])
                        : []),
                ],
            },
            {
                info: { id: "target-assistant", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "The static flag didn't take" }],
            },
            {
                info: { id: "tail-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continue" }],
            },
        ];
        insertTag(db, sessionId, "blank-owner:p0", "message", 1, 16778, 0, null, 0, null, null, {
            tokenCount: 0,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });
        markWhitespaceAssistantTagInert(db, sessionId, 16778, "blank-owner:p0");
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => decision) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "anthropic-test-model" }],
            ]),
            historyRefreshSessions,
            pendingMaterializationSessions,
            deferredHistoryRefreshSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
        });

        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
        await transform({}, { messages: sourceMessages(true, true) });
        expect(getTrailingBlankDecisions(db, sessionId).get("blank-owner")).toBe("strip");
        const toolTag = getTagsBySession(db, sessionId).find(
            (tag) => tag.type === "tool" && tag.messageId === "drained-tool",
        );
        expect(toolTag).toBeDefined();
        // The token window always retains the newest three tool tags. Add three
        // newer persisted arcs so this fixture's queued target is eligible to drain.
        const newestTagNumber = Math.max(
            ...getTagsBySession(db, sessionId).map((tag) => tag.tagNumber),
        );
        for (let offset = 1; offset <= 3; offset += 1) {
            insertTag(
                db,
                sessionId,
                `window-displacer-${offset}`,
                "tool",
                80_000,
                newestTagNumber + offset,
                0,
                "read",
                0,
                `window-displacer-owner-${offset}`,
                null,
                { tokenCount: 20_000, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
        }
        queuePendingOp(db, sessionId, toolTag!.tagNumber, "drop");
        replaceAllCompartmentState(
            db,
            sessionId,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "marker-user",
                    endMessageId: "marker-user",
                    title: "advanced marker",
                    content: "folded marker prefix",
                },
            ],
            [],
        );
        deferredHistoryRefreshSessions.add(sessionId);
        deferredMaterializationSessions.add(sessionId);

        const foldMessages = sourceMessages(true, false);
        await transform({}, { messages: foldMessages });
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        const foldAssistant = (
            JSON.parse(serializeProviderWire(foldMessages, "anthropic")) as Array<{
                role: string;
                content: TestPart[];
            }>
        ).find((message) => JSON.stringify(message).includes("The static flag didn't take"));

        decision = "defer";
        const replayMessages = sourceMessages(false, false).slice(1);
        await transform({}, { messages: replayMessages });
        const replayAssistant = (
            JSON.parse(serializeProviderWire(replayMessages, "anthropic")) as Array<{
                role: string;
                content: TestPart[];
            }>
        ).find((message) => JSON.stringify(message).includes("The static flag didn't take"));

        expect(replayAssistant).toEqual(foldAssistant);
    });

    it.each([
        ["anthropic", "claude-sonnet-5-5"],
        ["anthropic", "claude-haiku-5-5"],
        ["anthropic", "claude-fable-5-2"],
        ["anthropic", "claude-mythos-5-1"],
        ["anthropic", "claude-mythos-5-2"],
        ["anthropic", "claude-opus-5-5"],
        ["openai-codex", "gpt-6-astra"],
    ])("OpenCode %s/%s effort change leaves queued work deferred", async (providerID, modelID) => {
        useTempDataHome("ctx-effort-defer-");
        const sessionId = `ses-effort-${modelID}`;
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const lastHeuristicsTurnId = new Map<string, string>();
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
        const variantBySession = new Map<string, string | undefined>();
        const shouldExecute = mock(() => "defer" as const);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            liveModelBySession,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTokens: 0,
        });
        const hook = createChatMessageHook({
            db,
            liveModelBySession,
            variantBySession,
            agentBySession: new Map<string, string>(),
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
        });
        await hook({
            sessionID: sessionId,
            variant: "high",
            model: { providerID, modelID },
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        const beforeFlip = buildSimpleMessages(sessionId);
        await transform({}, { messages: beforeFlip });
        const beforeHash = createHash("sha256").update(JSON.stringify(beforeFlip)).digest("hex");
        queuePendingOp(db, sessionId, 1, "drop");

        await hook({
            sessionID: sessionId,
            variant: "xhigh",
            model: { providerID, modelID },
        });
        expect({
            history: historyRefreshSessions.size,
            systemPrompt: systemPromptRefreshSessions.size,
            materialization: pendingMaterializationSessions.size,
        }).toEqual({ history: 0, systemPrompt: 0, materialization: 0 });
        shouldExecute.mockClear();
        const afterFlip = buildSimpleMessages(sessionId);
        await transform({}, { messages: afterFlip });
        const afterHash = createHash("sha256").update(JSON.stringify(afterFlip)).digest("hex");

        expect(afterHash).toBe(beforeHash);
        expect(decisionLog.getPending(sessionId)).toBeUndefined();
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        expect(shouldExecute).toHaveBeenCalled();
    });

    it("Fable 5.1 variant change keeps the next pass deferred and pending ops untouched", async () => {
        useTempDataHome("ctx-fable-variant-defer-");
        const sessionId = "ses-fable-variant-defer";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const lastHeuristicsTurnId = new Map<string, string>();
        const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
        const shouldExecute = mock(() => "defer" as const);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            liveModelBySession,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            clearReasoningAge: 50,
            protectedTokens: 0,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        shouldExecute.mockClear();
        queuePendingOp(db, sessionId, 1, "drop");

        const hook = createChatMessageHook({
            db,
            liveModelBySession,
            variantBySession: new Map<string, string | undefined>(),
            agentBySession: new Map<string, string>(),
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
        });
        await hook({
            sessionID: sessionId,
            variant: "high",
            model: { providerID: "anthropic", modelID: "claude-fable-5-1" },
        });
        await hook({
            sessionID: sessionId,
            variant: "medium",
            model: { providerID: "anthropic", modelID: "claude-fable-5-1" },
        });

        expect(historyRefreshSessions.size).toBe(0);
        expect(systemPromptRefreshSessions.size).toBe(0);
        expect(pendingMaterializationSessions.size).toBe(0);
        const nextPass = buildSimpleMessages(sessionId);
        await transform({}, { messages: nextPass });
        expect(shouldExecute).toHaveBeenCalled();
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
    });

    it("keeps ignored Desktop command output byte-stable across three quiet passes", async () => {
        useTempDataHome("ctx-stripped-command-output-");
        const sessionId = "ses-stripped-command-output";
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });

        const warm = buildMessagesWithIgnoredCommandOutput(sessionId);
        await transform({}, { messages: warm });
        const passA = buildMessagesWithIgnoredCommandOutput(sessionId);
        await transform({}, { messages: passA });
        const passAWire = JSON.stringify(passA);
        const passB = buildMessagesWithIgnoredCommandOutput(sessionId);
        await transform({}, { messages: passB });

        expect(JSON.stringify(passB)).toBe(passAWire);
        const ignoredOutput = passB.find((message) => message.info.id === "m-command-output")
            ?.parts[0] as { type: string; text: string; ignored?: boolean } | undefined;
        expect(ignoredOutput?.ignored).toBe(true);
        expect(ignoredOutput?.text).toContain("## Magic Status\n\nStable output");
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
                    title: "Published summary",
                    content: "Published summary",
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
            db,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
        });

        await transform({}, { messages: buildSimpleMessages(sessionId) });

        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 13: active low-context execute consumes deferred state", async () => {
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
                db: openDatabase(),
                historyRefreshSessions: new Set<string>(),
                deferredHistoryRefreshSessions,
                pendingMaterializationSessions: new Set<string>(),
                deferredMaterializationSessions,
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTokens: 1,
                client: testClient,
                directory: testDirectory,
            });
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
            expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
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
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
    });

    it("Test 15: low-context explicit refresh drains both deferred sets", async () => {
        useTempDataHome("ctx-busting-test15-");
        const sessionId = "ses-explicit-drain";
        const historyRefreshSessions = new Set<string>([sessionId]);
        const pendingMaterializationSessions = new Set<string>();
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
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
            db: openDatabase(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 16: explicit refresh is delivered during historian overlap", async () => {
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
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });
        const lift = blockCompartmentRun(sessionId);
        let passAText = "";
        try {
            await transform({}, { messages: buildSimpleMessages(sessionId) });
            historyRefreshSessions.add(sessionId);
            requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
            const passA = buildSimpleMessages(sessionId);
            await transform({}, { messages: passA });
            passAText = JSON.stringify(passA[0]);
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
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
            db,
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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
            db,
            historyRefreshSessions: new Set<string>(),
            deferredHistoryRefreshSessions: set,
            pendingMaterializationSessions: new Set<string>(),
            deferredMaterializationSessions: mat,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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
        const pendingMaterializationSessions = new Set<string>();
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
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
            db: openDatabase(),
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
        });
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
        expect(deferredMaterializationSessions.has(sessionId)).toBe(false);
    });

    it("Test 21: explicit refresh does not need a retry after historian overlap", async () => {
        useTempDataHome("ctx-busting-test21-");
        const sessionId = "ses-test21";
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
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
            db,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: testClient,
            directory: testDirectory,
        });

        const lift = blockCompartmentRun(sessionId);
        await transform({}, { messages: buildSimpleMessages(sessionId) });
        historyRefreshSessions.add(sessionId);
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
        const passA = buildSimpleMessages(sessionId);
        try {
            await transform({}, { messages: passA });
            expect(historyRefreshSessions.has(sessionId)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
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
            db,
            historyRefreshSessions,
            deferredHistoryRefreshSessions,
            pendingMaterializationSessions,
            deferredMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
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

it.each([
    "queued",
    "age",
])("published A and %s drops drain together during historian B; B then waits for execute", async (dropLane) => {
    useTempDataHome("ctx-published-drain-");
    const sessionId = "ses-published-drain";
    const db = openDatabase();
    let decision: "execute" | "defer" = "defer";
    const deferredHistoryRefreshSessions = new Set<string>();
    const deferredMaterializationSessions = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: new Map([
            [
                sessionId,
                { usage: { percentage: 75.02, inputTokens: 75020 }, updatedAt: Date.now() },
            ],
        ]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 100000,
        protectedTokens: 1,
        client: testClient,
        directory: testDirectory,
    });
    const raw = (): TestMessage[] => [
        ...buildSimpleMessages(sessionId),
        {
            info: { id: "next-history", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "next history" }],
        },
        {
            info: { id: "old-tool", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: "old-call",
                    state: { tool: "read", output: "old payload ".repeat(200) },
                },
            ],
        },
        {
            info: { id: "latest-user", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "continue" }],
        },
    ];
    const publish = (sequence: number, title: string) => {
        appendCompartments(db, sessionId, [
            {
                sequence,
                startMessage: sequence,
                endMessage: sequence,
                startMessageId: ["m-user", "m-assistant", "next-history"][sequence - 1]!,
                endMessageId: ["m-user", "m-assistant", "next-history"][sequence - 1]!,
                title,
                content: title,
            },
        ]);
        deferredHistoryRefreshSessions.add(sessionId);
        deferredMaterializationSessions.add(sessionId);
    };
    publish(1, "BASELINE");
    await transform({}, { messages: raw() });
    publish(2, "PUBLISHED_A");
    const tag = getTagsBySession(db, sessionId).find((t) => t.messageId === "old-call");
    expect(tag).toBeDefined();
    for (let offset = 1; offset <= 3; offset++) {
        insertTag(
            db,
            sessionId,
            `newer-${offset}`,
            "tool",
            80000,
            tag!.tagNumber + 100 + offset,
            0,
            "read",
            0,
            `newer-owner-${offset}`,
            null,
            { tokenCount: 20000, inputTokenCount: 0, reasoningTokenCount: 0 },
        );
    }
    if (dropLane === "queued") queuePendingOp(db, sessionId, tag!.tagNumber, "drop");
    advanceToolReclaimWatermark(db, sessionId, tag!.tagNumber);
    const lift = blockCompartmentRun(sessionId);
    try {
        decision = "execute";
        const passN = raw();
        await transform({}, { messages: passN });
        expect(JSON.stringify(passN.slice(0, 2))).toContain("PUBLISHED_A");
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        expect(JSON.stringify(passN)).not.toContain("old payload");
        lift();
        await Promise.resolve();
        publish(3, "PUBLISHED_B");
        decision = "defer";
        const replay = raw();
        await transform({}, { messages: replay });
        expect(JSON.stringify(replay)).toBe(JSON.stringify(passN));
        expect(JSON.stringify(replay)).not.toContain("PUBLISHED_B");
        decision = "execute";
        const nextBust = raw();
        await transform({}, { messages: nextBust });
        expect(JSON.stringify(nextBust.slice(0, 2))).toContain("PUBLISHED_B");
    } finally {
        lift();
    }
});

it("contention replays the complete transform including the persisted raw boundary", async () => {
    useTempDataHome("ctx-whole-pass-contention-");
    const sessionId = "ses-whole-pass-contention";
    const db = openDatabase();
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "m-user",
            endMessageId: "m-user",
            title: "BASELINE",
            content: "BASELINE",
        },
    ]);
    let decision: "execute" | "defer" = "defer";
    const deferredHistoryRefreshSessions = new Set<string>();
    const deferredMaterializationSessions = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 75, inputTokens: 75000 }, updatedAt: Date.now() }],
        ]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions,
        deferredMaterializationSessions,
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 100000,
        protectedTokens: 1,
        client: testClient,
        directory: testDirectory,
    });
    const raw = (): TestMessage[] => [
        ...buildSimpleMessages(sessionId),
        {
            info: { id: "old-tool", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: "old-call",
                    state: { tool: "read", output: "old output ".repeat(200) },
                },
            ],
        },
        {
            info: { id: "latest-user", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "continue" }],
        },
    ];
    const baseline = raw();
    await transform({}, { messages: baseline });
    const frozen = JSON.stringify(baseline);
    const tool = getTagsBySession(db, sessionId).find((t) => t.messageId === "old-call")!;
    for (let n = 1; n <= 3; n++)
        insertTag(
            db,
            sessionId,
            `pad-${n}`,
            "tool",
            80000,
            tool.tagNumber + 100 + n,
            0,
            "read",
            0,
            `pad-owner-${n}`,
            null,
            { tokenCount: 20000, inputTokenCount: 0, reasoningTokenCount: 0 },
        );
    advanceToolReclaimWatermark(db, sessionId, tool.tagNumber);
    appendCompartments(db, sessionId, [
        {
            sequence: 2,
            startMessage: 2,
            endMessage: 2,
            startMessageId: "m-assistant",
            endMessageId: "m-assistant",
            title: "PUBLISHED_A",
            content: "PUBLISHED_A",
        },
    ]);
    deferredHistoryRefreshSessions.add(sessionId);
    deferredMaterializationSessions.add(sessionId);
    let contend = true;
    const original = prefixRenderer.injectM0M1;
    const injection = spyOn(prefixRenderer, "injectM0M1").mockImplementation((options) => {
        if (contend && !options.preparedPrefix) options.state.cachedM1Bytes = null;
        return original({
            ...options,
            beforePhase3ForTest:
                contend && !options.messages
                    ? () => {
                          queueM0Mutation(db, { sessionId, mutationType: "compartment_merge" });
                      }
                    : undefined,
        });
    });
    const lift = blockCompartmentRun(sessionId);
    try {
        decision = "execute";
        for (let pass = 0; pass < 2; pass++) {
            const messages = raw();
            await transform({}, { messages });
            expect(JSON.stringify(messages)).toBe(frozen);
            expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
        }
        contend = false;
        const delivered = raw();
        await transform({}, { messages: delivered });
        expect(JSON.stringify(delivered.slice(0, 2))).toContain("PUBLISHED_A");
        expect(JSON.stringify(delivered)).not.toContain("old output");
        decision = "defer";
        const replay = raw();
        await transform({}, { messages: replay });
        expect(JSON.stringify(replay)).toBe(JSON.stringify(delivered));
    } finally {
        injection.mockRestore();
        lift();
    }
});
