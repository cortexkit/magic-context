import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import {
    contextStore,
    fixture,
    hostStore,
    messageId,
    random,
    SESSION,
} from "../../features/magic-context/__tests__/host-stalls.fixture";
import {
    getHistorianFailureState,
    getOrCreateSessionMeta,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types";
import {
    type ProtectedTailBoundarySnapshot,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";
import {
    EXACT_ORDINAL_READ_DEFER_PASS_CAP,
    getExactOrdinalReadsStartedForTest,
    noteTransformPassForExactOrdinalReads,
    readExactRawMessageIdsOffThread,
    resetExactOrdinalReadsForTest,
    setExactOrdinalReadWorkerOptionsForTest,
    validateBoundarySnapshotOffThread,
} from "./raw-exact-ordinal-read";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import {
    getRawSessionMessageOrdinalCount,
    type RawMessageProvider,
    readRawSessionMessageIdOrdinalsForRange,
    readRawSessionMessageRange,
    withRawMessageProvider,
} from "./read-session-chunk";
import { closeReadOnlySessionDb, withReadOnlySessionDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import {
    getExactOrdinalScansOnThisThreadForTest,
    readRawSessionMessageIdOrdinalsForRangeFromDb,
    resetExactOrdinalScansOnThisThreadForTest,
} from "./read-session-raw";
import { computeRawRangeFingerprint } from "./read-session-true-raw-tokens";

const previousOpenCodeDb = process.env.OPENCODE_DB;
const SILENT_WORKER = new URL("./raw-ordinal-warmup-silent-worker.fixture.ts", import.meta.url);

afterEach(() => {
    resetExactOrdinalReadsForTest();
    resetRawSessionOrdinalWarmupsForTest();
    closeReadOnlySessionDb();
    if (previousOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previousOpenCodeDb;
});

/** Serve the session from an OpenCode 1 store file, with no registered provider. */
async function serveFromStoreFile(path: string): Promise<void> {
    process.env.OPENCODE_DB = path;
    closeReadOnlySessionDb();
    const outcome = await withReadOnlySessionDb((db) =>
        prewarmRawSessionOrdinalsForDb(db, SESSION, { acceptMs: 60_000, resultMs: 120_000 }),
    );
    expect(outcome).toBe("warm");
}

const exactIdAt = (ordinal: number): string | null =>
    readRawSessionMessageIdOrdinalsForRange(SESSION, ordinal, ordinal).keys().next().value ?? null;

/** A trigger-time snapshot of the current store, with the protected tail at the last `tail` messages. */
function snapshotAt(offset: number, tail = 3): ProtectedTailBoundarySnapshot {
    const count = getRawSessionMessageOrdinalCount(SESSION);
    const end = count - tail;
    return {
        sessionId: SESSION,
        mode: "incremental-runner",
        offset,
        offsetMessageId: exactIdAt(offset),
        protectedTailStart: end,
        protectedTailStartMessageId: exactIdAt(end),
        eligibleEndOrdinal: end,
        eligibleEndMessageId: exactIdAt(end - 1),
        rawMessageCountAtTrigger: count,
        rawLastMessageIdAtTrigger: exactIdAt(count),
        N: 0,
        usagePercentage: 50,
        usageInputTokens: 1000,
        usageSource: "live",
        contextLimit: 128_000,
        executeThresholdPercentage: 65,
        triggerBudget: 1000,
        priorBoundaryOrdinal: end,
        migrationFloorActive: false,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `test:${SESSION}`,
        createdAt: 0,
        rawRangeFingerprint: computeRawRangeFingerprint(
            readRawSessionMessageRange(SESSION, offset, end - 1),
            offset,
            end,
        ),
        trueRawEligibleTokens: 1000,
        summaryRemovedEligibleTokens: 1000,
        oversizeAtomicUnit: false,
        boundaryReason: "test-legacy",
    };
}

/** Stored compartments ending right before `offset`, as the runner derives its offset from them. */
function storePriorCompartment(db: Database, offset: number): void {
    db.prepare(
        "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES (?,0,1,?,?,?,'previous','summary',0)",
    ).run(SESSION, offset - 1, exactIdAt(1), exactIdAt(offset - 1));
}

it("worker ids equal synchronous exact reads on stores with summaries and malformed rows", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 1100, 2026);
    try {
        await serveFromStoreFile(path);
        const rng = random(41);
        const ordinals = [
            0,
            1,
            255,
            256,
            257,
            1100,
            1200,
            ...Array.from({ length: 24 }, () => 1 + Math.floor(rng() * 1150)),
        ];
        const answer = await readExactRawMessageIdsOffThread(SESSION, ordinals);
        expect(answer?.kind).toBe("ready");
        if (answer?.kind !== "ready") throw new Error("worker read did not answer");
        for (const ordinal of ordinals) {
            const synchronous =
                readRawSessionMessageIdOrdinalsForRangeFromDb(raw, SESSION, ordinal, ordinal)
                    .keys()
                    .next().value ?? null;
            expect([ordinal, answer.ids.get(ordinal)]).toEqual([ordinal, synchronous]);
        }
    } finally {
        raw.close();
        f.cleanup();
    }
});

it("off-thread boundary validation answers exactly as synchronous validation after interior edits", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 900, 7);
    const db = contextStore(join(f.dir, "context.db"));
    try {
        await serveFromStoreFile(path);
        const rng = random(0xc0ffee);
        const edits = [
            // Moves one row to the front: every later ordinal shifts by one.
            (index: number) =>
                raw.prepare("UPDATE message SET time_created=-1 WHERE id=?").run(messageId(index)),
            // Turns an ordinary row into an excluded finished summary.
            (index: number) =>
                raw
                    .prepare(
                        `UPDATE message SET data='{"role":"assistant","summary":true,"finish":"stop"}' WHERE id=?`,
                    )
                    .run(messageId(index)),
            (index: number) => raw.prepare("DELETE FROM message WHERE id=?").run(messageId(index)),
            // A rewrite that leaves the ordinal space unchanged.
            (index: number) =>
                raw
                    .prepare(`UPDATE message SET data='{"role":"user"}' WHERE id=?`)
                    .run(messageId(index)),
        ];
        const outcomes = new Set<string>();
        for (let round = 0; round < 12; round++) {
            await serveFromStoreFile(path);
            const offset = 1 + Math.floor(rng() * 300);
            db.prepare("DELETE FROM compartments WHERE session_id=?").run(SESSION);
            if (offset > 1) storePriorCompartment(db, offset);
            const snapshot = snapshotAt(offset, 2 + Math.floor(rng() * 20));
            if (round % 3 !== 0) edits[round % edits.length](Math.floor(rng() * 880));
            await serveFromStoreFile(path);
            const offThread = await validateBoundarySnapshotOffThread({ db, snapshot });
            expect(offThread.kind).toBe("validated");
            if (offThread.kind !== "validated") throw new Error("validation deferred");
            expect(offThread.result).toEqual(validateBoundarySnapshot({ db, snapshot }));
            outcomes.add(offThread.result.ok ? "ok" : (offThread.result.detail ?? "stale"));
        }
        // Both accepted and rejected snapshots were compared, not only one kind.
        console.log(JSON.stringify({ validationOutcomes: [...outcomes] }));
        expect(outcomes.has("ok")).toBe(true);
        expect(outcomes.size).toBeGreaterThan(1);
        expect(getExactOrdinalReadsStartedForTest()).toBe(12);
    } finally {
        db.close();
        raw.close();
        f.cleanup();
    }
});

