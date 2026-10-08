/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    addProcessedImageStrippedIds,
    addStaleReduceStrippedIds,
    applyStrippedPlaceholderDelta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    appendNoteNudgeAnchor,
    setChannel2NudgeState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { setProjectState } from "../../features/magic-context/storage-project-state";
import {
    getDroppedTagsBySession,
    insertTag,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { insertUserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { flushLogger, getLogFilePath } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    __moduleStateSyncTest,
    buildModuleStateSyncPayload,
    buildPagedModuleStateSyncPayloads,
    loadModuleWatermarks,
    type ModuleStateSyncState,
    syncModuleState,
} from "./module-state-sync";
import { StateSyncTiming } from "./module-state-sync-timing";
import {
    MODULE_PAGE_MAX_BYTES,
    moduleWireBodyBytes,
    resolveOrdinalsForModule,
} from "./module-wire";
import { closeReadOnlySessionDb } from "./read-session-db";

const databases: Database[] = [];
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;

it("sorts canonical seeds byte-identically with one key read per seed", () => {
    let reads = 0;
    const seeds = ["strip2", "strip10", "strip1", "strip1"].map((id) => ({
        get message_id() {
            reads++;
            return id;
        },
        strip_kind: "placeholder",
    }));
    const sorted = __moduleStateSyncTest.sortCanonicalSeeds(seeds);
    expect(reads).toBe(seeds.length);
    expect(sorted).toEqual([seeds[2], seeds[3], seeds[1], seeds[0]]);
    expect(sorted[0]).toBe(seeds[2]);
    expect(sorted[1]).toBe(seeds[3]);
});

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    closeReadOnlySessionDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });

    if (originalLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
    else process.env.MAGIC_CONTEXT_LOG_PATH = originalLogPath;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_LOG_PATH = join(dir, "state-sync.log");
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; summary?: boolean; parts?: unknown[] }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME ?? "", "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
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
        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({
                    id: message.id,
                    role: message.role,
                    summary: message.summary === true ? true : undefined,
                    finish: message.summary === true ? "stop" : undefined,
                }),
            );
            for (const part of message.parts ?? [{ type: "text", text: message.id }]) {
                insertPart.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(part));
            }
        });
    } finally {
        closeQuietly(db);
    }
}

function createContextDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function syncState(generation = 1): {
    moduleGeneration: number;
    lastAckedSeq: number;
    lastAckedWatermarks: null;
    idOrdinalMemoGeneration: number;
    idOrdinalMemo: Map<string, number>;
    seedPassPending: boolean;
} {
    return {
        moduleGeneration: generation,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: generation,
        idOrdinalMemo: new Map(),
        seedPassPending: true,
    };
}

function wireMessage(
    sessionId: string,
    id: string,
): {
    info: { id: string; role: string; sessionID: string };
    parts: Array<{ type: string; text: string }>;
} {
    return {
        info: { id, role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: id }],
    };
}

function syntheticWireMessage(
    sessionId: string,
    id: string,
): {
    info: { id: string; role: string; sessionID: string };
    parts: Array<{ type: string; text: string; synthetic: true }>;
} {
    return {
        info: { id, role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: id, synthetic: true }],
    };
}

describe("module drop-state cold-start seed", () => {
    it("maps dropped message and tool tags to deterministic module blocks", async () => {
        useTempDataHome("module-state-sync-drop-seed-");
        const sessionId = "ses-drop-seed";
        createOpenCodeDb(sessionId, [
            {
                id: "m1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        tool: "edit",
                        state: {
                            status: "completed",
                            input: {
                                filePath: "src/main.ts",
                                content: "a very long edit payload that should be hinted",
                            },
                            output: "large output",
                        },
                    },
                ],
            },
            { id: "m2", role: "user" },
        ]);
        const db = createContextDb();
        insertTag(db, sessionId, "call-1", "tool", 100, 1, 0, "edit", 20, "m1");
        updateTagStatus(db, sessionId, 1, "dropped");
        updateTagDropMode(db, sessionId, 1, "edit_marker");
        insertTag(db, sessionId, "m2:p0", "message", 100, 2);
        updateTagStatus(db, sessionId, 2, "dropped");
        insertTag(db, sessionId, "missing-call", "tool", 100, 3, 0, "bash", 20, null);
        updateTagStatus(db, sessionId, 3, "dropped");

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            drop_seeds: Array<{
                block_id: string;
                related_block_ids?: string[];
                drop_mode: string;
                payload?: string;
            }>;
            drop_seed_skipped: number;
        };
        expect(body.drop_seeds).toEqual([
            expect.objectContaining({
                block_id: "m1#0",
                related_block_ids: ["m1#1"],
                drop_mode: "edit_marker",
            }),
            expect.objectContaining({ block_id: "m2#0", drop_mode: "full" }),
        ]);
        expect(body.drop_seeds[0]?.payload).toContain("src/main.ts");
        expect(body.drop_seed_skipped).toBe(1);
    });
});

describe("module Channel-2 lease cold-start seed", () => {
    it("carries the durable terminal lease into a restarted module", async () => {
        const db = createContextDb();
        const sessionId = "ses-channel2-restart-seed";
        setChannel2NudgeState(db, sessionId, "delivered");
        const calls: Array<Record<string, unknown>> = [];

        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body as Record<string, unknown>);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.channel2_nudge_state).toBe("delivered");
    });
});

