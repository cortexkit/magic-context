/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    getOverflowState,
    getPendingCompactionMarkerState,
    type PendingCompactionMarker,
    recordDetectedContextLimit,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import * as logger from "../../shared/logger";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type SqliteWriteLocker,
    startSqliteWriteLocker,
} from "../../shared/sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createDbLkgPersistence } from "./lkg-persist";
import { checkLkgDurability, readServedMarker, ServedMarkerWriteError } from "./lkg-served-marker";
import { getSlot, registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";
import {
    applyRustModeDeferredCompactionMarker,
    RUST_MARKER_LOCK_SKIP_LOG,
} from "./transform-postprocess-phase";

const MODULE_TEXT = "module-rendered tail";

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    __resetToolDefinitionMeasurements();
    closeReadOnlySessionDb();
    resetLkgSlotsForTest();
});

function openFileDb(): { db: ContextDatabase; dbPath: string } {
    const directory = createTestTempDirFromPath(join(tmpdir(), "rust-marker-lock-contention-"));
    const dbPath = join(directory, "context.db");
    const db = openDatabase(dbPath) as ContextDatabase | null;
    if (!db) throw new Error("file-backed test database did not open");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanups.push(() => closeQuietly(db));
    registerLkgPersistence(createDbLkgPersistence(db));
    return { db, dbPath };
}

function busyTimeoutMs(db: ContextDatabase): number {
    const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
    return Number(Object.values(row)[0]);
}

function installRawProvider(sessionId: string): void {
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    cleanups.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) => (after ? [] : [row].slice(0, limit)),
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "hello" }],
                createdAt: 1,
            }),
        }),
    );
}

function inputMessages(sessionId: string): MessageLike[] {
    return [
        {
            info: {
                id: "m1",
                role: "user",
                sessionID: sessionId,
                model: { providerID: "test-provider", modelID: "test-model" },
            },
            parts: [{ type: "text", text: "hello" }],
        },
    ];
}

/**
 * Drive one real Rust-mode pass whose fake module takes the cross-process write
 * lock from inside its `transform` call, so the lock is held when the apply stage
 * records the compaction target the response materialized.
 */
async function runPassUnderLock(args: {
    db: ContextDatabase;
    dbPath: string;
    sessionId: string;
    lockHoldMs: number | null;
    /** Module decision; defaults to the priced HARD re-render. */
    decision?: string;
    moduleUnavailable?: boolean;
}): Promise<{
    served: MessageLike[];
    moduleCalls: number;
    drained: Array<PendingCompactionMarker | null>;
    elapsedSinceLockMs: number;
}> {
    const { db, dbPath, sessionId } = args;
    installRawProvider(sessionId);
    let moduleCalls = 0;
    let locker: SqliteWriteLocker | null = null;
    let lockedAt = 0;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            moduleCalls += 1;
            if (args.lockHoldMs !== null) {
                locker = await startSqliteWriteLocker(dbPath, args.lockHoldMs);
            }
            lockedAt = performance.now();
            if (args.moduleUnavailable) throw new Error("module unavailable; replay latest LKG");
            return {
                decision: args.decision ?? "HARD",
                prefix_bust_permitted: args.decision !== "SOFT+",
                scheduler_decision: "execute",
                committed: true,
                row_version: 4,
                coverage_ordinal: 7,
                boundary_id: "m1#0",
                native_messages: [
                    // A boundary response starts with the synthetic m0 history message.
                    {
                        info: { role: "user", sessionID: sessionId },
                        parts: [
                            {
                                type: "text",
                                text: "<project-docs>m0</project-docs>",
                                synthetic: true,
                            },
                        ],
                    },
                    {
                        info: { id: "m1", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: MODULE_TEXT }],
                    },
                ],
            };
        },
    };
    // The drain records what the apply stage left in the pending slot, without
    // writing OpenCode's own store.
    const drained: Array<PendingCompactionMarker | null> = [];
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([
            [sessionId, { providerID: "test-provider", modelID: "test-model" }],
        ]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        compactionMarkerStrategy: {
            applyDeferred: (markerDb, markerSessionId) => {
                drained.push(getPendingCompactionMarkerState(markerDb, markerSessionId));
                return { kind: "already-current" };
            },
            reconcile: () => false,
        },
    };
    const meta = getOrCreateSessionMeta(db, sessionId);
    const overflow = getOverflowState(db, sessionId);
    if (overflow.detectedContextLimit <= 0) {
        recordDetectedContextLimit(db, sessionId, 200_000, "test-provider/test-model");
    }
    recordToolDefinition("test-provider", "test-model", undefined, "read", "read fixture", {
        type: "object",
    });
    updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
    meta.systemPromptTokens = 100;

    const transform = createRustModeTransform(deps, {
        moduleClient,
        scheduleLkgCapture: (capture) => capture(),
    });
    const input = inputMessages(sessionId);
    const output = { messages: [...input] };
    let passEndedAt = 0;
    try {
        await transform.run(sessionId, input, output, meta);
        passEndedAt = performance.now();
    } finally {
        // Never leave a locker holding the file past the test.
        const running = locker as SqliteWriteLocker | null;
        if (running) await running.exited;
        transform.dispose();
    }
    return {
        served: output.messages,
        moduleCalls,
        drained,
        elapsedSinceLockMs: passEndedAt - lockedAt,
    };
}

function servedText(messages: MessageLike[]): string[] {
    return messages.flatMap((message) =>
        (message.parts as Array<{ type?: string; text?: string }>)
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? ""),
    );
}