it("concurrent requests share one outstanding read and a finished answer is never reused", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 120);
    try {
        await serveFromStoreFile(path);
        const first = readExactRawMessageIdsOffThread(SESSION, [60, 100]);
        const second = readExactRawMessageIdsOffThread(SESSION, [100, 60]);
        expect(second).toBe(first);
        // A different range while the session's read runs must not start a second scan.
        expect(await readExactRawMessageIdsOffThread(SESSION, [61])).toEqual({
            kind: "not-ready",
            reason: "read-outstanding",
        });
        const before = await first;
        expect(getExactOrdinalReadsStartedForTest()).toBe(1);
        expect(before).toEqual({
            kind: "ready",
            ids: new Map([
                [60, messageId(59)],
                [100, messageId(99)],
            ]),
        });
        // An interior move shifts both ordinals; the next request must see it.
        raw.prepare("UPDATE message SET time_created=-1 WHERE id=?").run(messageId(110));
        const after = await readExactRawMessageIdsOffThread(SESSION, [60, 100]);
        expect(getExactOrdinalReadsStartedForTest()).toBe(2);
        expect(after).toEqual({
            kind: "ready",
            ids: new Map([
                [60, messageId(58)],
                [100, messageId(98)],
            ]),
        });
    } finally {
        raw.close();
        f.cleanup();
    }
});

