/// <reference types="bun-types" />

import { describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { reserveProtectedTailDrainTokens } from "../../features/magic-context/storage-meta-persisted";
import { getPrimerCandidatesForProject } from "../../features/magic-context/storage-primers";
import { getUserMemoryCandidates } from "../../features/magic-context/user-memory/storage-user-memory";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createV2RawMessageProvider, createV2RawMessageReader } from "../../v2/hooks/store";
import {
    getV2StoreReaderDebugCounters,
    RAW_MESSAGE_TYPES,
    resetV2StoreReaderDebugCounters,
    V2_MESSAGE_PAGE_SQL,
    V2StoreReader,
} from "../../v2/store-reader";
import { runCompartmentAgent } from "./compartment-runner";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import {
    type ProtectedTailBoundarySnapshot,
    resolveWrapupProtectedTailBoundary,
} from "./protected-tail-boundary";
import {
    readSessionChunk,
    setBoundedRawMessageProvider,
    setRawMessageProvider,
} from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function rawMessages(count: number): RawMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} with enough content` }],
    }));
}

function withProviderMessages<T>(
    sessionId: string,
    messages: RawMessage[],
    fn: () => Promise<T>,
): Promise<T> {
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => messages,
        getMessageCount: () => messages.length,
    });
    return fn().finally(unregister);
}

function withProvider<T>(sessionId: string, count: number, fn: () => Promise<T>): Promise<T> {
    return withProviderMessages(sessionId, rawMessages(count), fn);
}

function alternatingMessages(count: number): RawMessage[] {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${index + 1} ${text} ${text} ${text}` }],
    }));
}

function completedArcMessages(): RawMessage[] {
    return [
        {
            ordinal: 1,
            id: "m-1",
            role: "user",
            parts: [{ type: "text", text: "Inspect the failing flow." }],
        },
        {
            ordinal: 2,
            id: "m-2",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "wrapup-call",
                    state: { input: { path: "src/flow.ts" } },
                },
            ],
        },
        {
            ordinal: 3,
            id: "m-3",
            role: "user",
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "wrapup-call",
                    state: { output: "flow contents" },
                },
            ],
        },
        {
            ordinal: 4,
            id: "m-4",
            role: "assistant",
            parts: [{ type: "text", text: "Applied the fix." }],
        },
        {
            ordinal: 5,
            id: "m-5",
            role: "user",
            parts: [{ type: "text", text: "Keep this live tail." }],
        },
    ];
}

function historianXml(): string {
    return `<output>
<compartments>
<compartment start="1" end="1" title="Wrapped" episode_type="debug" importance="50">
<p1>Detailed wrapup.</p1><p2>Short wrapup.</p2><p3>Tiny wrapup.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Keep regression tests around wrapup promotion.
</PROJECT_RULES></facts>
<events>
<causal_incident at_compartment="1">
<summary>Wrapup promotion regression</summary>
<disposition>fixed</disposition>
</causal_incident>
</events>
<user_observations>
* User prefers regression tests for wrapup behavior.
</user_observations>
<primer_candidates>
<primer at_compartment="1">How does wrapup promotion work?</primer>
</primer_candidates>
<meta><messages_processed>1-1</messages_processed><unprocessed_from>2</unprocessed_from></meta>
</output>`;
}

function twoCompartmentHistorianXml(): string {
    return `<output>
<compartments>
<compartment start="1" end="2" title="First wrapped" episode_type="debug" importance="50">
<p1>First durable wrapup.</p1><p2>First.</p2><p3>First.</p3><p4>wrapup</p4>
</compartment>
<compartment start="3" end="4" title="Provisional wrapped" episode_type="debug" importance="50">
<p1>Provisional wrapup.</p1><p2>Provisional.</p2><p3>Prov.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Mid-loop wrapup facts must promote.
</PROJECT_RULES></facts>
<meta><messages_processed>1-4</messages_processed><unprocessed_from>5</unprocessed_from></meta>
</output>`;
}

function client(
    output = historianXml(),
    beforeHistorianCollect?: () => void,
): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/wrapup-runner" } })),
            create: mock(async () => ({ data: { id: `child-${Math.random()}` } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => {
                beforeHistorianCollect?.();
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: output }],
                        },
                    ],
                };
            }),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

