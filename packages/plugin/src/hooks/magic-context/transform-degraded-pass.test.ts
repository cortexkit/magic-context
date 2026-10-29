/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createScheduler, type Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { getDatabasePath } from "../../features/magic-context/storage-db";
import {
    addMergedReasoningStrippedIds,
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    addTrailingBlankDecisions,
    appendNoteNudgeAnchor,
    getNoteNudgeAnchors,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import { markTagDropped } from "../../features/magic-context/storage-tags";
import * as coordinateRebase from "../../features/magic-context/store-generation-rebase";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as decisionLogInternals } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import * as autoSearchRunner from "./auto-search-runner";
import * as modeTransition from "./compaction-off-transition";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import * as staleReduce from "./drop-stale-reduce-calls";
import * as injectCompartments from "./inject-compartments";
import { __test as fenceInternals, lkgRecoveryFencePath } from "./lkg-recovery-fence";
import { dropSlot, getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import * as noteNudger from "./note-nudger";
import { requestPendingMaterialization } from "./pending-materialization";
import { STORAGE_BUSY_MESSAGE } from "./storage-busy-refusal";
import { createTransform } from "./transform";
import * as transformOperations from "./transform-operations";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];

const BULKY = "BULKY-TOOL-OUTPUT const value = compute(input, options); // line\n".repeat(600);

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let heldLock: Database | null = null;

