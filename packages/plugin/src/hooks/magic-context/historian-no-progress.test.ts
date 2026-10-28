import { afterEach, describe, expect, it, mock } from "bun:test";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    getHistorianFailureState,
    getOrCreateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { shouldWaitForNewHistorianHistory } from "./historian-history-wait";
import { markHostUnservedRow } from "./host-served-rows";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    cleanups.length = 0;
    clearProducerModelObservations();
});

function message(ordinal: number): RawMessage {
    return {
        ordinal,
        id: `m${ordinal}`,
        role: ordinal % 2 === 1 ? "user" : "assistant",
        parts: [
            {
                type: "text",
                text: `Message ${ordinal}: investigate and fix the historian retry behavior.`,
            },
        ],
    };
}

function compartment(start: number, end: number): string {
    return `<compartment start="${start}" end="${end}" title="History"><p1>Investigated the retry behavior.</p1></compartment>`;
}

async function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = `no-progress-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 24 }, (_, index) => message(index + 1));
    markHostUnservedRow(messages[0]);
    const unregister = setRawMessageProvider(sessionId, { readMessages: () => messages });
    cleanups.push(() => db.close(), unregister);
    const holder = "test-historian";
    expect(acquireCompartmentLease(db, sessionId, holder)).not.toBeNull();
    let output = "";
    const modelCalls = mock(async () => ({}));
    const client = {
        session: {
            get: mock(async () => ({ data: { directory: process.cwd() } })),
            create: mock(async () => ({ data: { id: "historian-child" } })),
            prompt: mock(async (args: { path?: { id?: string } }) => {
                if (args.path?.id === "historian-child") return modelCalls();
                return {};
            }),
            messages: mock(async () => ({
                data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: output }] }],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    const pass = async (percentage = 80, manual = false, publishEnd?: number, direct = false) => {
        const decision = checkCompartmentTrigger(
            db,
            sessionId,
            getOrCreateSessionMeta(db, sessionId),
            { percentage, inputTokens: percentage * 1000, contextLimit: 100_000 },
            0,
            65,
            100_000,
        );
        if (!decision.shouldFire && !manual && !direct) return;
        const snapshot = {
            ...createDefaultBoundarySnapshotForTests(sessionId),
            usagePercentage: percentage,
        };
        const start = getCompartments(db, sessionId).at(-1)?.endMessage ?? 0;
        output =
            publishEnd === undefined
                ? compartment(start + 1, start + 1) +
                  compartment(start + 2, snapshot.eligibleEndOrdinal - 1)
                : compartment(start + 1, publishEnd);
        if (publishEnd !== undefined) {
            output += `<unprocessed_from>${publishEnd + 1}</unprocessed_from>`;
        }
        await runCompartmentAgent(
            await prepareProducerFixture({
                db,
                sessionId,
                client,
                directory: process.cwd(),
                historianChunkTokens: 20_000,
                boundarySnapshot: snapshot,
                compartmentLeaseHolderId: holder,
                memoryEnabled: false,
                forceDrainQuota: manual,
            }),
        );
    };
    return { db, sessionId, messages, modelCalls, pass };
}

describe("historian no-progress history wait", () => {
    it("makes one model call across unchanged trigger passes, then retries after a new message", async () => {
        const { db, sessionId, messages, modelCalls, pass } = await fixture();
        await pass();
        expect(getHistorianFailureState(db, sessionId).lastError).toContain("no forward progress");
        await pass();
        expect(modelCalls).toHaveBeenCalledTimes(1);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(1);
        messages.push(message(25));
        await pass();
        expect(modelCalls).toHaveBeenCalledTimes(2);
    });

    it("allows the force band once on an unchanged failed window", async () => {
        const { modelCalls, pass } = await fixture();
        await pass();
        await pass(85);
        expect(modelCalls).toHaveBeenCalledTimes(2);
        await pass(85);
        await pass(95, false, undefined, true);
        expect(modelCalls).toHaveBeenCalledTimes(2);
    });

    it("allows an emergency start once even when it bypasses the trigger", async () => {
        const { modelCalls, pass } = await fixture();
        await pass();
        await pass(95, false, undefined, true);
        expect(modelCalls).toHaveBeenCalledTimes(2);
        await pass(95, false, undefined, true);
        expect(modelCalls).toHaveBeenCalledTimes(2);
    });

    it("preserves the one-pass permission to lift the newest-prompt floor", async () => {
        const { sessionId, pass } = await fixture();
        await pass();
        const snapshot = createDefaultBoundarySnapshotForTests(sessionId);
        expect(shouldWaitForNewHistorianHistory(snapshot)).toBe(true);
        const lifted = { ...snapshot, liftLivePromptFloor: true };
        expect(shouldWaitForNewHistorianHistory(lifted)).toBe(false);
        expect(shouldWaitForNewHistorianHistory(lifted, { claim: true })).toBe(false);
        expect(shouldWaitForNewHistorianHistory(lifted)).toBe(true);
    });

    it("allows manual publication and clears the history wait after commit", async () => {
        const { db, sessionId, modelCalls, pass } = await fixture();
        await pass();
        await pass(80, true, 2);
        expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(2);
        await pass(80, false, 14);
        expect(modelCalls).toHaveBeenCalledTimes(3);
        expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(14);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    });

    it("can publish after new history even when the unserved row remains", async () => {
        const { db, sessionId, messages, modelCalls, pass } = await fixture();
        await pass();
        messages.push(message(25));
        await pass(80, false, 2);
        expect(modelCalls).toHaveBeenCalledTimes(2);
        expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(2);
    });
});
