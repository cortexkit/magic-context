import { drainNotifications } from "../../shared/rpc-notifications";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    insertTag,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { DRAIN_WINDOW_MS } from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import * as runner from "./compartment-runner";
import { getActiveCompartmentRun, registerActiveCompartmentRun } from "./compartment-runner";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import * as rawHistory from "./read-session-chunk";
import { __ignoredNotificationTest } from "./send-session-notification";
import {
    HISTORIAN_INLINE_JOIN_BUDGET_MS,
    historianJoinFailClosedMessage,
    resolveHistorianInlineJoinBudget,
    runCompartmentPhase,
} from "./transform-compartment-phase";

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        messages.forEach((m, idx) => {
            const ts = idx + 1;
            insertMessage.run(
                m.id,
                sessionId,
                ts,
                ts,
                JSON.stringify({ id: m.id, role: m.role, sessionID: sessionId }),
            );
            insertPart.run(m.id, sessionId, ts, ts, JSON.stringify({ type: "text", text: m.text }));
        });
    } finally {
        closeQuietly(db);
    }
}

let tempDir: string | undefined;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-compartment-phase-"));
    process.env.XDG_DATA_HOME = tempDir;
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir)
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
});

describe("runCompartmentPhase boundary handoff", () => {
    it("spent drain budget suppresses a firing trigger and all compartment startup work until reset", async () => {
        const sessionId = "ses-spent-drain-hot-path";
        const raw = [
            { id: "m1", role: "user", text: "a ".repeat(3500) },
            { id: "m2", role: "assistant", text: "done" },
            { id: "m3", role: "user", text: "b ".repeat(3500) },
            { id: "m4", role: "assistant", text: "done" },
            { id: "m5", role: "user", text: "c ".repeat(3500) },
            { id: "m6", role: "assistant", text: "done" },
            ...Array.from({ length: 5 }, (_, i) => ({
                id: `m${i + 7}`,
                role: "user",
                text: "protected",
            })),
        ];
        createOpenCodeDb(sessionId, raw);
        const db = openDatabase();
        for (const [i, id] of ["m1", "m3", "m5"].entries())
            insertTag(db, sessionId, id, "message", 3500, i + 1);
        const usage = { percentage: 25, inputTokens: 50_000 };
        const trigger = () =>
            checkCompartmentTrigger(
                db,
                sessionId,
                getOrCreateSessionMeta(db, sessionId),
                usage,
                25,
                65,
                1000,
                undefined,
                undefined,
                undefined,
                200_000,
            );
        expect(trigger().shouldFire).toBe(true);
        const startedAt = Date.now();
        db.prepare(
            "UPDATE session_meta SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 500000 WHERE session_id = ?",
        ).run(startedAt, sessionId);
        const start = spyOn(runner, "startCompartmentAgent").mockImplementation(() => {});
        const prime = spyOn(rawHistory, "primeTailRawMessageCache");
        const log = spyOn(logger, "sessionLog");
        const messages = raw.map((m) => ({
            info: { id: m.id, role: m.role },
            parts: [{ type: "text", text: m.text }],
        }));
        const bytes = JSON.stringify(messages);
        const phase = (intent: boolean) =>
            runCompartmentPhase({
                canRunCompartments: true,
                fullFeatureMode: true,
                sessionMeta: { compartmentInProgress: intent },
                contextUsage: usage,
                boundaryContextLimit: 200_000,
                boundaryExecuteThresholdPercentage: 65,
                boundaryUsage: usage,
                boundaryUsageSource: "live",
                db,
                sessionId,
                resolvedSessionId: sessionId,
                historianChunkTokens: 20_000,
                compartmentDirectory: "/tmp",
                messages,
                pendingCompartmentInjection: null,
                deferredHistoryRefreshSessions: new Set(),
                client: {} as PluginContext["client"],
            });
        try {
            for (let i = 0; i < 3; i++) {
                const decision = trigger();
                expect(decision.shouldFire).toBe(false);
                await phase(decision.shouldFire);
                expect(JSON.stringify(messages)).toBe(bytes);
            }
            // Recovery and mode transitions can leave an intent without going through the trigger.
            updateSessionMeta(db, sessionId, { compartmentInProgress: true });
            expect((await phase(true)).compartmentInProgress).toBe(false);
            expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
            expect(start).not.toHaveBeenCalled();
            expect(prime).not.toHaveBeenCalled();
            expect(
                log.mock.calls.filter(
                    ([id, text]) => id === sessionId && String(text).includes("next eligible at"),
                ),
            ).toHaveLength(1);
            expect(
                log.mock.calls.some(([, text]) =>
                    String(text).includes(new Date(startedAt + DRAIN_WINDOW_MS).toISOString()),
                ),
            ).toBe(true);
            db.prepare(
                "UPDATE session_meta SET protected_tail_drain_window_started_at = ? WHERE session_id = ?",
            ).run(Date.now() - DRAIN_WINDOW_MS, sessionId);
            const resumed = trigger();
            expect(resumed.shouldFire).toBe(true);
            await phase(resumed.shouldFire);
            expect(start).toHaveBeenCalledTimes(1);
        } finally {
            start.mockRestore();
            prime.mockRestore();
            log.mockRestore();
        }
    });

    it("ordinary compartment phase returns before raw-history startup even without a trigger snapshot", async () => {
        const sessionId = "ses-deferred-compartment-startup";
        createOpenCodeDb(
            sessionId,
            Array.from({ length: 12 }, (_, i) => ({
                id: `m${i}`,
                role: i % 2 ? "assistant" : "user",
                text: "history",
            })),
        );
        const db = openDatabase();
        const prime = spyOn(rawHistory, "primeTailRawMessageCache");
        try {
            const result = await runCompartmentPhase({
                canRunCompartments: true,
                fullFeatureMode: true,
                sessionMeta: { compartmentInProgress: true },
                contextUsage: { percentage: 25 },
                boundaryContextLimit: 200_000,
                boundaryExecuteThresholdPercentage: 65,
                boundaryUsage: { percentage: 25, inputTokens: 50_000 },
                boundaryUsageSource: "live",
                db,
                sessionId,
                resolvedSessionId: sessionId,
                historianChunkTokens: 20_000,
                compartmentDirectory: "/tmp",
                messages: [],
                pendingCompartmentInjection: null,
                deferredHistoryRefreshSessions: new Set(),
                client: {} as PluginContext["client"],
            });
            expect(result.awaitedCompartmentRun).toBe(false);
            expect(getActiveCompartmentRun(sessionId)).toBeDefined();
            expect(prime).not.toHaveBeenCalled();
            await getActiveCompartmentRun(sessionId)?.promise;
            expect(prime).toHaveBeenCalledTimes(1);
        } finally {
            prime.mockRestore();
        }
    });

    it("reuses the trigger boundary anchor without rereading the compartment row", async () => {
        const sessionId = "ses-boundary-handoff";
        createOpenCodeDb(
            sessionId,
            Array.from({ length: 6 }, (_, index) => ({
                id: `m${index + 1}`,
                role: index % 2 === 0 ? "user" : "assistant",
                text: `message ${index + 1}`,
            })),
        );
        const realDb = openDatabase();
        appendCompartments(realDb, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "one",
                content: "summary",
            },
        ]);
        const preparedSql: string[] = [];
        const db = new Proxy(realDb, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        preparedSql.push(sql);
                        return target.prepare.call(target, sql);
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as typeof realDb;
        const input = [{ info: { id: "m6", role: "assistant" }, parts: [] }];
        const run = async () => {
            const messages = structuredClone(input);
            await runCompartmentPhase({
                canRunCompartments: true,
                fullFeatureMode: true,
                sessionMeta: { compartmentInProgress: true },
                contextUsage: { percentage: 20 },
                boundaryContextLimit: 12_000,
                boundaryExecuteThresholdPercentage: 65,
                boundaryUsage: { percentage: 20, inputTokens: 1_000 },
                boundaryUsageSource: "live",
                db,
                sessionId,
                resolvedSessionId: sessionId,
                historianChunkTokens: 25_000,
                compartmentDirectory: "/tmp",
                messages: messages as never,
                pendingCompartmentInjection: null,
                deferredHistoryRefreshSessions: new Set(),
                preResolvedBoundarySnapshot: {
                    ...createDefaultBoundarySnapshotForTests(sessionId),
                    mode: "transform-force",
                    offset: 3,
                    lastCompartmentEndMessageId: "m2",
                    protectedTailStart: 5,
                    eligibleEndOrdinal: 5,
                    rawMessageCountAtTrigger: 6,
                },
            });
            return messages;
        };
        const first = await run();
        const second = await run();
        const digest = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");

        expect(digest(second)).toBe(digest(first));
        expect(
            preparedSql.some(
                (sql) =>
                    sql.includes("MAX(end_message)") ||
                    (sql.includes("SELECT end_message_id") && sql.includes("ORDER BY sequence")),
            ),
        ).toBe(false);
    });
});

