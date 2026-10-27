/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { markProtectedTailPolicyV3Seeded } from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runCompartmentAgent } from "./compartment-runner";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import {
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

// One meaningful prompt followed by a long autonomous run: every later user
// message is a system reminder, so the newest meaningful prompt stays at ordinal 1.
function onePromptSession(assistantTurns: number): RawMessage[] {
    const messages: RawMessage[] = [
        {
            ordinal: 1,
            id: "m-1",
            role: "user",
            parts: [{ type: "text", text: "Implement the long autonomous task" }],
        },
    ];
    for (let turn = 0; turn < assistantTurns; turn++) {
        const assistantOrdinal = messages.length + 1;
        messages.push({
            ordinal: assistantOrdinal,
            id: `m-${assistantOrdinal}`,
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `Work phase ${turn}: inspected code and verified the next change. `.repeat(
                        250,
                    ),
                },
            ],
        });
        const reminderOrdinal = messages.length + 1;
        messages.push({
            ordinal: reminderOrdinal,
            id: `m-${reminderOrdinal}`,
            role: "user",
            parts: [{ type: "text", text: "<system-reminder>Continue working</system-reminder>" }],
        });
    }
    return messages;
}

const CONTEXT_LIMIT = 100_000;
const EXECUTE_THRESHOLD = 65;
// Above the execute threshold and below the force band (85%), where the
// live-prompt floor normally applies.
const USAGE = { percentage: 70, inputTokens: 70_000 };

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function triggerSnapshot(
    db: Database,
    sessionId: string,
    liftLivePromptFloor: boolean,
): ProtectedTailBoundarySnapshot {
    // The same resolution compartment-trigger.ts performs for a fire decision.
    return resolveOpenCodeProtectedTailBoundary({
        db,
        sessionId,
        mode: "trigger",
        contextLimit: CONTEXT_LIMIT,
        executeThresholdPercentage: EXECUTE_THRESHOLD,
        usage: USAGE,
        usageSource: "live",
        liftLivePromptFloor,
    });
}