describe("module strip-state cold-start seed", () => {
    it("carries frozen placeholder, stale-reduce, and image ids plus the tag watermark", async () => {
        const db = createContextDb();
        const sessionId = "ses-strip-seed";
        applyStrippedPlaceholderDelta(db, sessionId, { add: ["placeholder-message"] });
        addStaleReduceStrippedIds(db, sessionId, ["reduce-message"]);
        addProcessedImageStrippedIds(db, sessionId, ["image-message"]);
        db.prepare(
            "UPDATE session_meta SET cleared_reasoning_through_tag = ? WHERE session_id = ?",
        ).run(42, sessionId);

        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        const body = calls[0] as {
            strip_seeds: Array<{ message_id: string; strip_kind: string }>;
            reasoning_cleared_through_tag: number;
        };
        expect(body.strip_seeds).toEqual([
            { message_id: "image-message", strip_kind: "processed_image" },
            { message_id: "placeholder-message", strip_kind: "placeholder" },
            { message_id: "reduce-message", strip_kind: "stale_reduce" },
        ]);
        expect(body.reasoning_cleared_through_tag).toBe(42);
    });
});

describe("historian compartment sync fence", () => {
    it("keeps the same delta pending when the module asks for a retry", async () => {
        const db = createContextDb();
        const state = syncState();
        let calls = 0;
        const result = await syncModuleState({
            client: {
                async call() {
                    calls += 1;
                    throw Object.assign(new Error("historian owns the compartment snapshot"), {
                        code: "historian_compartment_sync_busy",
                    });
                },
            },
            state,
            pass: { db, sessionId: "sync-busy", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });

        expect(result).toEqual({ status: "retry_busy" });
        expect(calls).toBe(1);
        expect(state.lastAckedSeq).toBe(0);
        expect(state.lastAckedWatermarks).toBeNull();
    });
});

describe("authority cold-start sequence matrix", () => {
    it("bootstraps or adopts every adapter/module age combination without rewinding", async () => {
        const cases = [
            { name: "both fresh", senderSeq: 0, durableSeq: 0, senderWarm: false },
            { name: "fresh module + old adapter", senderSeq: 7, durableSeq: 0, senderWarm: true },
            { name: "fresh adapter + old module", senderSeq: 0, durableSeq: 7, senderWarm: false },
            { name: "mid-turn adapter restart", senderSeq: 7, durableSeq: 7, senderWarm: false },
        ] as const;

        for (const fixture of cases) {
            const db = createContextDb();
            const sessionId = `ses-cold-matrix-${fixture.name.replaceAll(" ", "-")}`;
            const baseline = loadModuleWatermarks({ db, sessionId });
            const state: ModuleStateSyncState = {
                ...syncState(),
                lastAckedSeq: fixture.senderSeq,
                lastAckedWatermarks: fixture.senderWarm ? baseline : null,
                seedPassPending: !fixture.senderWarm,
            };
            if (fixture.senderWarm) {
                updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"delta"}]' });
            }
            let durableSeq = fixture.durableSeq;
            const observedExpectedSeqs: number[] = [];
            const acceptedSeqs: number[] = [];
            let mismatches = 0;

            const result = await syncModuleState({
                client: {
                    async call(args) {
                        const body = args.body as Record<string, unknown>;
                        const expected = Number(body.expected_shadow_seq);
                        observedExpectedSeqs.push(expected);
                        if (expected !== durableSeq) {
                            mismatches += 1;
                            const error = new Error(
                                JSON.stringify({
                                    code: "authority_seq_mismatch",
                                    durable_authority_seq: durableSeq,
                                }),
                            ) as Error & { code: string };
                            error.code = "authority_seq_mismatch";
                            throw error;
                        }
                        acceptedSeqs.push(expected);
                        durableSeq += 1;
                        return { result: { shadow_seq: durableSeq } };
                    },
                },
                state,
                pass: { db, sessionId, nowMs: 1 },
                projectRoot: "/tmp/project",
                force: !fixture.senderWarm,
                options: { authority: true, authoritySeqAdoption: { used: false } },
            });

            expect(result.status, fixture.name).toBe("acked");
            expect(state.lastAckedSeq, fixture.name).toBe(durableSeq);
            expect(durableSeq, fixture.name).toBeGreaterThan(fixture.durableSeq);
            expect(acceptedSeqs, fixture.name).toEqual([fixture.durableSeq]);
            expect(mismatches, fixture.name).toBe(fixture.senderSeq === fixture.durableSeq ? 0 : 1);
            expect(observedExpectedSeqs.at(-1), fixture.name).toBe(fixture.durableSeq);
        }
    });
});

describe("module note evaluation capability sync", () => {});