describe("runCompartmentPhase - 95% emergency notification idempotency", () => {
    // High pressure may survive many transform passes. Publish one RPC status
    // per active historian run, never a user row that could extend that run.
    it("sends the 95% comparting notification at most once per active compartment run", async () => {
        const sessionId = "ses-notification-guard";

        // Create an OpenCode DB with enough messages so hasEligibleHistoryForCompartment
        // returns true (need raw history beyond any existing compartment end).
        createOpenCodeDb(
            sessionId,
            Array.from({ length: 12 }, (_, i) => ({
                id: `m-${i + 1}`,
                role: i % 2 === 0 ? "user" : "assistant",
                text: `message ${i + 1}`,
            })),
        );

        const db = openDatabase();

        // A status update must never call the prompt transport.
        const promptMock = mock(async () => ({ data: {} }));
        const client = {
            session: {
                prompt: promptMock,
            },
        } as unknown as PluginContext["client"];

        // Register a never-resolving active compartment run so the phase sees
        // an in-flight run on every pass. Using registerActiveCompartmentRun
        // directly avoids depending on runCompartmentAgent's network paths.
        const neverResolves = new Promise<void>(() => {});
        registerActiveCompartmentRun(sessionId, neverResolves);

        const activeRun = getActiveCompartmentRun(sessionId);
        expect(activeRun).toBeDefined();
        expect(activeRun?.notificationSent).toBeFalsy();

        const baseArgs = {
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: false },
            contextUsage: { percentage: 97 }, // >= 95% triggers the notification path
            boundaryContextLimit: 12_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 97, inputTokens: 7_600 },
            boundaryUsageSource: "live" as const,
            client,
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            compartmentDirectory: "/tmp",
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            // historianTimeoutMs short so the await returns "timed_out" quickly
            // (the registered activeRun never resolves on its own).
            historianTimeoutMs: 50,
        };

        // Pass 1: pressure is high, activeRun exists with notificationSent=false.
        // The notification should fire exactly once and flip notificationSent=true.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);
        expect(activeRun?.notificationSent).toBe(true);

        // Pass 2: same activeRun, still notificationSent=true → no additional call.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);

        // Pass 3: still 1 — never re-fires while the same run is active.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);

        // Verify message text
        const notifText = drainNotifications(0, sessionId)
            .map((notice) => String(notice.payload.message))
            .find((text) => text.includes("comparting history"));
        expect(notifText).toBeDefined();
        expect(notifText).toContain("Context at 97%");
    });
    it("bounds a stuck historian join at 60 seconds and adopts its later publication", async () => {
        const sessionId = "ses-bounded-historian-join";
        const db = openDatabase();
        const deferredHistoryRefreshSessions = new Set<string>();
        let finishHistorian!: () => void;
        const historian = new Promise<void>((resolve) => {
            finishHistorian = resolve;
        });
        const activeRun = registerActiveCompartmentRun(sessionId, historian);
        const args = {
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 97 },
            boundaryContextLimit: 100_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 97, inputTokens: 97_000 },
            boundaryUsageSource: "live" as const,
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            historianTimeoutMs: 15,
            skipAwaitForThisPass: true,
            compartmentDirectory: "/tmp",
            messages: [
                { info: { id: "m1", role: "user" }, parts: [] },
                { info: { id: "m2", role: "assistant" }, parts: [] },
                { info: { id: "m3", role: "user" }, parts: [] },
            ],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions,
        };

        try {
            expect(resolveHistorianInlineJoinBudget(600_000)).toBe(HISTORIAN_INLINE_JOIN_BUDGET_MS);
            const started = performance.now();
            const timedOut = await runCompartmentPhase(args);
            expect(performance.now() - started).toBeLessThan(250);
            expect(timedOut.historianJoinTimedOut).toBe(true);
            expect(timedOut.historianJoinBudgetMs).toBe(15);

            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "m1",
                    endMessageId: "m2",
                    title: "Published later",
                    content: "The background historian completed after the inline join budget.",
                },
            ]);
            activeRun.published = true;
            deferredHistoryRefreshSessions.add(sessionId);
            finishHistorian();

            // Start the next pass before the completed historian run leaves the active registry.
            // That pass adopts the publication inline; the run's finally-handler then clears it.
            const nextPass = await runCompartmentPhase({ ...args, messages: [...args.messages] });
            expect(nextPass.awaitedCompartmentRun).toBe(true);
            expect(nextPass.justAwaitedPublication).toBe(true);
            expect(nextPass.pendingCompartmentInjection?.block).toContain("Published later");
        } finally {
            finishHistorian();
        }
    });

    it("proceeds only when post-timeout emergency reclaim proves the wire fits", () => {
        expect(
            historianJoinFailClosedMessage({
                timedOut: true,
                budgetMs: HISTORIAN_INLINE_JOIN_BUDGET_MS,
                finalWireEstimate: { tokens: 64_000, trusted: true },
                contextLimitTokens: 100_000,
                lastHistorianError: "provider is slow",
            }),
        ).toBeNull();
        expect(
            historianJoinFailClosedMessage({
                timedOut: true,
                budgetMs: HISTORIAN_INLINE_JOIN_BUDGET_MS,
                finalWireEstimate: { tokens: 104_000, trusted: true },
                contextLimitTokens: 100_000,
                lastHistorianError: "provider is slow",
            }),
        ).toBe("historian did not complete within 60 s: provider is slow");
        expect(
            historianJoinFailClosedMessage({
                timedOut: true,
                budgetMs: HISTORIAN_INLINE_JOIN_BUDGET_MS,
                finalWireEstimate: { tokens: 64_000, trusted: false },
                contextLimitTokens: 100_000,
            }),
        ).toBe("historian did not complete within 60 s: background historian is still running");
    });

    it("keeps an in-budget historian completion on the inline fold path", async () => {
        const sessionId = "ses-fast-historian-join";
        const db = openDatabase();
        let finishHistorian!: () => void;
        const activeRun = registerActiveCompartmentRun(
            sessionId,
            new Promise<void>((resolve) => {
                finishHistorian = resolve;
            }),
        );
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "Fast fold",
                content: "The historian completed within the inline join budget.",
            },
        ]);
        activeRun.published = true;
        const deferredHistoryRefreshSessions = new Set([sessionId]);
        const pass = runCompartmentPhase({
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 97 },
            boundaryContextLimit: 100_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 97, inputTokens: 97_000 },
            boundaryUsageSource: "live",
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            historianTimeoutMs: 600_000,
            skipAwaitForThisPass: true,
            compartmentDirectory: "/tmp",
            messages: [
                { info: { id: "m1", role: "user" }, parts: [] },
                { info: { id: "m2", role: "assistant" }, parts: [] },
                { info: { id: "m3", role: "user" }, parts: [] },
            ],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions,
        });
        finishHistorian();
        const result = await pass;
        expect(result.awaitedCompartmentRun).toBe(true);
        expect(result.historianJoinTimedOut).toBe(false);
        expect(result.justAwaitedPublication).toBe(true);
        expect(result.pendingCompartmentInjection?.block).toContain("Fast fold");
    });

    it("does not start independent compressor when historian is disabled", async () => {
        const sessionId = "ses-compressor-disabled";
        const db = openDatabase();
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                title: "one",
                content: "large content ".repeat(200),
            },
            {
                sequence: 2,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "m11",
                endMessageId: "m20",
                title: "two",
                content: "large content ".repeat(200),
            },
        ]);
        const promptMock = mock(async () => ({ data: {} }));
        const client = { session: { prompt: promptMock } } as unknown as PluginContext["client"];

        await runCompartmentPhase({
            canRunCompartments: false,
            fullFeatureMode: true,
            historianRunnable: false,
            sessionMeta: { compartmentInProgress: false },
            contextUsage: { percentage: 20 },
            boundaryContextLimit: 12_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 20, inputTokens: 1_000 },
            boundaryUsageSource: "live",
            client,
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            historyBudgetTokens: 1,
            compartmentDirectory: "/tmp",
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            safeForBackgroundCompression: true,
        });

        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
        expect(promptMock).not.toHaveBeenCalled();
    });
});
