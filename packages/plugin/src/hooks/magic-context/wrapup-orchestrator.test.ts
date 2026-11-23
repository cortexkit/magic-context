/// <reference types="bun-types" />

import { describe, expect, it, mock, spyOn } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
    getLastCompartmentEndMessage,
} from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { promoteSessionFactsDurable } from "../../features/magic-context/memory/promotion";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import {
    acquireWrapupInProgress,
    getWrapupInProgressState,
    incrementHistorianFailure,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { executeContextRecompWithResult, registerActiveCompartmentRun } from "./compartment-runner";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";
import { createLiveSessionState, type LiveSessionState } from "./live-session-state";
import { pendingMaterializationOrigin } from "./pending-materialization";
import { setRawMessageProvider } from "./read-session-chunk";
import { type ManagedWrapupContext, runManagedWrapup } from "./wrapup-orchestrator";

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

function liveState(): LiveSessionState {
    return createLiveSessionState();
}

function messages(count: number, words = "alpha beta gamma delta epsilon zeta") {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} ${words}` }],
    }));
}

async function withProvider<T>(sessionId: string, count: number, fn: () => Promise<T>): Promise<T> {
    const raw = messages(count);
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => raw,
        getMessageCount: () => raw.length,
    });
    try {
        return await fn();
    } finally {
        unregister();
    }
}

function stealWrapupMarker(db: Database, sessionId: string): void {
    const state = getWrapupInProgressState(db, sessionId);
    expect(state).not.toBeNull();
    db.prepare("UPDATE session_meta SET wrapup_in_progress_state = ? WHERE session_id = ?").run(
        JSON.stringify({
            ...state,
            holderId: "foreign-holder",
            updatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
        }),
        sessionId,
    );
}

function appendRange(db: Database, sessionId: string, start: number, end: number): void {
    if (end < start) return;
    appendCompartments(db, sessionId, [
        {
            sequence: getCompartments(db, sessionId).length,
            startMessage: start,
            endMessage: end,
            startMessageId: `m-${start}`,
            endMessageId: `m-${end}`,
            title: `Wrapped ${start}-${end}`,
            content: `Wrapped ${start}-${end}`,
        },
    ]);
}

function baseCtx(db: Database, state = liveState()): ManagedWrapupContext {
    return {
        client: {} as never,
        db,
        liveSessionState: state,
        directory: "/tmp/project",
        historianChunkTokens: 10,
        historianTimeoutMs: 1_000,
        memoryEnabled: false,
        autoPromote: false,
        fallbackModels: [],
        runMigration: false,
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
        contextLimit: 100,
        executeThresholdPercentage: 50,
        hasPendingNaturalBust: () => false,
    };
}

describe("runManagedWrapup", () => {
    it("runs v2 wrapup historian chunks through the supplied executor without a v1 client", async () => {
        const db = createDb();
        const sessionId = "ses-wrapup-v2-executor";
        const opens: string[] = [];
        const executor: HiddenCompletionExecutor = {
            capabilities: { tools: false, harness: "opencode" },
            open: async (run) => {
                opens.push(run.kind);
                return { id: `child-${opens.length}`, childSessionId: `child-${opens.length}` };
            },
            attempt: async () => {},
            collect: async () => ({
                text: `<output><compartment start="${1 + (opens.length - 1) * 3}" end="${1 + (opens.length - 1) * 3}" title="History"><p1>Preserved.</p1></compartment></output>`,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }),
            close: async () => {},
        };
        try {
            const ctx = baseCtx(db);
            ctx.client = undefined as never;
            ctx.hiddenCompletionExecutor = executor;
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                const start = Math.max(1, getLastCompartmentEndMessage(db, sessionId) + 1);
                const pass = await runValidatedHistorianPass({
                    client: deps.client,
                    hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                    db,
                    parentSessionId: sessionId,
                    sessionDirectory: deps.directory,
                    prompt: `Messages ${start}-${start}:\n${start}: U: preserve this`,
                    chunk: {
                        startIndex: start,
                        endIndex: start,
                        lines: [{ ordinal: start, messageId: `m-${start}` }],
                    },
                    priorCompartments: [],
                    sequenceOffset: 0,
                    dumpLabelBase: "wrapup-v2",
                });
                expect(pass.ok, pass.error).toBe(true);
                appendRange(
                    db,
                    sessionId,
                    start,
                    Math.min(start + 2, deps.boundarySnapshot.eligibleEndOrdinal - 1),
                );
                deps.onCompartmentStatePublished?.(sessionId);
            });
            const result = await withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );
            expect(result).toContain("Wrapped up 6 messages into 2 compartments");
            expect(opens).toHaveLength(2);
        } finally {
            closeQuietly(db);
        }
    });
    it.each([
        { label: "configured", cap: 65_536, expected: 65_536 },
        { label: "unset", cap: undefined, expected: undefined },
    ])("passes the $label historian output cap to wrapup runs", async ({ cap, expected }) => {
        const db = createDb();
        const sessionId = `ses-wrapup-output-cap-${String(expected ?? "unset")}`;
        try {
            const ctx = baseCtx(db);
            ctx.historianMaxOutputTokens = cap;
            const seenCaps: Array<number | undefined> = [];
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                seenCaps.push(deps.historianMaxOutputTokens);
                const start = getLastCompartmentEndMessage(db, sessionId) + 1;
                appendRange(db, sessionId, start, deps.boundarySnapshot.eligibleEndOrdinal - 1);
                deps.onCompartmentStatePublished?.(sessionId);
            });

            const result = await withProvider(sessionId, 6, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("Wrapped up 4 messages into 1 compartment");
            expect(seenCaps).toEqual([expected]);
        } finally {
            closeQuietly(db);
        }
    });

    it("promotes facts from every non-final wrapup window and skips only the final window", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-multi";
            const project = resolveProjectIdentity("/tmp/project");
            const forceKeepFlags: boolean[] = [];
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                const finalWindow = deps.forceKeepLastCompartment === true;
                forceKeepFlags.push(finalWindow);
                const chunkNumber = forceKeepFlags.length;
                if (!finalWindow) {
                    promoteSessionFactsDurable(db, sessionId, project, [
                        {
                            category: "PROJECT_RULES",
                            content: `Durable wrapup fact from chunk ${chunkNumber}.`,
                        },
                    ]);
                }
                const before = Math.max(1, getLastCompartmentEndMessage(db, sessionId) + 1);
                const end = Math.min(deps.boundarySnapshot.eligibleEndOrdinal - 1, before + 2);
                appendRange(db, sessionId, before, end);
                deps.onCompartmentStatePublished?.(sessionId);
            });

            const result = await withProvider(sessionId, 12, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 3 }),
            );

            expect(result).toContain("Wrapped up 9 messages into 3 compartments");
            expect(result).toContain(
                "The compacted history applies on your next message, or on the next rebuild if the host restarts first.",
            );
            expect(
                pendingMaterializationOrigin(
                    ctx.liveSessionState.pendingMaterializationSessions,
                    sessionId,
                ),
            ).toBe("user_wrapup");
            expect(forceKeepFlags).toEqual([false, false, true]);
            const promoted = getMemoriesByProject(db, project).map((memory) => memory.content);
            expect(promoted).toHaveLength(2);
            expect(promoted).toEqual(
                expect.arrayContaining([
                    "Durable wrapup fact from chunk 1.",
                    "Durable wrapup fact from chunk 2.",
                ]),
            );
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(9);
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
            expect(ctx.liveSessionState.deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
            expect(ctx.liveSessionState.deferredMaterializationSessions.has(sessionId)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    it("no-ops within keep-N without acquiring the marker or running the historian", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-noop";
            const runner = mock(async () => {});
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = runner;

            const result = await withProvider(sessionId, 3, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 3 }),
            );

            expect(result).toBe("Nothing to wrap up — only 3 messages above the last compartment.");
            expect(runner).not.toHaveBeenCalled();
            expect(ctx.liveSessionState.pendingMaterializationSessions.has(sessionId)).toBe(false);
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("aborts when wrapup marker ownership is lost and leaves the foreign marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-ownership-lost";
            let calls = 0;
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                calls += 1;
                appendRange(db, sessionId, 1, 3);
                deps.onCompartmentStatePublished?.(sessionId);
                stealWrapupMarker(db, sessionId);
            });

            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("another process took over this session's wrapup");
            expect(calls).toBe(1);
            expect(getWrapupInProgressState(db, sessionId)?.holderId).toBe("foreign-holder");
        } finally {
            closeQuietly(db);
        }
    });

    it("stops on no progress and releases the marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-no-progress";
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async () => {});

            const result = await withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("made no forward progress");
            expect(result).toContain("Run /ctx-wrapup again to continue");
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("bounds waiting for a foreign compartment lease and releases the wrapup marker", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-lease-timeout";
            const foreignHolder = "foreign-lease-holder";
            expect(acquireCompartmentLease(db, sessionId, foreignHolder)).not.toBeNull();
            const ctx = baseCtx(db);
            ctx.wrapupLeaseWaitTimeoutMs = 0;
            ctx.runCompartmentAgentForWrapup = mock(async () => {});

            const result = await withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("Timed out waiting");
            expect(ctx.runCompartmentAgentForWrapup).not.toHaveBeenCalled();
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
            releaseCompartmentLease(db, sessionId, foreignHolder);
        } finally {
            closeQuietly(db);
        }
    });

    it("marks progress failed and releases the marker when a wrapup iteration throws", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-throw";
            const state = liveState();
            const ctx = baseCtx(db, state);
            ctx.runCompartmentAgentForWrapup = mock(async () => {
                throw new Error("database is locked");
            });

            await expect(
                withProvider(sessionId, 10, () =>
                    runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
                ),
            ).rejects.toThrow("database is locked");

            expect(state.recompProgressBySession.get(sessionId)).toMatchObject({
                kind: "wrapup",
                phase: "failed",
                message: "Wrapup stopped: database is locked. Run /ctx-wrapup again to continue.",
            });
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("clears its wait timer once the active historian run it waited for settles", async () => {
        const db = createDb();
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
        try {
            const sessionId = "ses-wrapup-wait-timer";
            let settleActive!: () => void;
            registerActiveCompartmentRun(
                sessionId,
                new Promise<void>((resolve) => {
                    settleActive = resolve;
                }),
                "other",
            );
            const ctx = baseCtx(db);
            ctx.wrapupLeaseWaitTimeoutMs = 600_000;
            ctx.runCompartmentAgentForWrapup = mock(async () => {});

            const run = withProvider(sessionId, 8, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );
            settleActive();
            await run;

            // The wait races the active run against a timer as long as the configured
            // lease wait. Once the run wins, that timer must not stay armed for minutes.
            const waitTimers = setTimeoutSpy.mock.calls.flatMap((call, index) =>
                typeof call[1] === "number" && call[1] > 500_000
                    ? [setTimeoutSpy.mock.results[index]?.value]
                    : [],
            );
            expect(waitTimers.length).toBeGreaterThan(0);
            const cleared = new Set(clearTimeoutSpy.mock.calls.map((call) => call[0]));
            for (const timer of waitTimers) expect(cleared.has(timer)).toBe(true);
        } finally {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("succeeds with zero new compartments when an already-running historian covers the target", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-finished-by-active-historian";
            const active = Promise.withResolvers<void>();
            registerActiveCompartmentRun(sessionId, active.promise, "other");
            const ctx = baseCtx(db);
            const runner = mock(async () => {});
            ctx.runCompartmentAgentForWrapup = runner;
            const result = await withProvider(sessionId, 8, async () => {
                const run = runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 });
                try {
                    await Bun.sleep(0);
                    expect(getWrapupInProgressState(db, sessionId)).not.toBeNull();
                    appendRange(db, sessionId, 1, 6);
                } finally {
                    active.resolve();
                }
                return run;
            });
            expect(runner).not.toHaveBeenCalled();
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(6);
            expect(result).toBe("Wrapped up 0 messages into 0 compartments.");
            expect(ctx.liveSessionState.pendingMaterializationSessions.has(sessionId)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    it("reports a mid-loop historian failure while preserving published chunks", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-failure";
            let call = 0;
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                call += 1;
                if (call === 1) {
                    appendRange(db, sessionId, 1, 3);
                    deps.onCompartmentStatePublished?.(sessionId);
                    return;
                }
                incrementHistorianFailure(db, sessionId, "scripted failure");
            });

            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("## Magic Wrapup — Partial");
            expect(result).toContain("historian failed");
            expect(result).toContain("Run /ctx-wrapup again to continue");
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(3);
            expect(getWrapupInProgressState(db, sessionId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    it("rejects concurrent wrapups and recomp-kind active runs", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-concurrent";
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async () => {});
            acquireWrapupInProgress(db, sessionId, {
                holderId: "other-holder",
                messagesToKeep: 2,
                anchorRawMessageCount: 10,
                targetEligibleEndOrdinal: 8,
                lastCompartmentEnd: 0,
                chunkIndex: 1,
                expectedChunks: 3,
            });
            const busy = await withProvider(sessionId, 10, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );
            expect(busy).toContain("already running");

            const recompSkip = await executeContextRecompWithResult({
                ...ctx,
                sessionId,
            } as never);
            expect(recompSkip.published).toBe(false);
            expect(recompSkip.message).toContain("/ctx-wrapup is already compacting");
        } finally {
            closeQuietly(db);
        }

        const db2 = createDb();
        let releaseActive!: () => void;
        const active = new Promise<void>((resolve) => {
            releaseActive = resolve;
        });
        try {
            const sessionId = "ses-wrapup-recomp-active";
            registerActiveCompartmentRun(sessionId, active, "recomp");
            const result = await withProvider(sessionId, 10, () =>
                runManagedWrapup(baseCtx(db2), sessionId, { messagesToKeep: 2 }),
            );
            expect(result).toContain("Another Magic Context rebuild is already running");
            expect(getWrapupInProgressState(db2, sessionId)).toBeNull();
        } finally {
            releaseActive();
            await active;
            closeQuietly(db2);
        }
    });

    it("keeps published chunks deferred when a later chunk fails", async () => {
        const db = createDb();
        try {
            const sessionId = "ses-wrapup-partial-no-rebuild";
            const ctx = baseCtx(db);
            ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                if (getLastCompartmentEndMessage(db, sessionId) > 0) return;
                appendRange(db, sessionId, 1, 1);
                deps.onCompartmentStatePublished?.(sessionId);
            });

            const result = await withProvider(sessionId, 6, () =>
                runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
            );

            expect(result).toContain("Magic Wrapup — Partial");
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(1);
            expect(ctx.liveSessionState.pendingMaterializationSessions.has(sessionId)).toBe(false);
            expect(ctx.liveSessionState.deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    it("forwards the user-memory collection gate to every wrapup chunk", async () => {
        for (const userMemoriesEnabled of [true, false]) {
            const db = createDb();
            try {
                const sessionId = `ses-wrapup-user-memories-${userMemoriesEnabled}`;
                const seen: Array<boolean | undefined> = [];
                const ctx = baseCtx(db);
                ctx.userMemoriesEnabled = userMemoriesEnabled;
                ctx.runCompartmentAgentForWrapup = mock(async (deps) => {
                    seen.push(deps.experimentalUserMemories);
                    const before = Math.max(1, getLastCompartmentEndMessage(db, sessionId) + 1);
                    const end = Math.min(deps.boundarySnapshot.eligibleEndOrdinal - 1, before + 2);
                    appendRange(db, sessionId, before, end);
                    deps.onCompartmentStatePublished?.(sessionId);
                });

                await withProvider(sessionId, 10, () =>
                    runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 }),
                );

                expect(seen.length).toBeGreaterThan(0);
                for (const flag of seen) {
                    expect(flag).toBe(userMemoriesEnabled);
                }
            } finally {
                closeQuietly(db);
            }
        }
    });
});