describe("module state sync section deltas", () => {
    function createWorkspace(db: Database): void {
        db.exec(
            `INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
             VALUES (1, 'shared', 0, 0, '["CONSTRAINTS"]');
             INSERT INTO workspace_members
                 (workspace_id, project_path, display_name, display_path, added_at)
             VALUES
                 (1, '/tmp/project', 'project', '/tmp/project', 0),
                 (1, '/tmp/foreign', 'foreign', '/tmp/foreign', 0);`,
        );
        setProjectState(db, "/tmp/project", { projectMemoryEpoch: 1 });
        setProjectState(db, "/tmp/foreign", { projectMemoryEpoch: 1 });
    }

    async function _buildDeltaPayload(args: {
        db: Database;
        state: ModuleStateSyncState;
        sessionId: string;
        force?: boolean;
    }): Promise<Record<string, unknown>> {
        const payload = await buildModuleStateSyncPayload({
            state: args.state,
            pass: {
                db: args.db,
                sessionId: args.sessionId,
                projectPath: "/tmp/project",
                nowMs: 1,
            },
            force: args.force ?? false,
            options: { stateSyncDeltas: true },
        });
        expect(payload).not.toBeNull();
        expect(typeof payload).toBe("object");
        if (!payload || typeof payload !== "object" || "method" in payload === false) {
            throw new Error("expected a state-sync payload");
        }
        return payload.params as Record<string, unknown>;
    }

    it("uses omitted sections only after the module advertises the delta capability", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-capability";
        const baseline = loadModuleWatermarks({ db, sessionId, projectPath: "/tmp/project" });
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"todo"}]' });
        const state = {
            ...syncState(),
            lastAckedWatermarks: baseline,
            seedPassPending: false,
        };
        const calls: unknown[] = [];
        await syncModuleState({
            client: {
                async stateSyncCapabilities() {
                    return { state_sync_deltas: true };
                },
                async call(args) {
                    calls.push(args.body);
                    return { result: { shadow_seq: 1 } };
                },
            },
            state,
            pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: false,
        });
        expect(calls).toHaveLength(1);
        const body = calls[0] as Record<string, unknown>;
        expect(body).not.toHaveProperty("user_profile");
        expect(body).not.toHaveProperty("workspace");
    });

    it("does not issue session.status for a no-change pass with cached capabilities", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-capability-cache";
        const state = {
            ...syncState(),
            lastAckedWatermarks: loadModuleWatermarks({ db, sessionId }),
            seedPassPending: false,
        };
        const transportMethods: string[] = [];
        const transport = {
            getCachedStateSyncCapabilities: () => ({ state_sync_deltas: true }),
            async stateSyncCapabilities() {
                transportMethods.push("session.status");
                return { state_sync_deltas: true };
            },
            async call(args: { method: string }) {
                transportMethods.push(args.method);
                return { result: { shadow_seq: 1 } };
            },
        };

        await expect(
            syncModuleState({
                client: transport,
                state,
                pass: { db, sessionId, nowMs: 1 },
                projectRoot: "/tmp/project",
                force: false,
            }),
        ).resolves.toEqual({ status: "no_change" });

        expect(transportMethods).not.toContain("session.status");
        expect(transportMethods).toHaveLength(0);
    });

    it("re-probes once after the transport capability generation changes", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-capability-generation";
        const state = {
            ...syncState(),
            lastAckedWatermarks: loadModuleWatermarks({ db, sessionId }),
            seedPassPending: false,
        };
        let generation = 1;
        let cached = {
            generation,
            capabilities: { state_sync_deltas: true },
        };
        let statusCalls = 0;
        const transport = {
            getCachedStateSyncCapabilities: () =>
                cached.generation === generation ? cached.capabilities : undefined,
            async stateSyncCapabilities() {
                statusCalls += 1;
                const capabilities = { state_sync_deltas: true };
                cached = { generation, capabilities };
                return capabilities;
            },
            async call() {
                return { result: { shadow_seq: 1 } };
            },
        };
        const sync = () =>
            syncModuleState({
                client: transport,
                state,
                pass: { db, sessionId, nowMs: 1 },
                projectRoot: "/tmp/project",
                force: false,
            });

        await expect(sync()).resolves.toEqual({ status: "no_change" });
        generation += 1;
        await expect(sync()).resolves.toEqual({ status: "no_change" });
        await expect(sync()).resolves.toEqual({ status: "no_change" });

        expect(statusCalls).toBe(1);
    });

    it("re-probes and rebuilds a full payload after a delta crosses a connection generation", async () => {
        const db = createContextDb();
        const sessionId = "ses-state-sync-delta-reconnect";
        createWorkspace(db);
        insertUserMemory(db, "profile survives reconnect", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
        const state = {
            ...syncState(),
            lastAckedWatermarks: loadModuleWatermarks({
                db,
                sessionId,
                projectPath: "/tmp/project",
            }),
            seedPassPending: false,
        };
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"changed"}]' });

        let generation = 1;
        let cachedGeneration = 1;
        let moduleSupportsDeltas = true;
        let statusCalls = 0;
        const stateSyncBodies: Record<string, unknown>[] = [];
        let moduleProfile = ["profile survives reconnect"];
        let moduleWorkspace: unknown = { preserved: true };
        const transport = {
            getCachedStateSyncCapabilities: () =>
                cachedGeneration === generation
                    ? { state_sync_deltas: moduleSupportsDeltas }
                    : undefined,
            async stateSyncCapabilities() {
                statusCalls += 1;
                cachedGeneration = generation;
                return { state_sync_deltas: moduleSupportsDeltas };
            },
            async call(args: { body: unknown; generationSensitive?: boolean }) {
                const body = args.body as Record<string, unknown>;
                stateSyncBodies.push(body);
                if (stateSyncBodies.length === 1) {
                    expect(args.generationSensitive).toBe(true);
                    expect(body).not.toHaveProperty("user_profile");
                    expect(body).not.toHaveProperty("workspace");
                    generation = 2;
                    moduleSupportsDeltas = false;
                    return {
                        transport_status: "connection_generation_changed",
                        previous_generation: 1,
                        current_generation: 2,
                    };
                }
                expect(args.generationSensitive).toBe(false);
                moduleProfile = body.user_profile as string[];
                moduleWorkspace = body.workspace;
                return { result: { shadow_seq: 1 } };
            },
        };

        await expect(
            syncModuleState({
                client: transport,
                state,
                pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
                projectRoot: "/tmp/project",
                force: false,
            }),
        ).resolves.toMatchObject({ status: "acked" });

        expect(statusCalls).toBe(1);
        expect(stateSyncBodies).toHaveLength(2);
        expect(stateSyncBodies[1]).not.toHaveProperty("user_profile");
        expect(stateSyncBodies[1]).not.toHaveProperty("workspace");
        expect(moduleProfile).toBeUndefined();
        expect(moduleWorkspace).toBeUndefined();
    });
});

