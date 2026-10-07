/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSessionCompactionMarkers } from "../../features/magic-context/compaction-marker";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import * as embeddingDrain from "../../features/magic-context/memory/single-store-embedding-drain";
import { runMigrations } from "../../features/magic-context/migrations";
import { ensureMuralRendered } from "../../features/magic-context/mural/render-trigger";
import {
    computeCueContentHash,
    setMuralCue,
} from "../../features/magic-context/mural/storage-mural-cues";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { getChannel2NudgeState, setChannel2NudgeState } from "../../features/magic-context/storage";
import {
    getDatabasePath,
    initializeDatabase,
    openDatabase,
} from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    addTrailingBlankDecisions,
    armThinkingBindingRecovery,
    getEmergencyRecoveryArmedAt,
    getMergedReasoningStrippedIds,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    getPersistedNoteNudge,
    getThinkingBindingRecoveryTarget,
    getTrailingBlankDecisions,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
    setPendingCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import {
    isRustMarkerAdmissionFenced,
    setRustMarkerAdmissionFence,
} from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import {
    scheduleOpenCodeTransformDecisionWrite,
    __test as transformDecisionTest,
} from "../../features/magic-context/transform-decision-log";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { ABSOLUTE_EMERGENCY_PERCENTAGE } from "../../shared/escalation-bands";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { promptSurfaceConfigIdentity } from "../../shared/prompt-surface";
import { createPromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import {
    Database,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type SqliteWriteLocker,
    startSqliteWriteLocker,
} from "../../shared/sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { deriveWindowGeometry } from "../../shared/window-geometry";
import { createCtxSearchTools } from "../../tools/ctx-search/tools";
import {
    applyDeferredCompactionMarker,
    type MarkerUpdateOutcome,
} from "./compaction-marker-manager";
import { primeCtxReduceSpawnPermission } from "./ctx-reduce-availability";
import { autoEmbedAttemptedBySession } from "./embed-session-state";
import {
    EmergencyFailClosedError,
    ENGINE_RECONNECTING_USER_MESSAGE,
} from "./emergency-fail-closed";
import { getVisibleMemoryIds } from "./inject-compartments";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "./lkg-measured-request";
import { createDbLkgPersistence, loadPersistedLkgSlot, saveLkgSlotToDb } from "./lkg-persist";
import { checkLkgDurability, readServedMarker } from "./lkg-served-marker";
import * as lkgSlot from "./lkg-slot";
import { getSlot, registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { MODULE_ORDINAL_PAGE_SIZE, MODULE_PAGE_MAX_BYTES } from "./module-wire";
import { moveInputs, persistedMoveInputs } from "./move-inputs";
import { clearNoteNudgeTriggerOnly } from "./note-nudger";
import { RawFallbackContextLimitError } from "./raw-fallback-context-limit";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    __rustModeTransformTest,
    applyNativeMessagesVerbatim,
    createRustModeTransform as createRustModeTransformImpl,
    RUST_EMERGENCY_WALL_PCT,
    RUST_FAILURE_PARK_THRESHOLD,
    RUST_PARK_PROBE_PRESSURE_BYPASS_PCT,
    RUST_PARK_RETRY_INTERVAL,
    type RustModeModuleClient,
} from "./rust-mode-transform";
import { StorageBusyRefusalError } from "./storage-busy-refusal";
import { buildSyntheticTodoPart } from "./todo-view";
import type { TransformDeps } from "./transform";
import { createTransform } from "./transform";
import type { MessageLike } from "./transform-operations";
import { reconcileMarkerRepresentation } from "./transform-postprocess-phase";

const createRustModeTransform = (
    deps: TransformDeps,
    options: Parameters<typeof createRustModeTransformImpl>[1],
) =>
    createRustModeTransformImpl(deps, {
        ...options,
        modulePageMaxBytes: 512 * 1024,
        scheduleLkgCapture: options.scheduleLkgCapture ?? ((capture) => capture()),
    });

const sessions: string[] = [];
const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
const availabilityDataHomes: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

type LegacySnapshotField = string | number | boolean | symbol;

function legacyMessageContentFields(
    value: unknown,
    fields: LegacySnapshotField[] = [],
): LegacySnapshotField[] {
    const tags = __rustModeTransformTest.snapshotTags;
    if (value === null) fields.push(tags.null);
    else if (typeof value === "string") fields.push(tags.string, value);
    else if (typeof value === "number") fields.push(tags.number, value);
    else if (typeof value === "boolean") fields.push(tags.boolean, value);
    else if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        fields.push(tags.undefined);
    } else if (Array.isArray(value)) {
        fields.push(tags.array, value.length);
        for (const item of value) legacyMessageContentFields(item, fields);
    } else if (typeof value === "object") {
        const entries = Object.entries(value).filter(
            ([, child]) =>
                child !== undefined && typeof child !== "function" && typeof child !== "symbol",
        );
        fields.push(tags.object, entries.length);
        for (const [key, child] of entries) {
            fields.push(tags.key, key);
            legacyMessageContentFields(child, fields);
        }
    } else fields.push(tags.undefined);
    return fields;
}