it("the pass cap releases a waiting read without starting another scan of the session", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 40);
    try {
        await serveFromStoreFile(path);
        setExactOrdinalReadWorkerOptionsForTest({ entry: SILENT_WORKER });
        const waiting = readExactRawMessageIdsOffThread(SESSION, [5]);
        for (let pass = 1; pass < EXACT_ORDINAL_READ_DEFER_PASS_CAP; pass++)
            noteTransformPassForExactOrdinalReads(SESSION);
        noteTransformPassForExactOrdinalReads("another-session");
        let settled = false;
        void waiting?.then(() => {
            settled = true;
        });
        await Bun.sleep(20);
        expect(settled).toBe(false);
        noteTransformPassForExactOrdinalReads(SESSION);
        expect(await waiting).toEqual({ kind: "not-ready", reason: "pass-cap" });
        // The released read still runs: the same ordinals are not served from it,
        // and no second worker starts while it does.
        expect(await readExactRawMessageIdsOffThread(SESSION, [5])).toEqual({
            kind: "not-ready",
            reason: "read-outstanding",
        });
        expect(getExactOrdinalReadsStartedForTest()).toBe(1);
    } finally {
        raw.close();
        f.cleanup();
    }
});

it("sessions without an OpenCode 1 store file keep their synchronous reads", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 10);
    try {
        await serveFromStoreFile(path);
        const provider: RawMessageProvider = { readMessages: () => [] };
        withRawMessageProvider(SESSION, provider, () => {
            expect(readExactRawMessageIdsOffThread(SESSION, [1])).toBeNull();
        });
        process.env.OPENCODE_DB = join(f.dir, "absent.db");
        closeReadOnlySessionDb();
        expect(readExactRawMessageIdsOffThread(SESSION, [1])).toBeNull();
        expect(getExactOrdinalReadsStartedForTest()).toBe(0);
    } finally {
        raw.close();
        f.cleanup();
    }
});

async function waitForOutstandingRead(): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt++) {
        if (getExactOrdinalReadsStartedForTest() > 0) return;
        await Bun.sleep(5);
    }
    throw new Error("the historian never requested its exact ordinal read");
}

it("historian start that is not ready defers without a failure, backoff or notice", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 80);
    const db = contextStore(join(f.dir, "context.db"));
    try {
        await serveFromStoreFile(path);
        storePriorCompartment(db, 40);
        const snapshot = snapshotAt(40);
        setExactOrdinalReadWorkerOptionsForTest({ entry: SILENT_WORKER });
        const clientCalls: string[] = [];
        const client = new Proxy(
            {},
            {
                get: (_target, key) => {
                    clientCalls.push(String(key));
                    return undefined;
                },
            },
        ) as HiddenCompartmentRunnerDeps["client"];
        const run = runCompartmentAgent({
            client,
            db,
            sessionId: SESSION,
            boundarySnapshot: snapshot,
            historianChunkTokens: 2000,
            directory: f.dir,
            memoryEnabled: false,
            forceDrainQuota: true,
        });
        await waitForOutstandingRead();
        for (let pass = 0; pass < EXACT_ORDINAL_READ_DEFER_PASS_CAP; pass++)
            noteTransformPassForExactOrdinalReads(SESSION);
        await run;
        expect(getHistorianFailureState(db, SESSION).failureCount).toBe(0);
        expect(loadProtectedTailMeta(db, SESSION).historianDrainFailureAt).toBeFalsy();
        expect(getOrCreateSessionMeta(db, SESSION).compartmentInProgress).toBe(false);
        expect(clientCalls).toEqual([]);
        expect(
            db
                .prepare("SELECT status, failure_reason FROM historian_runs WHERE session_id=?")
                .all(SESSION),
        ).toEqual([
            { status: "noop", failure_reason: "ordinals_not_ready: boundary validation pass-cap" },
        ]);
    } finally {
        db.close();
        raw.close();
        f.cleanup();
    }
});