function useTempDataHome(prefix: string): void {
    const { dir } = createTestTempDir(prefix);
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function releaseLock(): void {
    if (!heldLock) return;
    try {
        heldLock.exec("ROLLBACK");
    } finally {
        heldLock.close();
        heldLock = null;
    }
}

afterEach(() => {
    releaseLock();
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

function history(sessionId: string): Message[] {
    return [
        {
            info: { id: "u1", time: { created: 1 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "read the file" }],
        },
        {
            info: {
                id: "a1",
                time: { created: 2 },
                role: "assistant",
                sessionID: sessionId,
                finish: "tool-calls",
            },
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    tool: "read",
                    state: { status: "completed", input: { path: "a.ts" }, output: BULKY },
                },
            ],
        },
        {
            info: { id: "u2", time: { created: 3 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "thanks" }],
        },
        {
            info: {
                id: "a2",
                time: { created: 4 },
                role: "assistant",
                sessionID: sessionId,
                finish: "stop",
            },
            parts: [{ type: "text", text: "done" }],
        },
        {
            info: { id: "u3", time: { created: 5 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
}

function nextTurn(sessionId: string): Message[] {
    return [
        ...history(sessionId),
        {
            info: {
                id: "a3",
                time: { created: 6 },
                role: "assistant",
                sessionID: sessionId,
                finish: "stop",
            },
            parts: [{ type: "text", text: "answer" }],
        },
        {
            info: { id: "u4", time: { created: 7 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "follow-up" }],
        },
    ];
}

/**
 * A real database session whose tool output is a persisted drop, served once
 * healthy so the last-good request exists. `lockDuringTagging` makes the next
 * tagging step find the writer lock held by a second connection, released when
 * the transform resets the tagger, i.e. exactly across the tagging step.
 */
async function sessionWithPersistedDrop(
    sessionId: string,
    generation?: "v1" | "v2",
    noteAnchor?: { messageId: string; text: string },
    source = history,
) {
    useTempDataHome("mc-degraded-pass-");
    const db = openDatabase();
    if (noteAnchor) {
        appendNoteNudgeAnchor(db, sessionId, noteAnchor.messageId, noteAnchor.text);
    }
    let lockDuringTagging = false;
    const baseTagger = createTagger();
    const tagger = {
        ...baseTagger,
        initFromDb: (...args: Parameters<typeof baseTagger.initFromDb>) => {
            if (lockDuringTagging) {
                lockDuringTagging = false;
                const path = getDatabasePath(db);
                if (!path) throw new Error("test database has no file path");
                heldLock = new Database(path);
                heldLock.exec("BEGIN IMMEDIATE");
            }
            return baseTagger.initFromDb(...args);
        },
        cleanup: (id: string) => {
            releaseLock();
            baseTagger.cleanup(id);
        },
    };
    const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
    const deps: Parameters<typeof createTransform>[0] = {
        directory: generation ? process.env.XDG_DATA_HOME : undefined,
        storeGeneration: generation,
        hostRawMessages: generation ? async () => source(sessionId) : undefined,
        hostPrepareRawOrdinals: generation ? async () => true : undefined,
        tagger,
        scheduler,
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]),
        db,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
    };
    const transform = createTransform(deps);
    const onLkgReplay = mock(() => undefined);
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
        onLkgReplay,
    });
    const serve = async (messages: Message[]) => {
        const output = { messages } as unknown as Output;
        await handler({}, output);
        return output.messages as unknown as Message[];
    };

    // First pass tags the conversation; the tool output is then dropped the
    // way a flushed ctx_reduce leaves it.
    await serve(source(sessionId));
    const toolTag = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool");
    if (!toolTag) throw new Error("the first pass did not tag the tool output");
    updateTagStatus(db, sessionId, toolTag.tagNumber, "dropped");

    // A healthy defer pass replays the drop; it is the last good request.
    const managed = JSON.stringify(await serve(source(sessionId)));
    if (generation)
        updateSessionMeta(db, sessionId, {
            lastResponseTime: Date.now(),
            cacheTtl: "59m",
            systemPromptHash: "system-before-change",
        });
    expect(managed).not.toContain("BULKY-TOOL-OUTPUT");
    expect(getSlot(sessionId)).toBeDefined();

    return {
        db,
        deps,
        managed,
        serve,
        onLkgReplay,
        armLockDuringTagging: () => {
            lockDuringTagging = true;
        },
    };
}

function expectReplayOfManaged(served: Message[], managed: string, sessionId: string): void {
    const previous = JSON.parse(managed) as Message[];
    const json = JSON.stringify(served);
    expect(json).not.toContain("BULKY-TOOL-OUTPUT");
    // Byte-identical to the previous request, plus the new turn as it arrived.
    expect(JSON.stringify(served.slice(0, previous.length))).toBe(managed);
    expect(JSON.stringify(served.slice(previous.length))).toBe(
        JSON.stringify(nextTurn(sessionId).slice(history(sessionId).length)),
    );
}

describe("a degraded transform pass is never served", () => {
    it("preserves a captured note nudge on an older dropped synthetic user message during busy LKG replay", async () => {
        const sessionId = "ses-lkg-dropped-note-nudge";
        const instruction =
            '\n\n<instruction name="deferred_notes">frozen older-message note</instruction>';
        // Healthy postprocessing excludes synthetic notice parts from its late
        // drop sweep. The fallback must preserve their already-served note suffix too.
        const source = () => {
            const messages = history(sessionId);
            messages[0].parts[0] = {
                type: "text",
                synthetic: true,
                text: "[BACKGROUND BASH COMPLETED] finished earlier work",
            };
            return messages;
        };
        const session = await sessionWithPersistedDrop(
            sessionId,
            undefined,
            { messageId: "u1", text: instruction },
            source,
        );
        const userTag = getTagsBySession(session.db, sessionId).find(
            (tag) => tag.messageId === "u1:p0",
        );
        if (!userTag) throw new Error("Expected a tagged older user message");
        markTagDropped(session.db, sessionId, userTag.tagNumber, "full");
        const first = await session.serve(source());
        const firstUser = first.find((message) => message.info.id === "u1");
        expect(firstUser?.parts[0].text).toBe(`[dropped §${userTag.tagNumber}§]${instruction}`);
        expect(getSlot(sessionId)?.jsonPrefix).toContain("frozen older-message note");
        expect(session.onLkgReplay).not.toHaveBeenCalled();

        session.armLockDuringTagging();
        const second = await session.serve([
            ...source(),
            ...nextTurn(sessionId).slice(history(sessionId).length),
        ]);
        const secondUser = second.find((message) => message.info.id === "u1");
        expect(session.onLkgReplay).toHaveBeenCalledTimes(1);
        expect(getSlot(sessionId)?.jsonPrefix).toContain("frozen older-message note");
        expect(getNoteNudgeAnchors(session.db, sessionId)).toEqual([
            { messageId: "u1", text: instruction },
        ]);
        expect(JSON.stringify(secondUser)).toBe(JSON.stringify(firstUser));
    });

    for (const synthetic of [false, true]) {
        it(`keeps a captured reminder on ${synthetic ? "a synthetic source notice" : "ordinary user text"} when a failed attempt commits a new drop and the next pass is healthy`, async () => {
            const sessionId = `ses-lkg-new-drop-note-nudge-${synthetic}`;
            const instruction =
                '\n\n<instruction name="deferred_notes">captured before the new drop</instruction>';
            const source = () => {
                const messages = history(sessionId);
                messages[0].parts[0] = {
                    type: "text",
                    ...(synthetic ? { synthetic: true } : {}),
                    text: "[BACKGROUND BASH COMPLETED] output before reduction",
                };
                return messages;
            };
            const session = await sessionWithPersistedDrop(
                sessionId,
                undefined,
                { messageId: "u1", text: instruction },
                source,
            );
            const userTag = getTagsBySession(session.db, sessionId).find(
                (tag) => tag.messageId === "u1:p0",
            );
            if (!userTag) throw new Error("Expected the older text tag");
            expect(getSlot(sessionId)?.jsonPrefix).toContain("output before reduction");
            expect(getSlot(sessionId)?.jsonPrefix).toContain("captured before the new drop");

            const onLkgReplay = mock(() => undefined);
            const failing = createMessagesTransformHandler({
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        markTagDropped(session.db, sessionId, userTag.tagNumber, "full");
                        throw new DegradedPassRefusalError("pending-operation-failure");
                    },
                },
                onLkgReplay,
            });
            const raw = [...source(), ...nextTurn(sessionId).slice(history(sessionId).length)];
            const output = { messages: structuredClone(raw) } as unknown as Output;
            await failing({}, output);
            expect(onLkgReplay).toHaveBeenCalledTimes(1);
            const replayed = (output.messages as unknown as Message[]).find(
                (message) => message.info.id === "u1",
            );
            expect(replayed?.parts[0].text).toBe(`[dropped §${userTag.tagNumber}§]${instruction}`);
            const healthy = await session.serve(structuredClone(raw));
            expect(session.onLkgReplay).not.toHaveBeenCalled();
            expect(JSON.stringify(healthy.find((message) => message.info.id === "u1"))).toBe(
                JSON.stringify(replayed),
            );
        });
    }

    for (const generation of ["v1", "v2"] as const) {
        it(`preserves the entire busy raw tail on healthy ${generation} passes`, async () => {
            const sessionId = `ses-recovery-handoff-${generation}`;
            const session = await sessionWithPersistedDrop(sessionId, generation);
            await session.serve(history(sessionId));
            await new Promise<void>((resolve) => setImmediate(resolve));
            const path = getDatabasePath(session.db);
            if (!path) throw new Error("Expected throwaway database");
            const before = getTagsBySession(session.db, sessionId);
            heldLock = new Database(path);
            heldLock.exec("BEGIN IMMEDIATE");
            const busy = await session.serve(nextTurn(sessionId));
            expect(JSON.stringify(busy.slice(-2))).toBe(
                JSON.stringify(nextTurn(sessionId).slice(-2)),
            );
            expect(getTagsBySession(session.db, sessionId)).toEqual(before);
            releaseLock();
            const raw = [
                ...nextTurn(sessionId),
                {
                    info: { id: "u5", time: { created: 8 }, role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "genuinely new" }],
                },
            ];
            const healthy = await session.serve(structuredClone(raw));
            expect(JSON.stringify(healthy.slice(0, busy.length))).toBe(JSON.stringify(busy));
            expect(JSON.stringify(healthy.at(-1))).toMatch(/§\d+§ genuinely new/);
            expect(
                getTagsBySession(session.db, sessionId).some(
                    (tag) => tag.messageId === "a3:p0" || tag.messageId === "u4:p0",
                ),
            ).toBe(false);
            expect(JSON.stringify(await session.serve(structuredClone(raw)))).toBe(
                JSON.stringify(healthy),
            );
            for (let pass = 0; pass < 3; pass++)
                expect(JSON.stringify(await session.serve(structuredClone(raw)))).toBe(
                    JSON.stringify(healthy),
                );
            updateSessionMeta(session.db, sessionId, { systemPromptHash: "system-after-change" });
            const folded = await session.serve(structuredClone(raw));
            expect(JSON.stringify(folded.find((message) => message.info.id === "a3"))).toMatch(
                /§\d+§ answer/,
            );
            const tag = getTagsBySession(session.db, sessionId).find(
                (tag) => tag.messageId === "a3:p0",
            );
            if (!tag) throw new Error("Expected a normalized text target");
            const normalizedTags = getTagsBySession(session.db, sessionId);
            expect(
                String(folded.find((message) => message.info.id === "a3")?.parts[0].text).match(
                    /§\d+§/g,
                ),
            ).toHaveLength(1);
            expect(decisionLogInternals.getPending(sessionId)?.lkgFrozenReleaseReason).toBe(
                "recovery_tail_normalized",
            );
            expect(JSON.stringify(await session.serve(structuredClone(raw)))).toBe(
                JSON.stringify(folded),
            );
            expect(getTagsBySession(session.db, sessionId)).toEqual(normalizedTags);
            queuePendingOp(session.db, sessionId, tag.tagNumber, "drop", 1);
            updateSessionMeta(session.db, sessionId, { systemPromptHash: "system-third-change" });
            await session.serve(structuredClone(raw));
            expect(
                getTagsBySession(session.db, sessionId).find(
                    (value) => value.tagNumber === tag.tagNumber,
                )?.status,
            ).toBe("dropped");
        }, 30_000);
    }
    for (const generation of ["v1", "v2"] as const) {
        it(`review ${generation}: signed busy tail refuses an unproven bound prefix`, async () => {
            const sessionId = `review-signed-${generation}`;
            const session = await sessionWithPersistedDrop(sessionId, generation);
            session.deps.liveModelBySession = new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-opus-5-5" }],
            ]);
            await session.serve(history(sessionId));
            await new Promise<void>((resolve) => setImmediate(resolve));
            const path = getDatabasePath(session.db);
            if (!path) throw new Error("Expected throwaway database");
            const raw = [
                ...nextTurn(sessionId),
                {
                    info: { id: "a4", role: "assistant", sessionID: sessionId, finish: "stop" },
                    parts: [
                        { type: "thinking", thinking: "bound thought", signature: "signed-proof" },
                        { type: "text", text: "signed answer" },
                    ],
                },
                {
                    info: { id: "u5", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "close the signed turn" }],
                },
            ];
            session.db.exec("PRAGMA busy_timeout=0");
            heldLock = new Database(path);
            heldLock.exec("BEGIN IMMEDIATE");
            await expect(session.serve(structuredClone(raw))).rejects.toThrow(STORAGE_BUSY_MESSAGE);
            releaseLock();
        }, 30_000);
        for (const change of [
            "content mismatch",
            "branch contraction",
            "branch revert",
            "model switch",
            "session clear",
            "other session",
        ] as const) {
            it(`review ${generation}: ${change} refuses busy replay during an obligation`, async () => {
                const sessionId = `review-${generation}-${change}`;
                const session = await sessionWithPersistedDrop(sessionId, generation);
                await session.serve(history(sessionId));
                await new Promise<void>((resolve) => setImmediate(resolve));
                const path = getDatabasePath(session.db);
                if (!path) throw new Error("Expected throwaway database");
                session.db.exec("PRAGMA busy_timeout=0");
                heldLock = new Database(path);
                heldLock.exec("BEGIN IMMEDIATE");
                const busy = await session.serve(nextTurn(sessionId));
                expect(String(busy.at(-1)?.parts[0].text)).toBe("follow-up");
                let next = nextTurn(sessionId);
                if (change === "content mismatch") next.at(-1)!.parts[0].text = "edited raw";
                if (change === "branch contraction") next = next.slice(1);
                if (change === "branch revert")
                    next = [
                        ...history(sessionId),
                        {
                            info: { id: "new-branch", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "different branch" }],
                        },
                    ];
                if (change === "model switch") {
                    next[0].info.model = { providerID: "openai", modelID: "gpt-4.1" };
                    session.deps.liveModelBySession = new Map([
                        [sessionId, { providerID: "openai", modelID: "gpt-4.1" }],
                    ]);
                }
                if (change === "session clear") dropSlot(sessionId);
                if (change === "other session")
                    for (const message of next) message.info.sessionID = "unrelated-session";
                await expect(session.serve(structuredClone(next))).rejects.toThrow();
                releaseLock();
                if (change !== "other session") {
                    const rebuilt = await session.serve(structuredClone(next));
                    if (change === "content mismatch")
                        expect(JSON.stringify(rebuilt)).toContain("edited raw");
                    if (change === "branch revert") {
                        expect(JSON.stringify(rebuilt)).toContain("different branch");
                        expect(JSON.stringify(rebuilt)).not.toContain("follow-up");
                    }
                    if (change === "session clear")
                        expect(JSON.stringify(rebuilt.at(-1))).toMatch(/§\d+§ follow-up/);
                }
            }, 30_000);
        }
    }

    it("keeps seeded ordinary passes byte-identical in pure replay", async () => {
        const sessionId = "ses-pure-replay-degraded-pass";
        const session = await sessionWithPersistedDrop(sessionId);
        session.deps.liveModelBySession = new Map([
            [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4" }],
        ]);
        const source = () => {
            const messages = history(sessionId);
            messages[1].parts.push({
                type: "tool",
                tool: "ctx_reduce",
                callID: "reduce-old",
                state: { status: "completed", input: {}, output: "saved reduction" },
            });
            messages[2].parts.push({
                type: "file",
                mime: "image/png",
                url: `data:image/png;base64,${"c2VlZA".repeat(50)}`,
            });
            messages[3].parts.unshift({
                type: "thinking",
                thinking: "SAVED-REASONING",
                signature: "signature",
            });
            messages[3].parts.push({ type: "text", text: "" });
            return messages;
        };
        expect(addStaleReduceStrippedIds(session.db, sessionId, ["a1"])).toBe(true);
        expect(addProcessedImageStrippedIds(session.db, sessionId, ["u2"])).toBe(true);
        expect(
            addMergedReasoningStrippedIds(session.db, sessionId, [
                thinkingBindingRecoveryFrozenId("a2"),
            ]),
        ).toBe(true);
        expect(addTrailingBlankDecisions(session.db, sessionId, [["a2", "strip"]])).toBe(true);
        const managed = JSON.stringify(await session.serve(source()));
        expect(managed).not.toContain("saved reduction");
        expect(managed).not.toContain("SAVED-REASONING");
        expect(managed).not.toContain("data:image/png");
        const requests = [managed];
        for (let pass = 0; pass < 3; pass++) {
            const served = JSON.stringify(await session.serve(source()));
            expect(served).toBe(managed);
            requests.push(served);
        }
        const withTail = () => [
            ...source(),
            ...nextTurn(sessionId).slice(history(sessionId).length),
        ];
        const firstTail = JSON.stringify(await session.serve(withTail()));
        requests.push(firstTail);
        expect(JSON.stringify(await session.serve(withTail()))).toBe(firstTail);
        const hashes = requests.map((request) =>
            createHash("sha256").update(request).digest("hex"),
        );
        console.info(
            `pure replay: ${requests.length} served requests bytes=${requests.map((request) => Buffer.byteLength(request))} sha256=${hashes}`,
        );
        if (process.env.MC_PURE_REPLAY_CAPTURE)
            writeFileSync(process.env.MC_PURE_REPLAY_CAPTURE, JSON.stringify(requests));
    }, 30_000);
    it("replays the last good request after an ordinary wrapper exception", async () => {
        const sessionId = "ses-ordinary-wrapper-replay";
        const session = await sessionWithPersistedDrop(sessionId);
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, output) => {
                    output.messages[0].parts.length = 0;
                    throw new TypeError("partial replay defect");
                },
            },
        });
        const output = { messages: nextTurn(sessionId) } as unknown as Output;
        await handler({}, output);
        expectReplayOfManaged(output.messages as unknown as Message[], session.managed, sessionId);
    }, 30_000);

    for (const stage of ["rebase", "mode transition", "stale reduce", "image strip"] as const) {
        for (const lkg of [true, false]) {
            it(`${lkg ? "replays" : "refuses"} when ${stage} fails under the limit`, async () => {
                const sessionId = `ses-stage-${stage.replaceAll(" ", "-")}-${lkg}`;
                const session = await sessionWithPersistedDrop(sessionId);
                if (!lkg) dropSlot(sessionId);
                session.deps.storeGeneration = stage === "rebase" ? "v2" : undefined;
                session.deps.liveModelBySession = new Map([
                    [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4" }],
                ]);
                const fail = () => {
                    throw new Error(`injected ${stage}`);
                };
                const spy =
                    stage === "rebase"
                        ? spyOn(
                              coordinateRebase,
                              "rebaseSessionCoordinatesAsync",
                          ).mockImplementation(async () => fail())
                        : stage === "mode transition"
                          ? spyOn(modeTransition, "reconcileCompactionMode").mockImplementation(
                                fail,
                            )
                          : stage === "stale reduce"
                            ? spyOn(staleReduce, "dropStaleReduceCalls").mockImplementation(fail)
                            : spyOn(transformOperations, "stripProcessedImages").mockImplementation(
                                  fail,
                              );
                const site = {
                    rebase: "store-generation-rebase-failure",
                    "mode transition": "compaction-mode-transition-failure",
                    "stale reduce": "stale-reduce-strip-exception",
                    "image strip": "image-strip-exception",
                }[stage];
                try {
                    if (lkg)
                        expectReplayOfManaged(
                            await session.serve(nextTurn(sessionId)),
                            session.managed,
                            sessionId,
                        );
                    else
                        await expect(session.serve(nextTurn(sessionId))).rejects.toMatchObject({
                            name: "DegradedPassRefusalError",
                            site,
                        });
                    expect(spy).toHaveBeenCalledTimes(1);
                } finally {
                    spy.mockRestore();
                }
            }, 30_000);
        }
    }
    it("replays the last good request when the writer lock is held across tagging", async () => {
        const sessionId = "ses-degraded-tagging-busy";
        const session = await sessionWithPersistedDrop(sessionId);

        session.armLockDuringTagging();
        const served = await session.serve(nextTurn(sessionId));

        expect(heldLock).toBeNull();
        expectReplayOfManaged(served, session.managed, sessionId);
    }, 30_000);

    it("refuses with the storage-busy refusal when the lock is held across tagging and no last good request exists", async () => {
        const sessionId = "ses-degraded-tagging-busy-refusal";
        const session = await sessionWithPersistedDrop(sessionId);
        dropSlot(sessionId);

        session.armLockDuringTagging();
        const messages = nextTurn(sessionId);
        await expect(session.serve(messages)).rejects.toThrow(STORAGE_BUSY_MESSAGE);
    }, 30_000);

    it("replays the last good request when the persisted drop replay fails", async () => {
        const sessionId = "ses-degraded-flushed";
        const session = await sessionWithPersistedDrop(sessionId);

        const replay = spyOn(transformOperations, "applyFlushedStatuses").mockImplementationOnce(
            () => {
                throw new Error("flushed status replay failed");
            },
        );
        try {
            const served = await session.serve(nextTurn(sessionId));
            // After the transform fails, recovery reads saved drop decisions and
            // applies them to the last successfully sent request before resending it.
            expect(replay).toHaveBeenCalledTimes(2);
            expect(replay.mock.results[0]?.type).toBe("throw");
            expect(replay.mock.results[1]?.type).toBe("return");
            expectReplayOfManaged(served, session.managed, sessionId);
        } finally {
            replay.mockRestore();
        }
    }, 30_000);

    it("refuses when the persisted drop replay fails and no last good request exists", async () => {
        const sessionId = "ses-degraded-flushed-refusal";
        const session = await sessionWithPersistedDrop(sessionId);
        dropSlot(sessionId);

        const replay = spyOn(transformOperations, "applyFlushedStatuses").mockImplementationOnce(
            () => {
                throw new Error("flushed status replay failed");
            },
        );
        try {
            await expect(session.serve(nextTurn(sessionId))).rejects.toMatchObject({
                name: "DegradedPassRefusalError",
                site: "flushed-status-failure",
            });
        } finally {
            replay.mockRestore();
        }
    }, 30_000);
});