function wrapupSnapshot(
    db: Database,
    sessionId: string,
    usagePercentage = 0,
): ProtectedTailBoundarySnapshot {
    return resolveWrapupProtectedTailBoundary({
        db,
        sessionId,
        mode: "manual-wrapup",
        contextLimit: 20,
        executeThresholdPercentage: 50,
        usage: { percentage: usagePercentage, inputTokens: 0 },
        usageSource: "test",
        providerShapeVersion: "test-v1",
        cacheNamespace: "test",
        messagesToKeep: 1,
    }).snapshot;
}

async function runWithLease(args: {
    db: Database;
    sessionId: string;
    snapshot: ProtectedTailBoundarySnapshot;
    forceKeepLastCompartment?: boolean;
    forceDrainQuota?: boolean;
    refreshBoundarySnapshot?: Parameters<typeof runCompartmentAgent>[0]["refreshBoundarySnapshot"];
    historianChunkTokens?: number;
    output?: string;
    beforeHistorianCollect?: () => void;
    memoryEnabled?: boolean;
}) {
    const holderId = `holder-${Math.random()}`;
    expect(acquireCompartmentLease(args.db, args.sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent(
            await prepareProducerFixture({
                client: client(args.output, args.beforeHistorianCollect),
                db: args.db,
                sessionId: args.sessionId,
                historianChunkTokens: args.historianChunkTokens ?? 10_000,
                historianTimeoutMs: 5_000,
                boundarySnapshot: args.snapshot,
                currentContextLimit: 20,
                directory: "/tmp/wrapup-runner",
                memoryEnabled: args.memoryEnabled ?? true,
                autoPromote: true,
                experimentalUserMemories: true,
                fallbackModels: [],
                compartmentLeaseHolderId: holderId,
                forceKeepLastCompartment: args.forceKeepLastCompartment,
                forceDrainQuota: args.forceDrainQuota,
                preserveInjectionCacheUntilConsumed: true,
                refreshBoundarySnapshot: args.refreshBoundarySnapshot,
            }),
        );
    } finally {
        clearProducerModelObservations();
        releaseCompartmentLease(args.db, args.sessionId, holderId);
    }
}

describe("runCompartmentAgent wrapup controls", () => {
    it("persists a forced final compartment but skips facts, user observations, and primers", async () => {
        const project = resolveProjectIdentity("/tmp/wrapup-runner");
        for (const forceKeepLastCompartment of [true, false]) {
            const db = createDb();
            const sessionId = `ses-force-${forceKeepLastCompartment}`;
            try {
                await withProvider(sessionId, 3, () =>
                    runWithLease({
                        db,
                        sessionId,
                        snapshot: wrapupSnapshot(db, sessionId),
                        forceKeepLastCompartment,
                        forceDrainQuota: true,
                    }),
                );

                expect(getCompartments(db, sessionId)).toHaveLength(1);
                if (forceKeepLastCompartment) {
                    expect(getMemoriesByProject(db, project)).toHaveLength(0);
                    expect(getUserMemoryCandidates(db)).toHaveLength(0);
                    expect(getPrimerCandidatesForProject(db, project)).toHaveLength(0);
                } else {
                    expect(getMemoriesByProject(db, project).length).toBeGreaterThan(0);
                }
                const row = db
                    .prepare(
                        "SELECT facts_emitted, events_emitted, facts_by_category_json FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                    )
                    .get(sessionId) as {
                    facts_emitted: number;
                    events_emitted: number;
                    facts_by_category_json: string;
                };
                expect(row.facts_emitted).toBe(1);
                expect(row.events_emitted).toBe(1);
                expect(JSON.parse(row.facts_by_category_json)).toEqual(
                    expect.objectContaining({
                        facts_promoted: forceKeepLastCompartment ? 0 : 1,
                        events_published: forceKeepLastCompartment ? 0 : 1,
                    }),
                );
            } finally {
                closeQuietly(db);
            }
        }
    });

    it("refuses to mint a compartment whose raw boundary disappeared during the historian run", async () => {
        const db = createDb();
        const sessionId = "ses-boundary-disappeared";
        const messages = rawMessages(3);
        const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        try {
            await withProviderMessages(sessionId, messages, () =>
                runWithLease({
                    db,
                    sessionId,
                    snapshot: wrapupSnapshot(db, sessionId),
                    forceKeepLastCompartment: true,
                    forceDrainQuota: true,
                    beforeHistorianCollect: () => {
                        messages.splice(0, 1);
                    },
                }),
            );

            expect(getCompartments(db, sessionId)).toHaveLength(0);
            expect(logSpy).toHaveBeenCalledWith(
                sessionId,
                expect.stringContaining(
                    "historian publish refused: sequence=0 side=start missing_id=m-1",
                ),
            );
            expect(logSpy).toHaveBeenCalledWith(
                sessionId,
                "historian output discarded: reason=dangling_boundary",
            );
            expect(logSpy).toHaveBeenCalledWith(
                sessionId,
                expect.stringContaining(
                    "historian publish stage: stage=dangling-boundary-check status=discarded elapsed=",
                ),
            );
        } finally {
            logSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("logs why the final weak-lookahead window skips unanchored promotion", async () => {
        const db = createDb();
        const sessionId = "ses-force-final-log";
        const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        try {
            await withProvider(sessionId, 3, () =>
                runWithLease({
                    db,
                    sessionId,
                    snapshot: wrapupSnapshot(db, sessionId),
                    forceKeepLastCompartment: true,
                    forceDrainQuota: true,
                }),
            );

            expect(logSpy).toHaveBeenCalledWith(
                sessionId,
                expect.stringContaining(
                    "historian unanchored promotion skipped: reason=weak_lookahead_final_compartment",
                ),
            );
        } finally {
            logSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("downgrades forced final keep on token-capped chunks so discard-last healing still applies", async () => {
        const db = createDb();
        const sessionId = "ses-force-mid-loop-has-more";
        const project = resolveProjectIdentity("/tmp/wrapup-runner");
        try {
            const messages = alternatingMessages(10);
            await withProviderMessages(sessionId, messages, async () => {
                const snapshot = {
                    ...wrapupSnapshot(db, sessionId),
                    protectedTailStart: 9,
                    protectedTailStartMessageId: "m-9",
                    eligibleEndOrdinal: 9,
                    eligibleEndMessageId: "m-8",
                    rawRangeFingerprint: "",
                    trueRawEligibleTokens: 1_000,
                };
                const chunk = readSessionChunk(sessionId, 220, 1, snapshot.eligibleEndOrdinal);
                expect(chunk.hasMore).toBe(true);
                expect(chunk.endIndex).toBeGreaterThanOrEqual(4);
                expect(chunk.endIndex).toBeLessThanOrEqual(6);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceKeepLastCompartment: true,
                    forceDrainQuota: true,
                    historianChunkTokens: 220,
                    output: twoCompartmentHistorianXml(),
                });
            });

            // The downgrade proof is the HEALING, not promotion: an un-downgraded
            // forced keep would persist BOTH compartments; the token-capped chunk
            // instead drops the provisional tail (discard-last), and the discarded
            // range re-reads next iteration. Promotion is skipped on discard-last
            // runs by long-standing design (unanchored facts would double-store on
            // the re-read), so no memories may appear here.
            expect(getCompartments(db, sessionId)).toHaveLength(1);
            expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(2);
            expect(getMemoriesByProject(db, project)).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("does not let wrapup discard-last reopen a completed invocation/result arc", async () => {
        const db = createDb();
        const sessionId = "ses-wrapup-discard-arc";
        try {
            await withProviderMessages(sessionId, completedArcMessages(), async () => {
                const snapshot = {
                    ...wrapupSnapshot(db, sessionId),
                    protectedTailStart: 5,
                    protectedTailStartMessageId: "m-5",
                    eligibleEndOrdinal: 5,
                    eligibleEndMessageId: "m-4",
                    rawRangeFingerprint: "",
                    trueRawEligibleTokens: 1_000,
                };
                const chunk = readSessionChunk(sessionId, 10_000, 1, 5);
                expect(chunk.completedToolArcs).toEqual([{ start: 2, end: 3 }]);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceDrainQuota: true,
                    output: twoCompartmentHistorianXml(),
                });
            });

            expect(
                getCompartments(db, sessionId).map((compartment) => compartment.endMessage),
            ).toEqual([2, 4]);
        } finally {
            closeQuietly(db);
        }
    });

    it("forceDrainQuota bypasses an exhausted protected-tail drain window", async () => {
        const db = createDb();
        const sessionId = "ses-quota-bypass";
        try {
            await withProvider(sessionId, 3, async () => {
                const snapshot = wrapupSnapshot(db, sessionId, 83);
                const usable = Math.max(
                    1,
                    Math.round((snapshot.contextLimit * snapshot.executeThresholdPercentage) / 100),
                );
                const perRunCap = 3;
                expect(
                    reserveProtectedTailDrainTokens({
                        db,
                        sessionId,
                        runId: "exhaust-window",
                        trueRawTokens: 9,
                        usagePercentage: snapshot.usagePercentage,
                        usable,
                        perRunCap,
                        executeThresholdPercentage: snapshot.executeThresholdPercentage,
                    }).ok,
                ).toBe(true);

                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    forceDrainQuota: true,
                });
            });
            expect(getCompartments(db, sessionId)).toHaveLength(1);
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps a 10K-row v2 post-historian publish bounded and closes every reader", async () => {
        const db = createDb();
        const sessionId = "ses-v2-post-historian";
        const root = mkdtempSync(join(tmpdir(), "mc-v2-post-historian-"));
        const storePath = join(root, "opencode.db");
        const store = new Database(storePath);
        const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
        try {
            store.exec(`
                CREATE TABLE session_message(
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE UNIQUE INDEX session_message_session_seq_idx
                    ON session_message(session_id, seq);
                CREATE INDEX session_message_session_type_seq_idx
                    ON session_message(session_id, type, seq);
            `);
            const insert = store.prepare(
                "INSERT INTO session_message VALUES (?, ?, 'user', ?, ?, ?, ?)",
            );
            store.transaction(() => {
                for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
                    const time = 1_800_000_000_000 + ordinal;
                    insert.run(
                        `message-${ordinal}`,
                        sessionId,
                        ordinal,
                        time,
                        time,
                        JSON.stringify({
                            text: `message ${ordinal} with enough content for the historian`,
                            time: { created: time },
                        }),
                    );
                }
            })();

            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 9_900,
                    startMessageId: "message-1",
                    endMessageId: "message-9900",
                    title: "Prior history",
                    content: "Previously published history.",
                },
            ]);
            const snapshot: ProtectedTailBoundarySnapshot = {
                sessionId,
                mode: "incremental-runner",
                offset: 9_901,
                offsetMessageId: "message-9901",
                protectedTailStart: 9_951,
                protectedTailStartMessageId: "message-9951",
                eligibleEndOrdinal: 9_951,
                eligibleEndMessageId: "message-9950",
                rawMessageCountAtTrigger: 10_000,
                rawLastMessageIdAtTrigger: "message-10000",
                N: 0,
                usagePercentage: 90,
                usageInputTokens: 90_000,
                usageSource: "test",
                contextLimit: 128_000,
                executeThresholdPercentage: 65,
                triggerBudget: 83_200,
                priorBoundaryOrdinal: 9_951,
                migrationFloorActive: false,
                providerShapeVersion: "opencode-v2",
                cacheNamespace: "test:v2-post-historian",
                createdAt: Date.now(),
                rawRangeFingerprint: "",
                trueRawEligibleTokens: 10_000,
                oversizeAtomicUnit: false,
                boundaryReason: "test",
            };
            const output = `<output><compartments><compartment start="9901" end="9950" title="New history" episode_type="debug" importance="50"><p1>Newly published history.</p1><p2>New history.</p2><p3>New.</p3><p4>history</p4></compartment></compartments><meta><messages_processed>9901-9950</messages_processed><unprocessed_from>9951</unprocessed_from></meta></output>`;

            resetV2StoreReaderDebugCounters({ captureQueries: true });
            const boundedReader = createV2RawMessageReader(() => new V2StoreReader(storePath));
            const unregister = setBoundedRawMessageProvider(
                sessionId,
                createV2RawMessageProvider(boundedReader, sessionId),
            );
            try {
                await runWithLease({
                    db,
                    sessionId,
                    snapshot,
                    historianChunkTokens: 10_000,
                    forceDrainQuota: true,
                    memoryEnabled: false,
                    output,
                });
            } finally {
                unregister();
            }
            // History embedding runs even with memory off. It is
            // fire-and-forget, so its "embeddings" stage log lands after the
            // publish returns; one macrotask lets that background step finish
            // (no provider is registered, so it does no embedding work).
            await new Promise((resolve) => setTimeout(resolve, 0));

            const counters = getV2StoreReaderDebugCounters();
            expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(9_950);
            expect(counters.operations.history).toBeUndefined();
            expect(counters.decodedRows).toBeLessThanOrEqual(110);
            expect(counters.operations.messageExistsById?.calls).toBe(2);
            expect(counters.operations.messageOrdinalById).toBeUndefined();
            expect(counters.openReaders).toBe(0);
            expect(counters.readersOpened).toBe(counters.readersClosed);
            expect(counters.maxOpenReaders).toBe(1);

            const stageLines = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => String(message));
            for (const stage of [
                "parse",
                "validate",
                "dangling-boundary-check",
                "post-publish-drops",
                "publish-txn",
                "embeddings",
            ]) {
                expect(
                    stageLines.some(
                        (line) =>
                            line.includes(`stage=${stage}`) &&
                            line.includes("status=completed") &&
                            line.includes("elapsed="),
                    ),
                ).toBe(true);
            }
            expect(stageLines.some((line) => line.includes("range=9901-9950"))).toBe(true);

            const rawTypes = [...RAW_MESSAGE_TYPES];
            const plan = store
                .prepare(`EXPLAIN QUERY PLAN ${V2_MESSAGE_PAGE_SQL}`)
                .all(
                    9_900,
                    sessionId,
                    ...rawTypes,
                    9_899,
                    sessionId,
                    ...rawTypes,
                    9_949,
                    Number.MAX_SAFE_INTEGER,
                    sessionId,
                    ...rawTypes,
                    32,
                ) as Array<{ detail: string }>;
            const sessionMessageSteps = plan
                .map((row) => row.detail)
                .filter((detail) => detail.includes("session_message"));
            expect(sessionMessageSteps.length).toBeGreaterThan(0);
            expect(sessionMessageSteps.every((detail) => detail.includes("SEARCH"))).toBe(true);
            expect(
                sessionMessageSteps.some((detail) => detail.includes("session_message_session")),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
            closeQuietly(store);
            closeQuietly(db);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses refreshBoundarySnapshot when the initial boundary snapshot is stale", async () => {
        const db = createDb();
        const sessionId = "ses-refresh-boundary";
        try {
            await withProvider(sessionId, 3, async () => {
                const fresh = wrapupSnapshot(db, sessionId);
                const stale = {
                    ...fresh,
                    rawMessageCountAtTrigger: 1,
                    rawLastMessageIdAtTrigger: "m-1",
                    rawRangeFingerprint: "stale-fingerprint",
                };
                const refresh = mock(() => fresh);
                await runWithLease({
                    db,
                    sessionId,
                    snapshot: stale,
                    forceDrainQuota: true,
                    refreshBoundarySnapshot: refresh,
                });
                expect(refresh).toHaveBeenCalled();
            });
            expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

it("persists progress past an ignored notice and reasoning-only head without consuming the protected tail", async () => {
    const db = createDb();
    const sessionId = "ses-filtered-noise-head";
    const messages = rawMessages(4);
    messages[1].parts = [
        {
            type: "text",
            text: "⏳ Context at 114% — Magic Context is comparting history…",
            ignored: true,
        },
    ];
    messages[2].role = "assistant";
    messages[2].parts = [{ type: "reasoning", text: "aborted thought" }];
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "m-1",
            endMessageId: "m-1",
            title: "Prior",
            content: "Prior content",
            p1: "Prior content",
        },
    ]);
    try {
        await withProviderMessages(sessionId, messages, async () => {
            expect(readSessionChunk(sessionId, 10_000, 2, 4).messageCount).toBe(0);
            const snapshot = {
                ...wrapupSnapshot(db, sessionId, 114),
                offset: 2,
                protectedTailStart: 4,
                eligibleEndOrdinal: 4,
                rawRangeFingerprint: "",
            };
            await runWithLease({ db, sessionId, snapshot, forceDrainQuota: true });
            expect(getLastCompartmentEndMessage(db, sessionId)).toBe(3);
            expect(getCompartments(db, sessionId)).toHaveLength(2);
            expect(wrapupSnapshot(db, sessionId, 114).offset).toBe(4);
            await runWithLease({
                db,
                sessionId,
                snapshot: { ...snapshot, offset: 4 },
                forceDrainQuota: true,
            });
            expect(getCompartments(db, sessionId)).toHaveLength(2);
            expect(readSessionChunk(sessionId, 10_000, 4, 5).text).toContain("message 4");
        });
    } finally {
        closeQuietly(db);
    }
});