describe("module state authority direction", () => {});

describe("module compartment ordinal serialization", () => {
    it("keeps canonical ordinal drift fail-loud when the wire resolver finds a conflict", async () => {
        useTempDataHome("module-state-sync-ordinal-drift-");
        const sessionId = "ses-ordinal-drift";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "summary", role: "assistant", summary: true },
            { id: "m2", role: "user" },
        ]);
        const state = syncState(3);
        state.idOrdinalMemo.set("m2", 3);

        state.idOrdinalMemo.set("m1", 1);
        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [wireMessage(sessionId, "m2"), wireMessage(sessionId, "unseen")],
            generation: state.moduleGeneration,
            memoGeneration: state.idOrdinalMemoGeneration,
            memo: state.idOrdinalMemo,
            memoAnchor: { timeCreated: 1, id: "m1" },
            memoStoredCount: 1,
            memoCanonicalCount: 1,
        });

        expect(result).toEqual(expect.objectContaining({ ok: false, reason: "mismatch" }));
    });

    it("keeps persisted ordinals stable around an interior synthetic wire message", async () => {
        useTempDataHome("module-state-sync-interior-synthetic-");
        const sessionId = "ses-interior-synthetic";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "m2", role: "assistant" },
            { id: "m3", role: "user" },
        ]);

        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [
                wireMessage(sessionId, "m1"),
                syntheticWireMessage(sessionId, "nudge"),
                wireMessage(sessionId, "m2"),
                wireMessage(sessionId, "m3"),
            ],
            generation: 1,
            memoGeneration: 1,
            memo: new Map(),
        });

        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                annotatedInput: [
                    expect.objectContaining({ absolute_ordinal: 1 }),
                    expect.objectContaining({ absolute_ordinal: 1 }),
                    expect.objectContaining({ absolute_ordinal: 2 }),
                    expect.objectContaining({ absolute_ordinal: 3 }),
                ],
            }),
        );
    });

    it("reports the first non-synthetic ordinal gap with its wire identity", async () => {
        useTempDataHome("module-state-sync-unresolved-diagnostic-");
        const sessionId = "ses-unresolved-diagnostic";
        createOpenCodeDb(sessionId, [
            { id: "m1", role: "user" },
            { id: "m2", role: "assistant" },
        ]);

        const result = await resolveOrdinalsForModule({
            sessionId,
            messages: [
                wireMessage(sessionId, "m1"),
                {
                    info: { id: "missing", role: "assistant", sessionID: sessionId },
                    parts: [{ type: "text", text: "missing" }],
                },
                wireMessage(sessionId, "m2"),
            ],
            generation: 1,
            memoGeneration: 1,
            memo: new Map(),
        });

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                reason: "unresolved",
                messageId: "missing",
                messageIndex: 1,
                messageRole: "assistant",
            }),
        );
    });
});

describe("module incremental and paged assembly", () => {
    it("packs pages linearly and preserves item order under the wire cap", () => {
        createContextDb();
        const watermarks = {
            compartment_sequence: 0,
            memory_id: 0,
            m0_mutation_id: 0,
            memory_mutation_id: 0,
            last_todo_state_hash: "",
            project_memory_epoch: 0,
            project_user_profile_version: 0,
            reasoning_cleared_through_tag: 0,
        };
        const items = Array.from({ length: 900 }, (_, index) => ({
            message_id: String(index),
            text: "x".repeat(1200),
        }));
        const originalStringify = JSON.stringify;
        let serializedBytes = 0;
        JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
            const result = originalStringify(...args);
            if (typeof result === "string") serializedBytes += Buffer.byteLength(result);
            return result;
        }) as typeof JSON.stringify;
        let pages: ReturnType<typeof buildPagedModuleStateSyncPayloads> = [];
        try {
            pages = buildPagedModuleStateSyncPayloads(
                {
                    moduleGeneration: 1,
                    expectedShadowSeq: 0,
                    seedId: "seed",
                    seedBoundaryId: null,
                    noteNudgeAnchors: items,
                    memoryMutations: [],
                    userProfile: [],
                    workspace: null,
                    lastTodoState: "",
                    watermarks,
                },
                512 * 1024,
            );
        } finally {
            JSON.stringify = originalStringify;
        }

        expect(pages.length).toBeGreaterThan(1);
        expect(pages.flatMap((page) => page.params.note_nudge_anchors)).toEqual(items);
        expect(serializedBytes).toBeLessThan(10_000_000);
        for (const page of pages) {
            expect(
                moduleWireBodyBytes({
                    method: "state_sync",
                    params: page.params,
                }),
            ).toBeLessThanOrEqual(MODULE_PAGE_MAX_BYTES);
        }
    });

    it("does not read memory pools for a todo-only watermark change", async () => {
        const db = createContextDb();
        const sessionId = "ses-todo-only-sync";
        const baseline = loadModuleWatermarks({ db, sessionId, projectPath: "/tmp/project" });
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"todo"}]' });
        const originalPrepare = db.prepare.bind(db);
        let memoryPoolReads = 0;
        db.prepare = ((sql: string) => {
            if (/FROM memories/i.test(sql) && !/MAX\(/i.test(sql)) memoryPoolReads += 1;
            return originalPrepare(sql);
        }) as typeof db.prepare;

        const payload = await buildModuleStateSyncPayload({
            state: { ...syncState(), lastAckedWatermarks: baseline, seedPassPending: false },
            pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
            force: false,
        });

        expect(payload).not.toBeNull();
        expect(memoryPoolReads).toBe(0);
    });

    it("does not issue a full tag-table read during a force seed", async () => {
        const db = createContextDb();
        const originalPrepare = db.prepare.bind(db);
        let fullTagReads = 0;
        db.prepare = ((sql: string) => {
            if (/FROM tags WHERE session_id = \? ORDER BY tag_number/i.test(sql)) {
                fullTagReads += 1;
            }
            return originalPrepare(sql);
        }) as typeof db.prepare;

        await buildModuleStateSyncPayload({
            state: syncState(),
            pass: { db, sessionId: "ses-force-tags", nowMs: 1 },
            force: true,
        });

        expect(fullTagReads).toBeLessThanOrEqual(1);
    });
});