function historianClient(prompts: string[]): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/live-prompt-floor-refresh" } })),
            create: mock(async () => ({ data: { id: `child-${Math.random()}` } })),
            prompt: mock(async (input: unknown) => {
                prompts.push(JSON.stringify(input));
                return {};
            }),
            messages: mock(async () => {
                const range = /Messages (\d+)-(\d+):/.exec(prompts.at(-1) ?? "");
                if (!range) throw new Error("historian prompt did not name its message range");
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<output><compartments><compartment start="${range[1]}" end="${range[2]}" title="Autonomous work" episode_type="debug" importance="50"><p1>Completed the earlier work.</p1><p2>Earlier work.</p2><p3>Work.</p3><p4>work</p4></compartment></compartments><meta><messages_processed>${range[1]}-${range[2]}</messages_processed><unprocessed_from>${Number(range[2]) + 1}</unprocessed_from></meta></output>`,
                                },
                            ],
                        },
                    ],
                };
            }),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

async function runHistorian(
    db: Database,
    sessionId: string,
    snapshot: ProtectedTailBoundarySnapshot,
    prompts: string[],
): Promise<void> {
    const holderId = `holder-${Math.random()}`;
    expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent(
            await prepareProducerFixture({
                client: historianClient(prompts),
                db,
                sessionId,
                historianChunkTokens: 100_000,
                historianTimeoutMs: 5_000,
                boundarySnapshot: snapshot,
                currentContextLimit: CONTEXT_LIMIT,
                directory: "/tmp/live-prompt-floor-refresh",
                memoryEnabled: false,
                fallbackModels: [],
                compartmentLeaseHolderId: holderId,
            }),
        );
    } finally {
        clearProducerModelObservations();
        releaseCompartmentLease(db, sessionId, holderId);
    }
}

describe("stale-snapshot refresh and the trigger's live-prompt floor lift", () => {
    let cleanup: Array<() => void> = [];
    afterEach(() => {
        for (const fn of cleanup.reverse()) fn();
        cleanup = [];
    });

    function setup(sessionId: string) {
        const db = createDb();
        // Skip the one-time legacy migration floor so only the live-prompt floor applies.
        markProtectedTailPolicyV3Seeded(db, sessionId, 1);
        const messages = onePromptSession(20);
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => messages,
            getMessageCount: () => messages.length,
        });
        const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        cleanup.push(
            () => logSpy.mockRestore(),
            unregister,
            () => closeQuietly(db),
        );
        const logged = () => logSpy.mock.calls.map((call) => call.slice(1).join(" "));
        return { db, messages, logged };
    }

    it("records the lift on the snapshot only when the trigger granted it", () => {
        const sessionId = "ses-floor-lift-recorded";
        const { db } = setup(sessionId);
        const lifted = triggerSnapshot(db, sessionId, true);
        const floored = triggerSnapshot(db, sessionId, false);
        expect(lifted.liftLivePromptFloor).toBe(true);
        expect(floored.liftLivePromptFloor).toBeUndefined();
        // In a one-prompt session only the lifted resolution exposes a head.
        expect(hasRunnableCompartmentWindow(lifted)).toBe(true);
        expect(hasRunnableCompartmentWindow(floored)).toBe(false);
        expect(floored.protectedTailStart).toBe(1);
    });

    it("refreshes a stale lifted snapshot to a runnable window and publishes a compartment", async () => {
        const sessionId = "ses-floor-lift-stale-refresh";
        const { db, messages, logged } = setup(sessionId);
        const snapshot = triggerSnapshot(db, sessionId, true);
        expect(hasRunnableCompartmentWindow(snapshot)).toBe(true);

        // The session moves on before the historian validates the trigger's
        // snapshot: a head message's content changes and a new turn lands.
        const edited = messages[1];
        if (!edited) throw new Error("fixture needs a head message");
        edited.parts = [
            { type: "text", text: "Work phase 0: rewritten after the trigger. ".repeat(250) },
        ];
        messages.push({
            ordinal: messages.length + 1,
            id: `m-${messages.length + 1}`,
            role: "assistant",
            parts: [{ type: "text", text: "A newer step landed after the trigger." }],
        });

        // The boundary the refresh should rebuild from the live messages.
        const expectedRefresh = triggerSnapshot(db, sessionId, true);
        expect(hasRunnableCompartmentWindow(expectedRefresh)).toBe(true);

        const prompts: string[] = [];
        await runHistorian(db, sessionId, snapshot, prompts);

        const lines = logged();
        expect(
            lines.some((line) => line.includes("historian no-op: stale protected-tail snapshot")),
        ).toBe(false);
        expect(
            lines.some((line) =>
                line.includes("historian: refreshed stale protected-tail snapshot at run time"),
            ),
        ).toBe(true);
        const compartments = getCompartments(db, sessionId);
        expect(compartments).toHaveLength(1);
        expect(compartments[0]?.startMessage).toBe(1);
        // The protected tail is recomputed from live messages: the published
        // range ends inside the refreshed eligible head, never in the tail.
        expect(compartments[0]?.endMessage).toBeLessThan(expectedRefresh.eligibleEndOrdinal);
        expect(compartments[0]?.endMessage).toBeLessThan(expectedRefresh.protectedTailStart);
    });

    it("keeps clamping at the live prompt when the stale snapshot was not lifted", async () => {
        const sessionId = "ses-floor-unlifted-stale-refresh";
        const { db, messages, logged } = setup(sessionId);
        // Keep the lifted boundary's head but remove its lift flag, to check that
        // a refresh never lifts the floor for a snapshot that does not carry it.
        const lifted = triggerSnapshot(db, sessionId, true);
        const unlifted: ProtectedTailBoundarySnapshot = {
            ...lifted,
            liftLivePromptFloor: undefined,
        };
        const edited = messages[1];
        if (!edited) throw new Error("fixture needs a head message");
        edited.parts = [
            { type: "text", text: "Work phase 0: rewritten after the trigger. ".repeat(250) },
        ];

        const prompts: string[] = [];
        await runHistorian(db, sessionId, unlifted, prompts);

        expect(prompts).toHaveLength(0);
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(
            logged().some((line) =>
                line.includes(
                    "historian no-op: stale protected-tail snapshot (raw range fingerprint changed)",
                ),
            ),
        ).toBe(true);
    });
});
