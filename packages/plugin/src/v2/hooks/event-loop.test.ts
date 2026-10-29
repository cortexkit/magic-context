import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as embedding from "../../features/magic-context/memory/embedding";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import {
    seedRetainedSession,
    snapshotSessionRows,
} from "../../features/magic-context/session-retention.fixture";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import * as sessionStorage from "../../features/magic-context/storage-meta-session";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import {
    tagIdentityRevisionKey,
    tagRevisionKey,
    tagTombstoneOwnerRange,
} from "../../features/magic-context/storage-tag-identity-revision";
import { autoSearchTestSnapshot } from "../../hooks/magic-context/auto-search-snapshot.fixture";
import { queueAutoSearchBackfill } from "../../hooks/magic-context/auto-search-worker-client";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as transformModule from "../../hooks/magic-context/transform";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import * as logger from "../../shared/logger";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { getWorkerShutdownStats } from "../../shared/worker-shutdown";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

type Event = { type: string; data: { sessionID: string } };
const sessionID = "ses-event-usage";
const succeeded: Event = { type: "session.execution.succeeded", data: { sessionID } };
const deleted: Event = { type: "session.deleted", data: { sessionID: "ses-deleted" } };

function aborted(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await delay(5);
    expect(predicate()).toBe(true);
}