describe("module compartment mirror-back", () => {
    function mirrorRow(
        sequence: number,
        extras: Partial<{
            end_message: number;
            end_message_id: string;
            title: string;
            content: string;
        }> = {},
    ) {
        return {
            sequence,
            start_message: sequence * 2 - 1,
            end_message: extras.end_message ?? sequence * 2,
            start_message_id: `m${sequence * 2 - 1}#0`,
            end_message_id: extras.end_message_id ?? `m${sequence * 2}#0`,
            title: extras.title ?? `Compartment ${sequence}`,
            content: extras.content ?? `content ${sequence}`,
            created_at: sequence,
        };
    }

    function _pagingReader(
        getRows: () => Array<ReturnType<typeof mirrorRow>>,
        extra: () => {
            set_changed?: boolean;
            revert_epoch?: number;
            compartment_count?: number;
        } = () => ({}),
    ) {
        const calls: number[] = [];
        return {
            calls,
            reader: {
                async getCompartmentsAfter(_sessionId: string, afterSequence: number) {
                    calls.push(afterSequence);
                    const rows = getRows();
                    const extras = extra();
                    return {
                        max_sequence: rows.at(-1)?.sequence ?? -1,
                        compartments: rows
                            .filter((row) => row.sequence > afterSequence)
                            .slice(0, 2),
                        ...extras,
                    };
                },
            },
        };
    }
});

describe("state-sync resumable series", () => {
    it("a deadline mid-series resumes only the remaining pages", async () => {
        useTempDataHome("state-sync-resume-");
        const sessionId = "ses-resume";
        createOpenCodeDb(sessionId, [{ id: "m1", role: "user" }]);
        const db = createContextDb();
        for (let i = 0; i < 5; i++)
            appendNoteNudgeAnchor(db, sessionId, `m${i}`, "x".repeat(20 * 1024 * 1024));
        const state = syncState();
        let next = 0;
        let seedId: unknown;
        let fail = true;
        const sent: number[] = [];
        const client = {
            getCachedStateSyncCapabilities: () => ({
                state_sync_deltas: true,
                state_sync_resume: true,
            }),
            async call(args: { method: string; body: unknown }) {
                const body = args.body as Record<string, unknown>;
                if (args.method === "session.status")
                    return {
                        state_sync: {
                            seed_id: seedId,
                            generation: 1,
                            next_expected_index: next,
                            shadow_seq: 0,
                            completed: false,
                        },
                    };
                seedId ??= body.seed_id;
                expect(body.seed_id).toBe(seedId);
                const index = body.seed_batch_index as number;
                sent.push(index);
                if (index === 1 && fail) {
                    fail = false;
                    await new Promise((_resolve, reject) =>
                        setTimeout(
                            () =>
                                reject(
                                    Object.assign(new Error("state_sync transport timeout"), {
                                        code: "state_sync_timeout",
                                    }),
                                ),
                            1,
                        ),
                    );
                }
                next = index + 1;
                return { ok: true };
            },
        };
        const sync = () =>
            syncModuleState({
                client,
                state,
                pass: { db, sessionId, nowMs: 1 },
                projectRoot: "/tmp/project",
                force: true,
            });
        await expect(sync()).rejects.toMatchObject({ code: "state_sync_timeout" });
        await expect(sync()).resolves.toMatchObject({ status: "acked" });
        expect(sent).toEqual([0, 1, 1, 2]);
    });
});

