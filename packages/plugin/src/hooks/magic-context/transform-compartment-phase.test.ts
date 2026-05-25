/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getActiveCompartmentRun, registerActiveCompartmentRun } from "./compartment-runner";
import { runCompartmentPhase } from "./transform-compartment-phase";

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

function countIgnoredNotifications(
    promptMock: ReturnType<typeof mock>,
    matchSubstring?: string,
): number {
    return promptMock.mock.calls
        .map(
            (call) => call[0] as { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } },
        )
        .filter((input) => input.body?.noReply === true)
        .filter((input) =>
            matchSubstring ? (input.body?.parts?.[0]?.text ?? "").includes(matchSubstring) : true,
        ).length;
}

let tempDir: string | undefined;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mc-compartment-phase-"));
    process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir)
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
});

describe("runCompartmentPhase - 95% emergency notification idempotency", () => {
    /**
     * Regression guard for the CI-only infinite-loop bug discovered on 2026-05-19:
     *
     * When pressure stays >=95% across multiple transform passes (e.g. force-cleanup
     * usage that keeps reporting 85k tokens), the same compartment run stays active
     * for the duration of historian execution. Without the `notificationSent`
     * guard, each transform pass would call `sendIgnoredMessage(...)`, which uses
     * `client.session.prompt({ noReply: true })`. OpenCode persists each such
     * call as a USER message with finish=null in the session DB.
     *
     * On the next loop iteration, `latest(msgs)` returns the new notification-user
     * as `lastUser` (highest ID), and `lastUser.id > lastAssistant.id` makes
     * OpenCode's break condition `lastUser.id < lastAssistant.id` false →
     * runLoop keeps calling the LLM → mock returns 85k usage again → transform
     * fires again → notification fires again → INFINITE LOOP.
     *
     * The guard ensures sendIgnoredMessage runs at most once per ActiveCompartmentRun.
     */
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

        // Stub a client that exposes session.prompt. sendIgnoredMessage calls
        // session.prompt with noReply:true — we count those to verify the guard.
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
        expect(countIgnoredNotifications(promptMock, "Context at 97%")).toBe(1);
        expect(activeRun?.notificationSent).toBe(true);

        // Pass 2: same activeRun, still notificationSent=true → no additional call.
        await runCompartmentPhase(baseArgs);
        expect(countIgnoredNotifications(promptMock, "Context at 97%")).toBe(1);

        // Pass 3: still 1 — never re-fires while the same run is active.
        await runCompartmentPhase(baseArgs);
        expect(countIgnoredNotifications(promptMock, "Context at 97%")).toBe(1);

        // Verify message text
        const calls = promptMock.mock.calls as unknown as Array<
            [{ body?: { parts?: Array<{ text?: string }> } }]
        >;
        const notifText = calls
            .map((call) => call[0].body?.parts?.[0]?.text ?? "")
            .find((text) => text.includes("comparting history"));
        expect(notifText).toBeDefined();
        expect(notifText).toContain("Context at 97%");
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
