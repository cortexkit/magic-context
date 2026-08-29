/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    type AuthorityStatus,
    getAuthorityManagedMarker,
} from "../../features/magic-context/context-authority";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { getChannel2NudgeState, setChannel2NudgeState } from "../../features/magic-context/storage";
import { initializeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import {
    getEmergencyRecoveryArmedAt,
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import {
    scheduleOpenCodeTransformDecisionWrite,
    __test as transformDecisionTest,
} from "../../features/magic-context/transform-decision-log";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { ABSOLUTE_EMERGENCY_PERCENTAGE } from "../../shared/escalation-bands";
import * as logger from "../../shared/logger";
import { promptSurfaceConfigIdentity } from "../../shared/prompt-surface";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { deriveWindowGeometry } from "../../shared/window-geometry";
import { createCtxSearchTools } from "../../tools/ctx-search/tools";
import {
    EmergencyFailClosedError,
    ENGINE_RECONNECTING_USER_MESSAGE,
} from "./emergency-fail-closed";
import { getVisibleMemoryIds } from "./inject-compartments";
import { createDbLkgPersistence } from "./lkg-persist";
import { getSlot, registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { MODULE_PAGE_MAX_BYTES } from "./module-wire";
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
import type { TransformDeps } from "./transform";
import { createTransform } from "./transform";
import type { MessageLike } from "./transform-operations";

const createRustModeTransform = (
    deps: TransformDeps,
    options: Parameters<typeof createRustModeTransformImpl>[1],
) =>
    createRustModeTransformImpl(deps, {
        ...options,
        allowAuthorityProtocolBypassForTests: true,
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
    return db;
}

function makeFileDb(): ContextDatabase {
    const directory = mkdtempSync(join(tmpdir(), "rust-mode-context-"));
    availabilityDataHomes.push(directory);
    const db = openDatabase(join(directory, "context.db")) as ContextDatabase | null;
    if (!db) throw new Error("file-backed test database did not open");
    databases.push(db);
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
            info: { id: "m1", role: "user", sessionID: sessionId },
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
        protectedTags: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map(),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        rustModeAllowAuthorityProtocolBypassForTests: true,
    };
}

function makeMeta(
    db: ContextDatabase,
    sessionId: string,
): ReturnType<typeof getOrCreateSessionMeta> {
    return getOrCreateSessionMeta(db, sessionId);
}

function installAvailabilityDb(sessionId: string, firstUserTools?: Record<string, unknown>): void {
    const dataHome = mkdtempSync(join(tmpdir(), "rust-mode-availability-"));
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
    it("uses the resolved session directory instead of the plugin launch directory for authority routes", async () => {
        const sessionId = "ses-directory-root";
        installRawProvider(sessionId);
        const db = makeDb();
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'seed me', 'seed-hash', 0, 0, 0, 0)",
            ).run("git:identity");
        });
        const authorityRoots: string[] = [];
        const statuses = new Map<string, AuthorityStatus>();
        const module: RustModeModuleClient = {
            call: async () => {
                throw new Error("stop after authority preparation");
            },
            authorityStatus: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return { authority: statuses.get(args.domain) ?? null };
            },
            authorityPrepare: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                const domain = String(args.domain) as "memories" | "notes";
                const phase = String(args.phase);
                const base = {
                    context_store_uuid: String(args.context_store_uuid),
                    project: String(args.project),
                    domain,
                    generation: 1,
                };
                if (phase === "begin") {
                    const authority = { ...base, state: "PREPARING" as const };
                    statuses.set(domain, authority);
                    return { authority };
                }
                if (phase === "complete") {
                    const checksum = String(args.checksum_expected);
                    const authority = {
                        ...base,
                        state: "PREPARING" as const,
                        checksum_expected: checksum,
                        checksum_actual: checksum,
                        checksum_ok: true,
                    };
                    statuses.set(domain, authority);
                    return { authority };
                }
                if (phase === "ack") {
                    const authority = { ...base, state: "MODULE" as const };
                    statuses.set(domain, authority);
                    return { authority };
                }
                const authority = { ...base, state: "TS" as const };
                statuses.set(domain, authority);
                return { authority };
            },
            authoritySeed: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                const rows = Array.isArray(args.rows) ? args.rows : [];
                return { seeded: rows.length, module_row_ids: rows.map((_, index) => index + 1) };
            },
            mirrorPull: async (args) => {
                authorityRoots.push(String(args.projectRoot));
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
        };
        const deps = makeDeps(db, module);
        deps.directory = "/launch/root-a";
        deps.projectPath = "git:identity";
        deps.sessionDirectoryBySession?.set(sessionId, "/session/root-b");
        const runner = createRustModeTransformImpl(deps, { moduleClient: module });
        const messages = makeMessages(sessionId);

        await runner.run(sessionId, messages, { messages: [...messages] }, makeMeta(db, sessionId));

        expect(authorityRoots.length).toBeGreaterThan(0);
        expect(authorityRoots.every((root) => root === "/session/root-b")).toBe(true);
        expect(
            db
                .prepare(
                    "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'opencode'",
                )
                .get(sessionId),
        ).toEqual({
            project_path: resolveProjectIdentityForSession("/session/root-b", false),
        });
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
            },
        });
        expect(geometry).toEqual({
            usable_soft: 128_000,
            usable_hard: 168_000,
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
            midTurn: false,
        });
        expect(body.usage).toEqual({ context_limit_tokens: 128_000 });
        expect(body.geometry).toEqual(geometry);
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
            midTurn: false,
        });
        expect("geometry" in body).toBe(false);
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
            midTurn: false,
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
            midTurn: false,
        });

        expect(body.historian_model_chain).toEqual([
            "anthropic/profile-historian",
            "openai/profile-fallback",
        ]);
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
            midTurn: false,
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
            midTurn: false,
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

    it("copies caveman settings onto the authority wire", () => {
        const body = __rustModeTransformTest.buildTransformBody({
            sessionId: "caveman-wire",
            input: [],
            nativeMessages: [],
            passInputs: { caveman_enabled: true, caveman_min_chars: 240 },
            usage: {},
            modelKey: null,
            providerId: null,
            midTurn: false,
        });
        expect(body.caveman_enabled).toBe(true);
        expect(body.caveman_min_chars).toBe(240);
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
                served_from: "transform",
                timings: { handler_total: 5, total: 4, native_cache_encoded_messages: 1 },
            },
            {
                decision: "SOFT+",
                served_from: "lkg",
                timings: { handler_total: 3, total: 2, native_cache_reused_messages: 1 },
            },
        ];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? { ...responses.shift(), native_messages: makeMessages(sessionId) }
                    : { ok: true },
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
            const passLines = logged.filter((message) => message.startsWith("rust pass:"));
            expect(passLines).toHaveLength(2);
            expect(passLines[0]).toContain("decision=HARD");
            expect(passLines[0]).toContain("served_from=transform");
            expect(passLines[1]).toContain("decision=SOFT+");
            expect(passLines[1]).toContain("served_from=lkg");
            expect(passLines[0]).not.toBe(passLines[1]);
            expect(logged.some((message) => message.startsWith("rust module stages:"))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("keeps the rust pass line grep-compatible", () => {
        expect(
            __rustModeTransformTest.formatRustPassLog({
                decision: "HARD",
                reason: "first_render",
                servedFrom: "transform",
                inputCount: 4,
                outputCount: 3,
                applied: true,
                elapsedMs: 12.345,
                moduleElapsedMs: 8.765,
            }),
        ).toBe(
            "rust pass: decision=HARD reason=first_render served_from=transform in=4 out=3 applied=true row_version=0 elapsed=12.3 ms module=8.8 ms stages=prefix_guard:0.0 ordinal_resolve:0.0 state_sync:0.0 clone:0.0 wire_build:0.0 wire_messages:0 transport:0.0 transport_pages:0 transport_bytes:0 apply:0.0 lkg_snapshot:0.0 mirror_pull:0.0 compartment_mirror:0.0 other:12.3",
        );
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
        const bindProviderAssistant = async (sessionId: string, messageId: string) => {
            expect(
                scheduleOpenCodeTransformDecisionWrite({
                    db,
                    sessionId,
                    messageId,
                    inputTokens: 123,
                }),
            ).toBe(true);
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
            await failureTransform.run(
                failureSession,
                messages,
                { messages },
                makeMeta(db, failureSession),
            );
            await bindProviderAssistant(failureSession, `error-response-${index}`);
        }
        const parkedMessages = makeMessages(failureSession);
        await failureTransform.run(
            failureSession,
            parkedMessages,
            { messages: parkedMessages },
            makeMeta(db, failureSession),
        );
        await bindProviderAssistant(failureSession, "parked-response");

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
        await fullSyncTransform.run(
            fullSyncSession,
            fullSyncMessages,
            { messages: fullSyncMessages },
            makeMeta(db, fullSyncSession),
        );
        await bindProviderAssistant(fullSyncSession, "full-sync-response");

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
            ...Array.from({ length: 3 }, (_, index) => ({
                message_id: `error-response-${index}`,
                decision: "error",
                materialized: 0,
                materialize_reason: null,
            })),
            {
                message_id: "parked-response",
                decision: "parked",
                materialized: 0,
                materialize_reason: null,
            },
            {
                message_id: "full-sync-response",
                decision: "need_full_sync",
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
                return method === "transform" ? { native_messages: native } : { ok: true };
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
                return { native_messages: [] };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: messages as unknown[] };

        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        expect(methods).toEqual(["state_sync", "state_sync"]);
        expect(transform.getState(sessionId).lastAckedSeq).toBe(4);
        expect(transform.getState(sessionId).lastAckedWatermarks).toBeNull();
        expect(output.messages).toBe(messages);
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
                method === "transform" ? { native_messages: native } : { ok: true },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createTransform(deps);
        const output = { messages: input as unknown[] };
        await transform({}, output);
        expect(output.messages).toEqual(native);
        expect(input).toEqual(native);
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

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toBe(input);
        expect(output.messages[0]).toEqual(input[0]);
        expect(transform.getState(sessionId).failureCount).toBe(1);
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
                return method === "transform" ? { native_messages: native } : { ok: true };
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
        expect(transformRequest?.prompt_surface_model_key).toBeNull();
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
                return method === "transform" ? { native_messages: [] } : { ok: true };
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

    it("sends canonical model identity to the Rust wire for a Pi-native alias", async () => {
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
                    ? { native_messages: makeMessages(sessionId) }
                    : { ok: true };
            },
        };
        const deps = makeDeps(db, moduleClient);
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "openai-codex", modelID: "gpt-5.6-sol" };

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

        expect(transformRequest?.model_key).toBe("openai/gpt-5.6-sol");
        expect(transformRequest?.prompt_surface_model_key).toBe("openai/gpt-5.6-sol");
        expect(transformRequest?.render_config).toContain("model:openai/gpt-5.6-sol");
    });

    it("forwards the model-routed prompt preset and description overrides", async () => {
        const sessionId = `rust-prompt-surface-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        let transformRequest: Record<string, unknown> | undefined;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") transformRequest = body as Record<string, unknown>;
                return method === "transform"
                    ? { native_messages: makeMessages(sessionId) }
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
            resolveGuidance: () => ({
                preset: "light",
                primaryOverride: "## Magic Context\n\nTrusted user guidance.",
            }),
        };
        const transform = createRustModeTransform(deps, { moduleClient });
        const messages = makeMessages(sessionId);
        messages[0].info.model = { providerID: "anthropic", modelID: "opus" };

        await transform.run(
            sessionId,
            messages,
            { messages: messages as unknown[] },
            makeMeta(db, sessionId),
        );

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
        const search = await tools.ctx_search.execute(
            { query: `#${memory.id}`, sources: ["memory"] },
            { sessionID: sessionId, directory: "/tmp/project" } as never,
        );
        expect(search).toContain("No results found");

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

    it("preserves the receiver for a class-backed compartment mirror client", async () => {
        const sessionId = `rust-class-compartments-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);

        class ClassBackedModuleClient {
            private readonly title = "receiver-bound compartment";

            async call({ method }: Parameters<RustModeModuleClient["call"]>[0]) {
                return method === "transform" ? { native_messages: [] } : { ok: true };
            }

            async getCompartmentsAfter(_sessionId: string, _afterSequence: number) {
                if (this.title !== "receiver-bound compartment") {
                    throw new Error("class receiver was detached");
                }
                return {
                    max_sequence: 1,
                    compartments: [
                        {
                            sequence: 1,
                            start_message: 0,
                            end_message: 0,
                            start_message_id: "m1",
                            end_message_id: "m1",
                            title: this.title,
                            content: "summary",
                        },
                    ],
                };
            }
        }

        const moduleClient: RustModeModuleClient = new ClassBackedModuleClient();
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );

        expect(
            db.prepare("SELECT title FROM compartments WHERE session_id = ?").get(sessionId),
        ).toEqual({ title: "receiver-bound compartment" });
    });

    it("does not block transform completion on a compartment mirror backlog", async () => {
        const sessionId = `rust-compartment-backlog-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let releaseMirror!: () => void;
        const mirrorBacklog = new Promise<void>((resolve) => {
            releaseMirror = resolve;
        });
        let mirrorCompleted = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform" ? { native_messages: [] } : { ok: true },
            getCompartmentsAfter: async () => {
                await mirrorBacklog;
                mirrorCompleted = true;
                return { max_sequence: 0, compartments: [] };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);
        const run = transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );

        const disposition = await Promise.race([
            run.then(() => "served" as const),
            Bun.sleep(500).then(() => "blocked" as const),
        ]);
        expect(disposition).toBe("served");
        expect(mirrorCompleted).toBe(false);
        releaseMirror();
        await run;
        await Bun.sleep(0);
        expect(mirrorCompleted).toBe(true);
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
                return method === "transform" ? { native_messages: [] } : { ok: true };
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
                return method === "transform" ? { native_messages: [] } : { ok: true };
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
                return method === "transform" ? { native_messages: [] } : { ok: true };
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
        await transform.run(
            sessionId,
            firstInput,
            { messages: firstInput },
            makeMeta(db, sessionId),
        );

        const syntheticInput = [
            ...makeMessages(sessionId),
            {
                info: { id: "channel2-nudge-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "drop spent tool output", synthetic: true }],
            },
        ];
        await transform.run(
            sessionId,
            syntheticInput,
            { messages: syntheticInput },
            makeMeta(db, sessionId),
        );

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
                return { native_messages: native };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const output = { messages: messages as unknown[] };
        await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

        const pageIds = new Set(transformBodies.map((body) => body.transform_page_id));
        expect(pageIds.size).toBe(2);
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
        expect(capabilityInvalidations).toBe(1);
        expect(output.messages).toEqual(native);
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
                    ? { decision: "HARD", served_from: "transform", native_messages: native }
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
            expect(pageIds.size).toBe(2);
            expect(failedPageId).toBe(seriesStarts[0]?.transform_page_id);
            expect(seriesStarts[1]?.transform_page_id).not.toBe(seriesStarts[0]?.transform_page_id);
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
                    ? { decision: "HARD", served_from: "transform", native_messages: native }
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
            expect(new Set(seriesStarts.map(({ body }) => body.transform_page_id)).size).toBe(2);
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
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
        const transformCalls: Array<{
            body: Record<string, unknown>;
            attemptClass: string | undefined;
        }> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body, attemptClass }) => {
                if (method !== "transform") return { ok: true };
                const page = body as Record<string, unknown>;
                transformCalls.push({ body: page, attemptClass });
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
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformCalls.filter(
                ({ body }) => body.transform_page_index === 0,
            );
            expect(seriesStarts).toHaveLength(1);
            expect(transformCalls.at(-1)?.attemptClass).toBe("transform_series_execute");
            expect(
                transformCalls
                    .slice(0, -1)
                    .every(({ attemptClass }) => attemptClass === "transform_page_upload"),
            ).toBe(true);
            expect(output.messages).toEqual(messages);
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

    it("falls through after a second paged transform series mismatch", async () => {
        const sessionId = `rust-series-restart-bound-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installAvailabilityDb(sessionId, {});
        installRawProvider(sessionId);
        const messages = makeMessages(sessionId);
        messages[0]!.parts = [{ type: "text", text: "x".repeat(600_000) }];
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
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformBodies.filter((page) => page.transform_page_index === 0);
            expect(seriesStarts).toHaveLength(2);
            expect(new Set(seriesStarts.map((page) => page.transform_page_id)).size).toBe(2);
            expect(output.messages).toEqual(messages);
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

        transform.clearSession(sessionId);
        await Bun.sleep(0);
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
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method === "transform") requestBodies.push(body as Record<string, unknown>);
                return method === "transform" ? { native_messages: [] } : { ok: true };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = rows.map((row) => ({
            info: { id: row.id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: `message ${row.id}` }],
        }));
        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
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
        expect(steadyElapsed).toBeLessThan(100);
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

        const deltaPages = requestBodies.filter((body) => "transform_page_id" in body);
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

    it("serves raw instead of stale LKG after a stable-id content mutation", async () => {
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
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

        expect(output.messages).toEqual(input);
        expect((output.messages[0] as MessageLike).parts[0]).toEqual({
            type: "text",
            text: "same id, current content",
        });
        expect(getSlot(sessionId)).toBeUndefined();
    });

    it("drops the prior LKG slot when a successful cache-bust refresh is over budget", async () => {
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
        await transform.run(
            sessionId,
            secondInput,
            { messages: [...secondInput] },
            makeMeta(db, sessionId),
        );

        expect(getSlot(sessionId)).toBeUndefined();
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

    it("refuses a pre-bust LKG before the async replacement capture commits", async () => {
        const sessionId = `rust-lkg-async-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const scheduled: Array<() => void> = [];
        let pass = 0;
        let failTransform = false;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                if (failTransform) throw new Error("daemon unavailable before LKG commit");
                pass += 1;
                return {
                    decision: pass === 1 ? "HARD" : "SOFT",
                    row_version: pass,
                    native_messages: [
                        {
                            info: { id: "served", role: "assistant", sessionID: sessionId },
                            parts: [{ type: "text", text: `async response ${pass}` }],
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

        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeUndefined();
        expect(scheduled).toHaveLength(1);
        scheduled.shift()?.();
        expect(getSlot(sessionId)?.jsonPrefix).toContain("async response 1");

        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
        expect(getSlot(sessionId)).toBeUndefined();
        expect(scheduled).toHaveLength(1);

        failTransform = true;
        const failureOutput = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, failureOutput, makeMeta(db, sessionId));
        expect(failureOutput.messages).toEqual(input);
        expect(JSON.stringify(failureOutput.messages)).not.toContain("async response 1");
        expect(getSlot(sessionId)).toBeUndefined();

        scheduled.shift()?.();
        expect(getSlot(sessionId)?.jsonPrefix).toContain("async response 2");
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
                    decision: "HARD",
                    row_version: pass,
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

        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));
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
        const output = { messages: [] as unknown[] };

        await transform.run(sessionId, input, output, meta);

        expect(output.messages).toEqual(input);
        expect(moduleCall).not.toHaveBeenCalled();
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

    it("preserves raw fail-open when the estimate fits the known context limit", async () => {
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
        ).resolves.toBeUndefined();
        expect(output.messages).toEqual(input);
    });

    it("passes through raw input, parks after three failures, then probes on the fifth pass", async () => {
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
                    ? { native_messages: [{ role: "assistant", parts: [] }] }
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
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            expect(output.messages).toBe(input);
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(toastCalls).toBe(1);
        shouldFail = false;
        for (let pass = 0; pass < 2; pass += 1) {
            const input = makeMessages(sessionId);
            const output = { messages: input as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            if (pass === 0) expect(output.messages).toBe(input);
            else expect(output.messages).toEqual([{ role: "assistant", parts: [] }]);
        }
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
            await transform.run(
                sessionId,
                input,
                { messages: input as unknown[] },
                makeMeta(db, sessionId),
            );
        }
        expect(transform.getState(sessionId).parked).toBe(true);
        expect(transformCalls).toBe(3);

        const input = makeMessages(sessionId);
        await transform.run(
            sessionId,
            input,
            { messages: input as unknown[] },
            makeMeta(db, sessionId),
        );
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

    it("keeps below-95 failures on the existing fallback ladder", async () => {
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

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

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

        await transform.run(sessionId, input, output, makeMeta(db, sessionId));

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

describe("prepareRustMemoryAuthority mixed restore", () => {
    it("resumes a schema-57 DRAINING restart through the real prepare path", async () => {
        const db = makeDb();
        const projectPath = "git:schema-57-restart";
        const projectRoot = "/worktrees/schema-57-restart";
        db.exec(`
            DROP TABLE mirror_live_staging;
            DROP TABLE mirror_resnapshot_state;
            DROP TABLE mirror_live_memory_rows;
            DELETE FROM schema_migrations WHERE version >= 58;
        `);
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, ?, 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
            ).run(projectPath);
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/legacy', 100, 9395)",
            ).run();
            db.prepare(
                "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
            ).run();
        });
        runMigrations(db);
        db.prepare(
            "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
        ).run();
        db.prepare(
            "INSERT INTO mirror_live_staging VALUES ('abandoned', '/stale', 1, 'CONSTRAINTS', 'stale', NULL)",
        ).run();

        const calls: Array<{ liveOnly?: boolean; cursor: number }> = [];
        const statuses = new Map<string, AuthorityStatus | null>([
            [
                "memories",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "memories",
                    state: "DRAINING",
                    generation: 3,
                    captured_upper_bound: 21,
                    coordinator_token: "restart-token",
                },
            ],
            [
                "notes",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "notes",
                    state: "TS",
                    generation: 1,
                },
            ],
        ]);
        const memoryRow = (id: number, sourceProject: string) => ({
            id,
            project_path: sourceProject,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => ({ authority: statuses.get(args.domain) ?? null }),
            authorityPrepare: async () => {
                throw new Error("prepare should not run during DRAINING recovery");
            },
            authoritySeed: async () => ({ seeded: 0 }),
            authorityDrain: async (args) => {
                if (args.action === "finish") {
                    statuses.set("memories", {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "TS",
                        generation: 4,
                    });
                }
                return {
                    authority: {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: args.action === "finish" ? "TS" : "DRAINING",
                        generation: args.action === "finish" ? 4 : 3,
                        captured_upper_bound: 21,
                        coordinator_token: "restart-token",
                    },
                };
            },
            mirrorPull: async (args) => {
                calls.push({ liveOnly: args.live_only, cursor: args.cursor });
                return args.live_only
                    ? {
                          page: {
                              domain: "memories",
                              cursor: 0,
                              next_cursor: 200,
                              has_more: false,
                              rows: [
                                  {
                                      feed_seq: 0,
                                      domain: "memories",
                                      op: "insert",
                                      module_row_id: 200,
                                      full_row_snapshot: memoryRow(200, projectPath),
                                      content_hash: "same-hash",
                                  },
                              ],
                          },
                      }
                    : {
                          page: {
                              domain: "memories",
                              cursor: args.cursor,
                              next_cursor: 21,
                              has_more: false,
                              rows: [
                                  {
                                      feed_seq: 21,
                                      domain: "memories",
                                      op: "tombstone",
                                      module_row_id: 100,
                                      full_row_snapshot: memoryRow(100, "/legacy"),
                                      content_hash: "same-hash",
                                  },
                              ],
                          },
                      };
            },
        };
        const state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            memoryAuthorityProject: null as string | null,
            memoryAuthorityRoot: null as string | null,
            memoryAuthorityReady: false,
        };

        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot,
            state,
        });

        expect(calls.map((call) => call.liveOnly)).toEqual([true, undefined]);
        expect(
            db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({
            cursor: 21,
        });
        expect(db.prepare("SELECT id FROM memories WHERE id = 9395").get()).toEqual({ id: 9395 });
        expect(db.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
            status: "complete",
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get()).toEqual({
            count: 0,
        });
        expect(state.memoryAuthorityReady).toBe(true);
    });

    it("reconciles remaining MODULE domains after a DRAINING resume before tools open", async () => {
        const db = makeDb();
        const projectPath = "git:mixed-restore";
        const projectRoot = "/worktrees/mixed-restore";
        const authorityRoots: string[] = [];
        const statuses = new Map<string, AuthorityStatus | null>([
            [
                "memories",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "memories",
                    state: "DRAINING",
                    generation: 3,
                    coordinator_token: "tok-a",
                    captured_upper_bound: 0,
                },
            ],
            [
                "notes",
                {
                    context_store_uuid: "store",
                    project: projectPath,
                    domain: "notes",
                    state: "MODULE",
                    generation: 2,
                },
            ],
        ]);
        const module: RustModeModuleClient = {
            call: async () => ({ ok: true }),
            authorityStatus: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                return { authority: statuses.get(args.domain) ?? null };
            },
            authorityPrepare: async () => {
                throw new Error("prepare should not run on mixed DRAINING resume");
            },
            authoritySeed: async () => ({ seeded: 0 }),
            authorityDrain: async (args) => {
                authorityRoots.push(String(args.projectRoot));
                if (args.action === "begin") {
                    return {
                        authority: {
                            context_store_uuid: "store",
                            project: projectPath,
                            domain: "memories",
                            state: "DRAINING",
                            generation: 3,
                            coordinator_token: "tok-a",
                            captured_upper_bound: 0,
                        },
                    };
                }
                if (args.action === "finish") {
                    statuses.set("memories", {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "TS",
                        generation: 4,
                    });
                    return {
                        authority: {
                            context_store_uuid: "store",
                            project: projectPath,
                            domain: "memories",
                            state: "TS",
                            generation: 4,
                            coordinator_token: "tok-a",
                        },
                    };
                }
                return {
                    authority: {
                        context_store_uuid: "store",
                        project: projectPath,
                        domain: "memories",
                        state: "DRAINING",
                        generation: 3,
                        coordinator_token: "tok-a",
                    },
                };
            },
            mirrorPull: async (args) => {
                authorityRoots.push(String(args.projectRoot));
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
        };
        const state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            memoryAuthorityProject: null as string | null,
            memoryAuthorityRoot: null as string | null,
            memoryAuthorityReady: false,
        };
        const preparedProjects: string[] = [];
        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot,
            state,
            onProjectPrepared: (prepared) => preparedProjects.push(prepared),
        });
        expect(state.memoryAuthorityReady).toBe(true);
        // Hosts hang per-project services (the smart-note evaluator bridge) off this
        // callback, so it must fire with the RESOLVED project — a session that resolves
        // a project other than the plugin's launch directory still gets its bridge.
        expect(preparedProjects).toEqual([projectPath]);
        expect(authorityRoots.length).toBeGreaterThan(0);
        expect(authorityRoots.every((root) => root === projectRoot)).toBe(true);
        expect(getAuthorityManagedMarker(db, projectPath)).not.toBeNull();
        statuses.set("memories", {
            context_store_uuid: "store",
            project: projectPath,
            domain: "memories",
            state: "MODULE",
            generation: 4,
        });
        const secondRoot = "/worktrees/mixed-restore-two";
        await __rustModeTransformTest.prepareRustMemoryAuthority({
            db,
            module,
            projectPath,
            projectRoot: secondRoot,
            state,
        });
        expect(authorityRoots).toContain(secondRoot);
        expect(state.memoryAuthorityRoot).toBe(secondRoot);

        expect(() =>
            db
                .prepare(
                    "INSERT INTO notes(type, status, content, project_path, session_id, created_at, updated_at) VALUES ('plain', 'active', 'blocked', ?, 's', 0, 0)",
                )
                .run(projectPath),
        ).toThrow("managed by the Rust module");
    });
});