function sameSnapshotFields(
    left: readonly LegacySnapshotField[],
    right: readonly LegacySnapshotField[],
): boolean {
    return (
        left.length === right.length && left.every((field, index) => Object.is(field, right[index]))
    );
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function randomText(random: () => number, length: number): string {
    let text = "";
    for (let index = 0; index < length; index += 1) {
        text += String.fromCharCode(97 + Math.floor(random() * 26));
    }
    return text;
}

afterEach(() => {
    resetLkgSlotsForTest();
    __resetToolDefinitionMeasurements();
    closeReadOnlySessionDb();
    transformDecisionTest.reset();
    resetEmergencyRecoveryRegistryForTest();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const dataHome of availabilityDataHomes.splice(0)) {
        rmSync(dataHome, { recursive: true, force: true });
    }
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function makeDb(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    registerLkgPersistence(createDbLkgPersistence(db));
    return db;
}

function makeFileDb(): ContextDatabase {
    const directory = createTestTempDirFromPath(join(tmpdir(), "rust-mode-context-"));
    availabilityDataHomes.push(directory);
    const db = openDatabase(join(directory, "context.db")) as ContextDatabase | null;
    if (!db) throw new Error("file-backed test database did not open");
    databases.push(db);
    registerLkgPersistence(createDbLkgPersistence(db));
    return db;
}

function installRawProvider(sessionId: string): void {
    const row = {
        id: "m1",
        timeCreated: 1,
        contributesOrdinal: true,
        hasValidInfo: true,
    };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) =>
                !after || row.timeCreated > after.timeCreated || row.id > after.id
                    ? [row].slice(0, limit)
                    : [],
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

function makeMessages(sessionId: string): MessageLike[] {
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

function makeDeps(db: ContextDatabase, moduleClient: RustModeModuleClient): TransformDeps {
    return {
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
        liveModelBySession: new Map(
            sessions.map((sessionId) => [
                sessionId,
                { providerID: "test-provider", modelID: "test-model" },
            ]),
        ),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        // These fixtures assert the exact module calls a pass makes for the
        // authority protocol. Naming Broca keeps the historian pull loop, which an
        // unset runner builds on OpenCode, out of those call lists; the loop has
        // its own wiring tests.
        historianRunner: "broca",
    };
}

function makeMeta(
    db: ContextDatabase,
    sessionId: string,
): ReturnType<typeof getOrCreateSessionMeta> {
    const meta = getOrCreateSessionMeta(db, sessionId);
    const overflow = getOverflowState(db, sessionId);
    if (overflow.detectedContextLimit <= 0 && !overflow.needsEmergencyRecovery) {
        recordDetectedContextLimit(db, sessionId, 200_000, "test-provider/test-model");
    }
    recordToolDefinition("test-provider", "test-model", undefined, "read", "read fixture", {
        type: "object",
    });
    if (meta.systemPromptTokens <= 0) {
        updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
        meta.systemPromptTokens = 100;
    }
    return meta;
}

function installAvailabilityDb(sessionId: string, firstUserTools?: Record<string, unknown>): void {
    const dataHome = createTestTempDirFromPath(join(tmpdir(), "rust-mode-availability-"));
    availabilityDataHomes.push(dataHome);
    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const opencodeDb = new Database(dbPath);
    opencodeDb.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    if (firstUserTools !== undefined) {
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
                "availability-user",
                sessionId,
                1,
                1,
                JSON.stringify({ id: "availability-user", role: "user", tools: firstUserTools }),
            );
    }
    closeQuietly(opencodeDb);
    process.env.XDG_DATA_HOME = dataHome;
}

function authoritySeqMismatch(durableSeq: number): Error & {
    code: string;
} {
    const error = new Error(
        JSON.stringify({
            code: "authority_seq_mismatch",
            durable_authority_seq: durableSeq,
        }),
    ) as Error & { code: string };
    error.code = "authority_seq_mismatch";
    return error;
}

describe("Rust mode authority adapter", () => {
    function markerFaultFixture(
        fault:
            | "fence"
            | "after-marker"
            | "capture"
            | "bookkeeping"
            | "host-lock-capture"
            | "mirror"
            | "final-fit"
            | "os-cut",
        queueOldCapture = false,
        noCutOutcome?: MarkerUpdateOutcome,
        admissionEstimator?: Parameters<
            typeof createRustModeTransform
        >[1]["rawFallbackEstimatorForTests"],
        schedulerDecision = "execute",
        historianState = "idle",
    ) {
        const sid = `marker-admission-${fault}-${Date.now()}`;
        sessions.push(sid);
        installRawProvider(sid);
        installAvailabilityDb(sid);
        const oc = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.prepare("INSERT INTO message VALUES ('m1', ?, 1, 1, ?)").run(sid, '{"role":"user"}');
        oc.close();
        // Prime the host's WAL connection before taking its writer lock, so the
        // reverse-order probe fails at BEGIN, not during cold journal setup.
        if (fault === "host-lock-capture") listSessionCompactionMarkers(sid);
        let db = makeFileDb();
        const path = (
            db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>
        ).find((row) => row.name === "main")!.file;
        appendCompartments(db, sid, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "indexed",
                content: "indexed",
            },
        ]);
        registerLkgPersistence(createDbLkgPersistence(db));
        let step = 0;
        let fail = true;
        let captureCompleted = false;
        let deferRebuild = false;
        let hostLocker: SqliteWriteLocker | undefined;
        const markerOutcomes: MarkerUpdateOutcome[] = [];
        const queuedCaptures: Array<() => void> = [];
        const calls: string[] = [];
        const transformRequests: Record<string, unknown>[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                calls.push(method);
                if (method !== "transform") return { ok: true };
                transformRequests.push(body as Record<string, unknown>);
                step++;
                if (fault === "host-lock-capture" && fail && step === 2) {
                    hostLocker = await startSqliteWriteLocker(
                        join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"),
                        7_000,
                    );
                }
                captureCompleted = false;
                const oldRepresentation = step === 1 || (queueOldCapture && step === 2);
                return {
                    decision: deferRebuild || (queueOldCapture && step === 2) ? "SOFT+" : "HARD",
                    prefix_bust_permitted: !deferRebuild && !(queueOldCapture && step === 2),
                    scheduler_decision: queueOldCapture && step === 2 ? "defer" : schedulerDecision,
                    historian: { state: historianState },
                    row_version: step,
                    native_messages: oldRepresentation
                        ? makeMessages(sid)
                        : [
                              {
                                  info: { role: "user", sessionID: sid },
                                  parts: [
                                      {
                                          type: "text",
                                          text: "<session-history>new admitted prefix</session-history>",
                                          synthetic: true,
                                      },
                                  ],
                              },
                              ...makeMessages(sid),
                          ],
                    ...(!oldRepresentation
                        ? { committed: true, coverage_ordinal: 1, boundary_id: "m1#0" }
                        : {}),
                };
            },
        };
        let prepareSpy: ReturnType<typeof spyOn> | undefined;
        const build = () => {
            const originalPrepare = db.prepare.bind(db);
            prepareSpy = spyOn(db, "prepare").mockImplementation((sql) => {
                if (
                    fault === "fence" &&
                    fail &&
                    step >= 2 &&
                    String(sql).startsWith("UPDATE session_meta SET trailing_blank_decisions = ?")
                )
                    throw new Error("injected durable marker admission fence failure");
                if (
                    fault === "bookkeeping" &&
                    fail &&
                    step >= 2 &&
                    captureCompleted &&
                    String(sql).startsWith(
                        "SELECT detected_context_limit, detected_context_limit_model_key",
                    )
                ) {
                    if (noCutOutcome) fail = false;
                    throw new Error("injected late overflow bookkeeping failure");
                }
                if (
                    fault === "mirror" &&
                    fail &&
                    step >= 2 &&
                    String(sql).startsWith("UPDATE session_meta SET compaction_marker_state")
                ) {
                    throw new Error("injected post-cut context mirror failure");
                }
                return originalPrepare(sql);
            });
            const deps = makeDeps(db, moduleClient);
            deps.tagger = createTagger();
            deps.compactionMarkerStrategy = {
                applyDeferred: (...args) => {
                    expect(isRustMarkerAdmissionFenced(db, sid)).toBe(true);
                    const outcome = noCutOutcome ?? applyDeferredCompactionMarker(...args);
                    markerOutcomes.push(outcome);
                    if (fault === "os-cut" && fail && outcome.kind === "applied") {
                        const record = process.env.MC_RUST_MARKER_OS_CUT_RECORD;
                        if (!record) throw new Error("missing isolated crash record path");
                        writeFileSync(
                            record,
                            JSON.stringify({ sid, path, dataHome: process.env.XDG_DATA_HOME }),
                        );
                        process.kill(process.pid, "SIGKILL");
                    }
                    if (fault === "after-marker" && fail && outcome.kind === "applied")
                        throw new Error("injected after irreversible marker write");
                    return outcome;
                },
                reconcile: (...args) => {
                    reconcileMarkerRepresentation(...args);
                    if (fault === "final-fit" && fail && step >= 2) {
                        args[0].push({
                            info: { id: "over-limit", role: "user", sessionID: sid },
                            parts: [{ type: "text", text: "x".repeat(2_000_000) }],
                        } as MessageLike);
                    }
                },
            };
            return createRustModeTransform(deps, {
                moduleClient,
                rawFallbackEstimatorForTests: admissionEstimator,
                ...(queueOldCapture
                    ? {
                          scheduleLkgCapture: (capture: () => void) => {
                              queuedCaptures.push(capture);
                          },
                      }
                    : {}),
                onLkgCaptureForTests: () => {
                    if ((fault === "capture" || fault === "host-lock-capture") && fail && step >= 2)
                        throw new Error("injected priced LKG capture failure");
                    captureCompleted = true;
                },
            });
        };
        let transform = build();
        const invoke = async (output: { messages: unknown[] }) => {
            const input = makeMessages(sid);
            await transform.run(sid, input, output, makeMeta(db, sid));
        };
        const serve = async () => {
            const output = { messages: [...makeMessages(sid)] as unknown[] };
            await invoke(output);
            return JSON.stringify(output.messages);
        };
        return {
            sid,
            get db() {
                return db;
            },
            calls,
            transformRequests,
            markerOutcomes,
            serve,
            serveAliased: async () => {
                const input = makeMessages(sid);
                const output = { messages: input as unknown[] };
                await transform.run(sid, input, output, makeMeta(db, sid));
                return JSON.stringify(output.messages);
            },
            waitForHostLock: async () => {
                if (hostLocker) expect(await hostLocker.exited).toBe(0);
            },
            invoke,
            queuedCaptures,
            stopFault: () => {
                fail = false;
            },
            setDeferredRebuild: (deferred: boolean) => {
                deferRebuild = deferred;
            },
            restart: () => {
                transform.dispose();
                prepareSpy?.mockRestore();
                closeQuietly(db);
                resetLkgSlotsForTest();
                db = new Database(path) as ContextDatabase;
                databases.push(db);
                registerLkgPersistence(createDbLkgPersistence(db));
                transform = build();
            },
            dispose: () => {
                transform.dispose();
                prepareSpy?.mockRestore();
            },
        };
    }

    it("one shared rebuild drains while the historian is running", async () => {
        const fixture = markerFaultFixture(
            "capture",
            false,
            undefined,
            undefined,
            "defer",
            "running",
        );
        try {
            fixture.stopFault();
            await fixture.serve();
            const pending = { ordinal: 1, endMessageId: "m1", publishedAt: 1, injectAttempts: 3 };
            setPendingCompactionMarkerState(fixture.db, fixture.sid, pending);
            fixture.setDeferredRebuild(true);
            await fixture.serve();
            expect(getPendingCompactionMarkerState(fixture.db, fixture.sid)).toEqual(pending);
            expect(getPersistedCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
            expect(fixture.calls).not.toContain("session.flush");
            fixture.setDeferredRebuild(false);
            await fixture.serve();
            expect(
                getPersistedCompactionMarkerState(fixture.db, fixture.sid)?.boundaryOrdinal,
            ).toBe(1);
            expect(getPendingCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
        } finally {
            fixture.dispose();
        }
    });

    it("an error response cannot grant host authority even with true permission and native messages", async () => {
        const sessionId = `rust-error-permission-${Date.now()}`;
        sessions.push(sessionId);
        installRawProvider(sessionId);
        const db = makeDb();
        const pending = { ordinal: 1, endMessageId: "m1", publishedAt: 1, injectAttempts: 3 };
        setPendingCompactionMarkerState(db, sessionId, pending);
        let writes = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          status: "error",
                          decision: "HARD",
                          prefix_bust_permitted: true,
                          committed: true,
                          row_version: 7,
                          coverage_ordinal: 1,
                          boundary_id: "m1#0",
                          native_messages: [
                              {
                                  info: { role: "user", sessionID: sessionId },
                                  parts: [
                                      {
                                          type: "text",
                                          text: "<session-history>invalid response</session-history>",
                                          synthetic: true,
                                      },
                                  ],
                              },
                              ...makeMessages(sessionId),
                          ],
                      }
                    : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = createTagger();
        deps.compactionMarkerStrategy = {
            applyDeferred: () => {
                writes++;
                return { kind: "applied", markerOrdinal: 1 };
            },
            reconcile: reconcileMarkerRepresentation,
        };
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        await expect(
            transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(writes).toBe(0);
        expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
        transform.dispose();
    });

    it("a SOFT+ response that also claims prefix-bust permission is rejected before any host edit", async () => {
        // A defer (SOFT+) replays the provider's cached prefix byte for byte, so a
        // response that pairs it with permission to bust that prefix contradicts
        // itself. The host must treat it as a broken wire and grant nothing: no
        // compaction marker cut, and the queued marker target stays as it was.
        const sessionId = `rust-softplus-permission-${Date.now()}`;
        sessions.push(sessionId);
        installRawProvider(sessionId);
        const db = makeDb();
        const pending = { ordinal: 1, endMessageId: "m1", publishedAt: 1, injectAttempts: 3 };
        setPendingCompactionMarkerState(db, sessionId, pending);
        let writes = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: true,
                          committed: true,
                          row_version: 7,
                          coverage_ordinal: 1,
                          boundary_id: "m1#0",
                          native_messages: [
                              {
                                  info: { role: "user", sessionID: sessionId },
                                  parts: [
                                      {
                                          type: "text",
                                          text: "<session-history>contradictory response</session-history>",
                                          synthetic: true,
                                      },
                                  ],
                              },
                              ...makeMessages(sessionId),
                          ],
                      }
                    : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = createTagger();
        deps.compactionMarkerStrategy = {
            applyDeferred: () => {
                writes++;
                return { kind: "applied", markerOrdinal: 1 };
            },
            reconcile: reconcileMarkerRepresentation,
        };
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };
        let refusal: unknown;
        try {
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
        } catch (error) {
            refusal = error;
        }
        expect(writes).toBe(0);
        expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
        expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
        expect(JSON.stringify(output.messages)).not.toContain("contradictory response");
        expect(refusal).toBeInstanceOf(EmergencyFailClosedError);
        expect(String((refusal as { cause?: unknown }).cause)).toContain(
            "SOFT+ cannot permit a prefix bust",
        );
        transform.dispose();
    });

    it("supported false wire permission captures newest-tail replay while unsupported wire permission holds", async () => {
        for (const permission of [false, undefined, null, 1, "true", {}]) {
            const sessionId = `rust-wire-tail-${String(permission)}-${Date.now()}`;
            sessions.push(sessionId);
            installRawProvider(sessionId);
            const db = makeDb();
            const input = [
                ...makeMessages(sessionId),
                {
                    info: { id: "newest", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "already served tail" }],
                },
            ] as MessageLike[];
            input[0]!.info.model = { providerID: "anthropic", modelID: "mock-sonnet" };
            input[1]!.info.providerID = "anthropic";
            input[1]!.info.modelID = "mock-sonnet";
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) =>
                    method === "transform"
                        ? {
                              decision: "SOFT+",
                              ...(permission === undefined
                                  ? {}
                                  : { prefix_bust_permitted: permission }),
                              row_version: 1,
                              native_messages: structuredClone(input),
                          }
                        : { ok: true },
            };
            const deps = makeDeps(db, moduleClient);
            deps.liveModelBySession?.set(sessionId, {
                providerID: "anthropic",
                modelID: "mock-sonnet",
            });
            deps.getModelKey = () => "anthropic/mock-sonnet";
            const transform = createRustModeTransform(deps, { moduleClient });
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(getTrailingBlankDecisions(db, sessionId).get("newest")).toBe(
                permission === false ? "strip" : undefined,
            );
            expect(output.messages).toEqual(input);
            transform.dispose();
        }
    });

    it("all host first applications hold without an actual boolean permission", async () => {
        for (const wireValue of [undefined, null, false, 1, "true", "false", {}]) {
            const sessionId = `rust-permission-${String(wireValue)}-${Date.now()}`;
            sessions.push(sessionId);
            installRawProvider(sessionId);
            const db = makeDb();
            const pending = {
                ordinal: 1,
                endMessageId: "m1",
                publishedAt: 1,
                injectAttempts: 3,
                lastInjectError: "locked",
                firstInjectFailedAt: 1,
            };
            setPendingCompactionMarkerState(db, sessionId, pending);
            let writes = 0;
            const calls: string[] = [];
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) => {
                    calls.push(method);
                    if (method !== "transform") return { ok: true };
                    return {
                        decision: "HARD",
                        scheduler_decision: "execute",
                        committed: true,
                        ...(wireValue === undefined ? {} : { prefix_bust_permitted: wireValue }),
                        row_version: 7,
                        coverage_ordinal: 1,
                        boundary_id: "m1#0",
                        native_messages: [
                            {
                                info: { role: "user", sessionID: sessionId },
                                parts: [
                                    {
                                        type: "text",
                                        text: "<session-history>stable</session-history>",
                                        synthetic: true,
                                    },
                                ],
                            },
                            ...makeMessages(sessionId),
                        ],
                    };
                },
            };
            const deps = makeDeps(db, moduleClient);
            deps.tagger = createTagger();
            deps.compactionMarkerStrategy = {
                applyDeferred: () => {
                    writes++;
                    return { kind: "applied", markerOrdinal: 1 };
                },
                reconcile: reconcileMarkerRepresentation,
            };
            const transform = createRustModeTransform(deps, { moduleClient });
            const input = makeMessages(sessionId);
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            expect(writes).toBe(0);
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
            expect(calls).not.toContain("session.flush");
            expect(getSlot(sessionId)).toBeDefined();
            setRustMarkerAdmissionFence(db, sessionId, true);
            await expect(
                transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(isRustMarkerAdmissionFenced(db, sessionId)).toBe(true);
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
            transform.dispose();
        }
    });

    it.skipIf(process.env.MC_RUST_MARKER_OS_CUT_CHILD !== "1")("marker OS cut child", async () => {
        const fixture = markerFaultFixture("os-cut", false, undefined, undefined, "defer");
        await fixture.serve();
        await fixture.serve();
        throw new Error("the crash probe did not reach the committed host cut");
    });

    it("defer HARD failed admission remains fenced across restart", async () => {
        for (const fault of [
            "after-marker",
            "capture",
            "bookkeeping",
            "mirror",
            "final-fit",
        ] as const) {
            const fixture = markerFaultFixture(fault, false, undefined, undefined, "defer");
            try {
                await fixture.serve();
                await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
                expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(1);
                if (fault === "mirror")
                    expect(getPersistedCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
                else
                    expect(
                        getPersistedCompactionMarkerState(fixture.db, fixture.sid)?.boundaryOrdinal,
                    ).toBe(1);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
                fixture.restart();
                expect(getSlot(fixture.sid)).toBeUndefined();
                fixture.setDeferredRebuild(true);
                fixture.stopFault();
                await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
                fixture.setDeferredRebuild(false);
                expect(await fixture.serve()).toContain("new admitted prefix");
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            } finally {
                fixture.dispose();
            }
        }
        const home = createTestTempDirFromPath(join(tmpdir(), "marker-os-cut-"));
        const recordPath = join(home, "crash.json");
        const child = spawnSync(
            process.execPath,
            ["test", import.meta.path, "-t", "marker OS cut child"],
            {
                env: {
                    ...process.env,
                    MC_RUST_MARKER_OS_CUT_CHILD: "1",
                    MC_RUST_MARKER_OS_CUT_RECORD: recordPath,
                },
                encoding: "utf8",
                timeout: 30_000,
                windowsHide: true,
            },
        );
        expect(child.signal).toBe("SIGKILL");
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
            sid: string;
            path: string;
            dataHome: string;
        };
        sessions.push(record.sid);
        availabilityDataHomes.push(record.dataHome, home, dirname(record.path));
        process.env.XDG_DATA_HOME = record.dataHome;
        installRawProvider(record.sid);
        const recoveredDb = new Database(record.path) as ContextDatabase;
        databases.push(recoveredDb);
        registerLkgPersistence(createDbLkgPersistence(recoveredDb));
        expect(listSessionCompactionMarkers(record.sid)).toHaveLength(1);
        expect(isRustMarkerAdmissionFenced(recoveredDb, record.sid)).toBe(true);
        expect(loadPersistedLkgSlot(recoveredDb, record.sid)).toBeUndefined();
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "HARD",
                          prefix_bust_permitted: true,
                          committed: true,
                          row_version: 3,
                          coverage_ordinal: 1,
                          boundary_id: "m1#0",
                          native_messages: [
                              {
                                  info: { role: "user", sessionID: record.sid },
                                  parts: [
                                      {
                                          type: "text",
                                          text: "<session-history>new admitted prefix</session-history>",
                                          synthetic: true,
                                      },
                                  ],
                              },
                              ...makeMessages(record.sid),
                          ],
                      }
                    : { ok: true },
        };
        const deps = makeDeps(recoveredDb, moduleClient);
        deps.tagger = createTagger();
        const transform = createRustModeTransform(deps, { moduleClient });
        try {
            const input = makeMessages(record.sid);
            await transform.run(
                record.sid,
                input,
                { messages: [...input] },
                makeMeta(recoveredDb, record.sid),
            );
            expect(isRustMarkerAdmissionFenced(recoveredDb, record.sid)).toBe(false);
            expect(loadPersistedLkgSlot(recoveredDb, record.sid)?.jsonPrefix).toContain(
                "new admitted prefix",
            );
        } finally {
            transform.dispose();
        }
    });

    // Allow time for the separate process's seven-second SQLite write lock to release.
    it("a busy host cut followed by priced capture failure retains still-safe LKG across restart", async () => {
        const fixture = markerFaultFixture(
            "host-lock-capture",
            false,
            undefined,
            undefined,
            "defer",
        );
        try {
            const old = await fixture.serve();
            expect(await fixture.serveAliased()).toBe(old);
            expect(fixture.markerOutcomes.at(-1)).toMatchObject({
                kind: "retryable-failure",
                cut: "definitely-no-cut",
            });
            expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(0);
            expect(getPersistedCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(old);
            await fixture.waitForHostLock();
            fixture.restart();
            expect(getSlot(fixture.sid)?.jsonPrefix).toBe(old);
            fixture.stopFault();
            expect(await fixture.serve()).toContain("new admitted prefix");
        } finally {
            await fixture.waitForHostLock();
            fixture.dispose();
        }
    }, 30_000);

    for (const outcome of [
        { kind: "already-current" },
        { kind: "stale-skip", reason: "partial-message-boundary" },
    ] as const) {
        it(`a definitely unchanged ${outcome.kind} cut preserves old LKG after later capture failure`, async () => {
            const fixture = markerFaultFixture("capture", false, outcome);
            try {
                const old = await fixture.serve();
                expect(await fixture.serve()).toBe(old);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(old);
            } finally {
                fixture.dispose();
            }
        });
    }

    it("a proven no-cut bookkeeping fault restores the old durable slot after a newer capture persisted", async () => {
        const fixture = markerFaultFixture("bookkeeping", false, { kind: "already-current" });
        try {
            const old = await fixture.serve();
            expect(await fixture.serve()).toBe(old);
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(old);
            fixture.restart();
            expect(getSlot(fixture.sid)?.jsonPrefix).toBe(old);
        } finally {
            fixture.dispose();
        }
    });

    it("an uncertain strategy failure never revives quarantined LKG even without a visible marker", async () => {
        const fixture = markerFaultFixture("capture", false, {
            kind: "retryable-failure",
            error: new Error("strategy cannot prove its commit outcome"),
        });
        try {
            await fixture.serve();
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
            fixture.restart();
            expect(getSlot(fixture.sid)).toBeUndefined();
        } finally {
            fixture.dispose();
        }
    });

    for (const fault of ["after-marker", "capture", "bookkeeping"] as const) {
        it(`post-cut ${fault} fault refuses instead of old replay, then recomposes successfully`, async () => {
            const fixture = markerFaultFixture(fault);
            try {
                const old = await fixture.serve();
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeDefined();
                await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
                expect(
                    getPersistedCompactionMarkerState(fixture.db, fixture.sid)?.boundaryOrdinal,
                ).toBe(1);
                expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(1);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
                fixture.stopFault();
                const rebuilt = await fixture.serve();
                expect(rebuilt).not.toBe(old);
                expect(rebuilt).toContain("new admitted prefix");
                expect(fixture.calls).toContain("session.flush");
                expect(fixture.transformRequests.at(-1)?.tail_delta).toBeUndefined();
                expect(fixture.transformRequests.at(-1)?.native_messages).toEqual(
                    makeMessages(fixture.sid),
                );
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(rebuilt);
            } finally {
                fixture.dispose();
            }
        });
    }

    it("a failed durable admission fence prevents the host cut and preserves restart-safe old LKG", async () => {
        const fixture = markerFaultFixture("fence");
        try {
            const old = await fixture.serve();
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(getPersistedCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
            expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(0);
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(old);
            fixture.restart();
            expect(getSlot(fixture.sid)?.jsonPrefix).toBe(old);
            fixture.stopFault();
            expect(await fixture.serve()).toContain("new admitted prefix");
        } finally {
            fixture.dispose();
        }
    });

    it("a post-cut SOFT+ response cannot release the refusal fence even with committed execute metadata", async () => {
        const fixture = markerFaultFixture("capture");
        try {
            await fixture.serve();
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            fixture.stopFault();
            fixture.setDeferredRebuild(true);
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
            fixture.setDeferredRebuild(false);
            expect(await fixture.serve()).toContain("new admitted prefix");
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
        } finally {
            fixture.dispose();
        }
    });

    it("persistent post-cut capture faults refuse every rebuilding pass without old LKG or raw fallback", async () => {
        const fixture = markerFaultFixture("capture");
        try {
            await fixture.serve();
            for (let pass = 0; pass < 4; pass++) {
                await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
                expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
            }
            fixture.stopFault();
            expect(await fixture.serve()).toContain("new admitted prefix");
        } finally {
            fixture.dispose();
        }
    });

    it("post-cut outer storage-busy wrapper cannot replay old bytes and re-arms rebuilding admission", async () => {
        const fixture = markerFaultFixture("after-marker");
        try {
            await fixture.serve();
            fixture.stopFault();
            const replayed = mock(() => {});
            const wrapper = createMessagesTransformHandler({
                magicContext: {
                    "experimental.chat.messages.transform": async (_input, output) => {
                        await fixture.invoke(output);
                        throw Object.assign(new Error("outer post-cut storage failure"), {
                            code: "SQLITE_BUSY",
                        });
                    },
                },
                onLkgReplay: replayed,
            });
            const output = { messages: makeMessages(fixture.sid) };
            await expect(wrapper({}, output)).rejects.toBeInstanceOf(StorageBusyRefusalError);
            expect(replayed).not.toHaveBeenCalled();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
            expect(await fixture.serve()).toContain("new admitted prefix");
        } finally {
            fixture.dispose();
        }
    });

    it("post-cut refusal fence survives a new adapter and file connection without hydrating old LKG", async () => {
        const fixture = markerFaultFixture("capture");
        try {
            await fixture.serve();
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            fixture.restart();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
            expect(getSlot(fixture.sid)).toBeUndefined();
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            fixture.stopFault();
            expect(await fixture.serve()).toContain("new admitted prefix");
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
        } finally {
            fixture.dispose();
        }
    });

    it("a queued pre-cut defer capture cannot resurrect old LKG after a marker fault", async () => {
        const fixture = markerFaultFixture("after-marker", true);
        try {
            const old = await fixture.serve();
            expect(await fixture.serve()).toBe(old);
            expect(fixture.queuedCaptures).toHaveLength(1);
            await expect(fixture.serve()).rejects.toBeInstanceOf(EmergencyFailClosedError);
            fixture.queuedCaptures[0]!();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(true);
            expect(
                (
                    fixture.db
                        .prepare("SELECT count(*) AS n FROM lkg_slots WHERE session_id=?")
                        .get(fixture.sid) as { n: number }
                ).n,
            ).toBe(0);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)).toBeUndefined();
            fixture.stopFault();
            expect(await fixture.serve()).toContain("new admitted prefix");
        } finally {
            fixture.dispose();
        }
    });
    it("r2 proof: a rejected HARD output cannot move the host marker before LKG replay", async () => {
        const sid = `r2-rejected-hard-${Date.now()}`;
        sessions.push(sid);
        installRawProvider(sid);
        installAvailabilityDb(sid);
        const oc = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.prepare("INSERT INTO message VALUES ('m1', ?, 1, 1, ?)").run(sid, '{"role":"user"}');
        oc.close();
        const db = makeDb();
        appendCompartments(db, sid, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "indexed",
                content: "indexed",
            },
        ]);
        let step = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                step++;
                return {
                    decision: "HARD",
                    scheduler_decision: "execute",
                    prefix_bust_permitted: true,
                    row_version: step,
                    native_messages: makeMessages(sid),
                    ...(step === 2
                        ? { committed: true, coverage_ordinal: 1, boundary_id: "m1#0" }
                        : {}),
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = createTagger();
        const transform = createRustModeTransform(deps, { moduleClient });
        const serve = async () => {
            const input = makeMessages(sid);
            const output = { messages: [...input] as unknown[] };
            await transform.run(sid, input, output, makeMeta(db, sid));
            return JSON.stringify(output.messages);
        };
        // Each call recreates raw input, output and session metadata to compare the
        // last-known-good request (LKG) without reusing messages edited by the previous pass.
        const first = await serve();
        expect(await serve()).toBe(first);
        expect(transform.getState(sid).lkgRepresentationFrozen).toBe(true);
        expect(getPersistedCompactionMarkerState(db, sid)).toBeNull();
        expect(listSessionCompactionMarkers(sid)).toHaveLength(0);
        expect(isRustMarkerAdmissionFenced(db, sid)).toBe(false);
    });

    it("serves a rebuilding output above the fixed prompt floor without cutting, then cuts when room returns", async () => {
        const fixture = markerFaultFixture("capture");
        const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            fixture.stopFault();
            await fixture.serve();
            updateSessionMeta(fixture.db, fixture.sid, { systemPromptTokens: 1_000 });
            recordDetectedContextLimit(fixture.db, fixture.sid, 1_000, "test-provider/test-model");
            recordToolDefinition(
                "test-provider",
                "test-model",
                undefined,
                "large-tool",
                "schema ".repeat(1_000),
                {
                    type: "object",
                },
            );

            // The fixed system/tool floor exceeds this window even after the engine folds.
            // Failure to admit an optional host cut must not reject the fresh engine output.
            const served = await fixture.serve();
            expect(served).toContain("new admitted prefix");
            expect(fixture.markerOutcomes).toHaveLength(0);
            expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(0);
            expect(getPersistedCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            expect(loadPersistedLkgSlot(fixture.db, fixture.sid)?.jsonPrefix).toBe(served);
            const pending = getPendingCompactionMarkerState(fixture.db, fixture.sid);
            expect(pending).toMatchObject({ ordinal: 1, endMessageId: "m1" });
            const deferrals = log.mock.calls.filter((call) =>
                String(call[1]).startsWith("rust compaction-marker admission deferred:"),
            );
            expect(deferrals).toHaveLength(1);
            expect(deferrals[0]?.[1]).toContain("fit=over");
            expect(deferrals[0]?.[1]).toContain("limit=1000");
            expect(deferrals[0]?.[1]).toMatch(/estimated=\d+ trusted=true proxy_tokens=\d+/);

            fixture.setDeferredRebuild(true);
            expect(await fixture.serve()).toContain("new admitted prefix");
            expect(getPendingCompactionMarkerState(fixture.db, fixture.sid)).toEqual(pending);
            expect(fixture.markerOutcomes).toHaveLength(0);

            recordDetectedContextLimit(
                fixture.db,
                fixture.sid,
                200_000,
                "test-provider/test-model",
            );
            fixture.setDeferredRebuild(false);
            expect(await fixture.serve()).toContain("new admitted prefix");
            expect(fixture.markerOutcomes.at(-1)?.kind).toBe("applied");
            expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(1);
            expect(getPendingCompactionMarkerState(fixture.db, fixture.sid)).toBeNull();
            expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
        } finally {
            log.mockRestore();
            fixture.dispose();
        }
    });
    for (const unavailable of ["untrusted", "throwing"] as const) {
        it(`serves fresh output and retains the pending cut with an ${unavailable} admission estimate`, async () => {
            const fixture = markerFaultFixture("capture", false, undefined, () => {
                if (unavailable === "throwing") throw new Error("tokenizer unavailable");
                return {
                    tokens: 1,
                    trusted: false,
                    messageTokens: { conversation: 1, toolCall: 0 },
                    systemTokens: 0,
                };
            });
            try {
                fixture.stopFault();
                await fixture.serve();
                expect(await fixture.serve()).toContain("new admitted prefix");
                expect(fixture.markerOutcomes).toHaveLength(0);
                expect(getPendingCompactionMarkerState(fixture.db, fixture.sid)?.ordinal).toBe(1);
                expect(listSessionCompactionMarkers(fixture.sid)).toHaveLength(0);
                expect(isRustMarkerAdmissionFenced(fixture.db, fixture.sid)).toBe(false);
            } finally {
                fixture.dispose();
            }
        });
    }
    it("retains pending indexed markers while a healthy SOFT+ serves the frozen representation", async () => {
        const sessionId = `rust-frozen-marker-${Date.now()}`;
        sessions.push(sessionId);
        installRawProvider(sessionId);
        installAvailabilityDb(sessionId);
        const oc = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.prepare("INSERT INTO message VALUES ('m1', ?, 1, 1, ?)").run(
            sessionId,
            '{"role":"user"}',
        );
        oc.close();
        const db = makeDb();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                startBlockIndex: 0,
                endBlockIndex: 0,
                title: "indexed",
                content: "indexed",
            },
        ]);
        let step = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                step++;
                if (step === 2) throw new Error("module temporarily unavailable");
                return {
                    decision: step === 1 || step === 5 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: step === 1 || step === 5,
                    scheduler_decision: step === 1 || step === 5 ? "execute" : "defer",
                    row_version: step,
                    ...(step === 5 ? { coverage_ordinal: 1, boundary_id: "m1#0" } : {}),
                    native_messages: [
                        ...(step === 5
                            ? [
                                  {
                                      info: { role: "user", sessionID: sessionId },
                                      parts: [
                                          {
                                              type: "text",
                                              text: "<session-history>indexed</session-history>",
                                              synthetic: true,
                                          },
                                      ],
                                  },
                              ]
                            : []),
                        ...makeMessages(sessionId),
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = createTagger();
        const transform = createRustModeTransform(deps, { moduleClient });
        const serve = async () => {
            const input = makeMessages(sessionId);
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            return JSON.stringify(output.messages);
        };
        const first = await serve();
        await serve();
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        const pending = { ordinal: 1, endMessageId: "m1", publishedAt: 1 };
        setPendingCompactionMarkerState(db, sessionId, pending);
        for (let pass = 0; pass < 2; pass++) {
            expect(await serve()).toBe(first);
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(getPersistedCompactionMarkerState(db, sessionId)).toBeNull();
        }
        await serve();
        expect(getPendingCompactionMarkerState(db, sessionId)).toBeNull();
        expect(getPersistedCompactionMarkerState(db, sessionId)?.boundaryOrdinal).toBe(1);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
    });
    it("frozen SOFT+ holds retained markers beyond the former bounded release", async () => {
        const sessionId = `rust-local-release-marker-${Date.now()}`;
        sessions.push(sessionId);
        installRawProvider(sessionId);
        installAvailabilityDb(sessionId);
        const db = makeDb();
        const pending = { ordinal: 1, endMessageId: "m1", publishedAt: 1, injectAttempts: 3 };
        const native = [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>stable</session-history>",
                        synthetic: true,
                    },
                ],
            },
            ...makeMessages(sessionId),
        ];
        let step = 0;
        let writes = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (++step === 2) throw new Error("module temporarily unavailable");
                return {
                    decision: step === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: step === 1,
                    row_version: 1,
                    coverage_ordinal: 1,
                    boundary_id: "m1#0",
                    native_messages: structuredClone(native),
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = createTagger();
        deps.compactionMarkerStrategy = {
            applyDeferred: () => {
                writes++;
                return { kind: "applied", markerOrdinal: 1 };
            },
            reconcile: reconcileMarkerRepresentation,
        };
        const transform = createRustModeTransform(deps, { moduleClient });
        const serve = async () => {
            const input = makeMessages(sessionId);
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            return JSON.stringify(output.messages);
        };
        const first = await serve();
        await serve();
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        setPendingCompactionMarkerState(db, sessionId, pending);
        for (let pass = 0; pass < 8; pass++) {
            expect(await serve()).toBe(first);
            expect(getPendingCompactionMarkerState(db, sessionId)).toEqual(pending);
            expect(writes).toBe(0);
        }
        // Healthy-pass counts no longer release a frozen prefix without a rebuild.
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        transform.dispose();
    });

    it("unprovable shared boundaries fail by name without replay or parking", async () => {
        const sessionId = "ses-unprovable-shared-boundaries";
        sessions.push(sessionId);
        installRawProvider(sessionId);
        const db = makeDb();
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "missing-start",
                endMessageId: "missing-end",
                title: "missing coverage",
                content: "cannot infer both boundaries",
            },
        ]);
        const methods: string[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                methods.push(method);
                return { ok: true };
            },
        };
        const runner = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        for (let pass = 0; pass < 4; pass++) {
            const messages = makeMessages(sessionId);
            await expect(
                runner.run(
                    sessionId,
                    messages,
                    { messages: [...messages] },
                    makeMeta(db, sessionId),
                ),
            ).rejects.toThrow("context_compartment_boundary_unresolved");
        }
        expect(methods).not.toContain("transform");
        expect(runner.getState(sessionId).parked).toBe(false);
    });
    it("shared-store embedding drain does not inherit foreground SQLite retries", async () => {
        const sessionId = "ses-shared-store-background-drain";
        sessions.push(sessionId);
        installRawProvider(sessionId);
        const db = makeDb();
        const probe = new Database(":memory:");
        const busy = Object.assign(new Error("drain busy"), { code: "SQLITE_BUSY" });
        const exec = spyOn(probe, "exec").mockImplementation(() => {
            throw busy;
        });
        const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
        const drain = spyOn(
            embeddingDrain,
            "drainSingleStoreEmbeddingWatermarks",
        ).mockImplementation(async () => {
            expect(() => withPrivilegedWriter(probe, () => {})).toThrow("drain busy");
            expect(exec).toHaveBeenCalledTimes(1);
            expect(wait).not.toHaveBeenCalled();
            return 0;
        });
        try {
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) =>
                    method === "transform"
                        ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                        : { ok: true },
            };
            const runner = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const messages = makeMessages(sessionId);
            await withSqliteTransformPass(() =>
                runner.run(
                    sessionId,
                    messages,
                    { messages: [...messages] },
                    makeMeta(db, sessionId),
                ),
            );
            expect(drain).toHaveBeenCalledTimes(1);
            expect(exec).toHaveBeenCalledTimes(1);
        } finally {
            drain.mockRestore();
            exec.mockRestore();
            wait.mockRestore();
            probe.close();
        }
    });
    it("routes shared-store requests through the resolved session directory", async () => {
        const sessionId = "ses-shared-store-directory-root";
        sessions.push(sessionId);
        installRawProvider(sessionId);
        const db = makeDb();
        const roots: string[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async (args) => {
                roots.push(args.projectRoot);
                throw new Error("stop after routing");
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.directory = "/launch/root-a";
        deps.sessionDirectoryBySession?.set(sessionId, "/session/root-b");
        const runner = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        await expect(
            runner.run(sessionId, messages, { messages: [...messages] }, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(roots.length).toBeGreaterThan(0);
        expect(roots.every((root) => root === "/session/root-b")).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT project_path FROM session_projects WHERE session_id=? AND harness='opencode'",
                )
                .get(sessionId),
        ).toEqual({ project_path: resolveProjectIdentityForSession("/session/root-b", false) });
    });
    it("transports the host-resolved output_reserve as Rust usable_soft", () => {
        const resolved = deriveWindowGeometry(
            "openai-codex",
            "gpt-5.6-sol",
            { context: 400_000, input: 272_000, output: 128_000 },
            { outputReserveOverride: 16_384, harness: "opencode" },
        );
        const geometry = __rustModeTransformTest.transformGeometryForWire(resolved);

        expect(geometry).toEqual({
            usable_soft: 255_616,
            usable_hard: 368_000,
            absolute_wall: 400_000,
            derivation:
                "s1-shared/context-output/context=272000/output=16384/mode=shared_upfront/usable-hard=368000",
        });
    });

    it("transports S1 geometry and bases host preflight on the hard wall", () => {
        const geometry = __rustModeTransformTest.transformGeometryForWire({
            usableSoft: 128_000,
            usableHard: 168_000,
            geometry: "separate",
            derivation: {
                window: 168_000,
                reserve: 40_000,
                reserveSource: "output_catalog",
                geometry: "separate",
                windowSource: "provider",
                absoluteWall: 168_000,
            },
        });
        expect(geometry).toEqual({
            usable_soft: 128_000,
            usable_hard: 168_000,
            absolute_wall: 168_000,
            derivation: "s1-pre-carve/input=128000",
        });
        expect(
            __rustModeTransformTest.hardWallUsagePercentage(
                { inputTokens: 130_000, percentage: (130_000 / 128_000) * 100 },
                geometry,
            ),
        ).toBeCloseTo((130_000 / 168_000) * 100);

        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "geometry-wire",
            input: [],
            nativeMessages: [],
            passInputs: {},
            usage: { context_limit_tokens: 128_000 },
            geometry,
            modelKey: null,
            providerId: null,
        });
        expect(body.usage).toEqual({ context_limit_tokens: 128_000 });
        expect(body.geometry).toEqual(geometry);
    });

    it("omits retired host turn state from the transform wire", () => {
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "no-host-turn-state",
            input: [],
            nativeMessages: [],
            passInputs: {},
            usage: {},
            modelKey: null,
            providerId: null,
        });

        expect(body).not.toHaveProperty("mid_turn");
    });

    it("omits geometry without changing the legacy transform shape", () => {
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "legacy-geometry-wire",
            input: [],
            nativeMessages: [],
            passInputs: {},
            usage: { context_limit_tokens: 128_000 },
            modelKey: null,
            providerId: null,
        });
        expect("geometry" in body).toBe(false);
    });

    it("captures input key order only for edit-marker tools", () => {
        const input = [
            {
                mid: "tool-message",
                ck: {
                    content: [
                        {
                            kind: {
                                type: "tool_call",
                                name: "read",
                                input: { filePath: "read.ts", offset: 1 },
                            },
                        },
                        {
                            kind: {
                                type: "tool_call",
                                name: "edit",
                                input: { filePath: "edit.ts", oldString: "old", newString: "new" },
                            },
                        },
                        {
                            kind: {
                                type: "tool_call",
                                name: "write",
                                input: { filePath: "write.ts", content: "contents" },
                            },
                        },
                    ],
                },
            },
        ];
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "key-order-filter",
            input,
            nativeMessages: [],
            passInputs: {},
            usage: {},
            modelKey: null,
            providerId: null,
        });

        expect(body.tool_input_key_orders).toEqual({
            "tool-message#1": ["filePath", "oldString", "newString"],
            "tool-message#2": ["filePath", "content"],
        });
    });

    it("sends each historian chain model's resolved window and output ceiling", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-historian-model-limits-"));
        const previous = process.env.XDG_DATA_HOME;
        try {
            process.env.XDG_DATA_HOME = root;
            clearModelsDevCache();
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "anthropic",
                                    models: {
                                        primary: { limit: { context: 200_000, output: 16_000 } },
                                    },
                                },
                                {
                                    id: "openai",
                                    models: {
                                        fallback: {
                                            limit: {
                                                context: 400_000,
                                                input: 272_000,
                                                output: 128_000,
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const chain = ["anthropic/primary", "openai/fallback"];
            const body = __rustModeTransformTest.buildTransformBody({
                sessionId: "historian-limits",
                input: [],
                nativeMessages: [],
                passInputs: {
                    historian_model_chain: chain,
                    historian_model_limits:
                        __rustModeTransformTest.resolvedHistorianModelLimits(chain),
                },
                usage: {},
                modelKey: null,
                providerId: null,
            });
            expect(body.historian_model_limits).toEqual({
                "anthropic/primary": { context: 200_000, output: 16_000 },
                "openai/fallback": { context: 400_000, input: 272_000, output: 128_000 },
            });
        } finally {
            clearModelsDevCache();
            if (previous === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previous;
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("gates and copies a mural payload onto the transform wire", () => {
        const resolved = {
            enabled: true,
            supportsVision: true,
            dataUrl: "data:image/png;base64,cG5n",
            contentHash: "mural-epoch-a",
        };
        const mural = __rustModeTransformTest.muralInputForWire(resolved);
        expect(mural).toEqual({
            enabled: true,
            supports_vision: true,
            data_url: resolved.dataUrl,
            content_hash: resolved.contentHash,
        });
        expect(
            __rustModeTransformTest.muralInputForWire({ ...resolved, enabled: false }),
        ).toBeUndefined();
        expect(
            __rustModeTransformTest.muralInputForWire({ ...resolved, supportsVision: false }),
        ).toBeUndefined();
        expect(
            __rustModeTransformTest.muralInputForWire({ ...resolved, dataUrl: undefined }),
        ).toBeUndefined();

        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "mural-wire",
            input: [],
            nativeMessages: [],
            passInputs: { mural },
            usage: {},
            modelKey: "anthropic/vision-model",
            providerId: "anthropic",
        });

        expect(body.mural).toEqual(mural);
    });

    it("passes lineage-switch transport fields through opaquely", () => {
        const constituents: Array<[string, string, number]> = [
            ["prior", "middle", 8],
            ["middle", "new", 9],
        ];
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "lineage-wire",
            input: [],
            nativeMessages: [],
            passInputs: {
                lineage_switched: true,
                descent_edge_id: 77,
                prior_conversation_key: "prior",
                prior_epoch: 7,
                new_epoch: 9,
                constituents,
                compaction_observed: true,
            },
            usage: {},
            modelKey: null,
            providerId: null,
        });
        expect(body).toMatchObject({
            lineage_switched: true,
            descent_edge_id: 77,
            prior_conversation_key: "prior",
            prior_epoch: 7,
            new_epoch: 9,
            constituents,
            compaction_observed: true,
        });
    });

    it("sends the frozen built-in known-model TTL to the Rust module", async () => {
        const sessionId = "rust-known-model-ttl";
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const ttls: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") {
                    ttls.push([
                        body?.cache_ttl,
                        (body?.pass_inputs as Record<string, unknown>)?.cache_ttl,
                    ]);
                }
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: false,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.cacheTtlConfig = "5m";
        deps.cacheTtlConfigured = false;
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "openai", modelID: "gpt-6" };
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        deps.cacheTtlConfig = "1m";
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        expect(ttls).toEqual([
            ["30m", "30m"],
            ["30m", "30m"],
        ]);
        expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe("30m");
    });

    it("sends the live user TTL to both Rust module scheduling inputs on the next pass", async () => {
        const sessionId = "rust-live-user-ttl";
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const ttls: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform")
                    ttls.push([
                        body?.cache_ttl,
                        (body?.pass_inputs as Record<string, unknown>)?.cache_ttl,
                    ]);
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: false,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        let ttl = "1h";
        deps.sampleCacheTtlConfig = () => ({ cache_ttl: ttl, cacheTtlConfigured: true });
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "anthropic", modelID: "opus" };
        for (const next of ["1h", "13h"]) {
            ttl = next;
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );
        }
        expect(ttls).toEqual([
            ["1h", "1h"],
            ["13h", "13h"],
        ]);
        expect(getOrCreateSessionMeta(db, sessionId).cacheTtl).toBe("13h");
    });

    it("serves 2048-message SOFT+, SOFT and HARD native wires with the original SHA256", async () => {
        for (const decision of ["SOFT+", "SOFT", "HARD"]) {
            const sessionId = `rust-native-byte-identity-${decision}`;
            sessions.push(sessionId);
            const db = makeDb();
            installRawProvider(sessionId);
            const native = Array.from({ length: 2048 }, (_, index) => ({
                ...makeMessages(sessionId)[0],
                info: { ...makeMessages(sessionId)[0].info, id: `native_${index}` },
                parts: [
                    {
                        type: "text",
                        text: `history ${index} Ελληνικά 🚀 ${"ballast ".repeat(128)}`,
                    },
                ],
            }));
            const serializedBefore = JSON.stringify(structuredClone(native));
            const sha = (text: string) => createHash("sha256").update(text).digest("hex");
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) =>
                    method === "transform" ? { decision, native_messages: native } : { ok: true },
            };
            installAvailabilityDb(sessionId);
            clearModelsDevCache();
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: { "test-model": { limit: { context: 4_000_000 } } },
                                },
                            ],
                        },
                    }),
                },
            });
            const deps = makeDeps(db, moduleClient);
            deps.getModelKey = () => "test-provider/test-model";
            const transform = createRustModeTransform(deps, { moduleClient });
            const messages = makeMessages(sessionId);
            const output: { messages: unknown[] } = { messages: [...messages] };
            const meta = makeMeta(db, sessionId);
            // This test checks byte-for-byte preservation, not whether the large
            // request can be sent. Give its 2048-message fixture a fitting limit.
            recordDetectedContextLimit(db, sessionId, 4_000_000, "test-provider/test-model");
            await transform.run(sessionId, messages, output, meta);
            expect(output.messages).toHaveLength(2048);
            const beforeHash = sha(serializedBefore);
            const afterHash = sha(JSON.stringify(output.messages));
            console.log(
                `native-wire-identity decision=${decision} messages=2048 before=${beforeHash} after=${afterHash}`,
            );
            expect(afterHash).toBe(beforeHash);
            expect(JSON.stringify(native)).toBe(serializedBefore);
            clearModelsDevCache();
        }
    });

    it("emits discriminating pass and stage logs from ordinary Rust transforms", async () => {
        const sessionId = `rust-log-fence-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const responses = [
            {
                decision: "HARD",
                materialize_reason: "first_render",
                prefix_bust_permitted: true,
                scheduler_decision: "execute",
                historian: {
                    fired: false,
                    no_fire: "trigger_false",
                    canonical_cause: "no_new_raw_history",
                    state: "idle",
                },
                served_from: "transform",
                timings: { handler_total: 5, total: 4, native_cache_encoded_messages: 1 },
            },
            {
                decision: "SOFT+",
                scheduler_decision: "defer",
                scheduler_defer_reason: "scheduler_defer",
                served_from: "lkg",
                timings: { handler_total: 3, total: 2, native_cache_reused_messages: 1 },
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, onTimings }) => {
                if (method !== "transform") return { ok: true };
                onTimings?.({ lane: 1, route: 2, encode: 3, issue: 4, responseWait: 5, settle: 6 });
                return { ...responses.shift(), native_messages: makeMessages(sessionId) };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            for (let index = 0; index < 2; index += 1) {
                const messages = makeMessages(sessionId);
                await transform.run(
                    sessionId,
                    messages,
                    { messages: [...messages] },
                    makeMeta(db, sessionId),
                );
            }

            const logged = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => message);
            const coverageLines = logged.filter((message) =>
                message.startsWith("rust input coverage:"),
            );
            expect(coverageLines).toEqual([
                "rust input coverage: oc_input=1 marker_at=none covered=0 first_ordinal=1",
                "rust input coverage: oc_input=1 marker_at=none covered=0 first_ordinal=1",
            ]);
            const passLines = logged.filter((message) => message.startsWith("rust pass:"));
            expect(passLines).toHaveLength(2);
            expect(passLines[0]).toContain("decision=HARD");
            expect(passLines[0]).toContain("scheduler=execute");
            expect(passLines[0]).toContain(
                "historian_no_fire=trigger_false canonical_cause=no_new_raw_history",
            );
            expect(passLines[0]).toContain("served_from=transform");
            expect(passLines[1]).toContain("decision=SOFT+");
            expect(passLines[1]).toContain("scheduler=defer defer_reason=scheduler_defer");
            expect(passLines[1]).toContain("served_from=lkg");
            for (const line of passLines) {
                for (const field of [
                    "transport_lane:1.0",
                    "transport_route:2.0",
                    "transport_encode:3.0",
                    "transport_issue:4.0",
                    "transport_response_wait_decode:5.0",
                    "transport_settle:6.0",
                    "transport_wrapper:",
                    "preflight:",
                    "todo_verdict:",
                    "todo_probe:",
                    "todo_persist:",
                    "todo_probe_required:",
                    "todo_probe_reason:",
                    "todo_unprobed_bust:",
                    "session_directory:",
                    "paging:",
                    "output_clone:",
                    "delivery:",
                    "bookkeeping:",
                ])
                    expect(line).toContain(field);
            }
            expect(passLines[0]).not.toBe(passLines[1]);
            expect(logged.some((message) => message.startsWith("rust module stages:"))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("replays LKG when a defer pass reports frozen-prefix divergence", async () => {
        const sessionId = `rust-defer-prefix-guard-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const stableNative = makeMessages(sessionId);
        stableNative[0]!.parts = [{ type: "text", text: "stable frozen prefix" }];
        const divergentNative = makeMessages(sessionId);
        divergentNative[0]!.parts = [{ type: "text", text: "restart-only frozen prefix" }];
        const responses = [
            {
                decision: "HARD",
                scheduler_decision: "execute",
                prefix_bust_permitted: true,
                row_version: 1,
                native_messages: stableNative,
            },
            {
                decision: "SOFT+",
                scheduler_decision: "defer",
                scheduler_defer_reason: "scheduler_defer",
                row_version: 2,
                first_divergence: {
                    index: 1,
                    block_id_old: "mc_m1#0",
                    block_id_new: "mc_m1#0",
                    kind: "content_changed",
                    approx_token_depth: 100,
                },
                native_messages: divergentNative,
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform" ? responses.shift()! : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => capture(),
        });
        const firstInput = makeMessages(sessionId);
        const firstOutput = { messages: [...firstInput] as unknown[] };
        await transform.run(sessionId, firstInput, firstOutput, makeMeta(db, sessionId));
        const stableOutput = JSON.stringify(firstOutput.messages);

        const secondInput = makeMessages(sessionId);
        const secondOutput = { messages: [...secondInput] as unknown[] };
        await transform.run(sessionId, secondInput, secondOutput, makeMeta(db, sessionId));

        expect(JSON.stringify(secondOutput.messages)).toBe(stableOutput);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
    });

    it("treats a decisionless module response as a typed failure, never as a priced pass", async () => {
        const sessionId = `rust-missing-decision-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          status: "ok",
                          row_version: 2,
                          native_messages: [
                              {
                                  info: { id: "m1", role: "user", sessionID: sessionId },
                                  parts: [{ type: "text", text: "must not be served" }],
                              },
                          ],
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            await expect(
                transform.run(sessionId, input, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toEqual(input);
            expect(JSON.stringify(output.messages)).not.toContain("must not be served");
            expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
            expect(
                logSpy.mock.calls.some((call) =>
                    call.some(
                        (value) =>
                            value instanceof Error && value.name === "RustTransformProtocolError",
                    ),
                ),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("holds pending restart work through bounded subagent defers and adopts it on pass four", async () => {
        const sessionId = `rust-bounded-subagent-freeze-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    time: { created: 1 },
                    model: { providerID: "anthropic", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "start long tool turn" }],
            },
            {
                info: {
                    id: "tool-owner",
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: 2 },
                    finish: "tool-calls",
                },
                parts: [
                    {
                        type: "tool",
                        callID: "running-tool",
                        tool: "long_task",
                        state: { status: "running", input: { task: "long" } },
                    },
                ],
            },
            {
                info: {
                    id: "m2",
                    role: "user",
                    sessionID: sessionId,
                    time: { created: 3 },
                    model: { providerID: "anthropic", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "queued while tool runs" }],
            },
        ] as unknown as MessageLike[];
        const representation = (text: string): unknown[] => {
            const output = structuredClone(input) as unknown as MessageLike[];
            output[0]!.parts = [{ type: "text", text }];
            return output;
        };
        const representationA = representation("stable prefix before restart");
        const representationPending = representation("pending historian compartment");
        const representationPriced = representation(
            "<new-compartments>published historian compartment</new-compartments>",
        );
        let transformPass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                transformPass += 1;
                if (transformPass === 1) {
                    return {
                        decision: "HARD",
                        prefix_bust_permitted: true,
                        row_version: 1,
                        native_messages: structuredClone(representationA),
                    };
                }
                const priced = transformPass === 5;
                return {
                    decision: priced ? "SOFT" : "SOFT+",
                    prefix_bust_permitted: priced,
                    scheduler_decision: priced ? "execute" : "defer",
                    row_version: transformPass,
                    first_divergence: {
                        index: 1,
                        block_id_old: "mc_m1#0",
                        block_id_new: "mc_m1#0",
                        kind: "content_changed",
                        approx_token_depth: 100,
                    },
                    native_messages: structuredClone(
                        priced ? representationPriced : representationPending,
                    ),
                };
            },
        };
        const initial = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const initialMeta = makeMeta(db, sessionId);
        initialMeta.isSubagent = true;
        const initialOutput = { messages: [...input] as unknown[] };
        await initial.run(sessionId, input, initialOutput, initialMeta);
        const servedPrefixSha = (messages: unknown[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");
        const stableSha = servedPrefixSha(initialOutput.messages);

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        const restarted = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const restartMeta = makeMeta(db, sessionId);
        restartMeta.isSubagent = true;
        for (let deferredPass = 1; deferredPass <= 3; deferredPass += 1) {
            const output = { messages: [...input] as unknown[] };
            await restarted.run(sessionId, input, output, restartMeta);
            expect(servedPrefixSha(output.messages)).toBe(stableSha);
            expect(JSON.stringify(output.messages)).not.toContain(
                "published historian compartment",
            );
            expect(restarted.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        }

        const pricedOutput = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, pricedOutput, restartMeta);
        expect(servedPrefixSha(pricedOutput.messages)).not.toBe(stableSha);
        expect(JSON.stringify(pricedOutput.messages)).toContain("published historian compartment");
        expect(restarted.getState(sessionId).lkgRepresentationFrozen).toBe(false);
        expect(transformPass).toBe(5);
    });

    it("lets an external project-memory epoch force a HARD pass through the freeze", async () => {
        const sessionId = `rust-frozen-memory-epoch-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const representation = (text: string) => [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text }],
            },
        ];
        const stable = representation("stable prefix");
        const pending = representation("pending historian compartment");
        const drained = representation(
            "external memory epoch materialized with pending historian compartment",
        );
        let transformPass = 0;
        let externalEpochObserved = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "state_sync") {
                    if (JSON.stringify(body).includes('"project_memory_epoch":1')) {
                        externalEpochObserved = true;
                    }
                    return { ok: true };
                }
                if (method !== "transform") return { ok: true };
                transformPass += 1;
                if (transformPass === 1) {
                    return {
                        decision: "HARD",
                        prefix_bust_permitted: true,
                        row_version: 1,
                        native_messages: stable,
                    };
                }
                if (externalEpochObserved) {
                    return {
                        decision: "HARD",
                        prefix_bust_permitted: true,
                        row_version: 3,
                        native_messages: drained,
                    };
                }
                return {
                    decision: "SOFT+",
                    scheduler_decision: "defer",
                    row_version: 2,
                    first_divergence: {
                        index: 1,
                        block_id_old: "mc_m1#0",
                        block_id_new: "mc_m1#0",
                        kind: "content_changed",
                        approx_token_depth: 100,
                    },
                    native_messages: pending,
                };
            },
        };
        const initial = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const initialOutput = { messages: [...input] as unknown[] };
        await initial.run(sessionId, input, initialOutput, makeMeta(db, sessionId));
        const stableSha = createHash("sha256")
            .update(JSON.stringify(initialOutput.messages))
            .digest("hex");

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        const restarted = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const deferredOutput = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, deferredOutput, makeMeta(db, sessionId));
        expect(
            createHash("sha256").update(JSON.stringify(deferredOutput.messages)).digest("hex"),
        ).toBe(stableSha);
        expect(restarted.getState(sessionId).lkgRepresentationFrozen).toBe(true);

        bumpProjectMemoryEpoch(db, "/tmp/project", 10);
        const hardOutput = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, hardOutput, makeMeta(db, sessionId));
        expect(externalEpochObserved).toBe(true);
        expect(JSON.stringify(hardOutput.messages)).toContain(
            "external memory epoch materialized with pending historian compartment",
        );
        expect(
            createHash("sha256").update(JSON.stringify(hardOutput.messages)).digest("hex"),
        ).not.toBe(stableSha);
        expect(restarted.getState(sessionId).lkgRepresentationFrozen).toBe(false);
    });

    it("keeps host-only trailing blank stripping at a three-pass raw-ingress fixed point", async () => {
        const sessionId = `rust-host-strip-fixed-point-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        addTrailingBlankDecisions(db, sessionId, [["m1", "strip"]]);
        const transformBodies: Record<string, unknown>[] = [];
        const sourceMessages = () =>
            [
                {
                    info: {
                        id: "m1",
                        role: "assistant",
                        sessionID: sessionId,
                        providerID: "anthropic",
                        modelID: "claude-sonnet",
                    },
                    parts: [
                        { type: "text", text: "stable answer" },
                        { type: "text", text: "" },
                    ],
                },
            ] as unknown as MessageLike[];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(structuredClone(body));
                return {
                    decision: "PASSTHROUGH",
                    native_messages: sourceMessages(),
                };
            },
        };
        const runner = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const served: string[] = [];

        for (let pass = 0; pass < 3; pass += 1) {
            const messages = sourceMessages();
            const output = { messages };
            await runner.run(sessionId, messages, output, makeMeta(db, sessionId));
            served.push(JSON.stringify(output.messages));
            expect((output.messages[0] as MessageLike).parts).toEqual([
                { type: "text", text: "stable answer" },
            ]);
        }

        expect(served[1]).toBe(served[0]);
        expect(served[2]).toBe(served[0]);
        expect(
            (
                ((transformBodies[0]?.native_messages as MessageLike[])[0]?.parts ?? []) as Array<{
                    text?: string;
                }>
            ).at(-1)?.text,
        ).toBe("");
        expect(transformBodies.slice(1).map((body) => body.native_messages)).toEqual([[], []]);
        expect(transformBodies.slice(1).every((body) => body.tail_delta !== undefined)).toBe(true);
    });

    it("keeps the rust pass line grep-compatible", () => {
        expect(
            __rustModeTransformTest.formatRustInputCoverageLog({
                ocInput: 10_004,
                markerAt: "msg_boundary",
                covered: 9_590,
            }),
        ).toBe("rust input coverage: oc_input=10004 marker_at=msg_boundary covered=9590");
        expect(
            __rustModeTransformTest.formatRustInputCoverageLog({
                ocInput: 21_748,
                markerAt: null,
                covered: 7_400,
            }),
        ).toBe("rust input coverage: oc_input=21748 marker_at=none covered=7400");
        expect(
            __rustModeTransformTest.formatRustPassLog({
                decision: "HARD",
                reason: "first_render",
                identityDelta: ["mur"],
                servedFrom: "transform",
                inputCount: 4,
                outputCount: 3,
                applied: true,
                elapsedMs: 12.345,
                moduleElapsedMs: 8.765,
            }),
        ).toBe(
            "rust pass: decision=HARD reason=first_render prefix_bust_permitted=unsupported identity_delta=mur served_from=transform in=4 out=3 applied=true row_version=0 elapsed=12.3 ms module=8.8 ms stages=identity_resolve:0.0 prompt_surface:0.0 mural_resolve:0.0 prefix_guard:0.0 ordinal_resolve:0.0 ordinal_rebuild:0.0 ordinal_rows:0 ordinal_mode:memo state_sync:0.0 clone:0.0 wire_build:0.0 wire_messages:0 transport:0.0 transport_pages:0 transport_bytes:0 apply:0.0 lkg_snapshot:0.0 mirror_pull:0.0 compartment_mirror:0.0 other:12.3 transport_lane:0.0 transport_route:0.0 transport_encode:0.0 transport_issue:0.0 transport_response_wait_decode:0.0 transport_settle:0.0 transport_wrapper:0.0 preflight:0.0 todo_verdict:0.0 todo_probe:0.0 todo_persist:0.0 todo_probe_required:0 todo_probe_reason:none todo_unprobed_bust:0 session_directory:0.0 paging:0.0 output_clone:0.0 delivery:0.0 bookkeeping:0.0",
        );
    });

    it("accepts materialized boundaries from a committed rebuild regardless of scheduler", () => {
        expect(
            __rustModeTransformTest.materializedCompactionBoundary(
                {
                    decision: "HARD",
                    scheduler_decision: "defer",
                    committed: true,
                    row_version: 12,
                    coverage_ordinal: 9_590,
                    boundary_id: "msg_boundary#3",
                },
                true,
            ),
        ).toEqual({ rowVersion: 12, ordinal: 9_590, endMessageId: "msg_boundary" });
        expect(
            __rustModeTransformTest.materializedCompactionBoundary(
                {
                    decision: "SOFT+",
                    scheduler_decision: "defer",
                    committed: true,
                    row_version: 12,
                    coverage_ordinal: 9_590,
                    boundary_id: "msg_boundary#3",
                },
                false,
            ),
        ).toBeUndefined();
        expect(
            __rustModeTransformTest.materializedCompactionBoundary(
                {
                    decision: "SOFT+",
                    scheduler_decision: "execute",
                    committed: true,
                    row_version: 12,
                    coverage_ordinal: 9_590,
                    boundary_id: "msg_boundary#3",
                },
                false,
            ),
        ).toBeUndefined();
    });

    it("deferred rebuilding extraction preserves every durable coordinate guard", () => {
        const valid = {
            committed: true,
            scheduler_decision: "defer",
            row_version: 12,
            coverage_ordinal: 9590,
            boundary_id: "msg_boundary#3",
        };
        expect(__rustModeTransformTest.materializedCompactionBoundary(valid, true)).toEqual({
            rowVersion: 12,
            ordinal: 9590,
            endMessageId: "msg_boundary",
        });
        expect(
            __rustModeTransformTest.materializedCompactionBoundary(valid, false),
        ).toBeUndefined();
        for (const patch of [
            ...[undefined, false, 1, "true"].map((committed) => ({ committed })),
            ...[
                undefined,
                0,
                -1,
                1.5,
                Number.POSITIVE_INFINITY,
                Number.NaN,
                Number.MAX_SAFE_INTEGER + 1,
                "12",
            ].map((row_version) => ({ row_version })),
            ...[
                undefined,
                -1,
                1.5,
                Number.POSITIVE_INFINITY,
                Number.NaN,
                Number.MAX_SAFE_INTEGER + 1,
                "9590",
            ].map((coverage_ordinal) => ({ coverage_ordinal })),
            ...[
                undefined,
                null,
                "",
                "missing-hash",
                "#0",
                "msg#",
                "msg#-1",
                "msg#abc",
                "msg#1.5",
                "msg# 1",
            ].map((boundary_id) => ({ boundary_id })),
        ])
            expect(
                __rustModeTransformTest.materializedCompactionBoundary(
                    { ...valid, ...patch },
                    true,
                ),
            ).toBeUndefined();
    });

    it("arms the deferred-note nudge only when a module fold advances the published sequence", async () => {
        const sessionId = `rust-note-nudge-publish-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let coverageOrdinal = 12;
        const native = () => [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "<project-docs>m0</project-docs>", synthetic: true }],
            },
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "tail" }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "HARD",
                          scheduler_decision: "execute",
                          prefix_bust_permitted: true,
                          committed: true,
                          row_version: 4,
                          coverage_ordinal: coverageOrdinal,
                          boundary_id: "m1#0",
                          native_messages: native(),
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const runPass = async () => {
            const input = makeMessages(sessionId);
            await transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId));
        };

        await runPass();
        expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(true);

        // Clear the armed trigger so the next assertion observes only what this pass does.
        clearNoteNudgeTriggerOnly(db, sessionId);
        await runPass();
        expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(false);

        coverageOrdinal = 30;
        await runPass();
        expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(true);
    });

    it("does not re-arm the deferred-note nudge for a fold published before this process", async () => {
        const sessionId = `rust-note-nudge-restart-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        // Seed the compaction marker as if an earlier process had already recorded a fold
        // covering raw history through ordinal 12, so this pass sees no new coverage.
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "m1",
            summaryMessageId: "m1",
            compactionPartId: "prt_compaction",
            summaryPartId: "prt_summary",
            boundaryOrdinal: 12,
            targetEndMessageId: "m1",
        });
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "HARD",
                          scheduler_decision: "execute",
                          prefix_bust_permitted: true,
                          committed: true,
                          row_version: 4,
                          coverage_ordinal: 12,
                          boundary_id: "m1#0",
                          native_messages: [
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
                                  parts: [{ type: "text", text: "tail" }],
                              },
                          ],
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);

        await expect(
            transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        expect(getPersistedNoteNudge(db, sessionId).triggerPending).toBe(false);
    });

    it("consumes the persisted provider-overflow limit on the next Rust-mode pass", async () => {
        const sessionId = `rust-overflow-limit-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, 64_000, "anthropic/claude-fable-5-1");
        let transformBody: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBody = body;
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: makeMessages(sessionId),
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.liveModelBySession?.set(sessionId, {
            providerID: "anthropic",
            modelID: "claude-fable-5-1",
        });
        deps.getModelKey = () => "anthropic/claude-fable-5-1";
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        input[0]!.info.model = {
            providerID: "anthropic",
            modelID: "claude-fable-5-1",
        };

        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));

        expect(transformBody?.usage).toMatchObject({ context_limit_tokens: 64_000 });
        expect(transformBody?.emergency_recovery_armed).toBe(true);
    });

    it("keeps stale low usage armed until a post-overflow usage row proves recovery", async () => {
        const sessionId = `rust-overflow-recovery-${Date.now()}`;
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Record<string, unknown>[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(body);
                return transformBodies.length === 1
                    ? { native_messages: makeMessages(sessionId), decision: "PASSTHROUGH" }
                    : {
                          native_messages: makeMessages(sessionId),
                          decision: "HARD",
                          materialize_reason: "overflow_recovery_fold",
                      };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 30_000, percentage: 30 },
            updatedAt: Date.now(),
        });
        const runner = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        await runner.run(sessionId, messages, { messages }, makeMeta(db, sessionId));

        recordOverflowDetected(db, sessionId, 100_000, "test/model");
        const recoveryMessages = makeMessages(sessionId);
        await runner.run(
            sessionId,
            recoveryMessages,
            { messages: recoveryMessages },
            makeMeta(db, sessionId),
        );

        expect(transformBodies).toHaveLength(2);
        expect(transformBodies[1]?.emergency_recovery_armed).toBe(true);
        expect(transformBodies[1]?.tail_delta).toBeUndefined();
        expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(true);

        const armedAt = getEmergencyRecoveryArmedAt(sessionId);
        expect(armedAt).not.toBeNull();
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 30_000, percentage: 30 },
            updatedAt: (armedAt as number) + 1,
            hasUsageTokens: true,
        });
        const verifiedMessages = makeMessages(sessionId);
        await runner.run(
            sessionId,
            verifiedMessages,
            { messages: verifiedMessages },
            makeMeta(db, sessionId),
        );

        expect(transformBodies).toHaveLength(3);
        expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(false);
    });

    it("never treats stale percentages as provider-overflow recovery evidence", () => {
        for (const percentage of [0, 20.8, 79.9]) {
            expect(
                __rustModeTransformTest.shouldDisarmRustEmergencyRecovery({
                    materialized: true,
                    usagePercentage: percentage,
                    recoveryOrigin: "provider_overflow",
                    recoveryArmedAt: 200,
                    usageEntry: {
                        updatedAt: 100,
                        hasUsageTokens: true,
                    },
                    providerProvenLimitTokens: 100_000,
                }),
            ).toBeNull();
        }
    });

    it("binds every served Rust pass class to the provider assistant decision row", async () => {
        const db = makeFileDb();
        const bindProviderAssistant = async (
            sessionId: string,
            messageId: string,
            served = true,
        ) => {
            expect(
                scheduleOpenCodeTransformDecisionWrite({
                    db,
                    sessionId,
                    messageId,
                    inputTokens: 123,
                }),
            ).toBe(served);
            await new Promise((resolve) => setTimeout(resolve, 5));
        };

        const classifierSession = `rust-decisions-${Date.now()}`;
        sessions.push(classifierSession);
        installRawProvider(classifierSession);
        const responses = [
            { decision: "HARD", materialize_reason: "first_render" },
            { decision: "SOFT", materialize_reason: "m1_delta" },
            { decision: "SOFT+" },
            { decision: "PASSTHROUGH" },
        ];
        const classifierClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? { ...responses.shift(), native_messages: [] }
                    : { ok: true },
        };
        const classifierDeps = makeDeps(db, classifierClient);
        classifierDeps.contextUsageMap.set(classifierSession, {
            usage: { inputTokens: 123, percentage: 1 },
            updatedAt: Date.now(),
        });
        const classifierTransform = createRustModeTransform(classifierDeps, {
            moduleClient: classifierClient,
        });
        for (let index = 0; index < 4; index += 1) {
            const messages = makeMessages(classifierSession);
            await classifierTransform.run(
                classifierSession,
                messages,
                { messages },
                makeMeta(db, classifierSession),
            );
            await bindProviderAssistant(classifierSession, `classifier-response-${index}`);
        }

        const failureSession = `rust-decision-errors-${Date.now()}`;
        sessions.push(failureSession);
        installRawProvider(failureSession);
        const failureClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("daemon unavailable");
                return { ok: true };
            },
        };
        const failureTransform = createRustModeTransform(makeDeps(db, failureClient), {
            moduleClient: failureClient,
        });
        for (let index = 0; index < 3; index += 1) {
            const messages = makeMessages(failureSession);
            await expect(
                failureTransform.run(
                    failureSession,
                    messages,
                    { messages },
                    makeMeta(db, failureSession),
                ),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            await bindProviderAssistant(failureSession, `error-response-${index}`, false);
        }
        const parkedMessages = makeMessages(failureSession);
        await expect(
            failureTransform.run(
                failureSession,
                parkedMessages,
                { messages: parkedMessages },
                makeMeta(db, failureSession),
            ),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        await bindProviderAssistant(failureSession, "parked-response", false);

        const fullSyncSession = `rust-decision-full-sync-${Date.now()}`;
        sessions.push(fullSyncSession);
        installRawProvider(fullSyncSession);
        const fullSyncClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform" ? { status: "need_full_sync" } : { ok: true },
        };
        const fullSyncTransform = createRustModeTransform(makeDeps(db, fullSyncClient), {
            moduleClient: fullSyncClient,
        });
        const fullSyncMessages = makeMessages(fullSyncSession);
        await expect(
            fullSyncTransform.run(
                fullSyncSession,
                fullSyncMessages,
                { messages: fullSyncMessages },
                makeMeta(db, fullSyncSession),
            ),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        await bindProviderAssistant(fullSyncSession, "full-sync-response", false);

        expect(
            db
                .prepare(
                    "SELECT message_id, decision, materialized, materialize_reason FROM transform_decisions ORDER BY rowid",
                )
                .all(),
        ).toEqual([
            {
                message_id: "classifier-response-0",
                decision: "execute",
                materialized: 1,
                materialize_reason: "first_render",
            },
            {
                message_id: "classifier-response-1",
                decision: "execute",
                materialized: 0,
                materialize_reason: "m1_delta",
            },
            {
                message_id: "classifier-response-2",
                decision: "defer",
                materialized: 0,
                materialize_reason: null,
            },
            {
                message_id: "classifier-response-3",
                decision: "passthrough",
                materialized: 0,
                materialize_reason: null,
            },
        ]);
    });

    it("adopts a durable sequence from a fresh process and retries the sync", async () => {
        const sessionId = `rust-adopt-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const native = [{ role: "assistant", parts: [{ type: "text", text: "module output" }] }];
        const methods: string[] = [];
        let firstSync = true;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                methods.push(method);
                if (method === "state_sync" && firstSync) {
                    firstSync = false;
                    throw authoritySeqMismatch(5);
                }
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        expect(methods).toEqual(["state_sync", "state_sync", "transform"]);
        expect(transform.getState(sessionId).lastAckedSeq).toBe(6);
        expect(transform.getState(sessionId).lastAckedWatermarks).not.toBeNull();
        expect(output.messages).toEqual(native);
    });

    it("re-sends a full seed after historian busy while still applying the transform", async () => {
        const sessionId = `rust-seed-busy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const stateSyncBodies: Array<Record<string, unknown>> = [];
        let rejectSeed = true;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "state_sync") {
                    stateSyncBodies.push(body as Record<string, unknown>);
                    if (rejectSeed) {
                        rejectSeed = false;
                        throw Object.assign(new Error("historian owns compartment snapshot"), {
                            code: "historian_compartment_sync_busy",
                        });
                    }
                    return { ok: true };
                }
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: makeMessages(sessionId) }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const firstInput = makeMessages(sessionId);

        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        expect(transform.getState(sessionId).initialized).toBe(false);
        expect(transform.getState(sessionId).seedPassPending).toBe(true);

        const secondInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            secondInput,
            { messages: [...secondInput] },
            makeMeta(db, sessionId),
        );

        expect(stateSyncBodies).toHaveLength(2);
        expect(stateSyncBodies.every((body) => "seed_id" in body)).toBe(true);
        expect(transform.getState(sessionId).initialized).toBe(true);
        expect(transform.getState(sessionId).seedPassPending).toBe(false);
    });

    it("gates the transform before any TypeScript mutation", async () => {
        const sessionId = `rust-gate-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const native = [{ role: "user", parts: [{ type: "text", text: "unchanged" }] }];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native }
                    : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createTransform(deps);
        const output = { messages: input as unknown[] };
        await transform({}, output);
        expect(output.messages).toEqual(native);
        expect(input).toEqual(native);
    });

    it("skips TypeScript entry projection in Rust mode", async () => {
        const sessionId = `rust-no-entry-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const native = [{ role: "user", parts: [{ type: "text", text: "unchanged" }] }];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native }
                    : { ok: true },
        };
        const fullDigest = spyOn(lkgSlot, "lkgContentDigest");
        const fields = spyOn(lkgSlot, "lkgContentFields");
        try {
            const transform = createTransform(makeDeps(db, moduleClient));
            const output = { messages: makeMessages(sessionId) as unknown[] };
            await transform({}, output);
            expect(output.messages).toEqual(native);
            expect(fullDigest).not.toHaveBeenCalled();
            expect(fields).not.toHaveBeenCalled();
        } finally {
            fullDigest.mockRestore();
            fields.mockRestore();
        }
    });

    it("applies module output through the OpenCode hook array reference", async () => {
        const sessionId = `rust-hook-array-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const native = [
            {
                info: { role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "<project-docs>m0</project-docs>", synthetic: true }],
            },
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "tail" }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          action: "CACHE_HIT",
                          served_from: "transform",
                          boundary_id: "m1#0",
                          native_messages: native,
                      }
                    : { ok: true },
        };
        const transform = createTransform(makeDeps(db, moduleClient));
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": transform as never,
            },
        });
        const output = { messages: input as unknown[] };
        const callerHeldMessages = output.messages;

        const returned = await handler({}, output as never);

        expect(returned).toEqual(native);
        expect(output.messages).toEqual(native);
        expect(callerHeldMessages).toEqual(native);
        expect(output.messages).toBe(callerHeldMessages);
    });

    it("fails the pass when a present boundary lacks a synthetic session-scoped m0", async () => {
        const sessionId = `rust-wire-invariant-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          action: "CACHE_HIT",
                          served_from: "transform",
                          boundary_id: "m1#0",
                          native_messages: [
                              {
                                  info: { role: "user", sessionID: sessionId },
                                  parts: [{ type: "text", text: "not marked synthetic" }],
                              },
                          ],
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: input as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        expect(output.messages).toBe(input);
        expect(output.messages[0]).toEqual(input[0]);
        expect(transform.getState(sessionId).failureCount).toBe(1);
    });

    it("sends tool_present=false when agent permissions denied ctx_reduce before the verdict froze", async () => {
        const sessionId = `rust-permission-deny-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        let transformRequest: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        // The shared transform entry point awaits this read before dispatching to
        // the Rust facade; the facade then freezes the verdict it forwards.
        await primeCtxReduceSpawnPermission(
            {
                app: {
                    agents: async () => ({
                        data: [{ name: "reviewer", permission: { ctx_reduce: "deny" } }],
                    }),
                },
                session: { get: async () => ({ data: {} }) },
            } as never,
            sessionId,
            "reviewer",
        );
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );
        expect(transformRequest?.tool_present).toBe(false);
    });

    it("seeds before the first transform and applies native output verbatim", async () => {
        const sessionId = `rust-seed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const native = [{ role: "user", parts: [{ type: "text", text: "module output" }] }];
        const methods: string[] = [];
        let transformRequest: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                methods.push(method);
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
        expect(methods).toEqual(["state_sync", "transform"]);
        expect(transformRequest?.serve_native).toBe(true);
        expect(transformRequest?.tool_present).toBe(true);
        expect(transformRequest?.todo_tool_present).toBe(true);
        expect(transformRequest?.prompt_surface_preset).toBe("full");
        expect(transformRequest?.prompt_surface_model_key).toBe("test-provider/test-model");
        expect(transformRequest?.prompt_surface_config_identity).toBe(
            promptSurfaceConfigIdentity(undefined),
        );
        expect(transformRequest?.prompt_surface_tool_descriptions).toEqual({});
        expect(transformRequest?.native_messages).toBe(messages);
        expect(Array.isArray(transformRequest?.messages)).toBe(true);
        expect(output.messages).toEqual(native);

        methods.length = 0;
        const secondInput = makeMessages(sessionId);
        const secondOutput = { messages: secondInput as unknown[] };
        await transform.run(sessionId, secondInput, secondOutput, makeMeta(db, sessionId));
        expect(methods).toEqual(["transform"]);
        expect(transformRequest?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: 1,
            native_replace_from: 1,
        });
        expect((transformRequest?.messages as unknown[]).length).toBe(0);
        expect((transformRequest?.native_messages as unknown[]).length).toBe(0);
        expect(secondOutput.messages).toEqual(native);
    });

    it("forwards resolved auto-search controls, including an explicit disabled state", async () => {
        const db = makeDb();
        const requests: Record<string, unknown>[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requests.push(body as Record<string, unknown>);
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createRustModeTransform(deps, { moduleClient });

        const enabledSession = `rust-auto-search-enabled-${Date.now()}`;
        sessions.push(enabledSession);
        installRawProvider(enabledSession);
        deps.autoSearch = { enabled: true, scoreThreshold: 0.73, minPromptChars: 47 };
        const enabledMessages = makeMessages(enabledSession);
        await transform.run(
            enabledSession,
            enabledMessages,
            { messages: enabledMessages as unknown[] },
            makeMeta(db, enabledSession),
        );

        expect(requests.at(-1)).toEqual(
            expect.objectContaining({
                auto_search_enabled: true,
                auto_search_score_threshold: 0.73,
                auto_search_min_prompt_chars: 47,
            }),
        );

        const disabledSession = `rust-auto-search-disabled-${Date.now()}`;
        sessions.push(disabledSession);
        installRawProvider(disabledSession);
        deps.autoSearch = { enabled: false, scoreThreshold: 0.91, minPromptChars: 83 };
        const disabledMessages = makeMessages(disabledSession);
        await transform.run(
            disabledSession,
            disabledMessages,
            { messages: disabledMessages as unknown[] },
            makeMeta(db, disabledSession),
        );

        expect(requests.at(-1)).toEqual(
            expect.objectContaining({
                auto_search_enabled: false,
                auto_search_score_threshold: 0.91,
                auto_search_min_prompt_chars: 83,
            }),
        );
    });

    it("sends canonical Astra identity and live effort to the Rust wire for a Pi-native alias", async () => {
        const sessionId = `rust-model-alias-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        let transformRequest: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: false,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.variantBySession = new Map([[sessionId, "xhigh"]]);
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "openai-codex", modelID: "gpt-6-astra" };

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(transformRequest?.model_key).toBe("openai/gpt-6-astra");
        expect(transformRequest?.prompt_surface_model_key).toBe("openai/gpt-6-astra");
        expect(transformRequest?.render_config).toContain("model:openai/gpt-6-astra");
        expect(transformRequest?.render_config).toContain("variant:xhigh");
    });

    it("memoizes stable session and memory project identities", async () => {
        const sessionId = `rust-project-identity-cache-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let sessionIdentityReads = 0;
        let memoryIdentityReads = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 1,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        deps.memoryConfig = { enabled: true, injectionBudgetTokens: 1_000, autoPromote: false };
        deps.sessionDirectoryBySession?.set(sessionId, "/stable/session-root");
        const transform = createRustModeTransform(deps, {
            moduleClient,
            sessionProjectIdentityResolverForTests: () => {
                sessionIdentityReads += 1;
                return "git:stable-project";
            },
            memoryProjectIdentityResolverForTests: () => {
                memoryIdentityReads += 1;
                return "git:stable-project";
            },
        });
        const digests: string[] = [];
        for (let pass = 0; pass < 2; pass += 1) {
            const messages = makeMessages(sessionId);
            const output = { messages: [...messages] as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            digests.push(
                createHash("sha256").update(JSON.stringify(output.messages)).digest("hex"),
            );
        }

        expect(sessionIdentityReads).toBe(1);
        expect(memoryIdentityReads).toBe(1);
        expect(digests[1]).toBe(digests[0]);

        deps.sessionDirectoryBySession?.set(sessionId, "/moved/session-root");
        const movedMessages = makeMessages(sessionId);
        const movedOutput = { messages: [...movedMessages] as unknown[] };
        await transform.run(sessionId, movedMessages, movedOutput, makeMeta(db, sessionId));
        expect(sessionIdentityReads).toBe(2);
        expect(memoryIdentityReads).toBe(2);
        expect(
            createHash("sha256").update(JSON.stringify(movedOutput.messages)).digest("hex"),
        ).toBe(digests[0]);
    });

    it("skips acknowledged state watermark reads until an observed input changes", async () => {
        const sessionId = `rust-state-sync-hot-cache-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let stateSyncCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "state_sync") {
                    stateSyncCalls += 1;
                    return { ok: true };
                }
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 1,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const memorySyncRequestedSessions = new Set<string>();
        const originalPrepare = db.prepare.bind(db);
        let watermarkReads = 0;
        db.prepare = ((sql: string) => {
            if (/MAX\(sequence\)|m0_mutation_log|project_state|workspace_members/i.test(sql)) {
                watermarkReads += 1;
            }
            return originalPrepare(sql);
        }) as typeof db.prepare;
        const transform = createRustModeTransform(deps, {
            moduleClient,
            memorySyncRequestedSessions,
        });
        const run = async () => {
            const messages = makeMessages(sessionId);
            const output = { messages: [...messages] as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            return createHash("sha256").update(JSON.stringify(output.messages)).digest("hex");
        };

        const firstSha = await run();
        const readsAfterPrime = watermarkReads;
        const syncsAfterPrime = stateSyncCalls;
        expect(await run()).toBe(firstSha);
        expect(watermarkReads).toBe(readsAfterPrime);
        expect(stateSyncCalls).toBe(syncsAfterPrime);

        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"changed"}]' });
        expect(await run()).toBe(firstSha);
        expect(watermarkReads).toBeGreaterThan(readsAfterPrime);
        expect(stateSyncCalls).toBeGreaterThan(syncsAfterPrime);
        const readsAfterMeta = watermarkReads;

        memorySyncRequestedSessions.add(sessionId);
        expect(await run()).toBe(firstSha);
        expect(watermarkReads).toBeGreaterThan(readsAfterMeta);
    });

    it("re-arms auto-embed when the module publishes compartments into context.db", async () => {
        const sessionId = `rust-auto-embed-rearm-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let rowVersion = 1;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: rowVersion,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] as unknown[] },
                makeMeta(db, sessionId),
            );
            // The compartment check runs in a background task; let it settle.
            await new Promise((resolve) => setTimeout(resolve, 20));
        };

        await run();
        autoEmbedAttemptedBySession.add(sessionId);
        await run();
        expect(autoEmbedAttemptedBySession.has(sessionId)).toBe(true);

        // What the module does on a historian publish: a new shared row plus a new
        // row_version on the next transform response.
        db.prepare(
            `INSERT INTO compartments (session_id, sequence, start_message, end_message,
                start_message_id, end_message_id, title, content, created_at)
             VALUES (?, 0, 1, 2, 'm1', 'm2', 'published', 'published by the module', ?)`,
        ).run(sessionId, Date.now());
        rowVersion = 2;
        await run();
        expect(autoEmbedAttemptedBySession.has(sessionId)).toBe(false);
        autoEmbedAttemptedBySession.delete(sessionId);
    });

    it("forwards the model-routed prompt preset and description overrides", async () => {
        const sessionId = `rust-prompt-surface-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        let transformRequest: Record<string, unknown> | undefined;
        let guidanceResolves = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: false,
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.promptSurface = {
            default: "full",
            models: { "anthropic/opus": "light" },
            guidance_override_path: "trusted-guidance.md",
            tool_descriptions: { ctx_search: "Search the project memory index." },
        };
        deps.promptSurfaceRuntime = {
            resolveRegistration: () => ({
                preset: "full",
                descriptionFor: (_toolId, fullDescription) => fullDescription,
            }),
            resolveGuidance: () => {
                guidanceResolves += 1;
                return {
                    preset: "light",
                    primaryOverride: "## Magic Context\n\nTrusted user guidance.",
                };
            },
        };
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "anthropic", modelID: "opus" };

        const firstOutput = { messages: messages as unknown[] };
        await transform.run(sessionId, messages, firstOutput, makeMeta(db, sessionId));
        const firstSha = createHash("sha256")
            .update(JSON.stringify(firstOutput.messages))
            .digest("hex");
        const repeatedMessages = makeMessages(sessionId);
        repeatedMessages[0].info.model = { providerID: "anthropic", modelID: "opus" };
        const repeatedOutput = { messages: repeatedMessages as unknown[] };
        await transform.run(sessionId, repeatedMessages, repeatedOutput, makeMeta(db, sessionId));

        expect(guidanceResolves).toBe(1);
        expect(
            createHash("sha256").update(JSON.stringify(repeatedOutput.messages)).digest("hex"),
        ).toBe(firstSha);
        expect(transformRequest?.prompt_surface_preset).toBe("light");
        expect(transformRequest?.prompt_surface_model_key).toBe("anthropic/opus");
        expect(transformRequest?.prompt_surface_config_identity).toBe(
            promptSurfaceConfigIdentity(deps.promptSurface),
        );
        expect(transformRequest?.prompt_surface_tool_descriptions).toEqual({
            ctx_search: "Search the project memory index.",
        });
        expect(transformRequest?.prompt_surface_guidance_override).toBe(
            "## Magic Context\n\nTrusted user guidance.",
        );
        expect(transformRequest?.prompt_surface_guidance_override).not.toBe(
            deps.promptSurface.guidance_override_path,
        );
    });

    it("sends the resolved historian timeout and default on the transform request", async () => {
        for (const [configured, expected] of [
            [720_000, 720_000],
            [undefined, 600_000],
        ] as const) {
            const sessionId = `rust-historian-timeout-${configured ?? "default"}-${Date.now()}`;
            sessions.push(sessionId);
            const db = makeDb();
            installRawProvider(sessionId);
            let requestBody: Record<string, unknown> | undefined;
            const moduleClient: RustModeModuleClient = {
                call: async ({ method, body }) => {
                    if (method === "transform") requestBody = body as Record<string, unknown>;
                    return method === "transform"
                        ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                        : { ok: true };
                },
            };
            const deps = makeDeps(db, moduleClient);
            deps.historianTimeoutMs = configured;
            const transform = createRustModeTransform(deps, { moduleClient });
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: messages as unknown[] },
                makeMeta(db, sessionId),
            );
            expect(requestBody?.historian_timeout_ms).toBe(expected);
        }
    });

    it("sends fail-closed tool verdicts while availability remains provisional", async () => {
        const sessionId = `rust-availability-provisional-${Date.now()}`;
        sessions.push(sessionId);
        installAvailabilityDb(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages: MessageLike[] = [
            {
                info: { id: "m1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "assistant" }],
            },
        ];

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(requestBodies).toHaveLength(1);
        expect(requestBodies[0]?.tool_present).toBe(false);
        expect(requestBodies[0]?.todo_tool_present).toBe(false);
    });

    it("resolves the first user prompt's ctx_reduce verdict before its DB row exists", async () => {
        for (const [tools, expected] of [
            [{}, true],
            [{ "*": false, read: true }, false],
        ] as const) {
            const sessionId = `rust-first-prompt-availability-${expected}-${Date.now()}`;
            sessions.push(sessionId);
            installAvailabilityDb(sessionId);
            const db = makeDb();
            installRawProvider(sessionId);
            let requestBody: Record<string, unknown> | undefined;
            const moduleClient: RustModeModuleClient = {
                call: async ({ method, body }) => {
                    if (method === "transform") requestBody = body as Record<string, unknown>;
                    return method === "transform"
                        ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                        : { ok: true };
                },
            };
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const messages = makeMessages(sessionId);
            messages[0]!.info.tools = tools;
            await transform.run(
                sessionId,
                messages,
                { messages: messages as unknown[] },
                makeMeta(db, sessionId),
            );
            expect(requestBody?.tool_present).toBe(expected);
        }
    });

    it("sends a frozen disabled todowrite verdict on the transform wire", async () => {
        const sessionId = `rust-todo-disabled-${Date.now()}`;
        sessions.push(sessionId);
        installAvailabilityDb(sessionId, { "*": false, read: true });
        const db = makeDb();
        installRawProvider(sessionId);
        let requestBody: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBody = body as Record<string, unknown>;
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0]!.info.tools = { "*": false, read: true };

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(requestBody?.todo_tool_present).toBe(false);
    });

    it("reuses the persisted todo verdict on defer and probes a permission flip at execute pressure", async () => {
        const sessionId = "rust-todo-bust-permission";
        sessions.push(sessionId);
        installAvailabilityDb(sessionId, {});
        const db = makeDb();
        installRawProvider(sessionId);
        const bodies: Record<string, unknown>[] = [];
        updateSessionMeta(db, sessionId, {
            lastTodoState: '[{"content":"pending work","status":"pending","priority":"medium"}]',
        });
        let decision = "HARD";
        let materializeReason = "first_render";
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                bodies.push(body as Record<string, unknown>);
                return {
                    decision,
                    prefix_bust_permitted: decision === "HARD",
                    materialize_reason: materializeReason,
                    native_messages: makeMessages(sessionId),
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        let denied = false;
        const agents = mock(async () => ({
            data: [{ name: "build", permission: { todowrite: denied ? "deny" : "allow" } }],
        }));
        const get = mock(async () => ({ data: { agent: "build", directory: "/tmp/project" } }));
        deps.client = { app: { agents }, session: { get } } as never;
        deps.sessionDirectoryBySession!.set(sessionId, "/tmp/project");
        const transform = createRustModeTransform(deps, { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            messages[0]!.info.tools = {};
            (messages[0]!.info as { agent?: string }).agent = "build";
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );
        };
        await run();
        expect(bodies.at(-1)?.todo_tool_present).toBe(true);
        agents.mockClear();
        get.mockClear();
        denied = true;
        decision = "SOFT+";
        await run();
        expect(agents).toHaveBeenCalledTimes(0);
        expect(get).toHaveBeenCalledTimes(0);
        expect(bodies.at(-1)?.todo_tool_present).toBe(true);
        expect(bodies.at(-1)?.todo_verdict_probed).toBe(false);
        expect(bodies.at(-1)?.verdict_stale_ok).toBe(false);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 100_000, percentage: 90 },
            updatedAt: Date.now(),
        });
        decision = "HARD";
        await run();
        expect(agents).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(bodies.at(-1)?.todo_tool_present).toBe(false);
        expect(bodies.at(-1)?.todo_verdict_probed).toBe(true);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 100, percentage: 1 },
            updatedAt: Date.now(),
        });
        materializeReason = "boundary_divergence_recut";
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            await run();
            const logs = logSpy.mock.calls.map(([, message]) => message);
            expect(
                logs.some((line) =>
                    line.includes(
                        "todo_permission_probe_miss decision=HARD reason=boundary_divergence_recut",
                    ),
                ),
            ).toBe(true);
            expect(
                logs.some(
                    (line) =>
                        line.startsWith("rust pass:") && line.includes("todo_unprobed_bust:1"),
                ),
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("sends the combined todowrite map and live-permission verdict", async () => {
        const sessionId = `rust-todo-permission-denied-${Date.now()}`;
        sessions.push(sessionId);
        installAvailabilityDb(sessionId, {});
        const db = makeDb();
        installRawProvider(sessionId);
        let requestBody: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBody = body as Record<string, unknown>;
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const agents = mock(async () => ({
            data: [{ name: "build", permission: { todowrite: "deny" } }],
        }));
        deps.client = {
            app: { agents },
            session: {
                get: async () => ({ data: { agent: "build", directory: "/tmp/project" } }),
            },
        } as never;
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0]!.info.tools = {};
        (messages[0]!.info as { agent?: string }).agent = "build";

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(agents).toHaveBeenCalledTimes(1);
        expect(requestBody?.todo_tool_present).toBe(false);
    });

    it("probes changed todowrites and agent identity, not full-wire retries or unrelated refreshes", async () => {
        const sessionId = "rust-todo-related-only";
        sessions.push(sessionId);
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const db = makeDb();
        const bodies: Record<string, unknown>[] = [];
        let needFull = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                bodies.push(body as Record<string, unknown>);
                if (needFull) {
                    needFull = false;
                    return { need_full_sync: true };
                }
                return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const agents = mock(async () => ({ data: [{ name: "build", permission: {} }] }));
        const get = mock(async () => ({ data: { agent: "build" } }));
        deps.client = { app: { agents }, session: { get } } as never;
        deps.sessionDirectoryBySession!.set(sessionId, "/tmp/project");
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        (input[0].info as { agent?: string }).agent = "build";
        const run = async () => {
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
        };
        await run();
        expect(agents).toHaveBeenCalledTimes(1);
        agents.mockClear();
        get.mockClear();
        for (let pass = 0; pass < 12; pass++) {
            transform.invalidateWireState(sessionId);
            deps.historyRefreshSessions.add(sessionId);
            deps.contextUsageMap.set(sessionId, {
                usage: { inputTokens: 100_000, percentage: 90 },
                updatedAt: Date.now(),
            });
            input[0].parts = [{ type: "text", text: `unrelated edit ${pass}` }];
            await run();
        }
        needFull = true;
        await run();
        expect(agents).toHaveBeenCalledTimes(0);
        expect(get).toHaveBeenCalledTimes(0);
        expect(bodies.at(-1)?.todo_verdict_probed).toBe(false);
        input[0].parts.push({
            type: "tool",
            tool: "todowrite",
            callID: "new-todo",
            state: {
                status: "completed",
                input: { todos: [] },
                output: "[]",
            },
        });
        await run();
        expect(agents).toHaveBeenCalledTimes(1);
        await run();
        expect(agents).toHaveBeenCalledTimes(1);
        // A late completion on an older message is a todo change even on a full wire.
        (input[0].parts.at(-1)!.state as { output: string }).output = "updated";
        await run();
        expect(agents).toHaveBeenCalledTimes(2);
        (input[0].info as { agent?: string }).agent = "plan";
        await run();
        expect(agents).toHaveBeenCalledTimes(3);
    });

    it("defers a repeated module directive until the terminal boundary", async () => {
        const sessionId = `rust-channel2-refire-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const native = [{ role: "assistant", parts: [] }];
        const promptAsync = mock(async () => ({}));
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          native_messages: native,
                          host_directives: {
                              channel2_nudge: { text: "drop spent tool output" },
                          },
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            hostClient: {
                session: {
                    messages: async () => ({ data: [] }),
                    promptAsync,
                },
            },
        });

        const firstInput = makeMessages(sessionId);
        await expect(
            transform.run(sessionId, firstInput, { messages: firstInput }, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        const syntheticInput = [
            ...makeMessages(sessionId),
            {
                info: { id: "channel2-nudge-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "drop spent tool output", synthetic: true }],
            },
        ];
        await expect(
            transform.run(
                sessionId,
                syntheticInput,
                { messages: syntheticInput },
                makeMeta(db, sessionId),
            ),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        expect(getChannel2NudgeState(db, sessionId)).toBe("");
        expect(promptAsync).not.toHaveBeenCalled();
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(1);
    });

    it("breaks a synthetic-turn cascade after three turns", async () => {
        const sessionId = `rust-loop-breaker-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const promptAsync = mock(async () => ({}));
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          native_messages: [{ role: "assistant", parts: [] }],
                          host_directives: {
                              channel2_nudge: { text: "drop spent tool output" },
                          },
                      }
                    : { ok: true },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            hostClient: {
                session: {
                    messages: async () => ({ data: [] }),
                    promptAsync,
                },
            },
        });

        for (let turn = 1; turn <= 4; turn += 1) {
            setChannel2NudgeState(db, sessionId, "pending");
            const input = [
                ...makeMessages(sessionId),
                {
                    info: { id: `synthetic-${turn}`, role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "synthetic turn", synthetic: true }],
                },
            ];
            await transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId));
        }

        expect(promptAsync).toHaveBeenCalledTimes(0);
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(4);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");

        setChannel2NudgeState(db, sessionId, "pending");
        const realInput = makeMessages(sessionId);
        await transform.run(sessionId, realInput, { messages: realInput }, makeMeta(db, sessionId));
        expect(promptAsync).toHaveBeenCalledTimes(0);
        expect(getChannel2NudgeState(db, sessionId)).toBe("pending");
        expect(transform.getState(sessionId).syntheticTurnCount).toBe(0);
    });

    it("re-pages every transform payload after need_full_sync", async () => {
        const sessionId = `rust-repage-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
        const native = [{ role: "assistant", parts: [] }];
        const transformBodies: Array<Record<string, unknown>> = [];
        let retryStarted = false;
        let capabilityInvalidations = 0;
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => {
                capabilityInvalidations += 1;
            },
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformBodies.push(page);
                if (!retryStarted && page.transform_page_complete === true) {
                    retryStarted = true;
                    return { status: "need_full_sync" };
                }
                return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: messages as unknown[] };
        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        const pageIds = new Set(transformBodies.map((body) => body.transform_page_id));
        expect(pageIds.size).toBe(1);
        expect(transformBodies.length).toBeGreaterThan(2);
        expect(
            transformBodies.every((body) =>
                [
                    "transform_page_id",
                    "transform_generation",
                    "transform_page_index",
                    "transform_page_total",
                    "transform_page_complete",
                    "transform_page_digest",
                ].every((field) => field in body),
            ),
        ).toBe(true);
        expect(transformBodies.at(-1)?.tool_present).toBe(true);
        expect(transformBodies.at(-1)?.todo_tool_present).toBe(true);
        expect(capabilityInvalidations).toBe(0);
        expect(output.messages).toEqual(native);
    });

    it("forwards the served response clock and adopted system identity without hiding an omitted bootstrap hash", async () => {
        const sessionId = `rust-idle-system-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const bodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => undefined,
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                bodies.push(body as Record<string, unknown>);
                return {
                    decision: "SOFT+",
                    prefix_bust_permitted: false,
                    native_messages: [
                        { role: "assistant", parts: [{ type: "text", text: "stable" }] },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        for (const hash of ["", "oct02", "oct03"]) {
            const meta = makeMeta(db, sessionId);
            meta.systemPromptHash = hash;
            meta.cachedM0SystemHash = hash;
            meta.lastResponseTime = 123;
            const messages = makeMessages(sessionId);
            await transform.run(sessionId, messages, { messages: messages as unknown[] }, meta);
        }
        expect(bodies.map((body) => body.system_prompt_hash)).toEqual(["", "oct02", "oct03"]);
        expect(bodies.map((body) => body.adopted_system_prompt_hash)).toEqual([
            undefined,
            "oct02",
            "oct03",
        ]);
        expect(bodies.map((body) => body.prev_response_completed_at_ms)).toEqual([123, 123, 123]);
    });

    it("sends the same render identity on the need_full_sync full-array retry", async () => {
        // The module HARD-renders whenever the render identity changes. A retry that
        // drops a field (the reasoning variant) records a different identity, and the
        // next ordinary pass changes it back: two HARDs for one module restart.
        const sessionId = `rust-retry-identity-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        let transforms = 0;
        const native = [{ role: "assistant", parts: [{ type: "text", text: "stable" }] }];
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => undefined,
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(body as Record<string, unknown>);
                transforms += 1;
                // Pass two sends a tail delta that the restarted module cannot apply.
                if (transforms === 2) return { status: "need_full_sync" };
                return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.variantBySession = new Map([[sessionId, "high"]]);
        const transform = createRustModeTransform(deps, { moduleClient });
        for (let pass = 0; pass < 3; pass += 1) {
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: messages as unknown[] },
                makeMeta(db, sessionId),
            );
        }

        // steady full send, rejected tail delta, full-array retry, next ordinary pass
        expect(transformBodies.length).toBe(4);
        const [steady, rejectedDelta, retry, next] = transformBodies;
        expect("tail_delta" in (rejectedDelta ?? {})).toBe(true);
        expect("tail_delta" in (retry ?? {})).toBe(false);
        expect(steady?.render_config).toContain("variant:high");
        for (const body of [rejectedDelta, retry, next]) {
            expect(body?.render_config).toBe(steady?.render_config);
            for (const field of [
                "model_key",
                "provider_id",
                "system_prompt_hash",
                "adopted_system_prompt_hash",
                "upgrade_state",
            ]) {
                expect(body?.[field]).toEqual(steady?.[field]);
            }
        }
    });

    it("does not reseed after a healthy pass loses its delta base", async () => {
        const sessionId = `rust-restart-resync-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const calls: string[] = [];
        const native = [{ role: "assistant", parts: [{ type: "text", text: "stable" }] }];
        let transforms = 0;
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => undefined,
            call: async ({ method }) => {
                calls.push(method);
                if (method === "state_sync") return { ok: true };
                if (method !== "transform") return { ok: true };
                transforms += 1;
                if (transforms === 2) return { status: "need_full_sync" };
                return {
                    decision: transforms === 3 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: transforms === 3,
                    native_messages: native,
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        for (let pass = 0; pass < 22; pass += 1) {
            const messages = makeMessages(sessionId);
            const output = { messages: messages as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            expect(output.messages).toEqual(native);
        }

        expect(calls.filter((method) => method === "state_sync")).toHaveLength(1);
        expect(calls.filter((method) => method === "transform")).toHaveLength(23);
        expect(transforms).toBe(23);
    });

    it("keeps ordinal resolution bounded on a 10k-row session after failed passes and a removal", async () => {
        const sessionId = `rust-bounded-ordinal-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        const ROWS = 10_000;
        const rows = Array.from({ length: ROWS }, (_, index) => ({
            id: `m-${String(index + 1).padStart(6, "0")}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        const store = { ordinalRows: 0, fullReads: 0 };
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => {
                    store.fullReads += 1;
                    return [];
                },
                readMessageOrdinalPage: (after, limit) => {
                    const page = rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit);
                    store.ordinalRows += page.length;
                    return page;
                },
                getStoredMessageCount: () => rows.length,
            }),
        );
        // OpenCode hands the adapter only the post-compaction tail while the host store
        // keeps every row, which is the shape of the session that stalled.
        const wire = (): MessageLike[] =>
            rows.slice(-3).map((row) => ({
                info: {
                    id: row.id,
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: row.id }],
            }));
        const native = [{ role: "assistant", parts: [{ type: "text", text: "stable" }] }];
        let transforms = 0;
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => undefined,
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                transforms += 1;
                // Second pass: the module lost the delta base. Third pass: the module
                // times out and the adapter serves its last good array.
                if (transforms === 2)
                    return {
                        status: "need_full_sync",
                        need_full_sync_reason: "native_prefix_unavailable",
                    };
                if (transforms === 4 || transforms === 5)
                    throw new Error("rust module transform timed out");
                return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
            });
            const runPass = async () => {
                const messages = wire();
                await transform.run(
                    sessionId,
                    messages,
                    { messages: messages as unknown[] },
                    makeMeta(db, sessionId),
                );
            };
            await runPass();
            expect(store.ordinalRows).toBe(ROWS);
            store.ordinalRows = 0;
            store.fullReads = 0;
            logSpy.mockClear();

            await runPass(); // need_full_sync, then the full-array retry
            expect(
                logSpy.mock.calls.some(
                    ([, line]) =>
                        line ===
                        "need_full_sync retry=full ordinal_memo=kept reason=native_prefix_unavailable",
                ),
            ).toBe(true);
            await runPass(); // module timeout, served from the last good array
            rows.push({
                id: `m-${String(ROWS + 1).padStart(6, "0")}`,
                timeCreated: ROWS + 1,
                contributesOrdinal: true,
                hasValidInfo: true,
            });
            await runPass(); // the resumed turn with one new message

            expect(transforms).toBe(6);
            expect(store.ordinalRows).toBeLessThanOrEqual(MODULE_ORDINAL_PAGE_SIZE);
            expect(store.fullReads).toBe(0);
            const ordinalLines = logSpy.mock.calls
                .map((call) => String(call[1]))
                .filter((line) => line.includes("stage=rust.ordinal_resolve"));
            expect(ordinalLines.length).toBeGreaterThanOrEqual(3);
            expect(ordinalLines.some((line) => line.includes("mode=prime"))).toBe(false);
            const elapsedMs = ordinalLines.map((line) =>
                Number(/elapsed=([\d.]+)ms/.exec(line)?.[1] ?? Number.NaN),
            );
            expect(elapsedMs.every((ms) => ms < 250)).toBe(true);

            // A reverted message near the tail: the removal event must not send the next
            // pass back to the first row of the session.
            rows.splice(rows.length - 2, 1);
            transform.invalidateWireState(sessionId);
            store.ordinalRows = 0;
            logSpy.mockClear();
            await runPass();
            expect(transforms).toBe(7);
            expect(store.ordinalRows).toBeLessThanOrEqual(2 * MODULE_ORDINAL_PAGE_SIZE);
            expect(store.fullReads).toBe(0);
            const removalLines = logSpy.mock.calls
                .map((call) => String(call[1]))
                .filter((line) => line.includes("stage=rust.ordinal_resolve"));
            expect(removalLines.some((line) => line.includes("mode=rewind"))).toBe(true);
            expect(removalLines.some((line) => line.includes("mode=prime"))).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("restarts a paged transform series after an attempt mismatch", async () => {
        const sessionId = `rust-series-restart-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
        const native = [{ role: "assistant", parts: [] }];
        const transformBodies: Array<Record<string, unknown>> = [];
        let failedPageId: unknown;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformBodies.push(page);
                if (page.transform_page_index === 1 && failedPageId === undefined) {
                    failedPageId = page.transform_page_id;
                    throw Object.assign(
                        new Error(
                            "transform page generation or envelope changed during collection",
                        ),
                        { code: "authority_transform_page_attempt_mismatch" },
                    );
                }
                return page.transform_page_complete === true
                    ? {
                          decision: "HARD",
                          prefix_bust_permitted: true,
                          served_from: "transform",
                          native_messages: native,
                      }
                    : { staged: true };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const output = { messages: messages as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformBodies.filter((page) => page.transform_page_index === 0);
            const pageIds = new Set(seriesStarts.map((page) => page.transform_page_id));
            expect(seriesStarts).toHaveLength(2);
            expect(pageIds.size).toBe(1);
            expect(failedPageId).toBe(seriesStarts[0]?.transform_page_id);
            expect(seriesStarts[1]?.transform_page_id).toBe(seriesStarts[0]?.transform_page_id);
            expect(output.messages).toEqual(native);
            const logged = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => message);
            expect(logged).toContain(
                `transform_series_restart reason=attempt_mismatch pages=${seriesStarts[0]?.transform_page_total} at_page=1`,
            );
            expect(logged.some((message) => message.includes("served_from=transform"))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("restarts a paged transform series after a mid-series reconnect", async () => {
        const sessionId = `rust-series-reconnect-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
        const native = [{ role: "assistant", parts: [] }];
        const transformCalls: Array<{
            body: Record<string, unknown>;
            generationSensitive: boolean | undefined;
        }> = [];
        let reconnectReported = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, generationSensitive }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformCalls.push({ body: page, generationSensitive });
                if (page.transform_page_index === 1 && !reconnectReported) {
                    reconnectReported = true;
                    return {
                        transport_status: "connection_generation_changed",
                        previous_generation: 3,
                        current_generation: 4,
                    };
                }
                return page.transform_page_complete === true
                    ? {
                          decision: "HARD",
                          prefix_bust_permitted: true,
                          served_from: "transform",
                          native_messages: native,
                      }
                    : { staged: true };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const output = { messages: messages as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformCalls.filter(
                ({ body }) => body.transform_page_index === 0,
            );
            expect(seriesStarts).toHaveLength(2);
            expect(new Set(seriesStarts.map(({ body }) => body.transform_page_id)).size).toBe(1);
            expect(
                transformCalls.find(({ body }) => body.transform_page_index === 1)
                    ?.generationSensitive,
            ).toBe(true);
            expect(output.messages).toEqual(native);
            const logged = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => message);
            expect(logged).toContain(
                `transform_series_restart reason=reconnect pages=${seriesStarts[0]?.body.transform_page_total} at_page=1`,
            );
        } finally {
            logSpy.mockRestore();
        }
    });

    it("fails a completed-series timeout without uploading the page series again", async () => {
        const sessionId = `rust-series-execute-timeout-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "row ".repeat(150_000) }];
        recordDetectedContextLimit(db, sessionId, 1_000_000, "test-provider/test-model");
        const transformCalls: Array<{
            body: Record<string, unknown>;
            attemptClass: string | undefined;
            timeoutMs: number | undefined;
        }> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, attemptClass, timeoutMs }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformCalls.push({ body: page, attemptClass, timeoutMs });
                if (page.transform_page_complete === true) {
                    throw Object.assign(new Error("cold execute deadline"), { code: "ETIMEDOUT" });
                }
                return { staged: true };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const output = { messages: [] as unknown[] };
            await expect(
                transform.run(sessionId, messages, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);

            const seriesStarts = transformCalls.filter(
                ({ body }) => body.transform_page_index === 0,
            );
            expect(seriesStarts).toHaveLength(1);
            expect(transformCalls.at(-1)?.attemptClass).toBe("transform_series_execute");
            // Give cold execution and its one identical-final-page retry the full 45-second timeout.
            expect(transformCalls.at(-1)?.timeoutMs).toBe(45_000);
            const finals = transformCalls.filter(
                ({ body }) => body.transform_page_complete === true,
            );
            expect(finals).toHaveLength(2);
            expect(finals[0].body).toEqual(finals[1].body);
            expect(
                transformCalls
                    .filter(({ body }) => body.transform_page_complete !== true)
                    .every(({ attemptClass }) => attemptClass === "transform_page_upload"),
            ).toBe(true);
            expect(output.messages).toEqual([]);
            const logged = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => message);
            expect(logged.some((message) => message.startsWith("transform_series_restart"))).toBe(
                false,
            );
            expect(logged.some((message) => message.startsWith("rust transform failed"))).toBe(
                true,
            );
        } finally {
            logSpy.mockRestore();
        }
    });

    it("refuses after a second paged transform series mismatch", async () => {
        const sessionId = `rust-series-restart-bound-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "row ".repeat(150_000) }];
        recordDetectedContextLimit(db, sessionId, 1_000_000, "test-provider/test-model");
        const transformBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformBodies.push(page);
                if (page.transform_page_index === 1) {
                    throw Object.assign(new Error("attempt mismatch"), {
                        code: "authority_transform_page_attempt_mismatch",
                    });
                }
                return { staged: true };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const output = { messages: [] as unknown[] };
            await expect(
                transform.run(sessionId, messages, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);

            const seriesStarts = transformBodies.filter((page) => page.transform_page_index === 0);
            expect(seriesStarts).toHaveLength(2);
            expect(new Set(seriesStarts.map((page) => page.transform_page_id)).size).toBe(1);
            expect(output.messages).toEqual([]);
            const logged = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => message);
            expect(
                logged.filter((message) => message.startsWith("transform_series_restart")),
            ).toHaveLength(1);
            expect(logged.some((message) => message.startsWith("rust transform failed"))).toBe(
                true,
            );
        } finally {
            logSpy.mockRestore();
        }
    });

    it("re-primes all ordinal memo state after a durable message removal", async () => {
        const sessionId = `rust-removal-reprime-${Date.now()}`;
        sessions.push(sessionId);
        const rows = [
            { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true },
            { id: "m2", timeCreated: 2, contributesOrdinal: true, hasValidInfo: true },
        ];
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") transformCalls += 1;
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: [] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = () =>
            rows.map((row) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: row.id }],
            }));
        const initial = messages();
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );

        rows.splice(1, 1);
        transform.invalidateWireState(sessionId);
        const afterRemoval = messages();
        await transform.run(
            sessionId,
            afterRemoval,
            { messages: [...afterRemoval] },
            makeMeta(db, sessionId),
        );

        expect(transformCalls).toBe(2);
        expect(transform.getState(sessionId).ordinalMemoStoredCount).toBe(1);
        expect(transform.getState(sessionId).ordinalMemoCanonicalCount).toBe(1);
        expect(transform.getState(sessionId).idOrdinalMemo).toEqual(new Map([["m1", 1]]));
    });

    it("clears Rust state, wire caches, and the transport route for a deleted session", async () => {
        const sessionId = `rust-clear-session-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        const deleteSession = mock(async () => {});
        const closeSession = mock(() => {});
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformBodies.push(body as Record<string, unknown>);
                return method === "transform"
                    ? { decision: "PASSTHROUGH", native_messages: [] }
                    : { ok: true };
            },
            deleteSession,
            closeSession,
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            projectRoot: "/tmp/rust-clear-session-project",
        });
        for (let pass = 0; pass < 2; pass += 1) {
            const input = makeMessages(sessionId);
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
        }
        expect(transformBodies[1]?.tail_delta).toBeDefined();

        await transform.clearSession(sessionId);
        expect(deleteSession).toHaveBeenCalledWith(sessionId, "/tmp/rust-clear-session-project");
        expect(closeSession).toHaveBeenCalledWith(sessionId);
        const afterClear = makeMessages(sessionId);
        await transform.run(
            sessionId,
            afterClear,
            { messages: [...afterClear] },
            makeMeta(db, sessionId),
        );

        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[2]?.messages).toHaveLength(1);
        expect(transform.getState(sessionId).passCount).toBe(1);
    });

    it("does not let an in-flight transform repopulate a deleted session route", async () => {
        const sessionId = `rust-clear-session-in-flight-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        let releaseTransform!: (value: unknown) => void;
        let transformStarted!: () => void;
        const transformStartedPromise = new Promise<void>((resolve) => {
            transformStarted = resolve;
        });
        const pendingTransform = new Promise<unknown>((resolve) => {
            releaseTransform = resolve;
        });
        let releaseDelete!: () => void;
        const pendingDelete = new Promise<void>((resolve) => {
            releaseDelete = resolve;
        });
        let transformCalls = 0;
        const deleteSession = mock(() => pendingDelete);
        const closeSession = mock(() => {});
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(body as Record<string, unknown>);
                transformCalls += 1;
                if (transformCalls === 2) {
                    transformStarted();
                    return pendingTransform;
                }
                return { decision: "PASSTHROUGH", native_messages: [] };
            },
            deleteSession,
            closeSession,
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            projectRoot: "/tmp/rust-clear-session-in-flight-project",
            scheduleLkgCapture: (capture) => capture(),
        });
        const initial = makeMessages(sessionId);
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );
        const racingInput = makeMessages(sessionId);
        const racingRun = transform.run(
            sessionId,
            racingInput,
            { messages: [...racingInput] },
            makeMeta(db, sessionId),
        );
        await transformStartedPromise;

        const clearing = transform.clearSession(sessionId);
        expect(deleteSession).toHaveBeenCalledWith(
            sessionId,
            "/tmp/rust-clear-session-in-flight-project",
        );
        releaseTransform({ decision: "PASSTHROUGH", native_messages: [] });
        await racingRun;
        releaseDelete();
        await clearing;

        const afterDelete = makeMessages(sessionId);
        await transform.run(
            sessionId,
            afterDelete,
            { messages: [...afterDelete] },
            makeMeta(db, sessionId),
        );
        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[2]?.messages).toHaveLength(1);
        expect(closeSession).toHaveBeenCalledWith(sessionId);
    });

    it("propagates module deletion failures while still closing the transport route", async () => {
        const sessionId = `rust-clear-session-failure-${Date.now()}`;
        const db = makeDb();
        const deleteSession = mock(async () => {
            throw new Error("module unavailable");
        });
        const closeSession = mock(() => {});
        const moduleClient: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            deleteSession,
            closeSession,
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            projectRoot: "/tmp/rust-clear-session-failure-project",
        });

        await expect(transform.clearSession(sessionId)).rejects.toThrow("module unavailable");
        expect(deleteSession).toHaveBeenCalledWith(
            sessionId,
            "/tmp/rust-clear-session-failure-project",
        );
        expect(closeSession).toHaveBeenCalledWith(sessionId);
    });

    it("measures the 2,000-message hot-path cache differential with stage logs", async () => {
        const stageNames = [
            "identity_resolve",
            "prompt_surface",
            "mural_resolve",
            "ordinal_resolve",
            "state_sync",
            "mirror_pull",
            "compartment_mirror",
        ] as const;
        type StageName = (typeof stageNames)[number];
        const median = (values: number[]): number => {
            const ordered = [...values].sort((left, right) => left - right);
            return ordered[Math.floor(ordered.length / 2)] ?? 0;
        };
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});

        const measure = async (label: string, disableHotPathIoCachesForTests: boolean) => {
            const sessionId = "rust-hotpath-measure-session";
            sessions.push(sessionId);
            const db = makeDb();
            const projectRoot = createTestTempDirFromPath(join(tmpdir(), `rust-hotpath-${label}-`));
            availabilityDataHomes.push(projectRoot);
            mkdirSync(join(projectRoot, ".git"), { recursive: true });
            const guidance = `## Magic Context\n\n${"Measured guidance. ".repeat(2_000)}`;
            writeFileSync(join(projectRoot, "guidance.md"), guidance);

            for (let index = 0; index < 20; index += 1) {
                const content = `Memory ${index}: ${"architecture constraint ".repeat(20)}`;
                const memory = insertMemory(db, {
                    projectPath: projectRoot,
                    category: "ARCHITECTURE_DECISIONS",
                    content,
                    importance: 100 - index,
                });
                setMuralCue(
                    db,
                    projectRoot,
                    memory.id,
                    `cue ${index}: stable architectural relationship`,
                    computeCueContentHash(content),
                );
            }

            const rows = Array.from({ length: 2_000 }, (_, index) => ({
                id: `m-${index + 1}`,
                timeCreated: index + 1,
                contributesOrdinal: true,
                hasValidInfo: true,
            }));
            unregisters.push(
                setRawMessageProvider(sessionId, {
                    readMessages: () => rows,
                    readMessageOrdinalPage: (after, limit) =>
                        rows
                            .filter(
                                (row) =>
                                    !after ||
                                    row.timeCreated > after.timeCreated ||
                                    (row.timeCreated === after.timeCreated && row.id > after.id),
                            )
                            .slice(0, limit),
                    getStoredMessageCount: () => rows.length,
                }),
            );
            const messages = rows.map((row, index) => ({
                info: {
                    id: row.id,
                    role: index % 2 === 0 ? "user" : "assistant",
                    sessionID: sessionId,
                    ...(index % 2 === 0
                        ? {}
                        : { providerID: "anthropic", modelID: "claude-sonnet" }),
                },
                parts:
                    index % 10 === 9
                        ? [
                              {
                                  type: "tool",
                                  callID: `call-${index}`,
                                  tool: "read",
                                  state: {
                                      status: "completed",
                                      input: { filePath: `/repo/src/file-${index}.ts` },
                                      output: `fixture output ${index}`,
                                  },
                              },
                          ]
                        : [
                              {
                                  type: "text",
                                  text: `${index % 2 === 0 ? "request" : "response"} ${index}: ${"ASTRO ENGRAM fixture ".repeat(8)}`,
                              },
                          ],
            })) as MessageLike[];
            let memoryPulls = 0;
            let compartmentPulls = 0;
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) =>
                    method === "transform"
                        ? {
                              decision: "SOFT+",
                              row_version: 1,
                              rendered_memory_ids: [],
                              native_messages: messages,
                          }
                        : { ok: true },
                mirrorPull: async (args) => {
                    memoryPulls += 1;
                    return {
                        page: {
                            domain: args.domain,
                            cursor: args.cursor,
                            next_cursor: args.cursor,
                            has_more: false,
                            rows: [],
                        },
                    };
                },
                getCompartmentsAfter: async () => {
                    compartmentPulls += 1;
                    return { max_sequence: -1, compartment_count: 0, compartments: [] };
                },
            };
            const deps = makeDeps(db, moduleClient);
            deps.directory = projectRoot;
            deps.projectPath = projectRoot;
            deps.sessionDirectoryBySession?.set(sessionId, projectRoot);
            deps.memoryConfig = {
                enabled: false,
                injectionBudgetTokens: 1,
                autoPromote: false,
            };
            deps.muralEnabled = true;
            deps.promptSurface = {
                default: "full",
                guidance_override_path: "guidance.md",
            };
            deps.promptSurfaceRuntime = createPromptSurfaceRuntime({
                userConfigDirectory: projectRoot,
                warn: () => undefined,
            });
            const transform = createRustModeTransform(deps, {
                moduleClient,
                disableHotPathIoCachesForTests,
                muralResolverForTests: (muralDb, projectIdentity, _modelKey, _enabled, budget) => {
                    if (!projectIdentity) return { enabled: true, supportsVision: true };
                    const resolved = ensureMuralRendered(muralDb, projectIdentity, budget);
                    return {
                        enabled: true,
                        supportsVision: true,
                        dataUrl: resolved.dataUrl,
                        contentHash: resolved.contentHash,
                    };
                },
            });

            const runOnce = async () => {
                const output = { messages: [...messages] as unknown[] };
                await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
                await Bun.sleep(10);
                return createHash("sha256").update(JSON.stringify(output.messages)).digest("hex");
            };
            await runOnce();
            const logStart = logSpy.mock.calls.length;
            const digests: string[] = [];
            for (let pass = 0; pass < 5; pass += 1) digests.push(await runOnce());

            const samples = Object.fromEntries(
                stageNames.map((stage) => [stage, [] as number[]]),
            ) as Record<StageName, number[]>;
            for (const [rawMessage] of logSpy.mock.calls.slice(logStart)) {
                const message = String(rawMessage);
                if (!message.includes(`[${sessionId}]`)) continue;
                const match = message.match(
                    /transform stage: stage=rust\.([a-z_]+) elapsed=([\d.]+)ms/,
                );
                if (!match || !stageNames.includes(match[1] as StageName)) continue;
                samples[match[1] as StageName].push(Number(match[2]));
            }
            expect(new Set(digests).size).toBe(1);
            return {
                hash: digests[0],
                memoryPulls,
                compartmentPulls,
                medians: Object.fromEntries(
                    stageNames.map((stage) => [stage, median(samples[stage])]),
                ) as Record<StageName, number>,
            };
        };

        try {
            const before = await measure("before", true);
            const after = await measure("after", false);
            expect(after.hash).toBe(before.hash);
            expect(after.memoryPulls).toBe(0);
            expect(after.compartmentPulls).toBe(0);
            if (process.env.MAGIC_CONTEXT_HOTPATH_MEASURE === "1") {
                console.log(`HOTPATH_MEASUREMENT ${JSON.stringify({ before, after })}`);
            }
        } finally {
            logSpy.mockRestore();
        }
    });

    it("keeps all served bytes identical across 64 todo and mural cache passes", async () => {
        const baselinePath = process.env.MAGIC_CONTEXT_RUST_STAGE_BASELINE;
        const baselineFactory: typeof createRustModeTransformImpl = baselinePath
            ? (await import(baselinePath)).createRustModeTransform
            : createRustModeTransformImpl;
        const sessionId = "rust-stage-differential";
        const projectPath = "/tmp/rust-stage-fixture";
        const todoJson = '[{"content":"review changes","status":"pending","priority":"high"}]';
        const rows = Array.from({ length: 2_000 }, (_, index) => ({
            id: `fixture-${index}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
            ordinal: index + 1,
            role: index % 2 ? "assistant" : "user",
            parts: [],
        }));
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        const runArm = async (factory: typeof createRustModeTransformImpl, baseline: boolean) => {
            sessions.push(sessionId);
            installAvailabilityDb(sessionId, {});
            const db = makeDb();
            unregisters.push(
                setRawMessageProvider(sessionId, {
                    readMessages: () => rows,
                    getStoredMessageCount: () => rows.length,
                }),
            );
            const memories = Array.from({ length: 400 }, (_, index) => {
                const content = `Memory ${index}: ${"architectural constraint ".repeat(30)}`;
                const memory = insertMemory(db, { projectPath, category: "CONSTRAINTS", content });
                setMuralCue(
                    db,
                    projectPath,
                    memory.id,
                    `Stable cue ${index}`,
                    computeCueContentHash(content),
                );
                return memory;
            });
            const input = rows.map((row, index) => ({
                info: {
                    id: row.id,
                    sessionID: sessionId,
                    role: index % 2 ? "assistant" : "user",
                    ...(index % 2
                        ? { providerID: "test-provider", modelID: "test-model" }
                        : { agent: "build" }),
                },
                parts: [
                    { type: "text", text: `message ${index}: ${"fixture ballast ".repeat(12)}` },
                ],
            })) as MessageLike[];
            input[999].parts = [
                {
                    type: "tool",
                    tool: "todowrite",
                    callID: "origin-todo",
                    state: {
                        status: "completed",
                        input: { todos: JSON.parse(todoJson) },
                        output: todoJson,
                    },
                },
            ];
            updateSessionMeta(db, sessionId, { lastTodoState: todoJson });
            let pass = 0;
            let denied = false;
            const seenInputs: unknown[] = [];
            const moduleClient: RustModeModuleClient = {
                call: async ({ method, body }) => {
                    if (method !== "transform") return { ok: true };
                    const request = body as Record<string, unknown>;
                    seenInputs.push([request.todo_tool_present, request.mural]);
                    // A deterministic materializer consumes the adapter's actual candidates,
                    // rather than echoing a fixed native array regardless of their values.
                    const native: unknown[] = structuredClone(input);
                    if (pass >= 16) {
                        (native[999] as MessageLike).parts = [];
                        if (request.todo_tool_present)
                            native.unshift(
                                {
                                    info: { id: "__magic_context_todo_head__", role: "user" },
                                    parts: [{ type: "text", text: "Todo state" }],
                                },
                                {
                                    info: { id: "synthetic-todo", role: "assistant" },
                                    parts: [buildSyntheticTodoPart(todoJson)],
                                },
                            );
                    }
                    if (request.mural)
                        native.unshift({
                            info: { id: "mural", role: "user" },
                            parts: [request.mural],
                        });
                    return {
                        decision: "HARD",
                        prefix_bust_permitted: true,
                        native_messages: native,
                    };
                },
            };
            const deps = makeDeps(db, moduleClient);
            deps.projectPath = projectPath;
            deps.muralEnabled = true;
            deps.memoryConfig!.injectionBudgetTokens = 1;
            let probes = 0;
            let resolutions = 0;
            deps.client = {
                app: {
                    agents: async () => {
                        probes++;
                        return {
                            data: [
                                {
                                    name: "build",
                                    permission: { todowrite: denied ? "deny" : "allow" },
                                },
                            ],
                        };
                    },
                },
                session: { get: async () => ({ data: { agent: "build" } }) },
            } as never;
            deps.sessionDirectoryBySession!.set(sessionId, projectPath);
            const transform = factory(deps, {
                moduleClient,
                scheduleLkgCapture: (capture) => capture(),
                disableHotPathIoCachesForTests: baseline && !baselinePath,
                muralResolverForTests: (muralDb, project, _model, _enabled, budget) => {
                    resolutions++;
                    const result = ensureMuralRendered(muralDb, project!, budget);
                    return {
                        enabled: true,
                        supportsVision: true,
                        dataUrl: result.dataUrl,
                        contentHash: result.contentHash,
                    };
                },
            });
            const outputs: string[] = [];
            const start = logSpy.mock.calls.length;
            for (pass = 0; pass < 64; pass++) {
                // Full sends and unrelated edits do not imply a permission change.
                if (pass % 3 === 0) transform.invalidateWireState(sessionId);
                input[1200].parts = [{ type: "text", text: `late edit ${pass}` }];
                deps.contextUsageMap.set(sessionId, {
                    usage: {
                        inputTokens: pass >= 16 && pass < 24 ? 180_000 : 100,
                        percentage: pass >= 16 && pass < 24 ? 90 : 1,
                    },
                    updatedAt: Date.now(),
                });
                if (pass === 20 || pass === 22) denied = !denied;
                if (pass === 32) {
                    setMuralCue(
                        db,
                        projectPath,
                        memories[0].id,
                        "Changed cue",
                        computeCueContentHash(memories[0].content),
                    );
                    deps.pendingMaterializationSessions.add(sessionId);
                }
                if (pass === 48) {
                    (input[999].parts[0].state as { output: string }).output += " completed";
                }
                const output = { messages: [...input] as unknown[] };
                await transform.run(sessionId, input, output, makeMeta(db, sessionId));
                outputs.push(JSON.stringify(output.messages));
                deps.pendingMaterializationSessions.delete(sessionId);
            }
            const stages = ["todo_probe", "todo_verdict", "mural_resolve"];
            const samples = Object.fromEntries(
                stages.map((stage) => [
                    stage,
                    logSpy.mock.calls
                        .slice(start)
                        .filter(([, message]) => message.startsWith("rust pass:"))
                        .map(([, message]) =>
                            Number(
                                message.match(new RegExp(`(?:stages=| )${stage}:([\\d.]+)`))?.[1] ??
                                    0,
                            ),
                        ),
                ]),
            );
            transform.dispose();
            return { outputs, seenInputs, probes, resolutions, samples };
        };
        try {
            const before = await runArm(baselineFactory, true);
            const after = await runArm(createRustModeTransformImpl, false);
            expect(after.outputs).toEqual(before.outputs);
            expect(after.seenInputs).toEqual(before.seenInputs);
            expect(after.outputs[16]).not.toContain('"callID":"origin-todo"');
            expect(after.outputs[16]).toContain('"syntheticTodoMarker":true');
            expect(after.outputs[20]).not.toContain('"syntheticTodoMarker":true');
            expect(after.outputs[22]).toContain('"syntheticTodoMarker":true');
            expect(after.resolutions).toBe(2);
            if (baselinePath) expect(after.probes).toBeLessThan(before.probes);
            if (process.env.MAGIC_CONTEXT_HOTPATH_MEASURE === "1") {
                const summary = (arm: typeof after) => ({
                    probes: arm.probes,
                    resolutions: arm.resolutions,
                    stages: Object.fromEntries(
                        Object.entries(arm.samples).map(([stage, values]) => {
                            const sorted = values.sort((a, b) => a - b);
                            return [
                                stage,
                                {
                                    passes: sorted.length,
                                    median: sorted[Math.floor(sorted.length / 2)],
                                    p90: sorted[Math.floor(sorted.length * 0.9)],
                                    max: sorted.at(-1),
                                },
                            ];
                        }),
                    ),
                });
                console.log(
                    `RUST_STAGE_DIFFERENTIAL ${JSON.stringify({ baseline: baselinePath ?? "uncached", passes: 64, before: summary(before), after: summary(after) })}`,
                );
            }
        } finally {
            logSpy.mockRestore();
        }
    }, 120_000);

    it("keeps a 1,000-message steady-state pass under the adapter budget", async () => {
        const sessionId = `rust-wire-delta-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 1_000 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        let transformPass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") {
                    requestBodies.push(body as Record<string, unknown>);
                    transformPass += 1;
                }
                return method === "transform"
                    ? {
                          decision: transformPass === 1 ? "HARD" : "SOFT+",
                          prefix_bust_permitted: transformPass === 1,
                          row_version: transformPass,
                          native_messages: [],
                      }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = rows.map((row) => ({
            info: { id: row.id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: `message ${row.id}` }],
        }));
        const pricedStartedAt = performance.now();
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        const pricedElapsed = performance.now() - pricedStartedAt;
        const steadyStartedAt = performance.now();
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        const steadyElapsed = performance.now() - steadyStartedAt;

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[0]?.messages).toHaveLength(1_000);
        expect(requestBodies[1]?.messages).toHaveLength(0);
        expect(requestBodies[1]?.native_messages).toHaveLength(0);
        expect(requestBodies[1]?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: 1_000,
            native_replace_from: 1_000,
        });
        expect(Buffer.byteLength(JSON.stringify(requestBodies[1]))).toBeLessThan(
            MODULE_PAGE_MAX_BYTES,
        );
        // The property is that a steady pass ships an empty delta instead of rebuilding
        // the wire: the request-body assertions above prove it structurally, and the
        // same-process comparison below proves it costs less than the priced pass that
        // serialized 1,000 messages. A flat wall-clock cap alone read 378 ms under
        // release-gate load (issue 472) while measuring the runner, not the adapter; it
        // stays as an absolute belt only where the environment asks for it.
        console.log(
            `rust-adapter 1,000-message priced=${pricedElapsed.toFixed(1)}ms steady=${steadyElapsed.toFixed(1)}ms`,
        );
        expect(steadyElapsed).toBeLessThan(pricedElapsed);
        if (process.env.MC_PERF_GATE) {
            expect(pricedElapsed).toBeLessThan(250);
            expect(steadyElapsed).toBeLessThan(100);
        }
    });

    it("keeps a multi-frame tail delta paged instead of rebuilding the full wire", async () => {
        const sessionId = `rust-wire-paged-delta-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 3 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                requestBodies.push(body as Record<string, unknown>);
                return { decision: "PASSTHROUGH", native_messages: [] };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = () =>
            rows.map((row, index) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text:
                            index === rows.length - 1 && rows.length === 4
                                ? `large delta ${"x".repeat(350 * 1024)}`
                                : `message ${row.id}`,
                    },
                ],
            }));

        const initial = buildMessages();
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );
        rows.push({
            id: "m-4",
            timeCreated: 4,
            contributesOrdinal: true,
            hasValidInfo: true,
        });
        const appended = buildMessages();
        await transform.run(
            sessionId,
            appended,
            { messages: [...appended] },
            makeMeta(db, sessionId),
        );

        const deltaFinalPage = requestBodies.findLast((body) => body.tail_delta !== undefined)!;
        const deltaPages = requestBodies.filter(
            (body) => body.transform_page_id === deltaFinalPage.transform_page_id,
        );
        expect(deltaPages.length).toBeGreaterThan(1);
        expect(
            deltaPages.every(
                (page) => Buffer.byteLength(JSON.stringify(page)) <= MODULE_PAGE_MAX_BYTES,
            ),
        ).toBe(true);
        const finalPage = deltaPages.at(-1)!;
        expect(finalPage.tail_delta).toEqual({
            after: requestBodies[0]?.full_array_fingerprint,
            replace_from: 2,
            native_replace_from: 2,
        });
        const pagedWire = JSON.stringify(deltaPages);
        expect(pagedWire).not.toContain("message m-1");
        expect(pagedWire).not.toContain("message m-2");
        expect(pagedWire).toContain("message m-3");
        expect(pagedWire).toContain("large delta");
    });

    it("refuses instead of replaying stale LKG after a stable-id content mutation", async () => {
        const sessionId = `rust-lkg-content-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "captured stale content" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeDefined();

        (input[0]?.parts[0] as { text: string }).text = "same id, current content";
        failTransform = true;
        const output = { messages: [...input] as unknown[] };
        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        expect(output.messages).toEqual(input);
        expect((output.messages[0] as MessageLike).parts[0]).toEqual({
            type: "text",
            text: "same id, current content",
        });
        expect(getSlot(sessionId)).toBeUndefined();
    });

    it("refuses an oversized priced snapshot instead of serving it without durable LKG", async () => {
        const sessionId = `rust-lkg-refresh-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            role: "assistant",
                            parts: [
                                {
                                    type: "text",
                                    text:
                                        pass === 1
                                            ? "small capture"
                                            : "x".repeat(12 * 1024 * 1024 + 1_000),
                                },
                            ],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const firstInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        expect(getSlot(sessionId)).toBeDefined();

        const secondInput = makeMessages(sessionId);
        const secondOutput = { messages: [...secondInput] as unknown[] };
        const startedAt = performance.now();
        await expect(
            transform.run(sessionId, secondInput, secondOutput, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        const elapsedMs = performance.now() - startedAt;
        console.log(`oversized priced snapshot refusal: ${elapsedMs.toFixed(1)}ms`);
        expect(elapsedMs).toBeLessThan(1000);

        // Refusal can follow an in-place managed edit, but no sendable result is returned.
        expect(getSlot(sessionId)).toBeUndefined();
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
        for (let attempt = 0; attempt < 2; attempt++) {
            const input = makeMessages(sessionId);
            await expect(
                transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        }
        expect(transform.getState(sessionId).consecutiveFailures).toBe(3);
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(pass).toBe(4);
        const parkedInput = makeMessages(sessionId);
        await expect(
            transform.run(
                sessionId,
                parkedInput,
                { messages: [...parkedInput] },
                makeMeta(db, sessionId),
            ),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        // The fifth live pass is the one retry allowed while parked. Another invalid
        // response must refuse and increment the existing failure count.
        expect(pass).toBe(5);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(4);
        expect(transform.getState(sessionId).parkCount).toBe(1);
    });

    it("reuses only the exact accepted prefix after an older stable-id mutation", async () => {
        const sessionId = `rust-exact-prefix-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = Array.from({ length: 5 }, (_, index) => ({
            info: { id: `m${index + 1}`, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: `original ${index}` }],
        })) as MessageLike[];
        let pass = 0;
        const reused: number[] = [];
        const scheduled: Array<() => void> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                return {
                    decision: ++pass === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1,
                    row_version: pass,
                    native_messages: structuredClone(input),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
            onLkgCaptureForTests: (prefix) => reused.push(prefix),
        });
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(reused).toEqual([0]);
        const firstSlot = getSlot(sessionId);
        expect(firstSlot).toBeDefined();
        const mutationIndex = 2;
        (input[mutationIndex].parts[0] as { text: string }).text = "changed older content";
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));
        expect(scheduled).toHaveLength(1);
        scheduled.shift()!();
        const coldDigests = __rustModeTransformTest.rustCaptureDigests(
            input.map((message) => ({
                id: message.info.id,
                fields: __rustModeTransformTest.messageContentSnapshot(message).fields,
            })),
            undefined,
            null,
        );
        expect(getSlot(sessionId)?.inputContentDigests).toEqual(coldDigests.digests);
        expect(reused).toEqual([0, mutationIndex]);
        expect(JSON.stringify(output.messages)).toBe(JSON.stringify(input));
        expect(getSlot(sessionId)?.jsonPrefix).toBe(JSON.stringify(output.messages));

        // Model eviction after a failed durable refresh: the adapter remembers the
        // newer accepted input, but storage can restore only the older slot.
        resetLkgSlotsForTest();
        registerLkgPersistence({
            load: (id) => (id === sessionId ? firstSlot : undefined),
            clear: () => {},
        });
        try {
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            expect(scheduled).toHaveLength(1);
            scheduled.shift()!();
            expect(reused).toEqual([0, mutationIndex, 0]);
            expect(getSlot(sessionId)?.inputContentDigests).toEqual(coldDigests.digests);
        } finally {
            registerLkgPersistence(undefined);
        }
    });

    it("does not replay captured bytes over a later same-tick nested writer", async () => {
        const sessionId = `rust-detached-writer-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const scheduled: Array<() => void> = [];
        let pass = 0;
        let unavailable = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (unavailable) throw new Error("module unavailable");
                return {
                    decision: ++pass === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1,
                    row_version: pass,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: "captured module output" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
        });
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(scheduled).toHaveLength(1);
        (input[0].parts[0] as { text: string }).text = "later nested writer must survive";
        scheduled.shift()!();
        unavailable = true;
        const output = { messages: [...input] as unknown[] };
        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(JSON.stringify(output.messages)).toBe(JSON.stringify(input));
        expect(JSON.stringify(output.messages)).not.toContain("captured module output");
    });

    it("refreshes the LKG snapshot after an applied SOFT+ pass", async () => {
        const sessionId = `rust-lkg-soft-plus-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `applied response ${pass}` }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const firstInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        const firstSlot = getSlot(sessionId);
        expect(firstSlot?.jsonPrefix).toContain("applied response 1");

        const secondInput = makeMessages(sessionId);
        (secondInput[0]?.parts[0] as { text: string }).text = "new live tail state";
        await transform.run(
            sessionId,
            secondInput,
            { messages: [...secondInput] },
            makeMeta(db, sessionId),
        );
        const secondSlot = getSlot(sessionId);

        expect(secondSlot?.jsonPrefix).toContain("applied response 2");
        expect(secondSlot?.inputContentDigests).not.toEqual(firstSlot?.inputContentDigests);
    });

    it("replays byte-identical LKG after transform_transport_interrupted without retrying", async () => {
        const sessionId = `rust-interrupted-lkg-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let interrupted = false;
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                calls++;
                if (interrupted)
                    throw Object.assign(
                        new Error("Transform transport interrupted; abandon this pass"),
                        {
                            code: "transform_transport_interrupted",
                            cause: new Error("subc closed the connection"),
                        },
                    );
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: "last good module bytes" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        const firstOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, firstOutput, makeMeta(db, sessionId));
        const firstBytes = JSON.stringify(firstOutput.messages);
        expect(firstBytes).not.toBe(JSON.stringify(input));
        interrupted = true;
        const failedOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, failedOutput, makeMeta(db, sessionId));
        expect(JSON.stringify(failedOutput.messages)).toBe(firstBytes);
        expect(calls).toBe(2);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("replays byte-identical LKG on a typed mc-store transform failure", async () => {
        const sessionId = `rust-module-store-busy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let storeBusy = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (storeBusy) {
                    throw Object.assign(new Error("store: database is locked"), {
                        code: "transform_failed",
                    });
                }
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: "last good module bytes" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        const firstOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, firstOutput, makeMeta(db, sessionId));
        const firstBytes = JSON.stringify(firstOutput.messages);

        storeBusy = true;
        const failedOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, failedOutput, makeMeta(db, sessionId));

        expect(JSON.stringify(failedOutput.messages)).toBe(firstBytes);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("serves module output while context.db is busy, persists an uncertified refresh, then re-certifies", async () => {
        const sessionId = `rust-context-busy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeFileDb();
        installRawProvider(sessionId);
        let pass = 0;
        let unavailable = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (unavailable) throw new Error("daemon unavailable");
                pass += 1;
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `module output ${pass}` }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        const firstOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, firstOutput, makeMeta(db, sessionId));
        expect(JSON.stringify(firstOutput.messages)).toContain("module output 1");

        const dbPath = getDatabasePath(db);
        expect(dbPath).toBeDefined();
        const blocker = new Database(dbPath!);
        try {
            db.exec("PRAGMA busy_timeout=0");
            blocker.exec("PRAGMA busy_timeout=0");
            blocker.exec("BEGIN IMMEDIATE");
            const secondOutput = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, secondOutput, makeMeta(db, sessionId));
            expect(JSON.stringify(secondOutput.messages)).toBe(
                JSON.stringify([
                    {
                        info: { id: "served", role: "assistant", sessionID: sessionId },
                        parts: [{ type: "text", text: "module output 2" }],
                    },
                ]),
            );
            expect(getSlot(sessionId)?.jsonPrefix).toContain("module output 2");
            expect(getSlot(sessionId)?.servedCaptureId).toBeUndefined();
            // The durable prefix is stored as ordered slices.
            const persisted = (
                db
                    .prepare("SELECT body FROM lkg_slot_chunks WHERE session_id = ? ORDER BY chunk")
                    .all(sessionId) as Array<{ body: string }>
            )
                .map((row) => row.body)
                .join("");
            expect(persisted).toContain("module output 1");
        } finally {
            if (blocker.inTransaction) blocker.exec("ROLLBACK");
            closeQuietly(blocker);
        }

        // The deferred refresh can now land without borrowing the older marker.
        expect(saveLkgSlotToDb(db, sessionId, getSlot(sessionId)!)).toBe(true);
        expect(checkLkgDurability(db, sessionId)).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        expect(readServedMarker(db, sessionId)?.servedCaptureId).toBe(2);
        const thirdOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, thirdOutput, makeMeta(db, sessionId));
        expect(JSON.stringify(thirdOutput.messages)).toContain("module output 3");
        expect(checkLkgDurability(db, sessionId)).toEqual({ durable: true, servedCaptureId: 3 });

        unavailable = true;
        const hotReplay = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, hotReplay, makeMeta(db, sessionId));
        expect(JSON.stringify(hotReplay.messages)).toContain("module output 3");

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        const restarted = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const coldReplay = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, coldReplay, makeMeta(db, sessionId));
        expect(JSON.stringify(coldReplay.messages)).toContain("module output 3");
    });

    it("binds two Rust captures at one row_version to distinct durable served ids", async () => {
        const db = makeDb();
        const sessionId = "rust-served-ids";
        sessions.push(sessionId);
        installRawProvider(sessionId);
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                calls++;
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    row_version: 800,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `capture ${calls}` }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        for (let i = 1; i <= 2; i++) {
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            const saved = loadPersistedLkgSlot(db, sessionId)!;
            // Bootstrap's by-design cache-bust drop reserved id 1 before the
            // first capture. Served ids need not equal either module counter.
            expect(saved.servedCaptureId).toBe(i + 1);
            expect(saved.rowVersion).toBe(800);
            expect(saved.captureSequence).toBe(i);
            expect(checkLkgDurability(db, sessionId)).toEqual({
                durable: true,
                servedCaptureId: i + 1,
            });
            expect(persistedMoveInputs(saved)).toEqual(moveInputs("rust", input));
        }
        const before = readServedMarker(db, sessionId);
        // A replay-only failure emits no capture marker.
        const failing: RustModeModuleClient = {
            call: async () => {
                throw new Error("module unavailable");
            },
        };
        const restarted = createRustModeTransform(makeDeps(db, failing), { moduleClient: failing });
        await restarted.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(readServedMarker(db, sessionId)).toEqual(before);
        transform.dispose();
        restarted.dispose();
    });

    it("compactionOff serves without marker writes and move reports an uncertified session", async () => {
        const db = makeDb();
        const sessionId = "rust-unmanaged-marker";
        sessions.push(sessionId);
        installRawProvider(sessionId);
        db.exec(
            "CREATE TRIGGER marker_fail BEFORE INSERT ON lkg_served_markers BEGIN SELECT RAISE(ABORT, 'marker must not be attempted'); END",
        );
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    row_version: 1,
                    native_messages: [
                        {
                            info: { id: "u", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "native-compaction bytes" }],
                        },
                    ],
                };
            },
        };
        const deps = { ...makeDeps(db, moduleClient), compactionOff: true };
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] };
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));
        expect(JSON.stringify(output.messages)).toContain("native-compaction bytes");
        expect(readServedMarker(db, sessionId)).toBeUndefined();
        expect(checkLkgDurability(db, sessionId, { compactionOff: true })).toEqual({
            durable: true,
            servedCaptureId: null,
            certified: false,
        });
        transform.dispose();
    });

    it("persists a priced replacement before a process restart can expose stale LKG", async () => {
        const sessionId = `rust-lkg-priced-sync-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const scheduled: Array<() => void> = [];
        let pass = 0;
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable after priced serve");
                pass += 1;
                return {
                    decision: pass === 1 ? "HARD" : "SOFT",
                    prefix_bust_permitted: true,
                    row_version: pass,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `priced response ${pass}` }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
        });
        const input = makeMessages(sessionId);
        const servedSha = (messages: unknown[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");

        const firstOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, firstOutput, makeMeta(db, sessionId));
        const preBustSha = servedSha(firstOutput.messages);
        expect(scheduled).toHaveLength(0);
        expect(getSlot(sessionId)?.rowVersion).toBe(1);

        const pricedOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, pricedOutput, makeMeta(db, sessionId));
        const pricedSha = servedSha(pricedOutput.messages);
        expect(pricedSha).not.toBe(preBustSha);
        expect(scheduled).toHaveLength(0);
        expect(getSlot(sessionId)?.rowVersion).toBe(2);

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        failTransform = true;
        const restarted = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const restartOutput = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, restartOutput, makeMeta(db, sessionId));

        expect(servedSha(restartOutput.messages)).toBe(pricedSha);
        expect(servedSha(restartOutput.messages)).not.toBe(preBustSha);
    });

    it("keeps binding recovery armed and replay-stable when native output installation fails", async () => {
        const sessionId = `rust-binding-install-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const scheduled: Array<() => void> = [];
        let moduleUnavailable = false;
        let rejectInstall = false;
        let rowVersion = 0;
        const input = [
            {
                info: {
                    id: "m1",
                    role: "assistant",
                    sessionID: sessionId,
                    model: { providerID: "anthropic", modelID: "fable-5-1" },
                },
                parts: [
                    { type: "thinking", thinking: "bound thinking", signature: "sig" },
                    { type: "text", text: "answer" },
                ],
            },
        ] as unknown as MessageLike[];
        recordDetectedContextLimit(db, sessionId, 200_000, "anthropic/fable-5-1");
        recordToolDefinition("anthropic", "fable-5-1", undefined, "read", "read fixture", {
            type: "object",
        });
        const nativeMessages = () => structuredClone(input) as unknown[];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (moduleUnavailable) throw new Error("module unavailable after install failure");
                rowVersion += 1;
                // The baseline pass is non-busting so this Fable 5.1 session keeps its
                // thinking until the reactive recovery under test removes it; a busting
                // baseline would already strip it proactively.
                return {
                    decision: rowVersion === 1 ? "SOFT+" : "HARD",
                    prefix_bust_permitted: rowVersion !== 1,
                    row_version: rowVersion,
                    native_messages: nativeMessages(),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
            installNativeMessagesForTests: (output, messages) => {
                if (rejectInstall) {
                    rejectInstall = false;
                    expect(JSON.stringify(messages)).not.toContain("bound thinking");
                    throw new Error("simulated native output installation failure");
                }
                output.messages.splice(0, output.messages.length, ...messages);
            },
        });
        const run = async () => {
            const output = { messages: structuredClone(input) as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            return output.messages;
        };

        const baseline = await run();
        expect(JSON.stringify(baseline)).toContain("bound thinking");
        scheduled.shift()?.();
        expect(getSlot(sessionId)?.jsonPrefix).toContain("bound thinking");

        armThinkingBindingRecovery(db, sessionId);
        rejectInstall = true;
        const failedInstallReplay = await run();
        const frozenId = "binding_mismatch:m1";
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBe(
            "all_reasoning_bearing_assistants",
        );
        expect(getMergedReasoningStrippedIds(db, sessionId)).toContain(frozenId);
        expect(JSON.stringify(failedInstallReplay)).not.toContain("bound thinking");
        expect(scheduled).toHaveLength(0);

        moduleUnavailable = true;
        const outageReplay = await run();
        expect(JSON.stringify(outageReplay)).toBe(JSON.stringify(failedInstallReplay));
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).not.toBeNull();

        moduleUnavailable = false;
        const recovered = await run();
        expect(JSON.stringify(recovered)).toBe(JSON.stringify(failedInstallReplay));
        expect(getThinkingBindingRecoveryTarget(db, sessionId)).toBeNull();
        expect(scheduled).toHaveLength(0);
        expect(getSlot(sessionId)?.jsonPrefix).not.toContain("bound thinking");
    });

    it("does not let an older async capture overwrite a newer model-switch capture", async () => {
        const sessionId = `rust-lkg-order-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const scheduled: Array<() => void> = [];
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                return {
                    decision: "SOFT+",
                    row_version: pass,
                    prefix_bust_permitted: false,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `ordered response ${pass}` }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
        });
        const firstInput = makeMessages(sessionId);
        await transform.run(
            sessionId,
            firstInput,
            { messages: [...firstInput] },
            makeMeta(db, sessionId),
        );
        const switchedInput = makeMessages(sessionId);
        switchedInput[0]!.info.model = { providerID: "anthropic", modelID: "switched" };
        await transform.run(
            sessionId,
            switchedInput,
            { messages: [...switchedInput] },
            makeMeta(db, sessionId),
        );

        expect(scheduled).toHaveLength(2);
        scheduled[1]?.();
        scheduled[0]?.();
        const slot = getSlot(sessionId);
        expect(slot?.jsonPrefix).toContain("ordered response 2");
        expect(slot?.modelKey).toBe("anthropic/switched");
        expect(slot?.rowVersion).toBe(2);
    });

    it("re-arms a synchronous capture after an async capture is rejected", async () => {
        const sessionId = `rust-lkg-rearm-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const scheduled: Array<() => void> = [];
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                return {
                    decision: "HARD",
                    row_version: pass,
                    native_messages: [
                        {
                            role: "assistant",
                            parts: [
                                {
                                    type: "text",
                                    text:
                                        pass === 1
                                            ? "x".repeat(12 * 1024 * 1024 + 1_000)
                                            : "recovered synchronously",
                                },
                            ],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            scheduleLkgCapture: (capture) => scheduled.push(capture),
        });
        const input = makeMessages(sessionId);

        await expect(
            transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        scheduled.shift()?.();
        expect(getSlot(sessionId)).toBeUndefined();

        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(scheduled).toHaveLength(0);
        expect(getSlot(sessionId)?.jsonPrefix).toContain("recovered synchronously");
    });

    it("keeps the raw array untouched when overflow-state storage is unreadable", async () => {
        const sessionId = `rust-overflow-state-fault-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const moduleCall = mock(async () => {
            throw new Error("module must not run after the preflight storage fault");
        });
        const moduleClient: RustModeModuleClient = { call: moduleCall };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "raw must survive" }],
            },
        ] as MessageLike[];
        const meta = makeMeta(db, sessionId);
        db.exec("DROP TABLE session_meta");
        const output = { messages: [...input] as unknown[] };

        await expect(transform.run(sessionId, input, output, meta)).rejects.toBeInstanceOf(
            RawFallbackContextLimitError,
        );

        expect(output.messages).toEqual(input);
        expect(moduleCall).not.toHaveBeenCalled();
    });

    it("fails closed when overflow recovery is armed but context.db becomes unreadable", async () => {
        const sessionId = `rust-overflow-state-armed-fault-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, 100_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async () => {
                throw new Error("module must not run after the preflight storage fault");
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        const meta = makeMeta(db, sessionId);
        db.exec("DROP TABLE session_meta");
        const output = { messages: [] as unknown[] };

        await expect(transform.run(sessionId, input, output, meta)).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
        expect(output.messages).toEqual([]);
    });

    it("retries a fold timeout with the identical final page and longer budget before parking", async () => {
        const sessionId = `rust-fold-timeout-retry-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const calls: Array<{ body: unknown; timeoutMs?: number }> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, timeoutMs }) => {
                if (method !== "transform") return { ok: true };
                calls.push({ body: structuredClone(body), timeoutMs });
                if (calls.length === 1)
                    throw Object.assign(new Error("request deadline"), { code: "ETIMEDOUT" });
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "managed fold" }],
                        },
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.pendingMaterializationSessions.add(sessionId);
        const transform = createRustModeTransform(deps, { moduleClient });
        const output = { messages: [] as unknown[] };
        await transform.run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId));
        expect(calls).toHaveLength(2);
        expect(calls[0].body).toEqual(calls[1].body);
        expect(calls.map((call) => call.timeoutMs)).toEqual([45_000, 45_000]);
        expect(JSON.stringify(output.messages)).toContain("managed fold");
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
        expect(transform.getState(sessionId).parked).toBe(false);
    });

    it("refuses transform_transport_interrupted without LKG instead of serving unmanaged history", async () => {
        const sessionId = `rust-interrupted-no-lkg-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                calls++;
                throw Object.assign(
                    new Error("Transform transport interrupted; abandon this pass"),
                    {
                        code: "transform_transport_interrupted",
                        cause: new Error("subc closed the connection"),
                    },
                );
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: [] as unknown[] };
        await expect(
            transform.run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId)),
        ).rejects.toThrow("Magic Context's engine is reconnecting");
        expect(output.messages).toEqual([]);
        expect(calls).toBe(1);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("refuses instead of rebuilding forever when every state sync loses the module connection", async () => {
        const sessionId = `rust-state-sync-reconnect-loop-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let stateSyncs = 0;
        let transforms = 0;
        const moduleClient: RustModeModuleClient = {
            stateSyncCapabilities: async () => ({ state_sync_deltas: true }),
            call: async ({ method }) => {
                if (method === "state_sync") {
                    stateSyncs += 1;
                    // Bounded so a client that never gives up still finishes and the
                    // assertions below report the retry count instead of hanging.
                    if (stateSyncs <= 50) {
                        return {
                            transport_status: "connection_generation_changed",
                            previous_generation: stateSyncs,
                            current_generation: stateSyncs + 1,
                        };
                    }
                    return { ok: true };
                }
                if (method === "transform") {
                    transforms += 1;
                    return { decision: "PASSTHROUGH", native_messages: makeMessages(sessionId) };
                }
                return { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: [] as unknown[] };
        await expect(
            transform.run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId)),
        ).rejects.toThrow("Magic Context's engine is reconnecting");
        expect(output.messages).toEqual([]);
        expect(stateSyncs).toBe(3);
        expect(transforms).toBe(0);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("refuses transform_transport_interrupted with compaction disabled instead of serving unmanaged history", async () => {
        const sessionId = `rust-interrupted-compaction-off-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 20_000, "test-provider/test-model");
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                calls++;
                throw Object.assign(
                    new Error("Transform transport interrupted; abandon this pass"),
                    { code: "transform_transport_interrupted" },
                );
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.compactionOff = true;
        const transform = createRustModeTransform(deps, {
            moduleClient,
            rawFallbackEstimatorForTests: () => ({
                tokens: 1,
                trusted: true,
                messageTokens: { conversation: 1, toolCall: 0 },
                systemTokens: 0,
                toolDefinitionTokens: 0,
            }),
        });
        const output = { messages: [] as unknown[] };
        await expect(
            transform.run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId)),
        ).rejects.toThrow("Magic Context's engine is reconnecting");
        expect(output.messages).toEqual([]);
        expect(calls).toBe(1);
    });

    it("refuses a module timeout without LKG instead of serving raw", async () => {
        const sessionId = `rust-timeout-no-lkg-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("rust module request timed out");
                return { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: [] as unknown[] };
        await expect(
            transform.run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId)),
        ).rejects.toThrow("Magic Context's engine is reconnecting");
        expect(output.messages).toEqual([]);
    });

    it("throws locally instead of serving raw above a known context limit", async () => {
        const sessionId = `rust-raw-limit-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("client closed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: randomText(seededRandom(7), 20_000) }],
            },
        ] as MessageLike[];
        const output = { messages: [] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
        expect(output.messages).toEqual([]);
    });

    it("refuses a large raw fallback when the token estimator is unavailable", async () => {
        const sessionId = `rust-raw-estimator-unavailable-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("client closed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        let estimatorCalls = 0;
        const transform = createRustModeTransform(deps, {
            moduleClient,
            rawFallbackEstimatorForTests: () => {
                estimatorCalls += 1;
                throw new Error("tokenizer unavailable");
            },
        });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "x".repeat(5_000) }],
            },
        ] as MessageLike[];
        const output = { messages: [] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
        // The byte proxy proves the refusal before any tokenizer run, so an
        // unavailable estimator is never even invoked on the failure path.
        expect(estimatorCalls).toBe(0);
        expect(output.messages).toEqual([]);
    });

    it("refuses a byte-large raw fallback when the token estimate is materially low", async () => {
        const sessionId = `rust-raw-estimator-low-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("client closed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createRustModeTransform(deps, {
            moduleClient,
            rawFallbackEstimatorForTests: () => ({
                tokens: 900,
                trusted: true,
                messageTokens: { conversation: 900, toolCall: 0 },
                systemTokens: 0,
                toolDefinitionTokens: 0,
            }),
        });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "x".repeat(5_000) }],
            },
        ] as MessageLike[];
        const output = { messages: [] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
        expect(output.messages).toEqual([]);
    });

    it("refuses unmanaged fallback even when the estimate fits the known context limit", async () => {
        const sessionId = `rust-raw-fits-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 10_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("client closed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "small raw prompt" }],
            },
        ] as MessageLike[];
        const output = { messages: [] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(output.messages).toEqual([]);
    });

    it("parks a typed non-retryable state-sync failure after the first pass", async () => {
        const sessionId = `rust-state-sync-non-retryable-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let stateSyncCalls = 0;
        let transformCalls = 0;
        let toastCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "state_sync") {
                    stateSyncCalls += 1;
                    throw Object.assign(new Error("workspace constraint"), {
                        code: "state_sync_non_retryable",
                    });
                }
                if (method === "transform") transformCalls += 1;
                return { ok: true };
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
                notifyParked: () => {
                    toastCalls += 1;
                },
            });
            const first = makeMessages(sessionId);
            await expect(
                transform.run(
                    sessionId,
                    first,
                    { messages: first as unknown[] },
                    makeMeta(db, sessionId),
                ),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);

            expect(transform.getState(sessionId).parked).toBe(true);
            expect(stateSyncCalls).toBe(1);
            expect(transformCalls).toBe(0);
            expect(toastCalls).toBe(1);
            expect(
                logSpy.mock.calls
                    .filter(([loggedSession]) => loggedSession === sessionId)
                    .map(([, message]) => message)
                    .find((message) => message.startsWith("rust pass:")),
            ).toContain(
                "decision=error reason=state_sync_non_retryable prefix_bust_permitted=unsupported served_from=refused",
            );

            for (let pass = 0; pass < 2; pass += 1) {
                const parked = makeMessages(sessionId);
                await expect(
                    transform.run(
                        sessionId,
                        parked,
                        { messages: parked as unknown[] },
                        makeMeta(db, sessionId),
                    ),
                ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            }
            expect(stateSyncCalls).toBe(3);
            expect(transformCalls).toBe(0);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("refuses every turn loudly when the module's store is ahead of it, without parking or falling back", async () => {
        const sessionId = `rust-store-ahead-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let moduleCalls = 0;
        let toastCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async () => {
                moduleCalls += 1;
                throw Object.assign(new Error("storage open refused"), {
                    code: "store_ahead_of_binary",
                    detail: {
                        reason_code: "store_ahead_of_binary",
                        db_version: 63,
                        binary_max: 62,
                    },
                });
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
                notifyParked: () => {
                    toastCalls += 1;
                },
            });
            // Four passes is more than RUST_FAILURE_PARK_THRESHOLD, the number of consecutive
            // failures that would park an ordinary failing session into fallback serving. A
            // refused store must keep failing visibly instead.
            for (let pass = 0; pass < 4; pass += 1) {
                const input = makeMessages(sessionId);
                const callsBefore = moduleCalls;
                const failure = transform
                    .run(
                        sessionId,
                        input,
                        { messages: input as unknown[] },
                        makeMeta(db, sessionId),
                    )
                    .then(
                        () => null,
                        (error: unknown) => error,
                    );
                const error = await failure;
                expect(error).toBeInstanceOf(EmergencyFailClosedError);
                expect((error as Error).message).toBe(
                    "Magic Context refused to start: its store (store.db) is at schema v63 but this ck-mc build only knows up to v62. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)",
                );
                expect(moduleCalls).toBeGreaterThan(callsBefore);
            }
            expect(transform.getState(sessionId).parked).toBe(false);
            expect(toastCalls).toBe(0);
            const messages = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => String(message));
            expect(
                messages.some((message) =>
                    message.startsWith("mc_rust_store_ahead_refusal db_version=63 binary_max=62"),
                ),
            ).toBe(true);
            expect(messages.some((message) => message.includes("lkg_replay_served"))).toBe(false);
            expect(messages.some((message) => message.includes("served_from=raw"))).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("refuses migration-required turns without LKG replay or parking", async () => {
        const sessionId = `rust-single-store-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let moduleCalls = 0;
        let toastCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async () => {
                moduleCalls += 1;
                throw Object.assign(new Error("storage open refused"), {
                    code: "single_store_migration_required",
                    detail: {
                        reason_code: "single_store_migration_required",
                    },
                });
            },
        };
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
                notifyParked: () => {
                    toastCalls += 1;
                },
            });
            // Four passes is more than RUST_FAILURE_PARK_THRESHOLD, the number of consecutive
            // failures that would park an ordinary failing session into fallback serving. A
            // refused store must keep failing visibly instead.
            for (let pass = 0; pass < 4; pass += 1) {
                const input = makeMessages(sessionId);
                const callsBefore = moduleCalls;
                const failure = transform
                    .run(
                        sessionId,
                        input,
                        { messages: input as unknown[] },
                        makeMeta(db, sessionId),
                    )
                    .then(
                        () => null,
                        (error: unknown) => error,
                    );
                const error = await failure;
                expect(error).toBeInstanceOf(EmergencyFailClosedError);
                expect((error as Error).message).toBe(
                    "Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)",
                );
                expect(moduleCalls).toBeGreaterThan(callsBefore);
            }
            expect(transform.getState(sessionId).parked).toBe(false);
            expect(toastCalls).toBe(0);
            const messages = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => String(message));
            expect(
                messages.some((message) =>
                    message.startsWith(
                        "mc_rust_single_store_refusal reason=single_store_migration_required",
                    ),
                ),
            ).toBe(true);
            expect(messages.some((message) => message.includes("lkg_replay_served"))).toBe(false);
            expect(messages.some((message) => message.includes("served_from=raw"))).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("parked without LKG retries the recovered module on the next pass even when raw exceeds the limit", async () => {
        const sessionId = `rust-failure-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let shouldFail = true;
        let transformCalls = 0;
        let toastCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") transformCalls += 1;
                if (shouldFail) throw new Error("daemon unavailable");
                return method === "transform"
                    ? {
                          decision: "SOFT+",
                          prefix_bust_permitted: false,
                          native_messages: [{ role: "assistant", parts: [] }],
                      }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            notifyParked: () => {
                toastCalls += 1;
            },
        });
        for (let pass = 1; pass <= 3; pass += 1) {
            const input = makeMessages(sessionId);
            const output = { messages: input as unknown[] };
            await expect(
                transform.run(sessionId, input, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toBe(input);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(toastCalls).toBe(1);
        shouldFail = false;
        recordDetectedContextLimit(db, sessionId, 1, "test-provider/test-model");
        const input = makeMessages(sessionId);
        const output = { messages: input as unknown[] };
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));
        expect(output.messages).toEqual([{ role: "assistant", parts: [] }]);
        expect(transform.getState(sessionId).parked).toBe(false);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
        expect(transform.getState(sessionId).warningSent).toBe(false);
        expect(transformCalls).toBe(1);
    });

    it("retries the module on every parked pass at emergency pressure", async () => {
        const sessionId = `rust-park-pressure-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") {
                    transformCalls += 1;
                    throw new Error("daemon unavailable");
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 90_000, percentage: 90 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });

        for (let pass = 0; pass < 3; pass += 1) {
            const input = makeMessages(sessionId);
            await expect(
                transform.run(
                    sessionId,
                    input,
                    { messages: input as unknown[] },
                    makeMeta(db, sessionId),
                ),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(transformCalls).toBe(3);

        const input = makeMessages(sessionId);
        await expect(
            transform.run(
                sessionId,
                input,
                { messages: input as unknown[] },
                makeMeta(db, sessionId),
            ),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(transformCalls).toBe(4);
        expect(transform.getState(sessionId).parked).toBe(true);
    });

    it("fails closed on failures one through three above 95% of a provider-proven limit", async () => {
        const sessionId = `rust-park-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const modelKey = "test-provider/test-model";
        recordDetectedContextLimit(db, sessionId, 100_000, modelKey);
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") {
                    transformCalls += 1;
                    throw new Error("daemon unavailable");
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 96_000, percentage: 96 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ] as MessageLike[];

        for (let pass = 1; pass <= 3; pass += 1) {
            const output = { messages: [...input] as unknown[] };
            await expect(
                transform.run(sessionId, input, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toEqual(input);
            expect(transformCalls).toBe(pass);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
    });

    it("refuses below-95 failures when LKG is unavailable", async () => {
        const sessionId = `rust-below-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 100_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("daemon unavailable");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 94_000, percentage: 94 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ] as MessageLike[];
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);

        expect(output.messages).toEqual(input);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("aborts an overflow-armed failure instead of falling through refused LKG to raw", async () => {
        const sessionId = `rust-overflow-fail-closed-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        { role: "assistant", parts: [{ type: "text", text: "lkg" }] },
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 30_000, percentage: 30 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "current raw" }],
            },
        ] as MessageLike[];
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeDefined();
        recordOverflowDetected(db, sessionId, 100_000, "test-provider/test-model");
        failTransform = true;
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(output.messages).toEqual(input);
    });

    it("aborts after a fresh repeated provider overflow when the provider reports no limit", async () => {
        const sessionId = `rust-overflow-unknown-repeat-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, undefined);
        resetEmergencyRecoveryRegistryForTest();
        expect(getOverflowState(db, sessionId)).toMatchObject({
            detectedContextLimit: 0,
            needsEmergencyRecovery: true,
            emergencyRecoveryOrigin: "provider_overflow",
        });
        // The second observation models a provider overflow event arriving while recovery
        // from the first rejection is still durably armed.
        recordOverflowDetected(db, sessionId, undefined);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("adapter validation failed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 95_000, percentage: 95 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(output.messages).toEqual(input);
    });

    it("does not treat the first unknown-limit overflow arm as repeated provider proof", async () => {
        const sessionId = `rust-overflow-unknown-first-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordOverflowDetected(db, sessionId, undefined);
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("adapter validation failed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 95_000, percentage: 95 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };

        await expect(
            transform.run(sessionId, input, output, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);

        expect(output.messages).toEqual(input);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
    });

    it("refuses both oversized LKG replay and the guaranteed-oversized raw fallback", async () => {
        const sessionId = `rust-lkg-limit-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "cached compact prefix" }],
                        },
                    ],
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 100, percentage: 10 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const firstInput = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "current prefix" }],
            },
        ] as MessageLike[];
        const firstMeta = makeMeta(db, sessionId);
        firstMeta.systemPromptTokens = 100;
        await transform.run(sessionId, firstInput, { messages: [...firstInput] }, firstMeta);
        expect(getSlot(sessionId)).toBeDefined();

        const appended = [
            ...firstInput,
            {
                info: { id: "m2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: randomText(seededRandom(42), 20_000) }],
            },
        ] as MessageLike[];
        failTransform = true;
        const output = { messages: [] as unknown[] };
        const failureMeta = makeMeta(db, sessionId);
        failureMeta.systemPromptTokens = 100;
        await expect(
            transform.run(sessionId, appended, output, failureMeta),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);

        expect(output.messages).toEqual([]);
    });
});

describe("native output delta", () => {
    it("keeps the module delta basis separate from marker insertion after a model-switch HARD", async () => {
        const sessionId = `rust-marker-delta-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        makeMeta(db, sessionId);
        setPersistedCompactionMarkerState(db, sessionId, {
            boundaryMessageId: "m1",
            summaryMessageId: "summary",
            compactionPartId: "compaction",
            summaryPartId: "summary-part",
            boundaryOrdinal: 0,
            targetEndMessageId: "m1",
        });
        const message = (id: string): MessageLike => ({
            info: { id, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool",
                    tool: "work",
                    callID: id,
                    state: {
                        status: "completed",
                        input: { action: "settle" },
                        output: id,
                    },
                },
            ],
        });
        let native: MessageLike[] = [
            ...makeMessages(sessionId),
            message("settle"),
            message("board"),
        ];
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const request = body as Record<string, unknown>;
                if (pass++ === 0)
                    return {
                        decision: "HARD",
                        reason: "epoch_change",
                        scheduler_decision: "defer",
                        native_messages: structuredClone(native),
                    };
                const replaceFrom = native.length - 1;
                native = [...native, message(`step-${pass}`)];
                return {
                    decision: "SOFT+",
                    scheduler_decision: "defer",
                    native_messages_delta: {
                        after: (request.tail_delta as { after: string }).after,
                        replace_from: replaceFrom,
                        messages: structuredClone(native.slice(replaceFrom)),
                    },
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.tagger = { assignTag: () => 1 } as unknown as TransformDeps["tagger"];
        const transform = createRustModeTransform(deps, { moduleClient });
        const hash = (messages: unknown[]) =>
            new Bun.CryptoHasher("sha256").update(JSON.stringify(messages)).digest("hex");
        let previous: unknown[] = [];
        for (let index = 0; index < 3; index++) {
            const input = makeMessages(sessionId);
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
            expect(output.messages).toHaveLength(native.length + 1);
            if (previous.length > 0)
                expect(hash(output.messages.slice(0, previous.length))).toBe(hash(previous));
            expect(
                (output.messages as MessageLike[]).filter((msg) => msg.info.id === "settle"),
            ).toHaveLength(1);
            previous = structuredClone(output.messages);
        }
    });
    it("retries with full arrays when a delta response omits native content", async () => {
        const sessionId = `rust-native-omission-retry-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        let healedNative: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const request = body as Record<string, unknown>;
                transformBodies.push(request);
                if (transformBodies.length === 1) {
                    return {
                        decision: "SOFT+",
                        prefix_bust_permitted: false,
                        native_messages: structuredClone(request.native_messages),
                    };
                }
                if (request.tail_delta) return { status: "ok", served_from: "transform" };
                return {
                    decision: "SOFT+",
                    prefix_bust_permitted: false,
                    native_messages: structuredClone(healedNative),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const initial = makeMessages(sessionId);
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );

        const changed = structuredClone(initial);
        changed[0]!.parts = [{ type: "text", text: "changed after warm prime" }];
        healedNative = structuredClone(changed);
        const output = { messages: [...changed] as unknown[] };
        await transform.run(sessionId, changed, output, makeMeta(db, sessionId));

        expect(transformBodies).toHaveLength(3);
        expect(transformBodies[1]?.tail_delta).toEqual({
            after: transformBodies[0]?.full_array_fingerprint,
            replace_from: 0,
            native_replace_from: 0,
        });
        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[2]?.native_messages).toEqual(changed);
        expect(output.messages).toEqual(healedNative);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
    });

    it("reconstructs the exact acknowledged prefix plus replacement suffix", () => {
        const previous = [
            { info: { id: "m0" }, parts: [{ type: "text", text: "stable" }] },
            { info: { id: "m1" }, parts: [{ type: "text", text: "old" }] },
        ];
        const suffix = [
            { info: { id: "m1" }, parts: [{ type: "text", text: "new" }] },
            { info: { id: "m2" }, parts: [{ type: "text", text: "tail" }] },
        ];
        const output = { messages: [] as unknown[] };

        const applied = applyNativeMessagesVerbatim(
            output,
            {
                native_messages_delta: {
                    after: "fp-before",
                    replace_from: 1,
                    messages: suffix,
                },
            },
            { messages: previous, fingerprint: "fp-before" },
        );

        expect(applied).toEqual([previous[0], ...suffix]);
        expect(output.messages).toEqual(applied);
        expect(applied[0]).toBe(previous[0]);
    });

    it("rejects a delta whose prefix fingerprint is not acknowledged", () => {
        expect(() =>
            applyNativeMessagesVerbatim(
                { messages: [] },
                {
                    native_messages_delta: {
                        after: "stale",
                        replace_from: 1,
                        messages: [],
                    },
                },
                { messages: [{ info: { id: "m0" } }], fingerprint: "current" },
            ),
        ).toThrow("did not match the acknowledged output");
    });
});

describe("delta prefix-mutation guard", () => {
    it("in-place mutation of an older message forces a full send instead of a delta", async () => {
        const sessionId = `rust-prefix-guard-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 4 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        let moduleNativeSnapshot: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const request = body as Record<string, unknown>;
                requestBodies.push(request);
                const suffix = request.native_messages as unknown[];
                const delta = request.tail_delta as { native_replace_from?: unknown } | undefined;
                if (delta && typeof delta.native_replace_from === "number") {
                    moduleNativeSnapshot = [
                        ...moduleNativeSnapshot.slice(0, delta.native_replace_from),
                        ...structuredClone(suffix),
                    ];
                } else {
                    moduleNativeSnapshot = structuredClone(suffix);
                }
                return {
                    decision: "SOFT+",
                    prefix_bust_permitted: false,
                    native_messages: structuredClone(moduleNativeSnapshot),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = (count: number, mutatePrefix = false): MessageLike[] =>
            rows.slice(0, count).map((row, index) => ({
                info: { id: row.id, role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: mutatePrefix && index === 0 ? "MESSAGE m-1" : `message ${row.id}`,
                    },
                ],
            }));

        const first = buildMessages(3);
        await transform.run(sessionId, first, { messages: [...first] }, makeMeta(db, sessionId));
        // Steady-state control: an appended tail rides a delta.
        const appended = buildMessages(4);
        await transform.run(
            sessionId,
            appended,
            { messages: [...appended] },
            makeMeta(db, sessionId),
        );
        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]?.tail_delta).toEqual({
            after: expect.any(String),
            replace_from: expect.any(Number),
            native_replace_from: expect.any(Number),
        });
        // Mutate an OLD message in place (the ephemeral reminder-wrapper class): the
        // pass must abandon the delta and full-send, because the prefix the module
        // would reuse no longer matches what OpenCode holds.
        const mutated = buildMessages(4, true);
        expect(__rustModeTransformTest.messageContentSnapshot(mutated[0]).signature).not.toBe(
            __rustModeTransformTest.messageContentSnapshot(appended[0]).signature,
        );
        const mutatedOutput = { messages: [...mutated] as unknown[] };
        await transform.run(sessionId, mutated, mutatedOutput, makeMeta(db, sessionId));
        expect(requestBodies).toHaveLength(3);
        expect(requestBodies[2]?.tail_delta).toBeUndefined();
        expect(requestBodies[2]?.messages).toHaveLength(4);
        expect(requestBodies[2]?.native_messages).toEqual(mutated);
        expect(JSON.stringify(requestBodies[2]?.messages)).toContain("MESSAGE m-1");
        expect(mutatedOutput.messages).toEqual(mutated);

        const stableOutput = { messages: [...mutated] as unknown[] };
        await transform.run(sessionId, mutated, stableOutput, makeMeta(db, sessionId));
        expect(requestBodies).toHaveLength(4);
        expect(requestBodies[3]?.tail_delta).toEqual({
            after: requestBodies[2]?.full_array_fingerprint,
            replace_from: 4,
            native_replace_from: 4,
        });
        expect(requestBodies[3]?.messages).toEqual([]);
        expect(requestBodies[3]?.native_messages).toEqual([]);
        expect(stableOutput.messages).toEqual(mutatedOutput.messages);
    });

    it("detects equal-length mutations inside tool input arguments", async () => {
        const sessionId = `rust-tool-input-prefix-guard-${Date.now()}`;
        sessions.push(sessionId);
        const rows = Array.from({ length: 3 }, (_, index) => ({
            id: `m-${index + 1}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        unregisters.push(
            setRawMessageProvider(sessionId, {
                readMessages: () => rows,
                readMessageOrdinalPage: (after, limit) =>
                    rows
                        .filter(
                            (row) =>
                                !after ||
                                row.timeCreated > after.timeCreated ||
                                (row.timeCreated === after.timeCreated && row.id > after.id),
                        )
                        .slice(0, limit),
                getStoredMessageCount: () => rows.length,
            }),
        );
        const db = makeDb();
        const requestBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform"
                    ? { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] }
                    : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const buildMessages = (query: string): MessageLike[] =>
            rows.map((row, index) => ({
                info: { id: row.id, role: "assistant", sessionID: sessionId },
                parts: [
                    {
                        type: "tool",
                        callID: `call-${index}`,
                        tool: "search",
                        state: { status: "completed", input: { query }, output: "ok" },
                    },
                ],
            }));

        const initial = buildMessages("alpha");
        await transform.run(
            sessionId,
            initial,
            { messages: [...initial] },
            makeMeta(db, sessionId),
        );
        const mutated = buildMessages("bravo");
        expect(__rustModeTransformTest.messageContentSnapshot(mutated[0]).signature).not.toBe(
            __rustModeTransformTest.messageContentSnapshot(initial[0]).signature,
        );
        await transform.run(
            sessionId,
            mutated,
            { messages: [...mutated] },
            makeMeta(db, sessionId),
        );

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[1]?.tail_delta).toBeUndefined();
        expect(requestBodies[1]?.native_messages).toEqual(mutated);
        expect(JSON.stringify(requestBodies[1]?.messages)).toContain('"query":"bravo"');
    });

    it("ignores empty OpenCode user diff summaries but rejects substantive prefix changes", () => {
        const original = {
            info: { id: "user-1", role: "user" },
            parts: [{ type: "text", text: "unchanged" }],
        } as MessageLike;
        const snapshot = __rustModeTransformTest.messageContentSnapshot(original);
        const withEmptySummary = {
            ...original,
            info: { ...original.info, summary: { diffs: [] } },
        } as MessageLike;
        expect(
            __rustModeTransformTest.messageMatchesContentSnapshot(withEmptySummary, snapshot),
        ).toBe(true);
        expect(
            __rustModeTransformTest.messageMatchesContentSnapshot(
                {
                    ...withEmptySummary,
                    info: { ...withEmptySummary.info, summary: { diffs: ["real-change"] } },
                },
                snapshot,
            ),
        ).toBe(false);
        expect(
            __rustModeTransformTest.messageMatchesContentSnapshot(
                {
                    ...withEmptySummary,
                    parts: [{ type: "text", text: "changed" }],
                },
                snapshot,
            ),
        ).toBe(false);
    });

    it("matches the legacy snapshot comparator across 500 randomized deep mutations", () => {
        const random = seededRandom(0x5eed_c0de);
        for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
            const chainDepth = 2 + Math.floor(random() * 5);
            let payload: Record<string, unknown> = {
                alpha: randomText(random, 8),
                beta: randomText(random, 12),
                gamma: [null, undefined, randomText(random, 6), Math.floor(random() * 10_000)],
                delta: { enabled: random() > 0.5, count: Math.floor(random() * 100) },
            };
            for (let depth = 0; depth < chainDepth; depth += 1) {
                payload = {
                    alpha: payload,
                    beta: randomText(random, 10),
                    gamma: [depth, randomText(random, 7)],
                    delta: null,
                };
            }
            const original = {
                info: {
                    id: `random-message-${caseIndex}`,
                    role: caseIndex % 2 === 0 ? "assistant" : "user",
                },
                parts: [
                    { type: "text", text: randomText(random, 20) },
                    {
                        type: "tool",
                        callID: `call-${caseIndex}`,
                        state: {
                            status: "completed",
                            input: { query: randomText(random, 9), limit: caseIndex % 17 },
                            output: randomText(random, 24),
                        },
                    },
                ],
                payload,
            } as MessageLike & { payload: Record<string, unknown> };
            const snapshot = __rustModeTransformTest.messageContentSnapshot(original);
            const legacyOriginal = legacyMessageContentFields(original);
            expect(sameSnapshotFields(legacyOriginal, snapshot.fields)).toBe(true);
            expect(__rustModeTransformTest.messageMatchesContentSnapshot(original, snapshot)).toBe(
                true,
            );

            const mutated = structuredClone(original);
            const mutationDepth = Math.floor(random() * chainDepth);
            let parent: Record<string, unknown> = mutated;
            let parentKey = "payload";
            let target = mutated.payload;
            for (let depth = 0; depth < mutationDepth; depth += 1) {
                parent = target;
                parentKey = "alpha";
                target = target.alpha as Record<string, unknown>;
            }
            switch (caseIndex % 5) {
                case 0:
                    target[`added_${caseIndex}`] = randomText(random, 5);
                    break;
                case 1:
                    delete target.beta;
                    break;
                case 2:
                    target.beta = [target.beta, { retyped: true }];
                    break;
                case 3: {
                    const reordered = Object.fromEntries(Object.entries(target).reverse());
                    parent[parentKey] = reordered;
                    break;
                }
                default: {
                    const prior = String(target.beta);
                    target.beta = `${prior.slice(0, -1)}${prior.endsWith("z") ? "y" : "z"}`;
                    break;
                }
            }

            const legacyMutated = legacyMessageContentFields(mutated);
            const legacyVerdict = sameSnapshotFields(legacyMutated, snapshot.fields);
            const cursorVerdict = __rustModeTransformTest.messageMatchesContentSnapshot(
                mutated,
                snapshot,
            );
            expect(cursorVerdict).toBe(legacyVerdict);
            expect(cursorVerdict).toBe(false);
        }
    });

    it("checks a 1,400-message multi-megabyte prefix within the steady-pass budget", () => {
        const text = "x".repeat(2_048);
        const messages = Array.from({ length: 1_400 }, (_, index) => ({
            info: { id: `m-${index}`, role: "user" },
            parts: [{ type: "text", text }],
        })) as MessageLike[];
        const snapshots = __rustModeTransformTest.contentSnapshotsFor(messages);
        const samples: number[] = [];
        for (let sample = 0; sample < 7; sample += 1) {
            const startedAt = performance.now();
            expect(
                messages.every((message, index) =>
                    __rustModeTransformTest.messageMatchesContentSnapshot(
                        message,
                        snapshots[index],
                    ),
                ),
            ).toBe(true);
            samples.push(performance.now() - startedAt);
        }
        samples.sort((left, right) => left - right);
        expect(samples[3]).toBeLessThan(10);
    });

    it("recovers after a queued user message is mutated in place and the module rejects twice", async () => {
        const sessionId = `rust-tail-mutation-recovery-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const initial = makeMessages(sessionId);
        const mutated: MessageLike[] = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>queued user message was wrapped in place</system-reminder>",
                    },
                ],
            },
        ];
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                transformCalls += 1;
                if (transformCalls === 2 || transformCalls === 3) {
                    throw new Error("CK message block identity drift");
                }
                return {
                    decision: "SOFT+",
                    prefix_bust_permitted: false,
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "module recovered" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });

        await transform.run(
            sessionId,
            initial,
            { messages: initial as unknown[] },
            makeMeta(db, sessionId),
        );
        for (let retry = 0; retry < 2; retry += 1) {
            const output = { messages: mutated as unknown[] };
            await expect(
                transform.run(sessionId, mutated, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toBe(mutated);
        }
        expect(transform.getState(sessionId).consecutiveFailures).toBe(2);
        expect(transform.getState(sessionId).parked).toBe(false);

        const recoveredOutput = { messages: mutated as unknown[] };
        await transform.run(sessionId, mutated, recoveredOutput, makeMeta(db, sessionId));
        expect(transformCalls).toBe(4);
        expect(recoveredOutput.messages).toEqual([
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "module recovered" }],
            },
        ]);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
    });
});