describe("a pass that falls back to the launch directory", () => {
    function directoryClient(resolve: () => string | undefined) {
        return {
            session: {
                get: mock(async () => {
                    const directory = resolve();
                    return { data: directory ? { directory } : {} };
                }),
                create: mock(async () => ({ data: { id: "unused" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
    }

    it("a no-busy directory-fallback managed pass writes no recovery fence", async () => {
        useTempDataHome("mc-directory-no-fence-");
        const db = openDatabase();
        const sessionId = "ses-directory-no-fence";
        const transform = createTransform({
            db,
            directory: process.env.XDG_DATA_HOME,
            client: directoryClient(() => undefined),
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) } as Scheduler,
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() },
                ],
            ]),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
        });
        const operations: string[] = [];
        const restore = fenceInternals.setIoObserver((operation) => operations.push(operation));
        try {
            const output = { messages: history(sessionId) };
            await transform({}, output as never);
            await new Promise((resolve) => setImmediate(resolve));
            expect(JSON.stringify(output.messages)).toContain("§");
            expect(operations.filter((operation) => operation === "write")).toEqual([]);
            expect(existsSync(lkgRecoveryFencePath(sessionId))).toBe(false);
        } finally {
            restore();
        }
    });

    function m0m1(messages: Message[]): string {
        return JSON.stringify(messages.filter((message) => message.info.syntheticHead === true));
    }

    const checkDirectoryReclaim = async (origin: "explicit flush" | "idle expiry") => {
        useTempDataHome("mc-directory-reclaim-");
        const sessionDirectory = createTestTempDir("mc-reclaim-session-dir-").dir;
        const launchDirectory = createTestTempDir("mc-reclaim-launch-dir-").dir;
        tempDirs.push(sessionDirectory, launchDirectory);
        const sessionId = "ses-directory-reclaim";
        const db = openDatabase();
        let hostDirectory: string | undefined = sessionDirectory;
        const usage = new Map([
            [sessionId, { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() }],
        ]);
        const flush = new Set<string>();
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            contextUsageMap: usage,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: flush,
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 50,
            protectedTokens: 4000,
            protectedTools: { read: 0 },
            historianRunnable: false,
            client: directoryClient(() => hostDirectory),
            directory: launchDirectory,
        });
        const pass = async () => {
            const messages = history(sessionId);
            messages.splice(
                messages.length - 1,
                0,
                ...[2, 3, 4].map((n) => ({
                    info: { id: `new-tool-${n}`, role: "assistant", sessionID: sessionId },
                    parts: [
                        {
                            type: "tool",
                            callID: `new-call-${n}`,
                            tool: "read",
                            state: {
                                status: "completed",
                                input: { path: `${n}.ts` },
                                output: `new output ${n}: ${BULKY}`,
                            },
                        },
                    ],
                })),
            );
            messages.at(-1)!.parts = [
                { type: "text", text: "protected working tail ".repeat(6000) },
            ];
            await transform({}, { messages });
            return messages;
        };
        const baseline = await pass();
        const pair = m0m1(baseline);
        const systemHash = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash;
        const tool = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool")!;
        expect(tool.status).toBe("active");
        queuePendingOp(db, sessionId, tool.tagNumber, "drop");
        if (origin === "explicit flush") {
            updateSessionMeta(db, sessionId, {
                systemPromptHash: "directory-lookup-held-hash",
            });
            requestPendingMaterialization(flush, sessionId, "user_flush");
        } else {
            updateSessionMeta(db, sessionId, {
                cacheTtl: "13h",
                lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
            });
        }
        hostDirectory = undefined;
        usage.set(sessionId, {
            usage: { percentage: 66, inputTokens: 132_000 },
            updatedAt: Date.now(),
        });
        const reclaimed = await pass();
        if (origin === "idle expiry") {
            expect(getPendingOps(db, sessionId)).toHaveLength(1);
            expect(
                getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === tool.tagNumber)
                    ?.status,
            ).toBe("active");
            expect(JSON.stringify(reclaimed)).toBe(JSON.stringify(baseline));
            return;
        }
        expect(getPendingOps(db, sessionId)).toHaveLength(0);
        expect(
            getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === tool.tagNumber)?.status,
        ).toBe("dropped");
        expect(JSON.stringify(reclaimed.find((message) => message.info.id === "a1"))).not.toContain(
            "BULKY-TOOL-OUTPUT",
        );
        expect(m0m1(reclaimed)).toBe(pair);
        expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash).toBe(systemHash);
        expect(flush.has(sessionId)).toBe(true);
    };

    it("directory fallback freezes injection but drains an execute-threshold queued drop", async () => {
        await checkDirectoryReclaim("explicit flush");
    }, 30_000);

    it("directory fallback and unheld idle expiry do not authorize a queued drop", async () => {
        await checkDirectoryReclaim("idle expiry");
    }, 30_000);

    it("replays the frozen m[0]/m[1] when it would otherwise rebuild, and a resolved pass rebuilds", async () => {
        useTempDataHome("mc-degraded-directory-");
        const sessionDirectory = createTestTempDir("mc-session-dir-").dir;
        const launchDirectory = createTestTempDir("mc-launch-dir-").dir;
        tempDirs.push(sessionDirectory, launchDirectory);
        const sessionId = "ses-directory-fallback";
        const db = openDatabase();
        let hostDirectory: string | undefined = sessionDirectory;
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            client: directoryClient(() => hostDirectory),
            directory: launchDirectory,
        });
        const pass = async () => {
            const messages = history(sessionId);
            await transform({}, { messages });
            return messages;
        };

        // Resolved first render freezes an m[0]/m[1] pair for the session's
        // own directory.
        const first = await pass();
        const frozen = m0m1(first);
        expect(frozen).not.toBe("[]");
        const frozenSystemHash = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash ?? "";

        // A system prompt change and an explicit flush both ask for a rebuild.
        updateSessionMeta(db, sessionId, { systemPromptHash: "system-after-change" });
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");

        // The host lookup fails: the launch directory is another project.
        hostDirectory = undefined;
        const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        try {
            const fallback = await pass();
            expect(m0m1(fallback)).toBe(frozen);
            expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash ?? "").toBe(
                frozenSystemHash,
            );
            expect(pendingMaterializationSessions.has(sessionId)).toBe(true);
            await pass();
            expect(
                logs.mock.calls
                    .filter((call) => String(call[1]).includes("m[0]/m[1] frozen:"))
                    .map((call) => call[1]),
            ).toEqual([
                "m[0]/m[1] frozen: session directory unresolved; replaying the frozen prefix and deferring any rebuild",
            ]);
        } finally {
            logs.mockRestore();
        }

        // The next resolved pass does the rebuild it was due.
        hostDirectory = sessionDirectory;
        await pass();
        expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash).toBe(
            "system-after-change",
        );
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
    }, 30_000);
});