it("AFT warm inventory sends only boundary-owned seeds with one raw batch", async () => {
    useTempDataHome("aft-warm-seed-");
    const sessionId = "ses-aft-warm";
    createOpenCodeDb(
        sessionId,
        Array.from({ length: 770 }, (_, index) => ({ id: `tail${index}`, role: "user" })),
    );
    const rawDb = new Database(join(process.env.XDG_DATA_HOME ?? "", "opencode", "opencode.db"));
    rawDb.exec(
        `UPDATE message SET time_created=time_created+100000; CREATE INDEX parts_by_owner ON part(session_id, message_id);`,
    );
    rawDb
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO message SELECT 'old'||i, ?, i, i, json_object('id','old'||i,'role','user') FROM n`)
        .run(sessionId);
    rawDb
        .prepare(`INSERT INTO part(message_id, session_id, time_created, time_updated, data)
        SELECT id, session_id, time_created, time_updated, '{"type":"text","text":"old"}' FROM message WHERE id LIKE 'old%'`)
        .run();
    closeQuietly(rawDb);
    const db = createContextDb();
    appendCompartments(
        db,
        sessionId,
        Array.from({ length: 1500 }, (_, sequence) => ({
            sequence,
            startMessage: 1,
            endMessage: 100000,
            startMessageId: "old1",
            endMessageId: "old100000",
            title: "folded",
            content: "x".repeat(2048),
        })),
    );
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size)
        SELECT ?, i, 'old'||i||':p0', 'message', 'dropped', 100 FROM n`).run(sessionId);
    for (let index = 0; index < 282; index++) {
        insertTag(db, sessionId, `tail${index}:p0`, "message", 100, 100001 + index);
        updateTagStatus(db, sessionId, 100001 + index, "dropped");
    }
    const timing = new StateSyncTiming();
    const bodies: Record<string, unknown>[] = [];
    const budgets: number[] = [];
    await syncModuleState({
        state: syncState(),
        force: true,
        pass: { db, sessionId, nowMs: 1 },
        projectRoot: "/tmp/project",
        options: { timing },
        client: {
            getCachedStateSyncCapabilities: () => ({
                state_sync_deltas: true,
                state_sync_resume: true,
            }),
            async call(args) {
                const body = args.body as Record<string, unknown>;
                if (body.state_sync_inventory)
                    return {
                        state_sync_inventory: {
                            generation: 1,
                            max_compartment_sequence: 1499,
                            boundary_id: "tail0#0",
                            context_boundaries_resolved: true,
                        },
                    };
                if (args.method === "session.status") return { state_sync: null };
                bodies.push(body);
                budgets.push(args.timeoutMs ?? 0);
                return { ok: true };
            },
        },
    });
    if (process.env.MC_STATE_SYNC_TIMING_FIXTURE === "1") {
        flushLogger();
        console.log(
            readFileSync(getLogFilePath(), "utf8")
                .split("\n")
                .find((line) => line.includes("stage=rust.state_sync_detail")),
        );
    }
    expect(bodies.flatMap((body) => (body.compartments ?? []) as unknown[])).toHaveLength(0);
    const seeds = bodies.flatMap((body) => body.drop_seeds as Array<{ block_id: string }>);
    expect(seeds).toHaveLength(282);
    expect(seeds.every((seed) => seed.block_id.startsWith("tail"))).toBe(true);
    expect(budgets).toEqual([17_104]);
    expect(timing.rawReads).toBe(1);
    expect(timing.rawMessages).toBe(770);
    expect(timing.tags).toBe(282);
    expect(timing.bytes).toBeLessThan(30000);
    if (process.env.MC_STATE_SYNC_TIMING_FIXTURE === "1") {
        flushLogger();
        const line = readFileSync(getLogFilePath(), "utf8")
            .split("\n")
            .find((line) => line.includes("stage=rust.state_sync_detail"));
        expect(line).toBeDefined();
        expect(line).toContain(`collect_ms=${timing.collect.toFixed(3)}`);
        expect(line).toContain(`serialize_ms=${timing.serialize.toFixed(3)}`);
        expect(line).toContain(`page_build_ms=${timing.pageBuild.toFixed(3)}`);
        expect(timing.collect).toBeGreaterThan(0);
        expect(timing.serialize).toBeGreaterThan(0);
        expect(timing.pageBuild).toBeGreaterThan(0);
        console.log(line);
    }
});

it("completed series receipts are reusable only in their module generation", async () => {
    const db = createContextDb();
    const sessionId = "ses-receipt-generation";
    let receiptGeneration = 1;
    let sends = 0;
    const client = {
        getCachedStateSyncCapabilities: () => ({
            state_sync_deltas: true,
            state_sync_resume: true,
        }),
        async call(args: { method: string; body: unknown }) {
            const body = args.body as Record<string, unknown>;
            if (body.state_sync_inventory) return {};
            if (args.method === "session.status")
                return {
                    state_sync: {
                        seed_id: body.state_sync_seed_id,
                        generation: receiptGeneration,
                        shadow_seq: 1,
                        completed: true,
                    },
                };
            sends++;
            return { ok: true };
        },
    };
    const run = () =>
        syncModuleState({
            client,
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });
    await expect(run()).resolves.toMatchObject({ status: "acked" });
    expect(sends).toBe(0);
    receiptGeneration = 0;
    await expect(run()).resolves.toMatchObject({ status: "acked" });
    expect(sends).toBe(1);
});

it("a committed final-page deadline is adopted after adapter restart without reupload", async () => {
    useTempDataHome("state-sync-final-receipt-");
    const sessionId = "ses-final-receipt";
    createOpenCodeDb(sessionId, [{ id: "m1", role: "user" }]);
    const db = createContextDb();
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: "m1",
            endMessageId: "m1",
            title: "seed",
            content: "content",
        },
    ]);
    let committedId: unknown;
    let sends = 0;
    const client = {
        getCachedStateSyncCapabilities: () => ({
            state_sync_deltas: true,
            state_sync_resume: true,
        }),
        async call(args: { method: string; body: unknown }) {
            const body = args.body as Record<string, unknown>;
            if (body.state_sync_inventory)
                return {
                    state_sync_inventory: {
                        generation: 1,
                        max_compartment_sequence: committedId ? 0 : -1,
                        boundary_id: committedId ? "m1#0" : null,
                    },
                };
            if (args.method === "session.status")
                return {
                    state_sync: committedId
                        ? { seed_id: committedId, generation: 1, shadow_seq: 1, completed: true }
                        : null,
                };
            sends++;
            committedId = body.seed_id;
            await new Promise((_resolve, reject) =>
                setTimeout(
                    () =>
                        reject(
                            Object.assign(new Error("deadline after durable commit"), {
                                code: "state_sync_timeout",
                            }),
                        ),
                    1,
                ),
            );
        },
    };
    const run = () =>
        syncModuleState({
            client,
            state: syncState(),
            pass: { db, sessionId, nowMs: 1 },
            projectRoot: "/tmp/project",
            force: true,
        });
    await expect(run()).rejects.toMatchObject({ code: "state_sync_timeout" });
    await expect(run()).resolves.toMatchObject({ status: "acked" });
    expect(sends).toBe(1);
});