describe("Rust stalled transform probe", () => {
    function fakeClock() {
        let now = 0;
        let nextId = 0;
        const timers = new Map<number, { at: number; callback: () => void }>();
        return {
            now: () => now,
            setTimeout: ((callback: () => void, delay: number) => {
                const id = ++nextId;
                timers.set(id, { at: now + delay, callback });
                return id as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout,
            clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
                timers.delete(id as unknown as number);
            }) as typeof clearTimeout,
            hasDelay: (delay: number) =>
                [...timers.values()].some((timer) => timer.at === now + delay),
            async waitForDelay(delay: number) {
                for (let turn = 0; turn < 1_000; turn++) {
                    if (this.hasDelay(delay)) return;
                    await Promise.resolve();
                }
                throw new Error(`Expected a ${delay}ms timer to be scheduled`);
            },
            async advance(ms: number) {
                const until = now + ms;
                while (true) {
                    const next = [...timers.entries()]
                        .filter(([, timer]) => timer.at <= until)
                        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                    if (!next) break;
                    now = next[1].at;
                    timers.delete(next[0]);
                    next[1].callback();
                    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
                }
                now = until;
            },
        };
    }

    const abortableSilence = (signal?: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
                once: true,
            });
        });

    it("direct Rust entry yields during async writer acquisition before invoking the callback", async () => {
        const sessionId = `rust-foreground-scope-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let injecting = false;
        let attempts = 0;
        let callbacks = 0;
        const exec = db.exec.bind(db);
        const intercepted = spyOn(db, "exec").mockImplementation((sql) => {
            if (injecting && sql === "BEGIN IMMEDIATE" && ++attempts === 1)
                throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
            return exec(sql);
        });
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                injecting = true;
                try {
                    await withAsyncPrivilegedWriter(db, () => {
                        callbacks++;
                    });
                } finally {
                    injecting = false;
                }
                return {
                    decision: "SOFT+",
                    prefix_bust_permitted: false,
                    native_messages: [
                        { role: "assistant", parts: [{ type: "text", text: "scoped result" }] },
                    ],
                };
            },
        };
        try {
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const output = { messages: [] as unknown[] };
            await transform.run(
                sessionId,
                makeMessages(sessionId),
                output,
                makeMeta(db, sessionId),
            );
            expect(attempts).toBe(2);
            expect(callbacks).toBe(1);
            expect(JSON.stringify(output.messages)).toContain("scoped result");
        } finally {
            intercepted.mockRestore();
        }
    });

    it("gives need_full_sync a fresh full-wire budget after a nearly exhausted delta", async () => {
        const sessionId = `rust-full-sync-fresh-budget-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const clock = fakeClock();
        const calls: Array<{ body: Record<string, unknown>; timeoutMs?: number; at: number }> = [];
        const native = [
            { role: "assistant", parts: [{ type: "text", text: "slow full retry completed" }] },
        ];
        const moduleClient: RustModeModuleClient = {
            invalidateStateSyncCapabilities: () => undefined,
            call: async ({ method, body, timeoutMs }) => {
                if (method !== "transform") return { ok: true };
                calls.push({
                    body: structuredClone(body) as Record<string, unknown>,
                    timeoutMs,
                    at: clock.now(),
                });
                if (calls.length === 2) {
                    await new Promise((resolve) => clock.setTimeout(resolve, 14000));
                    return { status: "need_full_sync" };
                }
                if (calls.length === 3)
                    await new Promise((resolve) => clock.setTimeout(resolve, 20000));
                return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: native };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            clockForTests: clock,
        });
        const first = makeMessages(sessionId);
        await transform.run(sessionId, first, { messages: [...first] }, makeMeta(db, sessionId));
        const second = makeMessages(sessionId);
        const output = { messages: [...second] as unknown[] };
        const outcome = transform.run(sessionId, second, output, makeMeta(db, sessionId)).then(
            () => "served",
            (error) => error,
        );
        await clock.waitForDelay(14000);
        expect(calls[1].body.tail_delta).toBeDefined();
        expect(calls[1].timeoutMs).toBe(15000);
        await clock.advance(14000);
        await clock.waitForDelay(20000);
        expect(calls[2].body.tail_delta).toBeUndefined();
        expect(calls[2].at).toBe(14000);
        expect(calls[2].timeoutMs).toBe(45000);
        await clock.advance(20000);
        expect(await outcome).toBe("served");
        expect(clock.now()).toBe(34000);
        expect(calls).toHaveLength(3);
        expect(output.messages).toEqual(native);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
    });

    it("polls an applying final page until committed without another execution", async () => {
        const sessionId = `rust-applying-replay-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const clock = fakeClock();
        let executions = 0;
        const pages: unknown[] = [];
        const budgets: number[] = [];
        const native = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "committed fold" }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, timeoutMs }) => {
                if (method !== "transform") return { ok: true };
                pages.push(structuredClone(body));
                budgets.push(timeoutMs!);
                if (executions === 0) {
                    executions++;
                    throw Object.assign(new Error("request deadline"), { code: "ETIMEDOUT" });
                }
                if (clock.now() < 750)
                    throw Object.assign(new Error("the final transform page is being applied"), {
                        code: "authority_transform_page_in_progress",
                    });
                return { decision: "HARD", row_version: 7, native_messages: native };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            clockForTests: clock,
        });
        const output = { messages: [] as unknown[] };
        const outcome = transform
            .run(sessionId, makeMessages(sessionId), output, makeMeta(db, sessionId))
            .then(
                () => "served",
                (error) => error,
            );
        await clock.waitForDelay(250);
        await clock.advance(750);
        expect(await outcome).toBe("served");
        expect(executions).toBe(1);
        expect(pages).toHaveLength(5);
        for (const page of pages) expect(page).toEqual(pages[0]);
        expect(budgets).toEqual([45000, 45000, 44750, 44500, 44250]);
        expect(output.messages).toEqual(native);
        expect(transform.getState(sessionId).consecutiveFailures).toBe(0);
    });

    it("in-progress final-page polling expires at one fixed completion deadline", async () => {
        const sessionId = `rust-applying-deadline-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const clock = fakeClock();
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (++calls === 1)
                    throw Object.assign(new Error("request deadline"), { code: "ETIMEDOUT" });
                throw Object.assign(new Error("still applying"), {
                    code: "authority_transform_page_in_progress",
                });
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            clockForTests: clock,
        });
        const outcome = transform
            .run(sessionId, makeMessages(sessionId), { messages: [] }, makeMeta(db, sessionId))
            .then(
                () => "served",
                (error) => error,
            );
        await clock.waitForDelay(250);
        await clock.advance(45000);
        expect(await outcome).toBeInstanceOf(EmergencyFailClosedError);
        expect(calls).toBeGreaterThan(2);
        expect(calls).toBeLessThanOrEqual(181);
        expect(clock.now()).toBe(45000);
    });

    it("parked no-LKG uses a short hard health deadline but admits a healthy slow module", async () => {
        const sessionId = `rust-park-probe-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const clock = fakeClock();
        let phase: "failing" | "hung" | "healthy" = "failing";
        let fullCalls = 0;
        let probes = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, timeoutMs }) => {
                if (method === "session.status") {
                    probes++;
                    expect(timeoutMs).toBeLessThanOrEqual(2000);
                    if (phase === "hung") return new Promise(() => {});
                    return { ok: true };
                }
                if (method !== "transform") return { ok: true };
                fullCalls++;
                if (phase === "failing") throw new Error("module unavailable");
                if (phase === "hung") return new Promise(() => {});
                await new Promise((resolve) => clock.setTimeout(resolve, 5000));
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: [
                        {
                            info: { id: "m1", role: "user", sessionID: sessionId },
                            parts: [{ type: "text", text: "healthy but slow" }],
                        },
                    ],
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            clockForTests: clock,
        });
        for (let i = 0; i < 3; i++)
            await expect(
                transform.run(
                    sessionId,
                    makeMessages(sessionId),
                    { messages: [] },
                    makeMeta(db, sessionId),
                ),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        expect(transform.getState(sessionId).parked).toBe(true);
        phase = "hung";
        const hung = transform
            .run(sessionId, makeMessages(sessionId), { messages: [] }, makeMeta(db, sessionId))
            .then(
                () => "served",
                (error) => error,
            );
        await clock.waitForDelay(2000);
        await clock.advance(2000);
        expect(await hung).toBeInstanceOf(EmergencyFailClosedError);
        expect(fullCalls).toBe(3);
        expect(probes).toBe(1);
        phase = "healthy";
        const output = { messages: [] as unknown[] };
        const healthy = transform.run(
            sessionId,
            makeMessages(sessionId),
            output,
            makeMeta(db, sessionId),
        );
        await clock.waitForDelay(5000);
        await clock.advance(5000);
        await healthy;
        expect(fullCalls).toBe(4);
        expect(probes).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(output.messages)).toContain("healthy but slow");
        expect(transform.getState(sessionId).parked).toBe(false);
    });

    it("waits for the original transform after a healthy probe without sending a duplicate", async () => {
        const sessionId = `rust-stall-probe-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        input[0]!.info.model = { providerID: "test-provider", modelID: "test-model" };
        const transformBodies: Record<string, unknown>[] = [];
        let healthProbes = 0;
        // Hold the original response until the probe answers so a duplicate
        // transform request cannot hide behind an early completion.
        let releaseTransform: () => void = () => {};
        const probeObserved = new Promise<void>((resolve) => {
            releaseTransform = resolve;
        });
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, signal }) => {
                if (method === "session.status") {
                    healthProbes += 1;
                    releaseTransform();
                    return { ok: true };
                }
                if (method !== "transform") return { ok: true };
                const request = body as Record<string, unknown>;
                transformBodies.push(request);
                await probeObserved;
                if (signal?.aborted) throw signal.reason ?? new Error("aborted");
                return {
                    decision: "SOFT+",
                    served_from: "transform",
                    native_messages: structuredClone(input),
                };
            },
        };
        const clock = fakeClock();
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            clockForTests: clock,
            moduleTimeoutMs: 100,
            stallProbeAfterMsForTests: 10,
            healthProbeTimeoutMsForTests: 50,
        });
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const output = { messages: [...input] as unknown[] };
            const run = transform.run(sessionId, input, output, makeMeta(db, sessionId));
            await clock.waitForDelay(10);
            await clock.advance(10);
            await run;

            expect(output.messages).toEqual(input);
            expect(healthProbes).toBe(1);
            expect(transformBodies).toHaveLength(1);
            expect(transformBodies[0]!.resend).toBeUndefined();
            const suppressionLogs = logSpy.mock.calls.filter(
                ([loggedSession, message]) =>
                    loggedSession === sessionId &&
                    String(message).includes("duplicate resend suppressed"),
            );
            expect(suppressionLogs).toHaveLength(1);
            expect(String(suppressionLogs[0]![1])).toContain(
                `original_attempt=${transformBodies[0]!.attempt_id}`,
            );
        } finally {
            logSpy.mockRestore();
        }
    });

    it("keeps waiting when the health probe fails and preserves the refusal", async () => {
        const sessionId = `rust-stall-probe-failure-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        input[0]!.info.model = { providerID: "test-provider", modelID: "test-model" };
        let transformCalls = 0;
        let healthProbes = 0;
        let releaseProbe: () => void = () => {};
        const probeObserved = new Promise<void>((resolve) => {
            releaseProbe = resolve;
        });
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, signal }) => {
                if (method === "session.status") {
                    healthProbes += 1;
                    releaseProbe();
                    throw new Error("probe unavailable");
                }
                if (method !== "transform") return { ok: true };
                transformCalls += 1;
                return abortableSilence(signal);
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { percentage: 96, inputTokens: 122_880 },
            updatedAt: Date.now(),
        });
        recordOverflowDetected(
            db,
            sessionId,
            128_000,
            "test-provider/test-model",
            "provider_overflow",
        );
        const clock = fakeClock();
        const transform = createRustModeTransform(deps, {
            moduleClient,
            clockForTests: clock,
            moduleTimeoutMs: 50,
            stallProbeAfterMsForTests: 0,
            healthProbeTimeoutMsForTests: 25,
        });

        const run = transform.run(
            sessionId,
            input,
            { messages: [...input] as unknown[] },
            makeMeta(db, sessionId),
        );
        let settled = false;
        const refusal = run
            .then(
                () => {
                    throw new Error("Expected an emergency refusal");
                },
                (error: unknown) => error,
            )
            .then((result) => {
                settled = true;
                return result;
            });
        await clock.waitForDelay(0);
        await clock.advance(0);
        await probeObserved;
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        expect(healthProbes).toBe(1);
        expect(settled).toBe(false);
        await clock.advance(50);
        expect(await refusal).toEqual(
            expect.objectContaining({
                name: "EmergencyFailClosedError",
                message: ENGINE_RECONNECTING_USER_MESSAGE,
            }),
        );
        expect(healthProbes).toBe(1);
        expect(transformCalls).toBe(1);
    });
});

describe("Rust ladder observability constants", () => {
    it("keeps the emergency wall locked to the shared 95% contract", () => {
        expect(RUST_EMERGENCY_WALL_PCT).toBe(95);
        expect(RUST_EMERGENCY_WALL_PCT).toBe(ABSOLUTE_EMERGENCY_PERCENTAGE);
    });

    it("exports the failure, retry, and pressure ladder budgets", () => {
        expect(RUST_FAILURE_PARK_THRESHOLD).toBeGreaterThan(0);
        expect(RUST_PARK_RETRY_INTERVAL).toBeGreaterThan(0);
        expect(RUST_PARK_PROBE_PRESSURE_BYPASS_PCT).toBeLessThan(RUST_EMERGENCY_WALL_PCT);
    });
});

describe("LKG durability across restarts", () => {
    function durableSlotCount(db: ContextDatabase, sessionId: string): number {
        const row = db
            .prepare("SELECT COUNT(*) AS count FROM lkg_slots WHERE session_id = ?")
            .get(sessionId) as { count: number };
        return row.count;
    }

    function makeRestartModuleClient(
        sessionId: string,
        fail: () => boolean,
    ): {
        moduleClient: RustModeModuleClient;
        servedNative: () => unknown[];
    } {
        const native = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "cached prefix" }],
            },
            {
                info: { id: "out-1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "served by module" }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (fail()) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: structuredClone(native),
                };
            },
        };
        return { moduleClient, servedNative: () => structuredClone(native) };
    }

    function makeRestartInput(sessionId: string): MessageLike[] {
        return [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "current prefix" }],
            },
        ] as MessageLike[];
    }

    it("replays the durably persisted snapshot after a simulated process restart", async () => {
        const sessionId = `rust-lkg-restart-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const { moduleClient, servedNative } = makeRestartModuleClient(
            sessionId,
            () => failTransform,
        );
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeRestartInput(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeDefined();
        expect(durableSlotCount(db, sessionId)).toBe(1);

        // Simulated restart: the in-memory slot store is gone and hook init
        // re-registers the durable backend; a fresh transform owns fresh state.
        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        try {
            expect(getSlot(sessionId)).toBeDefined(); // hydrated from disk
            const restarted = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
            });
            failTransform = true;
            const output = { messages: [...input] as unknown[] };
            await restarted.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(output.messages).toEqual(servedNative());
            expect(restarted.getState(sessionId).consecutiveFailures).toBe(1);
        } finally {
            resetLkgSlotsForTest();
        }
    });

    it("releases an over-context frozen replay to fitting module output on a healthy defer", async () => {
        const sessionId = `rust-lkg-context-escape-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeRestartInput(sessionId);
        const largePrefix = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "x".repeat(20_000) }],
            },
        ];
        const fittingOutput = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "§123§ fitting fresh prefix" }],
            },
        ];
        let pass = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
                    row_version: pass,
                    native_messages: structuredClone(pass === 1 ? largePrefix : fittingOutput),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            const fallback = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
            expect(fallback.messages).toEqual(largePrefix);
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
            recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
            const healthy = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, healthy, makeMeta(db, sessionId));
            expect(healthy.messages).toEqual(fittingOutput);
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
            expect(getSlot(sessionId)?.jsonPrefix).toBe(JSON.stringify(fittingOutput));
            expect(
                logSpy.mock.calls.filter(([sid]) => sid === sessionId).map(([, line]) => line),
            ).toContain("lkg_frozen_replay_released reason=frozen_over_context_limit");
        } finally {
            logSpy.mockRestore();
        }
    });

    for (const invalidation of ["model", "anchor"] as const) {
        it(`releases a frozen replay on ${invalidation} validation failure on a healthy defer`, async () => {
            const sessionId = `rust-lkg-validation-${invalidation}-${Date.now()}`;
            sessions.push(sessionId);
            const db = makeDb();
            installRawProvider(sessionId);
            const input = makeRestartInput(sessionId);
            let pass = 0;
            const fresh = [
                {
                    info: { id: "fresh", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "§123§ fresh validated output" }],
                },
            ];
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) => {
                    if (method !== "transform") return { ok: true };
                    pass += 1;
                    if (pass === 2) throw new Error("daemon unavailable");
                    return {
                        decision: pass === 1 ? "HARD" : "SOFT+",
                        row_version: pass,
                        native_messages: structuredClone(pass === 1 ? input : fresh),
                    };
                },
            };
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            await transform.run(
                sessionId,
                input,
                { messages: [...input] },
                makeMeta(db, sessionId),
            );
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
            const changed = structuredClone(input);
            if (invalidation === "model")
                changed[0]!.info.model = { providerID: "test-provider", modelID: "other-model" };
            else changed[0]!.info.id = "replacement-anchor";
            const healthy = { messages: [...changed] as unknown[] };
            await transform.run(sessionId, changed, healthy, makeMeta(db, sessionId));
            expect(healthy.messages).toEqual(fresh);
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
        });
    }

    it("releases an invalid frozen replay to priced module output without raw refusal", async () => {
        const sessionId = `rust-lkg-frozen-invalid-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        const input = makeRestartInput(sessionId);
        input[0]!.parts = [{ type: "text", text: "x".repeat(20_000) }];
        let pass = 0;
        const moduleOutput = (currentPass: number) => [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: `module representation ${currentPass}` }],
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
                    served_from: "transform",
                    row_version: pass,
                    native_messages: moduleOutput(pass),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const initial = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, initial, makeMeta(db, sessionId));
            expect(initial.messages).toEqual(moduleOutput(1));

            const fallback = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
            expect(fallback.messages).toEqual(moduleOutput(1));
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);

            input[0]!.parts = [{ type: "text", text: "y".repeat(20_000) }];
            const released = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, released, makeMeta(db, sessionId));

            expect(released.messages).toEqual(moduleOutput(3));
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
            expect(getSlot(sessionId)?.jsonPrefix).toContain("module representation 3");
            const logLines = logSpy.mock.calls
                .filter(([loggedSession]) => loggedSession === sessionId)
                .map(([, message]) => String(message));
            expect(logLines).toContain("lkg_frozen_replay_released reason=lkg_content_mismatch");
            expect(logLines.some((line) => line.includes("raw_fallback_over_context_limit"))).toBe(
                false,
            );
            const passLines = logLines.filter((line) => line.startsWith("rust pass:"));
            expect(passLines.at(-1)).toContain("served_from=transform");
            expect(passLines.some((line) => line.includes("served_from=raw"))).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    for (const alias of [true, false]) {
        for (const replayPath of [
            "failure ladder",
            "parked shortcut",
            "parked health probe",
            "outer wrapper",
        ] as const) {
            it(`preserves the frozen replay after one new raw message with ${alias ? "aliased" : "separate"} arrays (${replayPath})`, async () => {
                const sessionId = `rust-lkg-ingress-${alias}-${replayPath}-${Date.now()}`;
                sessions.push(sessionId);
                const db = makeDb();
                installRawProvider(sessionId);
                const raw = Array.from({ length: 40 }, (_, index) => ({
                    info: {
                        id: index === 0 ? "m1" : `raw-${index}`,
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "test-provider", modelID: "test-model" },
                    },
                    parts: [{ type: "text", text: `raw message ${index}` }],
                })) as MessageLike[];
                const representation = [
                    {
                        info: { id: "m1", role: "user", sessionID: sessionId },
                        parts: [{ type: "text", text: "frozen prefix" }],
                    },
                ];
                let fail = false;
                let transformCalls = 0;
                let statusCalls = 0;
                const moduleClient: RustModeModuleClient = {
                    call: async ({ method }) => {
                        if (method === "session.status") {
                            statusCalls += 1;
                            if (fail) throw new Error("daemon unavailable");
                        }
                        if (method !== "transform") return { ok: true };
                        transformCalls += 1;
                        if (fail) throw new Error("daemon unavailable");
                        return {
                            decision: transformCalls === 1 ? "HARD" : "SOFT+",
                            scheduler_decision: transformCalls === 1 ? "execute" : "defer",
                            row_version: transformCalls,
                            native_messages: structuredClone(
                                transformCalls === 1
                                    ? representation
                                    : [
                                          {
                                              ...representation[0],
                                              parts: [
                                                  {
                                                      type: "text",
                                                      text: "§123§ fresh module prefix",
                                                  },
                                              ],
                                          },
                                      ],
                            ),
                        };
                    },
                };
                const deps = makeDeps(db, moduleClient);
                const transform = createRustModeTransform(deps, { moduleClient });
                await transform.run(
                    sessionId,
                    raw,
                    { messages: [...raw] },
                    makeMeta(db, sessionId),
                );
                const saved = getSlot(sessionId)!;
                fail = true;
                if (replayPath.startsWith("parked")) {
                    // Park without a replay, so the chosen parked caller must create
                    // the first freeze rather than keep an earlier baseline.
                    lkgSlot.dropSlot(sessionId);
                    for (let pass = 0; pass < RUST_FAILURE_PARK_THRESHOLD; pass += 1) {
                        await expect(
                            transform.run(
                                sessionId,
                                raw,
                                { messages: [...raw] },
                                makeMeta(db, sessionId),
                            ),
                        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
                    }
                    if (replayPath === "parked shortcut") {
                        // Pass five is a health probe; pass six is the shortcut.
                        await expect(
                            transform.run(
                                sessionId,
                                raw,
                                { messages: [...raw] },
                                makeMeta(db, sessionId),
                            ),
                        ).rejects.toBeInstanceOf(EmergencyFailClosedError);
                    }
                    expect(transform.getState(sessionId).parked).toBe(true);
                    expect(transform.getState(sessionId).lkgFrozenAtInputCount).toBeNull();
                    expect(lkgSlot.captureSlot(sessionId, saved)).toBe(true);
                }
                const ingress = [...raw];
                const fallback = { messages: alias ? ingress : ([...ingress] as unknown[]) };
                const beforeTransform = transformCalls;
                const beforeStatus = statusCalls;
                if (replayPath === "outer wrapper") {
                    const wrapper = createMessagesTransformHandler({
                        magicContext: {
                            "experimental.chat.messages.transform": async () => {
                                throw new Error("hook unavailable");
                            },
                        },
                    });
                    await wrapper({}, fallback as never);
                } else {
                    await transform.run(sessionId, ingress, fallback, makeMeta(db, sessionId));
                }
                expect(transformCalls - beforeTransform).toBe(
                    replayPath === "failure ladder" ? 1 : 0,
                );
                expect(statusCalls - beforeStatus).toBe(
                    replayPath === "parked health probe" ? 1 : 0,
                );
                expect(fallback.messages).toEqual(representation);
                expect(fallback.messages === ingress).toBe(alias);
                const frozenBytes = JSON.stringify(fallback.messages);
                const baseline = transform.getState(sessionId).lkgFrozenAtInputCount;

                fail = false;
                // Bypass the parked shortcut to exercise an actual healthy defer.
                if (replayPath.startsWith("parked"))
                    deps.contextUsageMap.set(sessionId, {
                        usage: {
                            inputTokens: 90_000,
                            percentage: RUST_PARK_PROBE_PRESSURE_BYPASS_PCT,
                        },
                        updatedAt: Date.now(),
                    });
                const nextRaw = [
                    ...raw,
                    {
                        info: {
                            id: "next",
                            role: "user",
                            sessionID: sessionId,
                            model: { providerID: "test-provider", modelID: "test-model" },
                        },
                        parts: [{ type: "text", text: "one new raw message" }],
                    } as MessageLike,
                ];
                const deferred = { messages: alias ? [...nextRaw] : ([...nextRaw] as unknown[]) };
                const nextInput = alias ? (deferred.messages as MessageLike[]) : nextRaw;
                await transform.run(sessionId, nextInput, deferred, makeMeta(db, sessionId));
                expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
                expect(JSON.stringify(deferred.messages.slice(0, fallback.messages.length))).toBe(
                    frozenBytes,
                );
                expect(deferred.messages.at(-1)).toEqual(nextRaw.at(-1));
                expect(baseline).toBe(40);
                expect(transformCalls).toBe(
                    beforeTransform + (replayPath === "failure ladder" ? 2 : 1),
                );
            });
        }
    }

    for (const alias of [true, false]) {
        it(`keeps frozen bytes through twenty new raw messages and ten healthy defers with ${alias ? "aliased" : "separate"} arrays until a genuine rebuild`, async () => {
            const sessionId = `rust-lkg-debt-${alias}-${Date.now()}`;
            sessions.push(sessionId);
            const db = makeDb();
            installRawProvider(sessionId);
            const raw = makeRestartInput(sessionId);
            let pass = 0;
            let rebuild = false;
            let lastRaw = raw;
            const moduleClient: RustModeModuleClient = {
                call: async ({ method }) => {
                    if (method !== "transform") return { ok: true };
                    pass += 1;
                    if (pass === 2) throw new Error("daemon unavailable");
                    return {
                        decision: pass === 1 || rebuild ? "HARD" : "SOFT+",
                        prefix_bust_permitted: pass === 1 || rebuild,
                        scheduler_decision: pass === 1 || rebuild ? "execute" : "defer",
                        row_version: pass,
                        native_messages: structuredClone(lastRaw).map((message) => ({
                            ...message,
                            parts: [{ type: "text", text: `§123§ tagged ${message.info.id}` }],
                        })),
                    };
                },
            };
            let transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const serve = async (input: MessageLike[]) => {
                lastRaw = input;
                const ingress = structuredClone(input);
                const output = { messages: alias ? ingress : ([...ingress] as unknown[]) };
                await transform.run(sessionId, ingress, output, makeMeta(db, sessionId));
                return output.messages;
            };
            const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
            try {
                await serve(raw);
                const outageTail = [
                    {
                        info: { id: "outage-assistant", role: "assistant", sessionID: sessionId },
                        parts: [
                            { type: "text", text: "already served without a tag" },
                            {
                                type: "tool",
                                callID: "outage-read",
                                tool: "read",
                                state: {
                                    status: "completed",
                                    input: { path: "fixture.txt" },
                                    output: "already served tool result",
                                    title: "read fixture",
                                },
                            },
                        ],
                    },
                    {
                        info: {
                            id: "outage-user",
                            role: "user",
                            sessionID: sessionId,
                            model: { providerID: "test-provider", modelID: "test-model" },
                        },
                        parts: [{ type: "text", text: "already served user tail" }],
                    },
                ] as MessageLike[];
                raw.push(...outageTail);
                const fallback = await serve(raw);
                const frozenBytes = JSON.stringify(fallback);
                const appended = Array.from({ length: 20 }, (_, index) => ({
                    info: {
                        id: `new-${index}`,
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "test-provider", modelID: "test-model" },
                    },
                    parts: [{ type: "text", text: `new raw message ${index}` }],
                })) as MessageLike[];
                raw.push(...appended);
                const expectedBytes = JSON.stringify([...fallback, ...appended]);
                for (let healthyPass = 1; healthyPass <= 10; healthyPass += 1) {
                    const served = await serve(raw);
                    expect(JSON.stringify(served)).toBe(expectedBytes);
                    expect(JSON.stringify(served.slice(0, fallback.length))).toBe(frozenBytes);
                    expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
                    expect(transform.getState(sessionId).lkgFrozenHealthyPasses).toBe(healthyPass);
                }
                const lines = logSpy.mock.calls
                    .filter(([sid]) => sid === sessionId)
                    .map(([, line]) => String(line));
                expect(lines).toContain("lkg_frozen_replay_debt healthy_passes=10 raw_messages=20");
                expect(lines.some((line) => line.startsWith("lkg_frozen_replay_released"))).toBe(
                    false,
                );
                // Restarting must not turn pending tags into permission to rewrite
                // the raw-served tail recorded in the durable snapshot.
                transform.dispose();
                resetLkgSlotsForTest();
                registerLkgPersistence(createDbLkgPersistence(db));
                transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
                expect(JSON.stringify(await serve(raw))).toBe(expectedBytes);
                expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
                rebuild = true;
                const adopted = await serve(raw);
                expect(JSON.stringify(adopted)).not.toBe(expectedBytes);
                expect((adopted[1] as MessageLike).parts).toEqual([
                    { type: "text", text: "§123§ tagged outage-assistant" },
                ]);
                expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
                expect(transform.getState(sessionId).lkgFrozenHealthyPasses).toBe(0);
                expect(transform.getState(sessionId).lkgFrozenAtInputCount).toBeNull();
            } finally {
                logSpy.mockRestore();
            }
        });
    }

    it("keeps a valid frozen replay past the eighth healthy defer until a module rebuild", async () => {
        const sessionId = `rust-lkg-frozen-bounded-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeRestartInput(sessionId);
        const representationA = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "bounded representation A" }],
            },
        ];
        const representationB = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "bounded representation B" }],
            },
        ];
        let pass = 0;
        let rebuild = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 || rebuild ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1 || rebuild,
                    served_from: "transform",
                    row_version: pass,
                    native_messages: structuredClone(
                        pass === 1 ? representationA : representationB,
                    ),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const initial = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, initial, makeMeta(db, sessionId));
        const fallback = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
        expect(fallback.messages).toEqual(representationA);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);

        for (let healthyPass = 1; healthyPass <= 10; healthyPass += 1) {
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(output.messages).toEqual(representationA);
            expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        }
        rebuild = true;
        const rebuilt = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, rebuilt, makeMeta(db, sessionId));
        expect(rebuilt.messages).toEqual(representationB);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
    });

    it("keeps a valid frozen replay after sixteen new raw messages until a module rebuild", async () => {
        const sessionId = `rust-lkg-frozen-tail-bound-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeRestartInput(sessionId);
        const frozenRepresentation = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "tail-bound representation A" }],
            },
        ];
        const moduleRepresentation = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "tail-bound representation B" }],
            },
        ];
        let pass = 0;
        let rebuild = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 || rebuild ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 1 || rebuild,
                    served_from: "transform",
                    row_version: pass,
                    native_messages: structuredClone(
                        pass === 1 ? frozenRepresentation : moduleRepresentation,
                    ),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));

        const grownInput = [...input];
        for (let index = 1; index <= 16; index += 1) {
            grownInput.push({
                info: {
                    id: `tail-${index}`,
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: `tail message ${index}` }],
            } as MessageLike);
        }
        const released = { messages: [...grownInput] as unknown[] };
        await transform.run(sessionId, grownInput, released, makeMeta(db, sessionId));

        expect(released.messages).toEqual([...frozenRepresentation, ...grownInput.slice(1)]);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        rebuild = true;
        await transform.run(sessionId, grownInput, released, makeMeta(db, sessionId));
        expect(released.messages).toEqual(moduleRepresentation);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
    });

    it("freezes a replayed representation across defers and converts it on a bust", async () => {
        const sessionId = `rust-lkg-frozen-transition-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeRestartInput(sessionId);
        const representationA = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "representation A" }],
            },
        ];
        const representationB = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "representation B" }],
            },
        ];
        const representationC = [
            ...representationB,
            {
                info: { id: "m2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "delta tail" }],
            },
        ];
        let pass = 0;
        const transformBodies: Record<string, unknown>[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                transformBodies.push(body as Record<string, unknown>);
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 4 ? "HARD" : pass === 1 ? "HARD" : "SOFT+",
                    prefix_bust_permitted: pass === 4 || pass === 1,
                    native_messages: structuredClone(
                        pass === 1
                            ? representationA
                            : pass >= 5
                              ? representationC
                              : representationB,
                    ),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });

        const initial = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, initial, makeMeta(db, sessionId));
        expect(initial.messages).toEqual(representationA);

        const fallback = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
        expect(fallback.messages).toEqual(representationA);

        const deferred = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, deferred, makeMeta(db, sessionId));
        expect(deferred.messages).toEqual(representationA);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);

        const busted = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, busted, makeMeta(db, sessionId));
        expect(busted.messages).toEqual(representationB);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
        // The first recovery re-primes the native basis; later frozen passes may
        // use it for transport without changing the provider-visible representation.
        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[3]?.tail_delta).toBeDefined();

        const resumedInput = [
            ...input,
            {
                info: {
                    id: "m2",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "delta tail" }],
            },
        ] as MessageLike[];
        const resumed = { messages: [...resumedInput] as unknown[] };
        await transform.run(sessionId, resumedInput, resumed, makeMeta(db, sessionId));
        expect(resumed.messages).toEqual(representationC);
        expect(transformBodies[4]?.tail_delta).toBeDefined();
    });

    it("drops a frozen LKG instead of replaying it after an in-process model flip", async () => {
        const sessionId = `rust-lkg-frozen-model-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeRestartInput(sessionId);
        const frozenRepresentation = [
            {
                info: { id: "m1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "frozen representation" }],
            },
        ];
        let calls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                calls += 1;
                if (calls > 1) throw new Error("daemon unavailable");
                return {
                    decision: "HARD",
                    prefix_bust_permitted: true,
                    native_messages: structuredClone(frozenRepresentation),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        const fallback = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
        expect(fallback.messages).toEqual(frozenRepresentation);

        const switchedInput = structuredClone(input);
        switchedInput[0]!.info.model = {
            providerID: "test-provider",
            modelID: "other-model",
        };
        const switched = { messages: [...switchedInput] as unknown[] };
        await expect(
            transform.run(sessionId, switchedInput, switched, makeMeta(db, sessionId)),
        ).rejects.toBeInstanceOf(RawFallbackContextLimitError);

        expect(switched.messages).toEqual(switchedInput);
        expect(getSlot(sessionId)).toBeUndefined();
        expect(transform.getState(sessionId).forceFullWire).toBe(true);
    });

    it("still refuses a model change on a hydrated slot", async () => {
        const sessionId = `rust-lkg-restart-model-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const { moduleClient } = makeRestartModuleClient(sessionId, () => failTransform);
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeRestartInput(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(durableSlotCount(db, sessionId)).toBe(1);

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        try {
            const restarted = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
            });
            failTransform = true;
            // The session switched models across the restart: the replay model
            // fence must drop the hydrated slot and the durable row with it.
            const switchedInput = [
                {
                    info: {
                        id: "m1",
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "test-provider", modelID: "other-model" },
                    },
                    parts: [{ type: "text", text: "current prefix" }],
                },
            ] as MessageLike[];
            const output = { messages: [...switchedInput] as unknown[] };
            await expect(
                restarted.run(sessionId, switchedInput, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
            expect(output.messages).toEqual(switchedInput); // Refusal leaves the supplied message array unchanged instead of sending the cached prefix.
            expect(getSlot(sessionId)).toBeUndefined();
            expect(durableSlotCount(db, sessionId)).toBe(0);
        } finally {
            resetLkgSlotsForTest();
        }
    });

    it("still refuses an id-sequence divergence on a hydrated slot", async () => {
        const sessionId = `rust-lkg-restart-ids-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let failTransform = false;
        const { moduleClient } = makeRestartModuleClient(sessionId, () => failTransform);
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeRestartInput(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(durableSlotCount(db, sessionId)).toBe(1);

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        try {
            const restarted = createRustModeTransform(makeDeps(db, moduleClient), {
                moduleClient,
            });
            failTransform = true;
            // The conversation no longer contains the captured anchor message.
            const divergedInput = [
                {
                    info: {
                        id: "m2",
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "test-provider", modelID: "test-model" },
                    },
                    parts: [{ type: "text", text: "reshaped history" }],
                },
            ] as MessageLike[];
            const output = { messages: [...divergedInput] as unknown[] };
            await expect(
                restarted.run(sessionId, divergedInput, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
            expect(output.messages).toEqual(divergedInput);
            expect(getSlot(sessionId)).toBeUndefined();
            expect(durableSlotCount(db, sessionId)).toBe(0);
        } finally {
            resetLkgSlotsForTest();
        }
    });

    it("clears the durable row when a slot is dropped", async () => {
        const sessionId = `rust-lkg-drop-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const failTransform = false;
        const { moduleClient } = makeRestartModuleClient(sessionId, () => failTransform);
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const input = makeRestartInput(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(durableSlotCount(db, sessionId)).toBe(1);

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        try {
            // A drop with nothing in memory (the post-restart state) must still
            // reach the durable row.
            const { dropSlot } = await import("./lkg-slot");
            dropSlot(sessionId, "test-drop");
            expect(durableSlotCount(db, sessionId)).toBe(0);
        } finally {
            resetLkgSlotsForTest();
        }
    });
});

describe("raw fallback refusal copy and early abort", () => {
    it("keeps the refusal copy calm and number-free while preserving the typed fields", () => {
        const error = new RawFallbackContextLimitError(5_493_229, 1_000_000);
        expect(error.message).toBe(ENGINE_RECONNECTING_USER_MESSAGE);
        expect(error.message).not.toMatch(/\d/);
        expect(error.estimatedTokens).toBe(5_493_229);
        expect(error.contextLimitTokens).toBe(1_000_000);
        expect(error.code).toBe("RAW_FALLBACK_CONTEXT_LIMIT");
        expect(error.recoverable).toBe(true);
    });

    it("aborts the byte proxy early and never runs the estimator when the sum crosses the budget", async () => {
        const sessionId = `rust-raw-early-abort-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 1_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("client closed");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        let estimatorCalls = 0;
        const transform = createRustModeTransform(deps, {
            moduleClient,
            rawFallbackEstimatorForTests: () => {
                estimatorCalls += 1;
                return {
                    tokens: 10,
                    trusted: true,
                    messageTokens: { conversation: 10, toolCall: 0 },
                    systemTokens: 0,
                    toolDefinitionTokens: 0,
                };
            },
        });
        // Budget is 1,000 tokens = 4,000 proxy bytes. Three ~2,000-byte messages
        // cross it mid-array; the tokenizer pass must never run.
        const input = [0, 1, 2].map(
            (index) =>
                ({
                    info: {
                        id: `m${index + 1}`,
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "test-provider", modelID: "test-model" },
                    },
                    parts: [{ type: "text", text: "x".repeat(2_000) }],
                }) as MessageLike,
        );
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        // A module-mocked logger can retain earlier transforms' calls when Bun
        // reuses it for spyOn. Only this refusal pass belongs in the assertions.
        logSpy.mockClear();
        try {
            const output = { messages: [] as unknown[] };
            await expect(
                transform.run(sessionId, input, output, makeMeta(db, sessionId)),
            ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
            expect(estimatorCalls).toBe(0);
            expect(output.messages).toEqual([]);
            const refusalLine = logSpy.mock.calls
                .map((call) => String(call[1] ?? ""))
                .find((line) => line.startsWith("raw_fallback_over_context_limit"));
            expect(refusalLine).toBeDefined();
            expect(refusalLine).toContain("early_abort=true");
            expect(refusalLine).toContain("estimated=skipped");
            expect(refusalLine).toContain("trusted=false");
            const passLine = logSpy.mock.calls
                .map((call) => String(call[1] ?? ""))
                .find((line) => line.startsWith("rust pass:"));
            expect(passLine).toContain("served_from=refused");
            expect(passLine).not.toContain("served_from=raw");
        } finally {
            logSpy.mockRestore();
        }
    });

    it("uses the calm refusal copy for the rust emergency fail-closed throw", async () => {
        const sessionId = `rust-fail-closed-copy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 100_000, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method === "transform") throw new Error("daemon unavailable");
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 96_000, percentage: 96 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ] as MessageLike[];

        const failure = transform
            .run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId))
            .catch((error: unknown) => error);
        await expect(failure).resolves.toBeInstanceOf(EmergencyFailClosedError);
        const error = (await failure) as EmergencyFailClosedError;
        expect(error.message).toBe(ENGINE_RECONNECTING_USER_MESSAGE);
        expect(error.message).not.toMatch(/\d/);
        expect(error.code).toBe("EMERGENCY_FAIL_CLOSED");
    });

    it("notifies parked sessions with the calm reconnect line", async () => {
        const sessionId = `rust-park-copy-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const moduleClient: RustModeModuleClient = {
            call: async () => {
                throw new Error("daemon unavailable");
            },
        };
        const parkedMessages: string[] = [];
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            notifyParked: (_sid, message) => {
                parkedMessages.push(message);
            },
        });
        for (let pass = 0; pass < RUST_FAILURE_PARK_THRESHOLD; pass += 1) {
            const input = makeMessages(sessionId);
            await expect(
                transform.run(
                    sessionId,
                    input,
                    { messages: input as unknown[] },
                    makeMeta(db, sessionId),
                ),
            ).rejects.toBeInstanceOf(EmergencyFailClosedError);
        }
        expect(parkedMessages).toEqual([ENGINE_RECONNECTING_USER_MESSAGE]);
    });
});