function controlledBackoff(realRetries = 0) {
    const original = timers.setTimeout;
    const pending = new Set<() => void>();
    const clock = spyOn(timers, "setTimeout").mockImplementation(
        <T>(
            ms?: number,
            value?: T,
            options?: { signal?: AbortSignal; ref?: boolean },
        ): Promise<T> => {
            if (!options?.signal || realRetries-- > 0)
                return original(ms, value, options) as Promise<T>;
            const signal = options.signal;
            return new Promise<T>((resolve, reject) => {
                const finish = () => {
                    pending.delete(finish);
                    signal.removeEventListener("abort", abort);
                    resolve(value as T);
                };
                const abort = () => {
                    pending.delete(finish);
                    reject(new Error("backoff aborted"));
                };
                pending.add(finish);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            });
        },
    );
    return {
        pending: () => pending.size,
        async advance() {
            // Fire any armed retry, including one left behind by incorrect disposal.
            for (const finish of [...pending]) finish();
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        restore: () => clock.mockRestore(),
    };
}

async function fixture(
    stream: (signal: AbortSignal, subscription: number) => AsyncIterable<Event>,
    failDeletion = false,
) {
    const dir = createTestTempDir("mc-v2-event-loop-").dir;
    const oldEnv = {
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        OPENCODE_DB: process.env.OPENCODE_DB,
    };
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode2.db");
    resetOpenCodeDbPathStateForTesting();
    mkdirSync(join(dir, "opencode"));
    const hostDb = new Database(process.env.OPENCODE_DB);
    hostDb.exec(`
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT);
        INSERT INTO session_v2 VALUES ('${sessionID}', NULL, '${dir}');
    `);
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("throwaway store unavailable");
    getOrCreateSessionMeta(db, deleted.data.sessionID);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config: MagicContextConfigSchema.parse({
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
        }),
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const createGate = storageGate.createV2StorageGate;
    const gate = spyOn(storageGate, "createV2StorageGate").mockImplementation((options) =>
        createGate({ ...options, open: async () => db }),
    );
    const clearSessionLogState = mock(() => {
        if (failDeletion) throw new Error("injected deletion failure");
    });
    const fake = Object.assign(async () => {}, {
        getRustReplayParticipant: () => null,
        disposeRust: () => {},
        clearSessionLogState,
    });
    const transform = spyOn(transformModule, "createTransform").mockImplementation(
        () => fake as unknown as ReturnType<typeof transformModule.createTransform>,
    );
    const storageSet = mock(async (_key: string, _value: unknown) => {});
    const log = spyOn(logger, "log").mockImplementation(() => {});
    const sessionLog = spyOn(logger, "sessionLog");
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    const starts: number[] = [];
    const signals: AbortSignal[] = [];
    let duties: Awaited<ReturnType<typeof registerContext>>;
    const start = async () => {
        duties = await registerContext({
            location: { directory: dir },
            agent: { transform: async () => {}, reload: async () => {} },
            model: {
                list: () => [
                    {
                        providerID: "test-provider",
                        id: "test-model",
                        limit: { context: 200000, output: 32000 },
                    },
                ],
            },
            storage: { get: async () => undefined, set: storageSet },
            event: {
                subscribe: ({ signal }: { signal: AbortSignal }) => {
                    starts.push(Date.now());
                    signals.push(signal);
                    return stream(signal, starts.length);
                },
            },
            tool: { hook: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                interrupt: async () => ({}),
                hook: async (name: string, callback: typeof hook) => {
                    if (name === "context") hook = callback;
                },
                get: async () => ({ location: { directory: dir } }),
            },
        } as unknown as V2Context);
        await hook!({
            sessionID,
            model: { providerID: "test-provider", id: "test-model", limit: { context: 200000 } },
            agent: "build",
            system: [],
            options: {},
            tools: {},
            messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
        } as SessionContext);
        // The completion appears after the pre-generation pass, just as on the host.
        hostDb
            .prepare(
                "INSERT OR REPLACE INTO session_message VALUES (?, ?, 'assistant', 1, 1000, ?)",
            )
            .run(
                "a1",
                sessionID,
                JSON.stringify({
                    model: { providerID: "test-provider", id: "test-model" },
                    tokens: { input: 12345, output: 50, cache: { read: 0, write: 0 } },
                    time: { created: 1000, completed: 2000 },
                    finish: "stop",
                }),
            );
    };
    return {
        db,
        hostDb,
        starts,
        signals,
        start,
        log,
        sessionLog,
        clearSessionLogState,
        storageSet,
        dispose: async () => {
            await duties?.dispose();
            duties = undefined;
        },
        cleanup: async () => {
            await duties?.dispose();
            log.mockRestore();
            sessionLog.mockRestore();
            transform.mockRestore();
            gate.mockRestore();
            load.mockRestore();
            _resetDreamTimerForTests();
            closeDatabase();
            hostDb.close();
            resetCtxReduceRegisteredGloballyForTest();
            for (const [key, value] of Object.entries(oldEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            resetOpenCodeDbPathStateForTesting();
            cleanupTestTempDir(dir);
        },
    };
}

test("v2 session.deleted removes summaries, raw history, tag revisions and every seeded row", async () => {
    const ready = Promise.withResolvers<void>();
    let consumed = false;
    const f = await fixture(async function* () {
        await ready.promise;
        yield deleted;
        consumed = true;
    });
    const id = deleted.data.sessionID;
    const epochs = () =>
        f.db
            .prepare(
                "SELECT key FROM schema_migrations_meta WHERE key IN (?, ?) OR (key >= ? AND key < ?)",
            )
            .all(tagIdentityRevisionKey(id), tagRevisionKey(id), ...tagTombstoneOwnerRange(id));
    try {
        await f.start();
        seedRetainedSession(f.db, id, Date.now() - 25 * 60 * 60 * 1000);
        const before = snapshotSessionRows(f.db, id);
        expect(before.compartments).toHaveLength(40);
        expect(before.session_render_cache).toHaveLength(1);
        expect(before.session_meta_chunks.length).toBeGreaterThan(0);
        expect(before.session_meta_collection_revisions.length).toBeGreaterThan(0);
        expect(epochs().length).toBeGreaterThan(0);
        ready.resolve();
        await until(() => consumed);
        expect(epochs()).toEqual([]);
        for (const [table, rows] of Object.entries(snapshotSessionRows(f.db, id))) {
            expect(rows, `${table} retained deleted session data`).toEqual([]);
        }
    } finally {
        ready.resolve();
        await f.cleanup();
    }
});

for (const failDeletion of [false, true]) {
    test(`v2 records usage after ${failDeletion ? "a throwing" : "a normal"} deletion handler`, async () => {
        const ready = Promise.withResolvers<void>();
        let consumed = false;
        const f = await fixture(async function* () {
            await ready.promise;
            try {
                yield deleted;
                yield succeeded;
            } finally {
                consumed = true;
            }
        }, failDeletion);
        try {
            await f.start();
            expect(getOrCreateSessionMeta(f.db, sessionID).lastInputTokens).toBe(0);
            ready.resolve();
            await until(() => consumed);
            expect(
                getOrCreateSessionMeta(f.db, sessionID).lastInputTokens,
                JSON.stringify(f.sessionLog.mock.calls),
            ).toBe(12345);
            expect(f.starts).toHaveLength(1);
            expect(f.clearSessionLogState).toHaveBeenCalledTimes(1);
            const errors = f.log.mock.calls.filter(([message]) =>
                String(message).includes("event handler failed"),
            );
            expect(errors).toHaveLength(failDeletion ? 1 : 0);
            if (failDeletion)
                expect(errors[0]?.[0]).toContain("type=session.deleted, session=ses-deleted");
            else
                expect(
                    f.db
                        .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
                        .get(deleted.data.sessionID),
                ).toBeNull();
        } finally {
            ready.resolve();
            await f.cleanup();
        }
    });
}

for (const failure of ["end", "throw"] as const) {
    test(`v2 resubscribes with backoff after stream ${failure} and records usage`, async () => {
        const backoff = controlledBackoff(1);
        const ready = Promise.withResolvers<void>();
        let consumed = false;
        const f = await fixture(async function* (signal, subscription) {
            await ready.promise;
            if (subscription === 1) {
                if (failure === "throw") throw new Error("injected stream failure");
                return;
            }
            yield succeeded;
            consumed = true;
            await aborted(signal);
        });
        try {
            await f.start();
            ready.resolve();
            await until(() => consumed);
            expect(f.starts).toHaveLength(2);
            expect(f.starts[1]! - f.starts[0]!).toBeGreaterThanOrEqual(100);
            expect(
                getOrCreateSessionMeta(f.db, sessionID).lastInputTokens,
                JSON.stringify(f.sessionLog.mock.calls),
            ).toBe(12345);
            await f.dispose();
            expect(f.signals.every((signal) => signal.aborted)).toBe(true);
            await backoff.advance();
            expect(f.starts).toHaveLength(2);
        } finally {
            ready.resolve();
            await f.cleanup();
            backoff.restore();
        }
    });
}

test("v2 dispose cancels reconnect backoff before a replacement subscribes", async () => {
    const backoff = controlledBackoff();
    let ended = false;
    const f = await fixture(async function* () {
        ended = true;
        yield* [];
    });
    try {
        await f.start();
        await until(() => ended);
        await until(() => backoff.pending() > 0);
        await f.dispose();
        const previousStarts = f.starts.length;
        await f.start();
        expect(f.starts).toHaveLength(previousStarts + 1);
        expect(f.signals.slice(0, previousStarts).every((signal) => signal.aborted)).toBe(true);
        await until(() => backoff.pending() > 0);
        await f.dispose();
        await backoff.advance();
        expect(f.starts).toHaveLength(previousStarts + 1);
    } finally {
        await f.cleanup();
        backoff.restore();
    }
});

/** The deleted session's native-fold admission key; the in-memory cleanup removes it after the store clear. */
const deletedAdmissionKey = `native-fold/v2/${encodeURIComponent(deleted.data.sessionID)}`;

test("v2 deletion still runs its in-memory cleanup when the store clear is busy, and logs the error", async () => {
    const ready = Promise.withResolvers<void>();
    let consumed = false;
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const clear = spyOn(sessionStorage, "clearSession").mockImplementation(() => {
        throw busy;
    });
    const f = await fixture(async function* () {
        await ready.promise;
        try {
            yield deleted;
            yield succeeded;
        } finally {
            consumed = true;
        }
    });
    try {
        await f.start();
        ready.resolve();
        await until(() => consumed);
        expect(clear).toHaveBeenCalledWith(f.db, deleted.data.sessionID, false, true);
        // The cleanup after the store clear ran: it removes the fold admission key.
        expect(f.storageSet).toHaveBeenCalledWith(deletedAdmissionKey, null);
        // The store error was not swallowed: the event loop logged it.
        const errors = f.log.mock.calls.filter(([message]) =>
            String(message).includes("event handler failed"),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]?.[0]).toContain("type=session.deleted, session=ses-deleted");
        expect(errors[0]?.[1]).toBe(busy);
        // The usage event after the failed deletion was still handled.
        expect(getOrCreateSessionMeta(f.db, sessionID).lastInputTokens).toBe(12345);
    } finally {
        ready.resolve();
        clear.mockRestore();
        await f.cleanup();
    }
});

test("v2 deletion completes while the session's auto-search backfill is running", async () => {
    const ready = Promise.withResolvers<void>();
    let consumed = false;
    const f = await fixture(async function* () {
        await ready.promise;
        try {
            yield deleted;
            yield succeeded;
        } finally {
            consumed = true;
        }
    });
    const project = "git:v2-deleted-backfill";
    const initial = autoSearchTestSnapshot(project);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(initial);
    const query = spyOn(embedding, "embedTextForProject").mockResolvedValue({
        vector: new Float32Array([1, 0]),
        modelId: initial.modelId,
        chunkModelId: initial.chunkModelId,
        generation: 1,
    });
    const reached = Promise.withResolvers<void>();
    // The backfill worker waits for this batch with its writable connection open.
    const batch = spyOn(embedding, "embedBatchForProject").mockImplementation(() => {
        reached.resolve();
        return new Promise(() => {});
    });
    const before = getWorkerShutdownStats().get("auto-search") ?? { graceful: 0, forced: 0 };
    try {
        await f.start();
        insertMemory(f.db, {
            projectPath: project,
            category: "ARCHITECTURE_DECISIONS",
            content: "historian cache wiring details",
        });
        const backfill = queueAutoSearchBackfill(
            f.db,
            deleted.data.sessionID,
            project,
            "historian cache wiring",
        );
        await reached.promise;
        ready.resolve();
        await until(() => consumed);
        await backfill;
        const errors = f.log.mock.calls.filter(([message]) =>
            String(message).includes("event handler failed"),
        );
        expect(errors).toEqual([]);
        expect(
            f.db
                .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
                .get(deleted.data.sessionID),
        ).toBeNull();
        expect(f.storageSet).toHaveBeenCalledWith(deletedAdmissionKey, null);
        // Deleting the session closed the backfill worker's connection before the
        // store clear; the worker exited by itself rather than being terminated.
        await until(
            () => (getWorkerShutdownStats().get("auto-search")?.graceful ?? 0) > before.graceful,
        );
        expect(getWorkerShutdownStats().get("auto-search")?.forced ?? 0).toBe(before.forced);
    } finally {
        ready.resolve();
        snapshot.mockRestore();
        query.mockRestore();
        batch.mockRestore();
        await f.cleanup();
    }
});