it("an old module without state_sync_resume keeps the previous paged protocol", async () => {
    const db = createContextDb();
    for (const deltas of [true, false]) {
        const calls: Record<string, unknown>[] = [];
        await expect(
            syncModuleState({
                state: syncState(),
                force: true,
                pass: { db, sessionId: `ses-legacy-${deltas}`, nowMs: 1 },
                projectRoot: "/tmp/project",
                client: {
                    getCachedStateSyncCapabilities: () => ({ state_sync_deltas: deltas }),
                    async call(args) {
                        expect(args.method).toBe("state_sync");
                        calls.push(args.body as Record<string, unknown>);
                        return { result: { shadow_seq: 1 } };
                    },
                },
            }),
        ).resolves.toMatchObject({ status: "acked" });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            seed_batch_index: 0,
            seed_batch_total: 1,
            seed_complete: true,
        });
    }
});

it("a batched seed read refuses ordinal drift instead of overwriting the wire memo", async () => {
    useTempDataHome("state-sync-batch-drift-");
    const sessionId = "ses-batch-drift";
    createOpenCodeDb(sessionId, [{ id: "m1", role: "user" }]);
    const db = createContextDb();
    const state = syncState();
    state.idOrdinalMemo.set("m1", 99);
    await expect(
        buildModuleStateSyncPayload({
            state,
            pass: { db, sessionId, nowMs: 1 },
            force: true,
            options: { seedInventory: { maxCompartmentSequence: -1, boundaryId: "m1#0" } },
        }),
    ).resolves.toBe("mismatch");
    expect(state.idOrdinalMemo.get("m1")).toBe(99);
});

it("cold inventory bounds 100K-message seeds at the published host marker", async () => {
    useTempDataHome("cold-large-seed-");
    const sessionId = "ses-cold-large";
    createOpenCodeDb(sessionId, [{ id: "tail", role: "user" }]);
    const rawDb = new Database(join(process.env.XDG_DATA_HOME ?? "", "opencode", "opencode.db"));
    rawDb.exec(`UPDATE message SET time_created=100001;
        CREATE INDEX parts_by_message ON part(message_id);
        CREATE INDEX messages_by_session ON message(session_id, time_created, id);`);
    rawDb
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO message SELECT 'old'||i, ?, i, i, json_object('id','old'||i,'role','user') FROM n`)
        .run(sessionId);
    rawDb
        .prepare(`INSERT INTO part(message_id, session_id, time_created, time_updated, data)
        SELECT id, session_id, time_created, time_updated, '{"type":"text","text":"old"}' FROM message WHERE id LIKE 'old%'`)
        .run();
    closeQuietly(rawDb);
    const db = createContextDb();
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size)
        SELECT ?, i, 'old'||i||':p0', 'message', 'dropped', 100 FROM n`).run(sessionId);
    insertTag(db, sessionId, "tail:p0", "message", 100, 100001);
    updateTagStatus(db, sessionId, 100001, "dropped");
    setPersistedCompactionMarkerState(db, sessionId, {
        boundaryMessageId: "old100000",
        summaryMessageId: "summary",
        compactionPartId: "marker",
        summaryPartId: "summary-part",
        boundaryOrdinal: 100000,
        targetEndMessageId: "tail",
    });
    appendNoteNudgeAnchor(db, sessionId, "old1", "hidden");
    appendNoteNudgeAnchor(db, sessionId, "tail", "visible");
    addStaleReduceStrippedIds(db, sessionId, ["old1", "tail"]);
    const timing = new StateSyncTiming();
    const started = performance.now();
    const payload = await buildModuleStateSyncPayload({
        state: syncState(),
        pass: { db, sessionId },
        force: true,
        options: { timing, seedInventory: { boundaryId: null, contextBoundariesResolved: true } },
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(payload && typeof payload === "object").toBe(true);
    if (!payload || typeof payload !== "object") throw new Error("missing seed payload");
    expect(payload.params.drop_seeds?.map((seed) => seed.block_id)).toEqual([
        "old100000#0",
        "tail#0",
    ]);
    expect(payload.params.note_nudge_anchors).toEqual([{ message_id: "tail", text: "visible" }]);
    expect(payload.params.strip_seeds).toEqual([
        { message_id: "tail", strip_kind: "stale_reduce" },
    ]);
    expect(timing.rawMessages).toBe(2);
    expect(timing.rawReads).toBe(1);
    // Omitting seeds for hidden host messages must not also tell the module to
    // discard its cached prefix: that requires a separately resolved boundary.
    expect(payload.params.seed_boundary_id).toBeNull();
});

it("forced seed timing is logged when boundary assembly fails", async () => {
    useTempDataHome("failed-seed-timing-");
    const db = createContextDb();
    appendCompartments(db, "missing-session", [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "missing",
            endMessageId: "missing",
            title: "missing",
            content: "x",
        },
    ]);
    const timing = new StateSyncTiming();
    const logged: Array<{ sessionId: string; phase: string | undefined }> = [];
    timing.log = (sessionId, phase) => {
        logged.push({ sessionId, phase });
    };
    await expect(
        buildModuleStateSyncPayload({
            state: syncState(),
            pass: { db, sessionId: "missing-session" },
            force: true,
            options: { timing },
        }),
    ).rejects.toThrow("context_compartment_boundary_unresolved");
    expect(logged).toEqual([{ sessionId: "missing-session", phase: "seed" }]);
});