describe("rust-mode wire transport (protected_tokens_effective)", () => {
    it("transports resolved floor scalar protected_tokens_effective on the wire alongside effective_execute_threshold and never sends protected_tags", async () => {
        const sessionId = `rust-floor-wire-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") {
                    transformBodies.push(structuredClone(body) as Record<string, unknown>);
                    return { decision: "PASSTHROUGH", native_messages: [] };
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.protectedTokens = 24_000;
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));

        expect(transformBodies).toHaveLength(1);
        const wirePayload = transformBodies[0]!;
        expect(wirePayload.effective_execute_threshold).toBeDefined();
        expect(wirePayload.protected_tokens_effective).toBe(24_000);
        expect(wirePayload.protected_tags).toBeUndefined();
    });

    it("sends the derived floor when a project-only override tries to lower it", async () => {
        const sessionId = `rust-derived-floor-wire-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const transformBodies: Array<Record<string, unknown>> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") {
                    transformBodies.push(structuredClone(body) as Record<string, unknown>);
                    return { decision: "PASSTHROUGH", native_messages: [] };
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.protectedTokenTierOverrides = { project: 4_000 };
        deps.contextUsageMap.set(sessionId, {
            usage: { inputTokens: 20_000, percentage: 10 },
            updatedAt: Date.now(),
        });
        const transform = createRustModeTransform(deps, { moduleClient });
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));

        expect(transformBodies).toHaveLength(1);
        expect(transformBodies[0]?.protected_tokens_effective).toBe(10_240);
    });
});