describe("Rust-mode compaction target recording under cross-process write contention", () => {
    it("yields for a lock released within the foreground budget, serves the module output and records the target once", async () => {
        const { db, dbPath } = openFileDb();
        expect(busyTimeoutMs(db)).toBe(5000);
        const sessionId = "ses_lock_released";

        const result = await runPassUnderLock({ db, dbPath, sessionId, lockHoldMs: 1000 });

        expect(result.elapsedSinceLockMs).toBeGreaterThanOrEqual(950);
        expect(servedText(result.served)).toContain(MODULE_TEXT);
        expect(result.moduleCalls).toBe(1);
        expect(result.drained).toHaveLength(1);
        expect(result.drained[0]).toMatchObject({ ordinal: 7, endMessageId: "m1" });
    }, 20_000);

    it("records the target without contention", async () => {
        const { db, dbPath } = openFileDb();
        const sessionId = "ses_no_lock";

        const result = await runPassUnderLock({ db, dbPath, sessionId, lockHoldMs: null });

        expect(servedText(result.served)).toContain(MODULE_TEXT);
        expect(result.moduleCalls).toBe(1);
        expect(result.drained).toHaveLength(1);
        expect(result.drained[0]).toMatchObject({ ordinal: 7, endMessageId: "m1" });
    }, 20_000);

    it("SOFT+ capture refuses a blocked served marker, retries durably, and permits unchanged replay under lock", async () => {
        const { db, dbPath } = openFileDb();
        // The foreground admission has its own budget; this connection's normal
        // timeout must be restored even when the separate locker outlasts it.
        db.exec("PRAGMA busy_timeout = 300");
        const sessionId = "ses_lock_held";
        const sessionLog = spyOn(logger, "sessionLog");
        try {
            // There is no prior served capture in this fixture. Installing the
            // module's SOFT+ bytes is a capture, not an unchanged LKG replay, so
            // it must certify its served identity before any request is emitted.
            await expect(
                runPassUnderLock({
                    db,
                    dbPath,
                    sessionId,
                    lockHoldMs: 1000,
                    decision: "SOFT+",
                }),
            ).rejects.toBeInstanceOf(ServedMarkerWriteError);
            expect(readServedMarker(db, sessionId)).toBeUndefined();
            expect(getSlot(sessionId)).toBeUndefined();
            const skipCall = sessionLog.mock.calls.find(
                ([loggedSession, message]) =>
                    loggedSession === sessionId &&
                    typeof message === "string" &&
                    message.startsWith(RUST_MARKER_LOCK_SKIP_LOG),
            );
            expect(skipCall).toBeUndefined();
            // Once the lock is available the same turn is servable, and its
            // exact bytes reach the slot whose id equals the durable marker.
            const result = await runPassUnderLock({
                db,
                dbPath,
                sessionId,
                lockHoldMs: null,
                decision: "SOFT+",
            });
            expect(servedText(result.served)).toContain(MODULE_TEXT);
            expect(result.moduleCalls).toBe(1);
            expect(result.drained).toHaveLength(0);
            expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
            expect(checkLkgDurability(db, sessionId).durable).toBe(true);
            const marker = readServedMarker(db, sessionId);
            expect(getSlot(sessionId)?.jsonPrefix).toBe(JSON.stringify(result.served));
            // A genuine unchanged replay requires no new marker. The live turn
            // still serves under the lock, and cannot resurrect an older slot.
            const replay = await runPassUnderLock({
                db,
                dbPath,
                sessionId,
                lockHoldMs: 1000,
                moduleUnavailable: true,
            });
            expect(JSON.stringify(replay.served)).toBe(JSON.stringify(result.served));
            expect(readServedMarker(db, sessionId)).toEqual(marker);
        } finally {
            sessionLog.mockRestore();
        }
    }, 30_000);

    it("a cache-busting marker target write held past busy_timeout logs a cache-busting retry and leaves state untouched", async () => {
        const { db, dbPath } = openFileDb();
        const sessionId = "ses_priced_target_lock";
        getOrCreateSessionMeta(db, sessionId);
        db.exec("PRAGMA busy_timeout=300");
        const sessionLog = spyOn(logger, "sessionLog");
        const locker = await startSqliteWriteLocker(dbPath, 2000);
        let writes = 0;
        try {
            applyRustModeDeferredCompactionMarker({
                db,
                sessionId,
                cacheBustingPass: true,
                boundary: { rowVersion: 4, ordinal: 7, endMessageId: "m1" },
                applyDeferred: () => {
                    writes++;
                    return { kind: "already-current" };
                },
            });
            expect(writes).toBe(0);
            expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
            expect(
                sessionLog.mock.calls.some(
                    ([id, text]) =>
                        id === sessionId &&
                        typeof text === "string" &&
                        text.startsWith(RUST_MARKER_LOCK_SKIP_LOG),
                ),
            ).toBe(true);
            expect(RUST_MARKER_LOCK_SKIP_LOG).toContain("next cache-busting pass retries");
        } finally {
            await locker.exited;
            sessionLog.mockRestore();
        }
    }, 10_000);

    it("leaves a newer pending target unchanged", async () => {
        const { db, dbPath } = openFileDb();
        const sessionId = "ses_newer_pending";
        const newer: PendingCompactionMarker = {
            ordinal: 50,
            endMessageId: "m-newer",
            publishedAt: 123,
        };
        setPendingCompactionMarkerState(db, sessionId, newer);

        const result = await runPassUnderLock({ db, dbPath, sessionId, lockHoldMs: 300 });

        expect(servedText(result.served)).toContain(MODULE_TEXT);
        // The response consumed ordinal 7, so pending 50 must not even be attempted.
        expect(result.drained).toEqual([]);
    }, 20_000);
});
