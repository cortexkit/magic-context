/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getPersistedNudgePlacement,
    getPersistedStickyTurnReminder,
    insertTag,
    openDatabase,
    queuePendingOp,
    setPersistedStickyTurnReminder,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { createNudgePlacementStore, createTransform } from "./transform";

type TestMessage = {
    info: { id: string; role: string; sessionID?: string };
    parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-invocation"; callID: string }
        | { type: "tool"; callID: string; state: { output: string } }
    >;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function firstText(message: TestMessage): string {
    const firstPart = message.parts[0];
    if (!firstPart || firstPart.type !== "text") {
        throw new Error("expected first part to be text");
    }

    return firstPart.text;
}

function makeMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "user prompt" }],
        },
        {
            info: { id: "m-assistant", role: "assistant" },
            parts: [{ type: "text", text: "assistant response" }],
        },
    ];
}

function makePartialReleaseMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "user prompt" }],
        },
        {
            info: { id: "m-assistant-complete", role: "assistant" },
            parts: [{ type: "tool-invocation", callID: "call-complete" }],
        },
        {
            info: { id: "m-tool-complete", role: "tool" },
            parts: [{ type: "tool", callID: "call-complete", state: { output: "done" } }],
        },
        {
            info: { id: "m-assistant-incomplete", role: "assistant" },
            parts: [{ type: "tool-invocation", callID: "call-incomplete" }],
        },
    ];
}