for (const host of ["v1", "v2"] as const) {
    it(`${host} Rust failure serves measured 633258 LKG plus a small tail instead of inflated 912733`, async () => {
        const sessionId = `measured-rust-replay-${host}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const input = makeMessages(sessionId);
        const modelKey = "test-provider/test-model";
        if (host === "v1")
            noteLkgProviderResponse({ sessionId, modelKey, responseId: "reply", inputTokens: 0 });
        else beginV2LkgRequest(sessionId, modelKey, "previous-reply");
        let failing = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failing) throw new Error("rust module request timed out");
                return {
                    decision: "HARD",
                    row_version: 1,
                    native_messages: structuredClone(input),
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), {
            moduleClient,
            rawFallbackEstimatorForTests: () => ({
                tokens: 912_733,
                trusted: true,
                messageTokens: { conversation: 900_000, toolCall: 0 },
                systemTokens: 100,
                toolDefinitionTokens: 12_633,
            }),
        });
        const meta = makeMeta(db, sessionId);
        recordDetectedContextLimit(db, sessionId, 872_000, modelKey);
        await transform.run(sessionId, input, { messages: [...input] }, meta);
        const saved = getSlot(sessionId)!;
        expect(saved).toBeDefined();
        noteLkgProviderResponse({
            sessionId,
            modelKey,
            responseId: "reply",
            inputTokens: 633_258,
            finish: "stop",
            completedAt: Date.now() + 1,
            ...(host === "v2" ? { v2: true, createdAt: Date.now() + 1 } : {}),
        });
        const next: MessageLike[] = [
            ...input,
            {
                info: { id: "reply", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "small reply" }],
            } as MessageLike,
            {
                info: {
                    id: "next",
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: "test-provider", modelID: "test-model" },
                },
                parts: [{ type: "text", text: "continue" }],
            } as MessageLike,
        ];
        failing = true;
        const output = { messages: structuredClone(next) as unknown[] };
        await transform.run(sessionId, next, output, meta);
        expect(output.messages).toEqual([
            ...JSON.parse(saved.jsonPrefix),
            ...next.slice(input.length),
        ]);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        clearLkgMeasuredRequest(sessionId);
    });
}

it("refuses a tiny untrusted fallback estimate instead of treating the byte proxy as fit proof", async () => {
    const sessionId = "fit-incomplete-fallback";
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const moduleClient: RustModeModuleClient = {
        call: async () => {
            throw new Error("unavailable");
        },
    };
    const transform = createRustModeTransform(makeDeps(db, moduleClient), {
        moduleClient,
        rawFallbackEstimatorForTests: () => ({
            tokens: 1,
            trusted: false,
            messageTokens: { conversation: 1, toolCall: 0 },
            systemTokens: 0,
            toolDefinitionTokens: undefined,
        }),
    });
    const input = makeMessages(sessionId);
    const output = { messages: [...input] as unknown[] };
    await expect(
        transform.run(sessionId, input, output, makeMeta(db, sessionId)),
    ).rejects.toBeInstanceOf(RawFallbackContextLimitError);
    expect(output.messages).toEqual(input);
});

it("refuses LKG plus suffix when no tool-definition envelope exists", async () => {
    const sessionId = "fit-incomplete-replay";
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const input = makeMessages(sessionId);
    let failing = false;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            if (failing) throw new Error("unavailable");
            return { decision: "HARD", row_version: 1, native_messages: structuredClone(input) };
        },
    };
    const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const meta = makeMeta(db, sessionId);
    await transform.run(sessionId, input, { messages: [...input] }, meta);
    expect(getSlot(sessionId)).toBeDefined();
    failing = true;
    __resetToolDefinitionMeasurements();
    const output = { messages: [...input] as unknown[] };
    const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
    try {
        await expect(transform.run(sessionId, input, output, meta)).rejects.toBeInstanceOf(
            RawFallbackContextLimitError,
        );
        const lines = logSpy.mock.calls.map(([, message]) => String(message));
        expect(lines.some((line) => line.startsWith("lkg_fit_untrusted"))).toBe(true);
        expect(lines.some((line) => line.startsWith("lkg_over_context_limit"))).toBe(false);
    } finally {
        logSpy.mockRestore();
    }
    expect(output.messages).toEqual(input);
});

it("serves a fitting LKG with an envelope from another measured model", async () => {
    const sessionId = "fit-envelope-replay";
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const input = makeMessages(sessionId);
    let failing = false;
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            if (failing) throw new Error("module timed out");
            return { decision: "HARD", row_version: 1, native_messages: structuredClone(input) };
        },
    };
    const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const meta = makeMeta(db, sessionId);
    await transform.run(sessionId, input, { messages: [...input] }, meta);
    expect(getSlot(sessionId)).toBeDefined();
    __resetToolDefinitionMeasurements();
    recordToolDefinition("test-provider", "previous-model", "default", "read", "Read a file", {});
    failing = true;
    const output = { messages: [...input] as unknown[] };
    await transform.run(sessionId, input, output, meta);
    expect(output.messages).toEqual(input);
    expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
});

it("unknown calibrated raw fallback refuses both locally fitting and safe unmanaged requests", async () => {
    for (const [limit, allowed] of [
        [10000, false],
        [50000, true],
    ] as const) {
        const sessionId = `calibrated-raw-wall-${limit}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, limit, "test-provider/test-model");
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                throw new Error("synthetic daemon failure");
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const meta = makeMeta(db, sessionId);
        meta.systemPromptTokens = 6000;
        const input = makeMessages(sessionId);
        const output = { messages: [...input] as unknown[] };
        if (allowed) {
            await expect(transform.run(sessionId, input, output, meta)).rejects.toBeInstanceOf(
                EmergencyFailClosedError,
            );
            expect(output.messages).toEqual(input);
        } else {
            await expect(transform.run(sessionId, input, output, meta)).rejects.toMatchObject({
                code: "RAW_FALLBACK_CONTEXT_LIMIT",
                contextLimitTokens: 10000,
            });
            expect(output.messages).toEqual(input);
        }
    }
});