it("scoped drop seeds use address indexes instead of scanning dropped history", () => {
    const db = createContextDb();
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size)
        SELECT 'indexed-seed', i, 'old'||i||':p0', 'message', 'dropped', 100 FROM n`).run();
    const scope = { ownerIds: ["tail"], messageAddresses: ["tail:p0"] };
    const plans: string[] = [];
    const traced = new Proxy(db, {
        get(target, key) {
            if (key === "prepare")
                return (sql: string) => {
                    if (sql.includes("json_each")) {
                        const query = target.prepare(`EXPLAIN QUERY PLAN ${sql}`);
                        const args = sql.includes("UNION ALL")
                            ? [
                                  "indexed-seed",
                                  JSON.stringify(scope.ownerIds),
                                  "indexed-seed",
                                  JSON.stringify(scope.messageAddresses),
                              ]
                            : [
                                  "indexed-seed",
                                  JSON.stringify(scope.ownerIds),
                                  JSON.stringify(scope.messageAddresses),
                              ];
                        plans.push(
                            ...(query.all(...args) as Array<{ detail: string }>).map(
                                (row) => row.detail,
                            ),
                        );
                    }
                    return target.prepare(sql);
                };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    expect(getDroppedTagsBySession(traced, "indexed-seed", scope)).toEqual([]);
    expect(plans.join("\n")).toContain("idx_tags_pi_fallback_tool_owner");
    expect(plans.join("\n")).toContain("idx_tags_session_message_id");
    expect(plans.join("\n")).not.toContain("idx_tags_dropped_session_tag_number");
});

describe("provider historian chain watermarks", () => {
    it("changed chain overrides the no-event hint and unchanged chain reads and serializes no known content", async () => {
        useTempDataHome("module-state-sync-provider-chain-");
        const db = createContextDb();
        const sessionId = "chain-session";
        createOpenCodeDb(sessionId, [{ id: "known-message", role: "user" }]);
        const state: ModuleStateSyncState = syncState();
        const calls: Record<string, unknown>[] = [];
        const client = {
            getCachedStateSyncCapabilities: () => ({ state_sync_deltas: true }),
            async call(args: { body: Record<string, unknown> }) { calls.push(args.body); return { ok: true }; },
        };
        const pass = { db, sessionId, nowMs: 1, historianModelChain: ["provider/a"] };
        expect((await syncModuleState({ client, state, pass, projectRoot: "/project", force: false })).status).toBe("acked");
        const firstHash = state.lastAckedWatermarks?.historian_model_chain_hash;
        expect(calls.at(-1)?.historian_model_chain).toEqual(["provider/a"]);
        calls.length = 0;
        pass.historianModelChain = ["provider/b"];
        expect((await syncModuleState({ client, state, pass, projectRoot: "/project", force: false, options: { knownWatermarksUnchanged: true } })).status).toBe("acked");
        expect(state.lastAckedWatermarks?.historian_model_chain_hash).not.toBe(firstHash);
        expect(calls.at(-1)?.historian_model_chain).toEqual(["provider/b"]);
        calls.length = 0;
        let reads = 0;
        let knownSerializations = 0;
        const guardedDb = new Proxy(db, { get(target, property, receiver) {
            if (property === "prepare") return () => { reads++; throw new Error("unchanged chain read the own store"); };
            return Reflect.get(target, property, receiver);
        } });
        const stringify = JSON.stringify;
        JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
            if (value && typeof value === "object" && (value as { info?: { id?: string } }).info?.id === "known-message") knownSerializations++;
            return Reflect.apply(stringify, JSON, [value, ...rest]);
        }) as typeof JSON.stringify;
        try {
            expect(await syncModuleState({ client, state, pass: { ...pass, db: guardedDb }, projectRoot: "/project", force: false, options: { knownWatermarksUnchanged: true } })).toEqual({ status: "no_change" });
        } finally { JSON.stringify = stringify; }
        expect(reads).toBe(0);
        expect(knownSerializations).toBe(0);
        expect(calls).toEqual([]);
    });

    it("unchanged chain closes a no-append pass with a content-free barrier", async () => {
        useTempDataHome("module-state-sync-provider-barrier-");
        const db = createContextDb();
        const state: ModuleStateSyncState = syncState();
        const pass = { db, sessionId: "barrier-session", nowMs: 1, historianModelChain: [] };
        const calls: Record<string, unknown>[] = [];
        const client = { async call(args: { body: Record<string, unknown> }) { calls.push(args.body); return { ok: true }; } };
        await syncModuleState({ client, state, pass, projectRoot: "/project", force: false });
        calls.length = 0;
        expect(await syncModuleState({ client, state, pass, projectRoot: "/project", force: false, options: { knownWatermarksUnchanged: true, passComplete: true } })).toEqual({ status: "no_change" });
        expect(calls).toEqual([{ method: "state_sync", session_id: "barrier-session", pass_complete: true }]);
    });
});