describe("native output delta", () => {
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
                    return { native_messages: structuredClone(request.native_messages) };
                }
                if (request.tail_delta) return { status: "ok", served_from: "transform" };
                return { native_messages: structuredClone(healedNative) };
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
                return { native_messages: structuredClone(moduleNativeSnapshot) };
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
                return method === "transform" ? { native_messages: [] } : { ok: true };
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
            await transform.run(sessionId, mutated, output, makeMeta(db, sessionId));
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
                return { decision: "HARD", native_messages: structuredClone(native) };
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
                    native_messages: structuredClone(
                        pass === 1 ? representationA : pass >= 5 ? representationC : representationB,
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

        const busted = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, busted, makeMeta(db, sessionId));
        expect(busted.messages).toEqual(representationB);
        expect(transformBodies[2]?.tail_delta).toBeUndefined();
        expect(transformBodies[3]?.tail_delta).toBeUndefined();

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
                    native_messages: structuredClone(frozenRepresentation),
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
        const fallback = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, fallback, makeMeta(db, sessionId));
        expect(fallback.messages).toEqual(frozenRepresentation);

        const switchedInput = structuredClone(input);
        switchedInput[0]!.info.model = {
            providerID: "test-provider",
            modelID: "other-model",
        };
        const switched = { messages: [...switchedInput] as unknown[] };
        await transform.run(sessionId, switchedInput, switched, makeMeta(db, sessionId));

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
            await restarted.run(sessionId, switchedInput, output, makeMeta(db, sessionId));
            expect(output.messages).toEqual(switchedInput); // raw fallback, not the stale prefix
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
            await restarted.run(sessionId, divergedInput, output, makeMeta(db, sessionId));
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
            await transform.run(
                sessionId,
                input,
                { messages: input as unknown[] },
                makeMeta(db, sessionId),
            );
        }
        expect(parkedMessages).toEqual([ENGINE_RECONNECTING_USER_MESSAGE]);
    });
});