describe("proactive thinking strip on a released frozen replay", () => {
    const PREFIX_BOUND_MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

    function user(sessionId: string, id: string, text: string): MessageLike {
        return {
            info: { id, role: "user", sessionID: sessionId, model: { ...PREFIX_BOUND_MODEL } },
            parts: [{ type: "text", text }],
        } as MessageLike;
    }

    function thinkingAssistant(sessionId: string, id: string): MessageLike {
        return {
            info: { id, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "reasoning",
                    text: `thinking of ${id}`,
                    metadata: { anthropic: { signature: `signature-${id}` } },
                },
                { type: "text", text: `answer of ${id}` },
            ],
        } as MessageLike;
    }

    function hasReasoning(messages: unknown[], id: string): boolean {
        const message = messages.find(
            (candidate) => (candidate as MessageLike).info.id === id,
        ) as MessageLike;
        return message.parts.some((part) => (part as { type?: string }).type === "reasoning");
    }

    /**
     * Drive a prefix-bound Rust session through a HARD pass, an error pass that
     * freezes the last-known-good replay, and frozen defers. The module then keeps
     * deferring (`SOFT+`), so the only thing that can make the release pass priced
     * is the release itself.
     */
    async function frozenSession(label: string) {
        const sessionId = `rust-release-strip-${label}-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        recordDetectedContextLimit(db, sessionId, 200_000, "anthropic/claude-opus-5-5");
        let pass = 0;
        let decision = "SOFT+";
        let moduleOutput: (input: MessageLike[]) => unknown[] = (input) => structuredClone(input);
        let lastInput: MessageLike[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 ? "HARD" : decision,
                    prefix_bust_permitted: pass === 1 || decision === "HARD" || decision === "SOFT",
                    served_from: "transform",
                    row_version: pass,
                    native_messages: moduleOutput(lastInput),
                };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.liveModelBySession?.set(sessionId, { ...PREFIX_BOUND_MODEL });
        deps.getModelKey = () => "anthropic/claude-opus-5-5";
        const transform = createRustModeTransform(deps, { moduleClient });
        const run = async (input: MessageLike[]) => {
            lastInput = input;
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            return output.messages;
        };

        await run([user(sessionId, "m1", "question")]);
        const frozenInput = [
            user(sessionId, "m1", "question"),
            thinkingAssistant(sessionId, "a1"),
            user(sessionId, "m2", "follow-up"),
        ];
        await run(frozenInput);
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        const frozenServed = structuredClone(await run(frozenInput));
        expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
        expect(hasReasoning(frozenServed, "a1")).toBe(true);
        return {
            sessionId,
            transform,
            run,
            frozenInput,
            frozenServed,
            setDecision: (value: string) => {
                decision = value;
            },
            setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
                moduleOutput = value;
            },
        };
    }

    function sessionLines(logSpy: ReturnType<typeof spyOn>, sessionId: string): string[] {
        return logSpy.mock.calls
            .filter(([loggedSession]) => loggedSession === sessionId)
            .map(([, message]) => String(message));
    }

    it("serves byte-identical bytes past eight healthy defers without granting strip authority", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const session = await frozenSession("healthy");
            // Healthy defers accumulate debt but do not authorize any representation change.
            let served: unknown[] = session.frozenServed;
            for (let healthyPass = 2; healthyPass <= 8; healthyPass += 1) {
                served = await session.run(session.frozenInput);
            }
            expect(session.transform.getState(session.sessionId).lkgRepresentationFrozen).toBe(
                true,
            );
            const lines = sessionLines(logSpy, session.sessionId);
            expect(lines).toContain("lkg_frozen_replay_debt healthy_passes=8 raw_messages=0");
            expect(JSON.stringify(served)).toBe(JSON.stringify(session.frozenServed));
            expect(lines.some((line) => line.includes("proactive thinking strip"))).toBe(false);

            // Control: a pass the module prices itself still strips, so the fixture
            // reaches the strip and the release above was held by the predicate.
            session.setDecision("SOFT");
            const softServed = await session.run(session.frozenInput);
            expect(hasReasoning(softServed, "a1")).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("serves byte-identical bytes when a reasoning-run release changes nothing", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const session = await frozenSession("reasoning-run");
            // Two adjacent assistants that each open with thinking form one Anthropic
            // run with a second thinking block, which the frozen replay refuses.
            const releaseInput = [
                ...session.frozenInput,
                thinkingAssistant(session.sessionId, "a2"),
                thinkingAssistant(session.sessionId, "a3"),
            ];
            const served = await session.run(releaseInput);
            const lines = sessionLines(logSpy, session.sessionId);
            expect(lines).toContain(
                "lkg_frozen_replay_released reason=lkg_anthropic_reasoning_run_invalid",
            );
            expect(JSON.stringify(served.slice(0, session.frozenServed.length))).toBe(
                JSON.stringify(session.frozenServed),
            );
            expect(hasReasoning(served, "a1")).toBe(true);
            expect(hasReasoning(served, "a2")).toBe(true);
            expect(lines.some((line) => line.includes("proactive thinking strip"))).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("strips only thinking after the first message a release changes", async () => {
        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            const session = await frozenSession("tagged-tail");
            // The released module output tags the message the freeze served raw, the
            // shape both production specimens showed.
            session.setModuleOutput((input) =>
                structuredClone(input).map((message) =>
                    message.info.id === "m2"
                        ? { ...message, parts: [{ type: "text", text: "§2§ follow-up" }] }
                        : message,
                ),
            );
            const releaseInput = [
                ...session.frozenInput,
                thinkingAssistant(session.sessionId, "a2"),
                thinkingAssistant(session.sessionId, "a3"),
            ];
            const served = await session.run(releaseInput);
            expect(
                sessionLines(logSpy, session.sessionId).some((line) =>
                    line.includes("reason=lkg_anthropic_reasoning_run_invalid"),
                ),
            ).toBe(true);
            // a1 sits before the changed message: its bytes and prefix are unchanged.
            expect(JSON.stringify(served.slice(0, 2))).toBe(
                JSON.stringify(session.frozenServed.slice(0, 2)),
            );
            expect(hasReasoning(served, "a2")).toBe(false);
            expect(hasReasoning(served, "a3")).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });
});

it("copies the resolved history budget onto the authority wire", () => {
    const body = __rustModeTransformTest.buildTransformBody({
        sessionId: "budget-wire",
        input: [],
        nativeMessages: [],
        passInputs: { history_budget_tokens: 42_000 },
        usage: {},
        modelKey: null,
        providerId: null,
    });
    expect(body.history_budget_tokens).toBe(42_000);
});

it("copies the profile-resolved historian chain onto the authority wire", () => {
    const historianModelChain = __rustModeTransformTest.resolvedHistorianModelChain({
        historianModel: { model: "anthropic/profile-historian", qualifier: "high" },
        fallbackModels: [
            { model: "openai/profile-fallback", qualifier: "low" },
            "anthropic/profile-historian",
        ],
    });
    const body = __rustModeTransformTest.buildTransformBody({
        sessionId: "profile-model-wire",
        input: [],
        nativeMessages: [],
        passInputs: { historian_model_chain: historianModelChain },
        usage: {},
        modelKey: null,
        providerId: null,
    });

    expect(body.historian_model_chain).toEqual([
        "anthropic/profile-historian",
        "openai/profile-fallback",
    ]);
    const limits = __rustModeTransformTest.resolvedHistorianModelLimits(historianModelChain);
    expect(Object.keys(limits)).toEqual(body.historian_model_chain);
    expect(limits["anthropic/profile-historian"]).toBeDefined();
    expect(limits["openai/profile-fallback"]).toBeDefined();
});

it("copies each historian chain model's configured variant onto the authority wire", () => {
    const models = {
        historianModel: { model: "anthropic/profile-historian", qualifier: "high" },
        fallbackModels: [
            { model: "openai/profile-fallback", qualifier: "low" },
            "google/plain-fallback",
            // A repeated model keeps the first entry's slot, so its variant stays `high`.
            { model: "anthropic/profile-historian", qualifier: "max" },
        ],
    };
    const variants = __rustModeTransformTest.resolvedHistorianModelVariants(models);
    const body = __rustModeTransformTest.buildTransformBody({
        sessionId: "profile-variant-wire",
        input: [],
        nativeMessages: [],
        passInputs: {
            historian_model_chain: __rustModeTransformTest.resolvedHistorianModelChain(models),
            historian_model_variants: variants,
        },
        usage: {},
        modelKey: null,
        providerId: null,
    });

    expect(body.historian_model_variants).toEqual({
        "anthropic/profile-historian": "high",
        "openai/profile-fallback": "low",
    });
    expect(
        __rustModeTransformTest.resolvedHistorianModelVariants({
            historianModel: "anthropic/plain",
            fallbackModels: [],
        }),
    ).toEqual({});
});

it("copies caveman settings onto the authority wire", () => {
    const body = __rustModeTransformTest.buildTransformBody({
        sessionId: "caveman-wire",
        input: [],
        nativeMessages: [],
        passInputs: { caveman_enabled: true, caveman_min_chars: 240 },
        usage: {},
        modelKey: null,
        providerId: null,
    });
    expect(body.caveman_enabled).toBe(true);
    expect(body.caveman_min_chars).toBe(240);
});

it("fails after the second authority mismatch in one transform pass", async () => {
    const sessionId = `rust-adopt-once-${Date.now()}`;
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const messages = makeMessages(sessionId);
    const methods: string[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            methods.push(method);
            if (method === "state_sync") throw authoritySeqMismatch(4);
            return { decision: "SOFT+", prefix_bust_permitted: false, native_messages: [] };
        },
    };
    const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const output = { messages: messages as unknown[] };

    await expect(
        transform.run(sessionId, messages, output, makeMeta(db, sessionId)),
    ).rejects.toBeInstanceOf(EmergencyFailClosedError);

    expect(methods).toEqual(["state_sync", "state_sync"]);
    expect(transform.getState(sessionId).lastAckedSeq).toBe(4);
    expect(transform.getState(sessionId).lastAckedWatermarks).toBeNull();
    expect(output.messages).toBe(messages);
});

it("mirrors rendered memory ids for ctx_search without rewriting a stable manifest", async () => {
    const sessionId = `rust-memory-visibility-${Date.now()}`;
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const memory = insertMemory(db, {
        projectPath: "/tmp/project",
        category: "ARCHITECTURE_DECISIONS",
        content: "The rust-rendered memory must not be returned twice.",
    });
    const meta = makeMeta(db, sessionId);
    db.exec(`
            CREATE TABLE memory_manifest_updates (count INTEGER NOT NULL);
            INSERT INTO memory_manifest_updates (count) VALUES (0);
            CREATE TRIGGER count_memory_manifest_updates
            AFTER UPDATE OF memory_block_ids, memory_block_count ON session_meta
            BEGIN
                UPDATE memory_manifest_updates SET count = count + 1;
            END;
        `);
    let renderedMemoryIds = [memory.id];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) =>
            method === "transform"
                ? {
                      decision: "SOFT+",
                      native_messages: makeMessages(sessionId),
                      rendered_memory_ids: renderedMemoryIds,
                  }
                : { ok: true },
    };
    const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const run = async () => {
        const messages = makeMessages(sessionId);
        await transform.run(sessionId, messages, { messages: [...messages] }, meta);
    };

    await run();
    expect(getVisibleMemoryIds(db, sessionId)).toEqual(new Set([memory.id]));
    const tools = createCtxSearchTools({
        db,
        resolveProjectPath: () => "/tmp/project",
        memoryEnabled: true,
        embeddingEnabled: false,
        readMessages: () => [],
    });
    const search = await tools.ctx_search.execute({ query: `#${memory.id}`, sources: ["memory"] }, {
        sessionID: sessionId,
        directory: "/tmp/project",
    } as never);
    expect(search).toContain(
        `Memories: 1 match found, all already visible in your project-memory block (ids ${memory.id}).`,
    );

    await run();
    expect(
        db.prepare("SELECT count FROM memory_manifest_updates").get() as { count: number },
    ).toEqual({ count: 1 });

    renderedMemoryIds = [memory.id + 1];
    await run();
    expect(getVisibleMemoryIds(db, sessionId)).toEqual(new Set([memory.id + 1]));
    expect(
        db.prepare("SELECT count FROM memory_manifest_updates").get() as { count: number },
    ).toEqual({ count: 2 });
});