describe("the served-request size guard", () => {
    // 1,000 input tokens at 50% puts the window at 2,000 tokens; the user
    // message alone is far larger.
    const oversized = (sessionId: string): Message[] => [
        {
            info: { id: "u1", time: { created: 1 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: BULKY }],
        },
    ];

    function smallWindowTransform(
        sessionId: string,
        client?: PluginContext["client"],
        options: {
            tagger?: ReturnType<typeof createTagger>;
            schedulerDecision?: "defer" | "execute";
            directory?: string;
            autoSearch?: boolean;
        } = {},
    ) {
        useTempDataHome("mc-degraded-size-guard-");
        const decision = options.schedulerDecision ?? "defer";
        return createTransform({
            tagger: options.tagger ?? createTagger(),
            scheduler: { shouldExecute: mock(() => decision) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 50, inputTokens: 1_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            ...(client ? { client } : {}),
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.autoSearch
                ? { autoSearch: { enabled: true, scoreThreshold: 0, minPromptChars: 1 } }
                : {}),
        });
    }

    /** A host that resolves the session to `directory`, so the pass has a project. */
    function resolvedProject(): { client: PluginContext["client"]; directory: string } {
        const directory = createTestTempDir("mc-size-guard-project-").dir;
        tempDirs.push(directory);
        const client = {
            session: { get: mock(async () => ({ data: { directory } })) },
        } as unknown as PluginContext["client"];
        return { client, directory };
    }

    it("refuses a failed m[0]/m[1] stage before the context-limit backstop", async () => {
        const sessionId = "ses-size-guard-degraded";
        const { client, directory } = resolvedProject();
        const transform = smallWindowTransform(sessionId, client, { directory });
        // The session-history head messages (m[0]/m[1]) fail to render, so the
        // pass refuses rather than serving a fallback history block, regardless
        // of whether its estimate would fit.
        const inject = spyOn(injectCompartments, "injectM0M1").mockImplementation(() => {
            throw new Error("m[0]/m[1] render failed");
        });
        try {
            await expect(transform({}, { messages: oversized(sessionId) })).rejects.toMatchObject({
                name: "DegradedPassRefusalError",
                site: "m0-m1-fold-preexecution-degradation",
            });
            expect(inject).toHaveBeenCalled();
        } finally {
            inject.mockRestore();
        }
    }, 30_000);

    it("refuses a pass whose tagging failed, over the context limit", async () => {
        const sessionId = "ses-size-guard-tagging";
        const baseTagger = createTagger();
        const tagger = {
            ...baseTagger,
            initFromDb: () => {
                throw new Error("UNIQUE constraint failed: tags.session_id, tags.tag_number");
            },
        };
        const transform = smallWindowTransform(sessionId, undefined, { tagger });
        await expect(transform({}, { messages: oversized(sessionId) })).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "tagging-persistence-failure",
        });
    }, 30_000);

    it("serves a session's first pass over the context limit while the system prompt is still unmeasured", async () => {
        const sessionId = "ses-size-guard-first-pass";
        const { client, directory } = resolvedProject();
        const transform = smallWindowTransform(sessionId, client, { directory });
        // Nothing has measured the system prompt yet, so this first render's
        // own estimate is incomplete (untrusted). That is not a degradation.
        expect(getOrCreateSessionMeta(openDatabase(), sessionId).systemPromptTokens).toBe(0);
        const messages = oversized(sessionId);
        await transform({}, { messages });
        expect(JSON.stringify(messages)).toContain("BULKY-TOOL-OUTPUT");
        expect(messages.some((message) => message.info.syntheticHead === true)).toBe(true);
    }, 30_000);

    it("serves a pass over the context limit whose only degradation is an auto-search timeout", async () => {
        const sessionId = "ses-size-guard-auto-search";
        const { client, directory } = resolvedProject();
        const transform = smallWindowTransform(sessionId, client, { directory, autoSearch: true });
        const search = spyOn(autoSearchRunner, "runAutoSearchHint").mockResolvedValue({
            ok: false,
            kind: "timeout",
        });
        try {
            // A short first turn, then a pass (the scheduler defers, so nothing
            // is reduced) whose new user turn alone is over the window and whose
            // auto-search for a memory hint times out.
            await transform({}, { messages: history(sessionId).slice(0, 1) });
            const messages: Message[] = [
                ...history(sessionId).slice(0, 1),
                {
                    info: {
                        id: "a-short",
                        time: { created: 2 },
                        role: "assistant",
                        sessionID: sessionId,
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: "ok" }],
                },
                {
                    info: {
                        id: "u-bulky",
                        time: { created: 3 },
                        role: "user",
                        sessionID: sessionId,
                    },
                    parts: [{ type: "text", text: BULKY }],
                },
            ];
            await transform({}, { messages });
            expect(search).toHaveBeenCalled();
            expect(JSON.stringify(messages)).toContain("BULKY-TOOL-OUTPUT");
        } finally {
            search.mockRestore();
        }
    }, 30_000);

    for (const site of ["auto-search-internal-failure", "note-nudge-cas-failure"] as const) {
        it(`does not size-guard an optional fresh-tail ${site}`, async () => {
            const sessionId = `ses-size-guard-optional-${site}`;
            const { client, directory } = resolvedProject();
            const transform = smallWindowTransform(sessionId, client, {
                directory,
                autoSearch: site === "auto-search-internal-failure",
            });
            // Establish the managed prefix before the oversized new turn so the
            // second pass is an ordinary replay, not the first-render path.
            await transform({}, { messages: history(sessionId).slice(0, 1) });
            const peek =
                site === "note-nudge-cas-failure"
                    ? spyOn(noteNudger, "peekNoteNudgeText").mockReturnValue("optional reminder")
                    : null;
            const failure =
                site === "note-nudge-cas-failure"
                    ? spyOn(noteNudger, "markNoteNudgeDelivered").mockReturnValue({
                          ok: false,
                          kind: "cas-exhausted",
                      })
                    : spyOn(autoSearchRunner, "runAutoSearchHint").mockRejectedValue(
                          new Error("optional fresh-tail search failed"),
                      );
            try {
                const messages: Message[] = [
                    ...history(sessionId).slice(0, 1),
                    {
                        info: {
                            id: "a-short",
                            time: { created: 2 },
                            role: "assistant",
                            sessionID: sessionId,
                            finish: "stop",
                        },
                        parts: [{ type: "text", text: "ok" }],
                    },
                    {
                        info: {
                            id: "u-bulky",
                            time: { created: 3 },
                            role: "user",
                            sessionID: sessionId,
                        },
                        parts: [{ type: "text", text: BULKY }],
                    },
                ];
                await transform({}, { messages });
                expect(failure).toHaveBeenCalledTimes(1);
                expect(JSON.stringify(messages)).toContain("BULKY-TOOL-OUTPUT");
                expect(JSON.stringify(messages)).not.toContain("optional reminder");
            } finally {
                failure.mockRestore();
                peek?.mockRestore();
            }
        }, 30_000);
    }

    it("leaves a healthy pass of the same size to the existing emergency machinery", async () => {
        const sessionId = "ses-size-guard-healthy";
        const transform = smallWindowTransform(sessionId);
        const messages = oversized(sessionId);
        await transform({}, { messages });
        expect(JSON.stringify(messages)).toContain("BULKY-TOOL-OUTPUT");
    }, 30_000);
});

describe("DegradedPassRefusalError", () => {
    it("names its site and keeps the user-facing code", () => {
        const error = new DegradedPassRefusalError("tagging-persistence-failure");
        expect(error.site).toBe("tagging-persistence-failure");
        expect(error.message).toContain("MC-S06");
    });
});
