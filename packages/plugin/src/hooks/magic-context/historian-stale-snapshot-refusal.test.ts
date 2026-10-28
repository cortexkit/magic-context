/// <reference types="bun-types" />

/**
 * The historian refuses to publish only over a drifted OpenCode 1 file-store
 * snapshot: when the exact read disagrees on a boundary check that never
 * moves by itself (`offset`, `protectedTailStart` or `eligibleEnd`, or a
 * shrunk count), the serving-thread ranks are dropped and the run ends
 * without publishing and without a failure count. A stale `last` id moves
 * every turn as the live tail grows, so it still refreshes and adopts.
 */
import { Database as RawDatabase } from "bun:sqlite";
import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getHistorianFailureState } from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { isServingOrdinalDriftSignal, runCompartmentAgent } from "./compartment-runner-incremental";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import { closeReadOnlySessionDb, withReadOnlySessionDb } from "./read-session-db";
import { countRawSessionMessageOrdinalsFromDb } from "./read-session-raw";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanups.reverse()) fn();
    cleanups.length = 0;
});

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function historianClient(prompts: string[]): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/stale-refusal" } })),
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
                                    text: `<output><compartments><compartment start="${range[1]}" end="${range[2]}" title="Fresh head" episode_type="debug" importance="50"><p1>Fresh head.</p1><p2>Head.</p2><p3>Head.</p3><p4>head</p4></compartment></compartments><meta><messages_processed>${range[1]}-${range[2]}</messages_processed><unprocessed_from>${Number(range[2]) + 1}</unprocessed_from></meta></output>`,
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

it("classifies only non-moving serving-read disagreements as ordinal drift signals", () => {
    expect(isServingOrdinalDriftSignal("offset ordinal 12 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("protectedTailStart ordinal 4 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("eligibleEnd ordinal 3 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("raw message count shrank")).toBe(true);
    // The last id moves every turn as the live tail grows, so it still
    // refreshes instead of refusing.
    expect(isServingOrdinalDriftSignal("last ordinal 6 id changed")).toBe(false);
    expect(isServingOrdinalDriftSignal("last compartment moved: offset 1 -> 2")).toBe(false);
    expect(isServingOrdinalDriftSignal("raw range fingerprint changed")).toBe(false);
    expect(isServingOrdinalDriftSignal("context limit changed from 1 to 2")).toBe(false);
    expect(isServingOrdinalDriftSignal(undefined)).toBe(false);
});

function withFileStore(run: (sessionId: string) => Promise<void>): Promise<void> {
    const temp = createTestTempDir("mc-stale-refusal-");
    const path = join(temp.dir, "opencode.db");
    const source = new RawDatabase(path);
    source.exec("PRAGMA journal_mode=WAL");
    source.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const sessionId = "ses-stale-refusal";
    const insertMessage = source.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = source.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 1; index <= 12; index++) {
        const id = `m-${index}`;
        insertMessage.run(
            id,
            sessionId,
            index * 100,
            index * 100,
            JSON.stringify({ role: "user" }),
        );
        insertPart.run(
            `part-${id}`,
            id,
            sessionId,
            index * 100,
            index * 100,
            JSON.stringify({
                type: "text",
                text: `message ${index} with enough content to survive the noise gate`,
            }),
        );
    }
    const previousPath = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = path;
    closeReadOnlySessionDb();
    return run(sessionId).finally(() => {
        closeReadOnlySessionDb();
        if (previousPath === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previousPath;
        source.close();
        resetRawSessionOrdinalWarmupsForTest();
        temp.cleanup();
    });
}

async function runHistorian(
    db: Database,
    sessionId: string,
    snapshot: ReturnType<typeof createDefaultBoundarySnapshotForTests>,
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
                historianChunkTokens: 10_000,
                historianTimeoutMs: 5_000,
                boundarySnapshot: snapshot,
                currentContextLimit: 128_000,
                directory: "/tmp/stale-refusal",
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

it(
    "refuses an eligibleEnd id change on a file-store session and rebuilds the ranks",
    () =>
        withFileStore(async (sessionId) => {
            const db = createDb();
            const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
            cleanups.push(
                () => logSpy.mockRestore(),
                () => closeQuietly(db),
            );
            const logged = () => logSpy.mock.calls.map((call) => call.slice(1).join(" "));
            await withReadOnlySessionDb(async (reader) => {
                expect(await prewarmRawSessionOrdinalsForDb(reader, sessionId)).toBe("warm");
            });

            // The trigger's snapshot names the wrong message at the eligible head's
            // last ordinal. That check never moves by itself, so the serving-thread
            // ranks are drifted: drop them and end the run without publishing.
            const snapshot = {
                ...createDefaultBoundarySnapshotForTests(sessionId),
                eligibleEndMessageId: "wrong-id",
                rawRangeFingerprint: "non-empty-so-validation-runs",
            };
            const prompts: string[] = [];
            await runHistorian(db, sessionId, snapshot, prompts);

            expect(prompts).toHaveLength(0);
            expect(getCompartments(db, sessionId)).toHaveLength(0);
            expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
            const runs = db
                .prepare(
                    "SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId) as { status?: string } | null;
            expect(runs?.status).toBe("noop");
            expect(
                logged().some((line) =>
                    line.includes(
                        "historian: refusing to publish over a stale protected-tail snapshot (was: eligibleEnd ordinal 7 id changed)",
                    ),
                ),
            ).toBe(true);
            expect(
                logged().some((line) =>
                    line.includes("historian: dropped drifted ordinal checkpoints"),
                ),
            ).toBe(true);

            // The next warm-up rebuilds the dropped ranks from a full scan on the
            // same connection: the count is exact without a restart.
            await withReadOnlySessionDb(async (reader) => {
                expect(await prewarmRawSessionOrdinalsForDb(reader, sessionId)).toBe("warm");
                expect(countRawSessionMessageOrdinalsFromDb(reader, sessionId)).toBe(12);
            });
        }),
    60_000,
);

/* The still-refreshes halves of the narrow rule — a `last` id change on a
 * file-store session, and any stale snapshot on a provider session — stay
 * covered by the restored refresh tests: the stale-tail test in
 * compartment-runner.test.ts, the live-prompt-floor-refresh tests and the
 * wrapup refresh test. */