describe("authoritySeedRows — supersede pointer resolution (issue #377)", () => {
    // The store records a pending memory reference for any seeded row whose
    // superseded_by_memory_id it cannot resolve, and authority_finish_prepare
    // rejects the memories-domain handoff while any pending references exist.
    // A target outside the seed set can never resolve, so the pending survives
    // the resolution sweep and blocks rust mode permanently.
    function seedDb(): ContextDatabase {
        const db = new Database(":memory:") as ContextDatabase;
        initializeDatabase(db);
        return db;
    }

    function insert(
        db: ContextDatabase,
        project: string,
        content: string,
        status: string,
    ): number {
        const now = Date.now();
        db.prepare(
            `INSERT INTO memories
               (project_path, category, content, normalized_hash, source_type,
                seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                last_seen_at, status)
             VALUES (?, 'ARCHITECTURE', ?, ?, 'agent', 1, 0, ?, ?, ?, ?, ?)`,
        ).run(project, content, `hash-${content}`, now, now, now, now, status);
        return Number(
            (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
        );
    }

    it("drops a supersede pointer whose target is absent from the seed set", () => {
        const db = seedDb();
        try {
            const project = "git:seed-test";
            const survivor = insert(db, project, "survivor", "active");
            const superseded = insert(db, project, "superseded", "archived");
            const orphaned = insert(db, project, "orphaned", "archived");

            // Resolvable: target is in the same seed set.
            db.prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id = ?").run(
                survivor,
                superseded,
            );
            // Unresolvable: target id never existed in this project.
            db.prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id = ?").run(
                999_999,
                orphaned,
            );

            const rows = __rustModeTransformTest.authoritySeedRows(db, project, "memories");
            const byId = new Map(
                rows.map((row) => [
                    Number((row as { source_row_id: unknown }).source_row_id),
                    (row as { snapshot: Record<string, unknown> }).snapshot,
                ]),
            );

            // The dead link is dropped so the module never records a pending reference.
            expect(byId.get(orphaned)?.superseded_by_memory_id).toBeNull();
            // The resolvable pointer is preserved verbatim — this must stay surgical,
            // not a blanket null of the column.
            expect(byId.get(superseded)?.superseded_by_memory_id).toBe(survivor);
        } finally {
            closeQuietly(db);
        }
    });

    it("drops a supersede pointer whose target belongs to another project", () => {
        const db = seedDb();
        try {
            const project = "git:seed-a";
            const foreign = insert(db, "git:seed-b", "foreign-target", "active");
            const local = insert(db, project, "local", "archived");
            db.prepare("UPDATE memories SET superseded_by_memory_id = ? WHERE id = ?").run(
                foreign,
                local,
            );

            const rows = __rustModeTransformTest.authoritySeedRows(db, project, "memories");
            const snapshot = (
                rows.find(
                    (row) => Number((row as { source_row_id: unknown }).source_row_id) === local,
                ) as { snapshot: Record<string, unknown> }
            ).snapshot;

            // The seed set is project-scoped, so a cross-project target is
            // equally unresolvable module-side.
            expect(snapshot.superseded_by_memory_id).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
