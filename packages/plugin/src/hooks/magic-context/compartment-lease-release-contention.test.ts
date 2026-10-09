/// <reference types="bun-types" />

import { describe, expect, it, mock, spyOn } from "bun:test";
import { join } from "node:path";

import {
    acquireCompartmentLease,
    COMPARTMENT_LEASE_TTL_MS,
} from "../../features/magic-context/compartment-lease";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    getActiveCompartmentRun,
    type runCompartmentAgent,
    startCompartmentAgent,
} from "./compartment-runner";
import { createLiveSessionState } from "./live-session-state";
import { setRawMessageProvider } from "./read-session-chunk";
import { type ManagedWrapupContext, runManagedWrapup } from "./wrapup-orchestrator";

function createDb(path: string): Database {
    const db = new Database(path);
    initializeDatabase(db);
    db.exec("PRAGMA busy_timeout = 1");
    return db;
}

function rawMessages(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1}` }],
    }));
}

function waitForFinalizer(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
}

function wrapupContext(db: Database): ManagedWrapupContext {
    return {
        client: {} as PluginContext["client"],
        db,
        liveSessionState: createLiveSessionState(),
        directory: "/tmp/lease-release-contention",
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
    };
}

describe("compartment lease release under SQLite contention", () => {
    it("contains SQLITE_BUSY from the parked historian finalizer and leaves its TTL reclaimable", async () => {
        const { dir, cleanup } = createTestTempDir(
            "mc-test-temp-dir-helper-",
            "historian-lease-release-",
        );
        const path = join(dir, "context.db");
        const db = createDb(path);
        const blocker = new Database(path);
        blocker.exec("PRAGMA busy_timeout = 1");
        const now = 1_000_000;
        const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
        const sessionId = "ses-historian-release-contention";
        let holderId = "";
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        let resolveRun!: () => void;
        const underlyingRun = new Promise<void>((resolve) => {
            resolveRun = resolve;
        });
        const runAgent = (deps: Parameters<typeof runCompartmentAgent>[0]): Promise<void> => {
            holderId = deps.compartmentLeaseHolderId ?? "";
            deps.onHistorianRunStarted?.();
            markStarted();
            return underlyingRun;
        };
        const rejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        let blockerTransactionOpen = false;
        process.on("unhandledRejection", onUnhandledRejection);
        try {
            startCompartmentAgent(
                {
                    client: {} as PluginContext["client"],
                    db,
                    sessionId,
                    historianChunkTokens: 10,
                    directory: "/tmp/lease-release-contention",
                },
                runAgent,
            );
            expect(getActiveCompartmentRun(sessionId)).toBeDefined();
            await started;
            expect(holderId).not.toBe("");

            blocker.exec("BEGIN IMMEDIATE");
            blockerTransactionOpen = true;
            resolveRun();
            await waitForFinalizer();

            expect(rejections).toHaveLength(0);
            // Clearing the parked run proves its promise settled after the finalizer completed.
            expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
            expect(
                blocker
                    .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                    .get(sessionId),
            ).toEqual({ holder_id: holderId });

            blocker.exec("ROLLBACK");
            blockerTransactionOpen = false;
            nowSpy.mockImplementation(() => now + COMPARTMENT_LEASE_TTL_MS + 1);
            expect(acquireCompartmentLease(db, sessionId, "replacement-holder")).not.toBeNull();
        } finally {
            if (blockerTransactionOpen) blocker.exec("ROLLBACK");
            process.off("unhandledRejection", onUnhandledRejection);
            nowSpy.mockRestore();
            closeQuietly(blocker);
            closeQuietly(db);
            cleanup();
        }
    });

    it("contains SQLITE_BUSY from a wrapup iteration release and leaves its TTL reclaimable", async () => {
        const { dir, cleanup } = createTestTempDir(
            "mc-test-temp-dir-helper-",
            "wrapup-lease-release-",
        );
        const path = join(dir, "context.db");
        const db = createDb(path);
        const blocker = new Database(path);
        blocker.exec("PRAGMA busy_timeout = 1");
        const now = 2_000_000;
        const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
        const sessionId = "ses-wrapup-release-contention";
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => rawMessages(8),
            getMessageCount: () => 8,
        });
        const ctx = wrapupContext(db);
        let holderId = "";
        let resolveRun!: () => void;
        const underlyingRun = new Promise<void>((resolve) => {
            resolveRun = resolve;
        });
        const runner = mock(async (deps: Parameters<typeof runCompartmentAgent>[0]) => {
            holderId = deps.compartmentLeaseHolderId ?? "";
            await underlyingRun;
        });
        ctx.runCompartmentAgentForWrapup = runner;
        const rejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            rejections.push(reason);
        };
        let blockerTransactionOpen = false;
        let leaseReleaseFailure: string | undefined;
        let sawLeaseDuringReleaseFailure = false;
        const logSpy = spyOn(logger, "sessionLog").mockImplementation((_sid, message) => {
            if (!message.startsWith("lease release failed (")) return;
            leaseReleaseFailure = message;
            const row = blocker
                .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                .get(sessionId) as { holder_id: string } | null;
            sawLeaseDuringReleaseFailure = row?.holder_id === holderId;
            blocker.exec("ROLLBACK");
            blockerTransactionOpen = false;
        });
        process.on("unhandledRejection", onUnhandledRejection);
        try {
            const wrapup = runManagedWrapup(ctx, sessionId, { messagesToKeep: 2 });
            while (runner.mock.calls.length === 0) await Promise.resolve();
            expect(holderId).not.toBe("");

            blocker.exec("BEGIN IMMEDIATE");
            blockerTransactionOpen = true;
            resolveRun();

            await expect(wrapup).resolves.toContain("## Magic Wrapup — Partial");
            expect(rejections).toHaveLength(0);
            expect(leaseReleaseFailure).toMatch(
                /^lease release failed \(.+\); row expires on its TTL$/,
            );
            expect(sawLeaseDuringReleaseFailure).toBe(true);

            nowSpy.mockImplementation(() => now + COMPARTMENT_LEASE_TTL_MS + 1);
            expect(acquireCompartmentLease(db, sessionId, "replacement-holder")).not.toBeNull();
        } finally {
            if (blockerTransactionOpen) blocker.exec("ROLLBACK");
            process.off("unhandledRejection", onUnhandledRejection);
            logSpy.mockRestore();
            unregister();
            nowSpy.mockRestore();
            closeQuietly(blocker);
            closeQuietly(db);
            cleanup();
        }
    });
});