it("rechecks mural candidates on bootstrap, pressure and flush but not ordinary defers", async () => {
    const sessionId = `mural-opportunities-${Date.now()}`;
    sessions.push(sessionId);
    const db = makeDb();
    installRawProvider(sessionId);
    const muralHashes: unknown[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method !== "transform") return { ok: true };
            muralHashes.push((body.mural as { content_hash?: string } | undefined)?.content_hash);
            return { decision: "PASSTHROUGH", native_messages: makeMessages(sessionId) };
        },
    };
    const deps = makeDeps(db, moduleClient);
    deps.muralEnabled = true;
    let resolutions = 0;
    let cue = "a";
    const transform = createRustModeTransform(deps, {
        moduleClient,
        muralResolverForTests: () => {
            resolutions++;
            return {
                enabled: true,
                supportsVision: true,
                dataUrl: `data:image/png;base64,${cue}`,
                contentHash: cue,
            };
        },
    });
    const run = async () => {
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId));
    };
    await run();
    expect(resolutions).toBe(1);
    cue = "b";
    await run();
    expect(resolutions).toBe(1);
    expect(muralHashes.at(-1)).toBe("a");
    deps.contextUsageMap.set(sessionId, {
        usage: { inputTokens: 100_000, percentage: 90 },
        updatedAt: Date.now(),
    });
    // A refresh opportunity is not itself a new mural revision.
    await run();
    expect(resolutions).toBe(1);
    insertMemory(db, { projectPath: deps.projectPath!, category: "CONSTRAINTS", content: "b" });
    await run();
    expect(resolutions).toBe(2);
    expect(muralHashes.at(-1)).toBe("b");
    deps.contextUsageMap.set(sessionId, {
        usage: { inputTokens: 100, percentage: 1 },
        updatedAt: Date.now(),
    });
    cue = "c";
    insertMemory(db, { projectPath: deps.projectPath!, category: "CONSTRAINTS", content: "c" });
    await run();
    expect(resolutions).toBe(2);
    deps.pendingMaterializationSessions.add(sessionId);
    await run();
    expect(resolutions).toBe(3);
    expect(muralHashes.at(-1)).toBe("c");
});
it("Rust-mode final outgoing wire preserves successful no-op reclaim with no protected mass", async () => {
    const sid = "rust-mode-final-over-limit";
    sessions.push(sid);
    installRawProvider(sid);
    installAvailabilityDb(sid);
    const db = makeDb();
    const messages = makeMessages(sid);
    messages[0].parts = [{ type: "text", text: "word ".repeat(12000) }];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method === "transform") {
                return {
                    decision: "SOFT+",
                    scheduler_decision: "execute",
                    row_version: 1,
                    native_messages: structuredClone(messages),
                };
            }
            return { ok: true };
        },
    };
    const deps = makeDeps(db, moduleClient);
    const model = { providerID: "anthropic", modelID: "claude-fable-5-1" };
    messages[0].info.model = model;
    deps.liveModelBySession?.set(sid, model);
    const runner = createRustModeTransform(deps, { moduleClient });
    const meta = makeMeta(db, sid);
    recordToolDefinition(model.providerID, model.modelID, undefined, "read", "read fixture", {});
    recordDetectedContextLimit(db, sid, 16000, "anthropic/claude-fable-5-1");
    const output = { messages: [...messages] };
    await runner.run(sid, messages, output, meta);
    expect(output.messages).toEqual(messages);
});