/** Build a long session whose messages carry realistic metadata size. */
function longSessionStore(path: string, count: number): Database {
    const raw = hostStore(path, 0);
    const pad = "representative message metadata ".repeat(32);
    const insert = raw.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
    const part = raw.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
    raw.transaction(() => {
        for (let i = 0; i < count; i++) {
            insert.run(
                messageId(i),
                SESSION,
                i,
                i,
                JSON.stringify({ role: i % 2 ? "assistant" : "user", pad }),
            );
            if (i >= count - 200)
                part.run(
                    `part-${i}`,
                    messageId(i),
                    SESSION,
                    i,
                    i,
                    JSON.stringify({ type: "text", text: `meaningful source text ${i}` }),
                );
        }
    }).immediate();
    return raw;
}

/**
 * Historian boundary validation must not scan the session's ordinals on the
 * serving thread: those scans read every earlier message and froze the server
 * for seconds on long sessions. The scans are counted per thread (a worker has
 * its own copy of the counting module), so a zero here means every scan the
 * validation needed ran on the worker. The wall-clock block is measured only
 * under MC_PERF_GATE=1, on a long session, because timing bounds flake under
 * CI load; the counter is the guard.
 */
it("historian boundary validation runs no exact ordinal scan on the serving thread", async () => {
    const perfGate = process.env.MC_PERF_GATE === "1";
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const count = perfGate ? 120_000 : 2_000;
    const raw = longSessionStore(path, count);
    const db = contextStore(join(f.dir, "context.db"));
    try {
        await serveFromStoreFile(path);
        const offset = count - 150;
        storePriorCompartment(db, offset);
        // Building the snapshot reads exact ids synchronously on this thread, so
        // this also shows the counter sees serving-thread scans.
        resetExactOrdinalScansOnThisThreadForTest();
        const snapshot = snapshotAt(offset);
        expect(getExactOrdinalScansOnThisThreadForTest()).toBeGreaterThan(0);
        // The token counter loads its encoder on first use, once per process;
        // a serving process has long done that, so keep it out of the measure.
        estimateTokens("load the token encoder");
        let reachedProducer = false;
        let scansBeforeProducer = -1;
        const client = {
            session: {
                get: () => {
                    reachedProducer = true;
                    scansBeforeProducer = getExactOrdinalScansOnThisThreadForTest();
                    throw new Error("stop before creating a historian child session");
                },
            },
        } as unknown as HiddenCompartmentRunnerDeps["client"];
        let maxBlockMs = 0;
        let last = performance.now();
        const heartbeat = perfGate
            ? setInterval(() => {
                  const now = performance.now();
                  maxBlockMs = Math.max(maxBlockMs, now - last);
                  last = now;
              }, 1)
            : null;
        resetExactOrdinalScansOnThisThreadForTest();
        try {
            await runCompartmentAgent({
                client,
                db,
                sessionId: SESSION,
                boundarySnapshot: snapshot,
                historianChunkTokens: 2000,
                directory: f.dir,
                memoryEnabled: false,
                forceDrainQuota: true,
            });
            maxBlockMs = Math.max(maxBlockMs, performance.now() - last);
        } finally {
            if (heartbeat) clearInterval(heartbeat);
        }
        // Validation passed and the run went on to the producer, with the ids
        // it checked coming from exactly one worker read.
        expect(reachedProducer).toBe(true);
        expect(getExactOrdinalReadsStartedForTest()).toBe(1);
        expect(scansBeforeProducer).toBe(0);
        if (perfGate) {
            console.log(JSON.stringify({ messages: count, maxBlockMs }));
            expect(maxBlockMs).toBeLessThan(50);
        }
    } finally {
        db.close();
        raw.close();
        f.cleanup();
    }
}, 120_000);