describe("createTransform nudge cache handling", () => {
    it("clears stored nudge placement when pending operations mutate content", async () => {
        //#given
        useTempDataHome("context-transform-nudge-pending-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const nudgePlacements = createNudgePlacementStore(db);
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 61, inputTokens: 120_000 }, updatedAt: Date.now() }],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger: () => null,
            db,
            nudgePlacements,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        await transform({}, { messages: makeMessages() });
        queuePendingOp(db, "ses-1", 1, "drop");
        nudgePlacements.set("ses-1", "m-assistant", "\n[old nudge]");
        scheduler.shouldExecute = mock(() => "execute" as const);
        const secondPass = makeMessages();

        //#when
        await transform({}, { messages: secondPass });

        //#then — user (tag 1) shell is preserved via truncation (not stripped);
        // assistant at index 1 must have the stale nudge cleared.
        expect(secondPass).toHaveLength(2);
        expect(secondPass[0]?.info.role).toBe("user");
        const userShell = firstText(secondPass[0]!);
        expect(userShell.startsWith("[truncated \u00a71\u00a7]")).toBe(true);
        expect(firstText(secondPass[1]!)).not.toContain("[old nudge]");
        expect(getPersistedNudgePlacement(db, "ses-1")).toBeNull();
    });

    it("clears stored nudge placement when flushed statuses mutate content on execute pass", async () => {
        //#given — execute pass so nudge placement clear is allowed
        useTempDataHome("context-transform-nudge-flushed-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "execute" as const) };
        const db = openDatabase();
        const nudgePlacements = createNudgePlacementStore(db);
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger: () => null,
            db,
            nudgePlacements,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        await transform({}, { messages: makeMessages() });
        updateTagStatus(db, "ses-1", 2, "dropped");
        nudgePlacements.set("ses-1", "m-assistant", "\n[old nudge]");
        const secondPass = makeMessages();

        //#when
        await transform({}, { messages: secondPass });

        //#then — sentinel replacement preserves array length; assistant (tag 2) is
        // neutralized to an empty-text sentinel instead of spliced out.
        expect(secondPass).toHaveLength(2);
        expect(secondPass[1]?.parts).toEqual([{ type: "text", text: "" }]);
        expect(getPersistedNudgePlacement(db, "ses-1")).toBeNull();
    });

    it("keeps the original anchored nudge text stable across turns", async () => {
        //#given
        useTempDataHome("context-transform-nudge-stable-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const nudgePlacements = createNudgePlacementStore(db);
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 66, inputTokens: 120_000 }, updatedAt: Date.now() }],
        ]);
        let nudgeText = '\n\n<instruction name="context_warning">warning</instruction>';
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap,
            nudger: () => ({ type: "assistant", text: nudgeText }),
            db,
            nudgePlacements,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        const firstPass = makeMessages();
        await transform({}, { messages: firstPass });

        nudgeText = '\n\n<instruction name="context_critical">critical</instruction>';
        const secondPass = makeMessages();

        //#when
        await transform({}, { messages: secondPass });

        //#then
        const assistantText = firstText(secondPass[1]!);
        expect(assistantText).toContain("warning");
        expect(assistantText).not.toContain("critical");
        expect(assistantText.match(/<instruction name="context_/g)?.length).toBe(1);
    });

    it("restores anchored nudge placement from DB across store recreation", async () => {
        //#given
        useTempDataHome("context-transform-nudge-restart-restore-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const firstStore = createNudgePlacementStore(db);
        let nudgeText = '\n\n<instruction name="context_warning">warning</instruction>';
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 66, inputTokens: 120_000 }, updatedAt: Date.now() }],
        ]);
        const makeTransform = (store: ReturnType<typeof createNudgePlacementStore>) =>
            createTransform({
                tagger: createTagger(),
                scheduler,
                contextUsageMap,
                nudger: () => ({ type: "assistant", text: nudgeText }),
                db,
                nudgePlacements: store,
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTags: 0,
                autoDropToolAge: 1000,
            });

        await makeTransform(firstStore)({}, { messages: makeMessages() });
        expect(getPersistedNudgePlacement(db, "ses-1")).toEqual({
            messageId: "m-assistant",
            nudgeText: '\n\n<instruction name="context_warning">warning</instruction>',
        });

        nudgeText = '\n\n<instruction name="context_critical">critical</instruction>';
        const restartedStore = createNudgePlacementStore(db);
        const secondPass = makeMessages();

        //#when
        await makeTransform(restartedStore)({}, { messages: secondPass });

        //#then
        const assistantText = firstText(secondPass[1]!);
        expect(assistantText).toContain("warning");
        expect(assistantText).not.toContain("critical");
        expect(assistantText.match(/<instruction name="context_/g)?.length).toBe(1);
    });

    it("preserves persisted anchor and skips re-anchoring when the anchored message is gone after restart", async () => {
        //#given
        useTempDataHome("context-transform-nudge-restart-skip-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const firstStore = createNudgePlacementStore(db);
        let nudgeText = '\n\n<instruction name="context_warning">warning</instruction>';
        const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 66, inputTokens: 120_000 }, updatedAt: Date.now() }],
        ]);
        const makeTransform = (store: ReturnType<typeof createNudgePlacementStore>) =>
            createTransform({
                tagger: createTagger(),
                scheduler,
                contextUsageMap,
                nudger: () => ({ type: "assistant", text: nudgeText }),
                db,
                nudgePlacements: store,
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTags: 0,
                autoDropToolAge: 1000,
            });

        await makeTransform(firstStore)({}, { messages: makeMessages() });
        nudgeText = '\n\n<instruction name="context_critical">critical</instruction>';
        const restartedStore = createNudgePlacementStore(db);
        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-other-assistant", role: "assistant" },
                parts: [{ type: "text", text: "assistant response" }],
            },
        ];

        //#when
        await makeTransform(restartedStore)({}, { messages: secondPass });

        //#then
        expect(firstText(secondPass[1]!)).toContain("assistant response");
        expect(firstText(secondPass[1]!)).not.toContain('<instruction name="context_');
        expect(getPersistedNudgePlacement(db, "ses-1")).toEqual({
            messageId: "m-assistant",
            nudgeText: '\n\n<instruction name="context_warning">warning</instruction>',
        });
    });

    it("keeps sticky turn reminders across defer passes until pending drops are released", async () => {
        //#given
        useTempDataHome("context-transform-sticky-turn-reminder-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(db),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        setPersistedStickyTurnReminder(
            db,
            "ses-1",
            '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
        );

        const firstPass = makeMessages();

        //#when
        await transform({}, { messages: firstPass });

        //#then
        expect(firstText(firstPass[0]!)).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.text).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.messageId).toBe("m-user");

        const secondPass = makeMessages();

        //#when
        await transform({}, { messages: secondPass });

        //#then
        expect(firstText(secondPass[0]!)).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.text).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.messageId).toBe("m-user");

        queuePendingOp(db, "ses-1", 1, "drop");
        scheduler.shouldExecute = mock(() => "execute" as const);
        const thirdPass = makeMessages();

        //#when
        await transform({}, { messages: thirdPass });

        //#then
        expect(firstText(thirdPass[0]!)).not.toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")).toBeNull();
    });

    it("keeps sticky turn reminders when applyPendingOperations only partially drains the queue", async () => {
        //#given
        useTempDataHome("context-transform-sticky-turn-reminder-partial-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const tagger = createTagger();
        const transform = createTransform({
            tagger,
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(db),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        const insertedIncompleteToolTag = insertTag(db, "ses-1", "call-incomplete", "tool", 123, 7);
        tagger.initFromDb("ses-1", db);

        const baselinePass = makePartialReleaseMessages();
        await transform({}, { messages: baselinePass });

        const completeToolTag = tagger.getTag("ses-1", "call-complete");
        const incompleteToolTag = tagger.getTag("ses-1", "call-incomplete");
        expect(completeToolTag).toBeDefined();
        expect(incompleteToolTag).toBe(insertedIncompleteToolTag);

        queuePendingOp(db, "ses-1", completeToolTag!, "drop");
        queuePendingOp(db, "ses-1", incompleteToolTag!, "drop");
        setPersistedStickyTurnReminder(
            db,
            "ses-1",
            '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
        );
        scheduler.shouldExecute = mock(() => "execute" as const);
        const releasePass = makePartialReleaseMessages();

        //#when
        await transform({}, { messages: releasePass });

        //#then
        expect(firstText(releasePass[0]!)).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.text).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")?.messageId).toBe("m-user");
    });

    it("keeps sticky turn reminder anchored to the original user message across later turns", async () => {
        //#given
        useTempDataHome("context-transform-sticky-anchor-stable-");
        const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(db),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        setPersistedStickyTurnReminder(
            db,
            "ses-1",
            '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
        );

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "first user prompt" }],
            },
            {
                info: { id: "m-assistant-1", role: "assistant" },
                parts: [{ type: "text", text: "assistant response" }],
            },
        ];

        await transform({}, { messages: firstPass });

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "first user prompt" }],
            },
            {
                info: { id: "m-assistant-1", role: "assistant" },
                parts: [{ type: "text", text: "assistant response" }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "second user prompt" }],
            },
            {
                info: { id: "m-assistant-2", role: "assistant" },
                parts: [{ type: "text", text: "later assistant response" }],
            },
        ];

        //#when
        await transform({}, { messages: secondPass });

        //#then
        expect(firstText(secondPass[0]!)).toContain("sticky reminder");
        expect(firstText(secondPass[2]!)).not.toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")).toEqual({
            text: '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
            messageId: "m-user-1",
        });
    });

    it("keeps sticky turn reminder on cache-safe defer pass even when ctx_reduce is in recent messages", async () => {
        //#given — scheduler defers, so this is a cache-safe pass
        useTempDataHome("context-transform-sticky-keep-on-defer-");
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(db),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        setPersistedStickyTurnReminder(
            db,
            "ses-1",
            '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
        );

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "assistant response" },
                    {
                        type: "tool-invocation" as "text",
                        callID: "reduce-call" as unknown as undefined,
                        toolName: "ctx_reduce",
                    } as unknown as TestMessage["parts"][0],
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — reminder stays in DB and keeps being reinjected (cache-safe: no removal)
        expect(firstText(messages[0]!)).toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")).not.toBeNull();
    });

    it("clears sticky turn reminder on cache-busting execute pass when ctx_reduce is in recent messages", async () => {
        //#given — scheduler executes, so this pass already busts cache
        useTempDataHome("context-transform-sticky-clear-on-execute-");
        const db = openDatabase();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "execute" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-1",
                    { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            nudger: () => null,
            db,
            nudgePlacements: createNudgePlacementStore(db),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTags: 0,
            autoDropToolAge: 1000,
        });

        setPersistedStickyTurnReminder(
            db,
            "ses-1",
            '\n\n<instruction name="ctx_reduce_turn_cleanup">sticky reminder</instruction>',
        );

        const messages: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "user prompt" }],
            },
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [
                    { type: "text", text: "assistant response" },
                    {
                        type: "tool-invocation" as "text",
                        callID: "reduce-call" as unknown as undefined,
                        toolName: "ctx_reduce",
                    } as unknown as TestMessage["parts"][0],
                ],
            },
        ];

        //#when
        await transform({}, { messages });

        //#then — reminder cleared from DB and NOT injected (cache already busting)
        expect(firstText(messages[0]!)).not.toContain("sticky reminder");
        expect(getPersistedStickyTurnReminder(db, "ses-1")).toBeNull();
    });
});