it("Rust-mode final outgoing wire admits an uncalibrated healthy request despite a complete upper envelope", async () => {
    const sid = "rust-mode-uncalibrated-admission";
    sessions.push(sid);
    installRawProvider(sid);
    installAvailabilityDb(sid);
    const db = makeDb();
    const messages = makeMessages(sid);
    messages[0].parts = [{ type: "text", text: "word ".repeat(8000) }];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {
            if (method === "transform") {
                return {
                    decision: "SOFT+",
                    scheduler_decision: "execute",
                    row_version: 1,
                    native_messages: structuredClone(messages),
                };
            }
            return { ok: true };
        },
    };
    const runner = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const meta = makeMeta(db, sid);
    recordDetectedContextLimit(db, sid, 16000, "test-provider/test-model");
    const output = { messages: [...messages] };
    await runner.run(sid, messages, output, meta);
    expect(output.messages[0].parts).toEqual(messages[0].parts);
});

for (const measured of [false, true])
    it(`Rust-mode native refusal trust requires measured calibration (${measured ? "measured" : "unknown"} route)`, async () => {
        const sid = `rust-native-refusal-grade-${measured}`;
        sessions.push(sid);
        installRawProvider(sid);
        installAvailabilityDb(sid);
        const db = makeDb();
        const model = measured
            ? { providerID: "anthropic", modelID: "claude-fable-5-1" }
            : { providerID: "test-provider", modelID: "test-model" };
        const messages = makeMessages(sid);
        messages[0].info.model = model;
        const observations: unknown[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") {
                    observations.push(
                        (body as { usage: { final_wire_trusted: unknown } }).usage
                            .final_wire_trusted,
                    );
                    return {
                        decision: "SOFT+",
                        scheduler_decision: "execute",
                        row_version: 1,
                        native_messages: structuredClone(messages),
                    };
                }
                return { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        deps.liveModelBySession?.set(sid, model);
        const runner = createRustModeTransform(deps, { moduleClient });
        const meta = makeMeta(db, sid);
        recordToolDefinition(
            model.providerID,
            model.modelID,
            undefined,
            "read",
            "read fixture",
            {},
        );
        // Only overflow recovery measures and sends this request-specific evidence
        // to the native transform.
        recordOverflowDetected(db, sid, 16000, `${model.providerID}/${model.modelID}`);
        try {
            await runner.run(sid, messages, { messages: [...messages] }, meta);
        } catch {
            /* Recovery may refuse when the measured request still exceeds its provider limit. */
        }
        expect(observations).toEqual([measured]);
    });

it("Rust-mode typed protected overflow cannot become passthrough or LKG replay", async () => {
    const sid = "rust-mode-native-protected-refusal";
    sessions.push(sid);
    installRawProvider(sid);
    installAvailabilityDb(sid);
    const db = makeDb();
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method === "transform")
                throw Object.assign(new Error("module refusal"), {
                    code: "protected_tool_results_over_limit",
                });
            return { ok: true };
        },
    };
    const runner = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
    const messages = makeMessages(sid);
    await expect(
        runner.run(sid, messages, { messages: [...messages] }, makeMeta(db, sid)),
    ).rejects.toMatchObject({
        code: "protected_tool_results_over_limit",
        message:
            "The tool results kept by protected_tools are larger than this model's context window, so this turn was not sent. Lower the protected_tools counts.",
    });
});
