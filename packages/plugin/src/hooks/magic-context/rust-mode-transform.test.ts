/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    type AuthorityStatus,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
    resetAuthorityRoutingObservationsForTest,
    TRANSFORM_MEMORY_MIRROR_PAGE_BUDGET,
} from "../../features/magic-context/context-authority";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
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
    getPersistedNoteNudge,
    getThinkingBindingRecoveryTarget,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
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
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { deriveWindowGeometry } from "../../shared/window-geometry";
import { createCtxSearchTools } from "../../tools/ctx-search/tools";
import { primeCtxReduceSpawnPermission } from "./ctx-reduce-availability";
import {
    EmergencyFailClosedError,
    ENGINE_RECONNECTING_USER_MESSAGE,
} from "./emergency-fail-closed";
import { getVisibleMemoryIds } from "./inject-compartments";
import { createDbLkgPersistence } from "./lkg-persist";
import { getSlot, registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { MODULE_ORDINAL_PAGE_SIZE, MODULE_PAGE_MAX_BYTES } from "./module-wire";
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
        rustModeAllowAuthorityProtocolBypassForTests: true,
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
        resetAuthorityRoutingObservationsForTest();
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            await runner.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );

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
            expect(
                logSpy.mock.calls.filter(([message]) =>
                    String(message).includes("authority → MODULE: host backends → MODULE"),
                ),
            ).toHaveLength(1);
        } finally {
            logSpy.mockRestore();
            resetAuthorityRoutingObservationsForTest();
        }
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

    it("sends each historian chain model's resolved window and output ceiling", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-historian-model-limits-"));
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
                                        fallback: { limit: { context: 64_000, output: 8_000 } },
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
                "openai/fallback": { context: 64_000, output: 8_000 },
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
            const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
            const messages = makeMessages(sessionId);
            const output: { messages: unknown[] } = { messages: [...messages] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            expect(output.messages).toHaveLength(2048);
            const beforeHash = sha(serializedBefore);
            const afterHash = sha(JSON.stringify(output.messages));
            console.log(
                `native-wire-identity decision=${decision} messages=2048 before=${beforeHash} after=${afterHash}`,
            );
            expect(afterHash).toBe(beforeHash);
            expect(JSON.stringify(native)).toBe(serializedBefore);
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
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
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
                        row_version: 1,
                        native_messages: structuredClone(representationA),
                    };
                }
                const priced = transformPass === 5;
                return {
                    decision: priced ? "SOFT" : "SOFT+",
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
                    return { decision: "HARD", row_version: 1, native_messages: stable };
                }
                if (externalEpochObserved) {
                    return { decision: "HARD", row_version: 3, native_messages: drained };
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
            "rust pass: decision=HARD reason=first_render identity_delta=mur served_from=transform in=4 out=3 applied=true row_version=0 elapsed=12.3 ms module=8.8 ms stages=identity_resolve:0.0 prompt_surface:0.0 mural_resolve:0.0 prefix_guard:0.0 ordinal_resolve:0.0 ordinal_rebuild:0.0 ordinal_rows:0 ordinal_mode:memo state_sync:0.0 clone:0.0 wire_build:0.0 wire_messages:0 transport:0.0 transport_pages:0 transport_bytes:0 apply:0.0 lkg_snapshot:0.0 mirror_pull:0.0 compartment_mirror:0.0 other:12.3 transport_lane:0.0 transport_route:0.0 transport_encode:0.0 transport_issue:0.0 transport_response_wait_decode:0.0 transport_settle:0.0 transport_wrapper:0.0 preflight:0.0 todo_verdict:0.0 todo_probe:0.0 todo_persist:0.0 todo_probe_required:0 todo_probe_reason:none todo_unprobed_bust:0 session_directory:0.0 paging:0.0 output_clone:0.0 delivery:0.0 bookkeeping:0.0",
        );
    });

    it("accepts materialized boundaries only from a committed non-defer response", () => {
        expect(
            __rustModeTransformTest.materializedCompactionBoundary({
                decision: "HARD",
                scheduler_decision: "execute",
                committed: true,
                row_version: 12,
                coverage_ordinal: 9_590,
                boundary_id: "msg_boundary#3",
            }),
        ).toEqual({ rowVersion: 12, ordinal: 9_590, endMessageId: "msg_boundary" });
        expect(
            __rustModeTransformTest.materializedCompactionBoundary({
                decision: "SOFT+",
                scheduler_decision: "defer",
                committed: true,
                row_version: 12,
                coverage_ordinal: 9_590,
                boundary_id: "msg_boundary#3",
            }),
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

        await transform.run(sessionId, input, { messages: input }, makeMeta(db, sessionId));

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
                return { decision: "HARD", native_messages: makeMessages(sessionId) };
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
                return method === "transform"
                    ? { decision: "SOFT+", native_messages: native }
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
                return { decision: "SOFT+", native_messages: [] };
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
                method === "transform"
                    ? { decision: "SOFT+", native_messages: native }
                    : { ok: true },
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
                    ? { decision: "SOFT+", native_messages: [] }
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
                    ? { decision: "SOFT+", native_messages: native }
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
                    ? { decision: "SOFT+", native_messages: [] }
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
                    ? { decision: "SOFT+", native_messages: makeMessages(sessionId) }
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
                    ? { decision: "SOFT+", native_messages: makeMessages(sessionId) }
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
        const search = await tools.ctx_search.execute(
            { query: `#${memory.id}`, sources: ["memory"] },
            { sessionID: sessionId, directory: "/tmp/project" } as never,
        );
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

    it("preserves the receiver for a class-backed compartment mirror client", async () => {
        const sessionId = `rust-class-compartments-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);

        class ClassBackedModuleClient {
            private readonly title = "receiver-bound compartment";

            async call({ method }: Parameters<RustModeModuleClient["call"]>[0]) {
                return method === "transform"
                    ? { decision: "SOFT+", native_messages: [] }
                    : { ok: true };
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
                method === "transform" ? { decision: "HARD", native_messages: [] } : { ok: true },
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
        await Bun.sleep(20);
        expect(mirrorCompleted).toBe(true);
    });

    it("drains every memory mirror page before stamping the transform projection", async () => {
        const sessionId = `rust-memory-mirror-drain-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let memoryPulls = 0;
        let transform!: ReturnType<typeof createRustModeTransform>;
        const projectionKeysDuringPull: Array<string | null> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 7,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
            mirrorPull: async (args) => {
                memoryPulls += 1;
                projectionKeysDuringPull.push(
                    transform.getState(sessionId).memoryMirrorProjectionKey,
                );
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: args.cursor + 1,
                        has_more: memoryPulls < 4,
                        rows: [],
                    },
                };
            },
        };
        transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const messages = makeMessages(sessionId);

        await transform.run(
            sessionId,
            messages,
            { messages: [...messages] },
            makeMeta(db, sessionId),
        );
        await Bun.sleep(20);

        expect(memoryPulls).toBe(4);
        expect(projectionKeysDuringPull).toEqual([null, null, null, null]);
        expect(transform.getState(sessionId).memoryMirrorProjectionKey).toBe(
            JSON.stringify([7, null, null, []]),
        );
    });

    it("leaves a budget-exhausted memory mirror projection unstamped for the next pass", async () => {
        const sessionId = `rust-memory-mirror-budget-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const mirrorPageBudget = TRANSFORM_MEMORY_MIRROR_PAGE_BUDGET;
        let memoryPulls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 8,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
            mirrorPull: async (args) => {
                memoryPulls += 1;
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: args.cursor + 1,
                        has_more: true,
                        rows: [],
                    },
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );
            await Bun.sleep(20);
        };

        const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
        try {
            await run();
            expect(memoryPulls).toBe(mirrorPageBudget);
            expect(transform.getState(sessionId).memoryMirrorProjectionKey).toBeNull();

            await run();
            expect(memoryPulls).toBe(mirrorPageBudget * 2);
            expect(transform.getState(sessionId).memoryMirrorProjectionKey).toBeNull();
            const backlogLogs = logSpy.mock.calls.filter(
                ([loggedSession, message]) =>
                    loggedSession === sessionId &&
                    message.includes("rows_applied=0 backlog_remaining=true pages=20"),
            );
            expect(backlogLogs).toHaveLength(2);
        } finally {
            logSpy.mockRestore();
        }
    });

    it("does not repoll a completely drained memory mirror on stable passes", async () => {
        const sessionId = `rust-memory-mirror-stable-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let memoryPulls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 9,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
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
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );
            await Bun.sleep(20);
        };

        await run();
        await run();
        await run();
        await run();

        expect(memoryPulls).toBe(1);
        expect(transform.getState(sessionId).memoryMirrorProjectionKey).toBe(
            JSON.stringify([9, null, null, []]),
        );
    });

    it("resumes an interrupted multi-page mirror on later transform passes", async () => {
        const sessionId = `rust-memory-mirror-interrupted-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const feedHead = 2_500;
        let failSecondPage = true;
        const cursorSamples: Array<{ cursor: number; updated_at: number }> = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 10,
                          memory_mirror_head: feedHead,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
            mirrorPull: async (args) => {
                if (failSecondPage && args.cursor === 1_000) {
                    failSecondPage = false;
                    throw new Error("injected mirror page interruption");
                }
                const nextCursor = Math.min(feedHead, args.cursor + args.limit);
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: nextCursor,
                        has_more: nextCursor < feedHead,
                        rows: [],
                    },
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            await transform.run(
                sessionId,
                messages,
                { messages: [...messages] },
                makeMeta(db, sessionId),
            );
            await Bun.sleep(20);
            cursorSamples.push(
                db
                    .prepare(
                        "SELECT cursor, updated_at FROM mirror_cursors WHERE domain = 'memories'",
                    )
                    .get() as { cursor: number; updated_at: number },
            );
        };

        await run();
        await run();
        await run();
        await run();

        expect(cursorSamples[0]?.cursor).toBe(1_000);
        expect(cursorSamples.slice(1).map((sample) => sample.cursor)).toEqual([
            feedHead,
            feedHead,
            feedHead,
        ]);
        expect(cursorSamples[1]?.updated_at).toBeGreaterThan(cursorSamples[0]?.updated_at ?? 0);
        expect(cursorSamples[2]?.updated_at).toBe(cursorSamples[1]?.updated_at);
        expect(cursorSamples[3]?.updated_at).toBe(cursorSamples[2]?.updated_at);
    });

    it("uses the module feed frontier to resume without polling a caught-up mirror", async () => {
        const sessionId = `rust-memory-mirror-frontier-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let feedHead = 1;
        let memoryPulls = 0;
        const servedBytes: string[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 11,
                          memory_mirror_head: feedHead,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
            mirrorPull: async (args) => {
                memoryPulls += 1;
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: feedHead,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const run = async () => {
            const messages = makeMessages(sessionId);
            const output = { messages: [...messages] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            await Bun.sleep(20);
            servedBytes.push(JSON.stringify(output.messages));
        };

        await run();
        await run();
        await run();
        expect(memoryPulls).toBe(1);
        expect(new Set(servedBytes).size).toBe(1);

        feedHead = 2;
        await run();
        expect(memoryPulls).toBe(2);
        expect(
            db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({ cursor: 2 });
        expect(new Set(servedBytes).size).toBe(1);

        await run();
        expect(memoryPulls).toBe(2);
    });

    it("keeps defer bytes stable while one bounded memory mirror pull is in flight", async () => {
        const sessionId = `rust-memory-mirror-cache-neutral-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let releasePull!: () => void;
        const pullGate = new Promise<void>((resolve) => {
            releasePull = resolve;
        });
        let mirrorPullCalls = 0;
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) =>
                method === "transform"
                    ? {
                          decision: "SOFT+",
                          row_version: 4,
                          memory_mirror_head: 7,
                          rendered_memory_ids: [],
                          native_messages: makeMessages(sessionId),
                      }
                    : { ok: true },
            mirrorPull: async (args) => {
                mirrorPullCalls += 1;
                await pullGate;
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: 7,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };
        const transform = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const hashes: string[] = [];
        const run = async () => {
            const messages = makeMessages(sessionId);
            const output = { messages: [...messages] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            hashes.push(createHash("sha256").update(JSON.stringify(output.messages)).digest("hex"));
        };

        await run();
        await run();
        await run();
        await run();
        expect(mirrorPullCalls).toBe(1);
        expect(new Set(hashes).size).toBe(1);

        releasePull();
        await Bun.sleep(20);
        expect(
            db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({ cursor: 7 });
    });

    it("caches mural bytes and pulls mirrors only when the module projection moves", async () => {
        const sessionId = `rust-mural-mirror-generation-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        let rowVersion = 1;
        let muralResolves = 0;
        let memoryPulls = 0;
        let compartmentPulls = 0;
        let memoryCursor = 0;
        const transformMuralHashes: string[] = [];
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                const mural = (body as { mural?: { content_hash?: string } }).mural;
                transformMuralHashes.push(mural?.content_hash ?? "none");
                return {
                    decision: "SOFT+",
                    row_version: rowVersion,
                    rendered_memory_ids: [],
                    native_messages: makeMessages(sessionId),
                };
            },
            mirrorPull: async (args) => {
                memoryPulls += 1;
                const nextCursor = memoryPulls >= 2 ? 1 : memoryCursor;
                memoryCursor = nextCursor;
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: nextCursor,
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
        deps.muralEnabled = true;
        const transform = createRustModeTransform(deps, {
            moduleClient,
            muralResolverForTests: () => {
                muralResolves += 1;
                return {
                    enabled: true,
                    supportsVision: true,
                    dataUrl: `data:image/png;base64,mural-${muralResolves}`,
                    contentHash: `mural-${muralResolves}`,
                };
            },
        });
        const servedDigests: string[] = [];
        const run = async () => {
            const messages = makeMessages(sessionId);
            const output = { messages: [...messages] as unknown[] };
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));
            servedDigests.push(
                createHash("sha256").update(JSON.stringify(output.messages)).digest("hex"),
            );
            await Bun.sleep(20);
        };

        await run();
        await run();
        expect(muralResolves).toBe(1);
        expect(memoryPulls).toBe(1);
        expect(compartmentPulls).toBe(1);

        rowVersion = 2;
        await run();
        expect(memoryPulls).toBe(2);
        expect(compartmentPulls).toBe(2);
        await run();
        await run();

        expect(muralResolves).toBe(2);
        expect(memoryPulls).toBe(2);
        expect(compartmentPulls).toBe(2);
        expect(transformMuralHashes).toEqual([
            "mural-1",
            "mural-1",
            "mural-1",
            "mural-2",
            "mural-2",
        ]);
        expect(new Set(servedDigests)).toEqual(new Set([servedDigests[0]]));
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
                        ? { decision: "SOFT+", native_messages: [] }
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
                    ? { decision: "SOFT+", native_messages: [] }
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
                        ? { decision: "SOFT+", native_messages: [] }
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
                    ? { decision: "SOFT+", native_messages: [] }
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
        let decision = "HARD";
        let materializeReason = "first_render";
        const moduleClient: RustModeModuleClient = {
            call: async ({ method, body }) => {
                if (method !== "transform") return { ok: true };
                bodies.push(body as Record<string, unknown>);
                return {
                    decision,
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
                    ? { decision: "SOFT+", native_messages: [] }
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
                return { decision: "SOFT+", native_messages: native };
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
                return { decision: "SOFT+", native_messages: native };
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
                return { decision: transforms === 3 ? "HARD" : "SOFT+", native_messages: native };
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
                if (transforms === 2) return { status: "need_full_sync" };
                if (transforms === 4) throw new Error("rust module transform timed out");
                return { decision: "SOFT+", native_messages: native };
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
            await runPass(); // module timeout, served from the last good array
            rows.push({
                id: `m-${String(ROWS + 1).padStart(6, "0")}`,
                timeCreated: ROWS + 1,
                contributesOrdinal: true,
                hasValidInfo: true,
            });
            await runPass(); // the resumed turn with one new message

            expect(transforms).toBe(5);
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
            expect(transforms).toBe(6);
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
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformCalls.filter(
                ({ body }) => body.transform_page_index === 0,
            );
            expect(seriesStarts).toHaveLength(1);
            expect(transformCalls.at(-1)?.attemptClass).toBe("transform_series_execute");
            // One seed message: the cold-start floor plus one per-message increment.
            expect(transformCalls.at(-1)?.timeoutMs).toBe(15_002);
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
            await transform.run(sessionId, messages, output, makeMeta(db, sessionId));

            const seriesStarts = transformBodies.filter((page) => page.transform_page_index === 0);
            expect(seriesStarts).toHaveLength(2);
            expect(new Set(seriesStarts.map((page) => page.transform_page_id)).size).toBe(1);
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
            const projectRoot = mkdtempSync(join(tmpdir(), `rust-hotpath-${label}-`));
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
            expect(after.memoryPulls).toBeLessThan(before.memoryPulls);
            expect(after.compartmentPulls).toBeLessThan(before.compartmentPulls);
            if (process.env.MAGIC_CONTEXT_HOTPATH_MEASURE === "1") {
                console.log(`HOTPATH_MEASUREMENT ${JSON.stringify({ before, after })}`);
            }
        } finally {
            logSpy.mockRestore();
        }
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
        await transform.run(sessionId, secondInput, secondOutput, makeMeta(db, sessionId));

        expect(secondOutput.messages).toEqual(secondInput);
        expect(getSlot(sessionId)).toBeUndefined();
        expect(transform.getState(sessionId).consecutiveFailures).toBe(1);
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
        await transform.run(sessionId, input, output, makeMeta(db, sessionId));
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

    it("serves module output while context.db is busy and skips only the durable LKG refresh", async () => {
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
            expect(JSON.stringify(secondOutput.messages)).toContain("module output 2");
            expect(getSlot(sessionId)?.jsonPrefix).toContain("module output 2");
            const persisted = db
                .prepare("SELECT json_prefix FROM lkg_slots WHERE session_id = ?")
                .get(sessionId) as { json_prefix: string };
            expect(persisted.json_prefix).toContain("module output 1");
        } finally {
            if (blocker.inTransaction) blocker.exec("ROLLBACK");
            closeQuietly(blocker);
        }

        unavailable = true;
        const hotReplay = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, hotReplay, makeMeta(db, sessionId));
        expect(JSON.stringify(hotReplay.messages)).toContain("module output 2");

        resetLkgSlotsForTest();
        registerLkgPersistence(createDbLkgPersistence(db));
        const restarted = createRustModeTransform(makeDeps(db, moduleClient), { moduleClient });
        const coldReplay = { messages: [...input] as unknown[] };
        await restarted.run(sessionId, input, coldReplay, makeMeta(db, sessionId));
        expect(JSON.stringify(coldReplay.messages)).toContain("module output 1");
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
                return {
                    decision: "HARD",
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
            await transform.run(
                sessionId,
                first,
                { messages: first as unknown[] },
                makeMeta(db, sessionId),
            );

            expect(transform.getState(sessionId).parked).toBe(true);
            expect(stateSyncCalls).toBe(1);
            expect(transformCalls).toBe(0);
            expect(toastCalls).toBe(1);
            expect(
                logSpy.mock.calls
                    .filter(([loggedSession]) => loggedSession === sessionId)
                    .map(([, message]) => message)
                    .find((message) => message.startsWith("rust pass:")),
            ).toContain("decision=error reason=state_sync_non_retryable served_from=raw");

            for (let pass = 0; pass < 2; pass += 1) {
                const parked = makeMessages(sessionId);
                await transform.run(
                    sessionId,
                    parked,
                    { messages: parked as unknown[] },
                    makeMeta(db, sessionId),
                );
            }
            expect(stateSyncCalls).toBe(1);
            expect(transformCalls).toBe(0);
        } finally {
            logSpy.mockRestore();
        }
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
                    ? { decision: "SOFT+", native_messages: [{ role: "assistant", parts: [] }] }
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

    it("keeps MODULE memory and note values over conflicting TS rows during delta-cache recovery", async () => {
        const sessionId = `rust-authority-conflict-${Date.now()}`;
        sessions.push(sessionId);
        const db = makeDb();
        installRawProvider(sessionId);
        const projectPath = "/tmp/project";
        const contextStoreUuid = ensureContextStoreUuid(db);
        withPrivilegedWriter(db, () => {
            db.prepare(
                `INSERT INTO memories (
                    id, project_path, category, content, normalized_hash,
                    first_seen_at, created_at, updated_at, last_seen_at
                ) VALUES (501, ?, 'CONSTRAINTS', 'stale TS memory', 'ts-memory', 0, 0, 0, 0)`,
            ).run(projectPath);
            db.prepare(
                `INSERT INTO notes (
                    id, type, status, content, project_path, session_id, created_at, updated_at
                ) VALUES (601, 'smart', 'active', 'stale TS note', ?, ?, 0, 0)`,
            ).run(projectPath, sessionId);
        });
        const stateSyncBodies: unknown[] = [];
        let transformCalls = 0;
        const moduleClient: RustModeModuleClient = {
            authorityStatus: async (args) => ({
                authority: {
                    context_store_uuid: contextStoreUuid,
                    project: projectPath,
                    domain: args.domain,
                    state: "MODULE",
                    generation: 1,
                },
            }),
            authorityPrepare: async () => {
                throw new Error("MODULE authority must not prepare from TS");
            },
            authoritySeed: async () => ({ seeded: 0 }),
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: 1,
                    has_more: false,
                    rows:
                        args.domain === "memories"
                            ? [
                                  {
                                      feed_seq: 1,
                                      domain: "memories",
                                      op: "update",
                                      module_row_id: 51,
                                      full_row_snapshot: {
                                          context_store_uuid: contextStoreUuid,
                                          context_row_id: 501,
                                          project_path: projectPath,
                                          category: "CONSTRAINTS",
                                          content: "MODULE memory wins",
                                          normalized_hash: "module-memory",
                                          status: "active",
                                          created_at_ms: 0,
                                          updated_at_ms: 1,
                                      },
                                      content_hash: "module-memory",
                                  },
                              ]
                            : [
                                  {
                                      feed_seq: 1,
                                      domain: "notes",
                                      op: "update",
                                      module_row_id: 61,
                                      full_row_snapshot: {
                                          context_store_uuid: contextStoreUuid,
                                          context_row_id: 601,
                                          type: "smart",
                                          project_path: projectPath,
                                          session_id: sessionId,
                                          content: "MODULE note wins",
                                          status: "active",
                                          created_at_ms: 0,
                                          updated_at_ms: 1,
                                      },
                                      content_hash: null,
                                  },
                              ],
                },
            }),
            call: async ({ method, body }) => {
                if (method === "state_sync") {
                    stateSyncBodies.push(structuredClone(body));
                    return { ok: true };
                }
                if (method !== "transform") return { ok: true };
                transformCalls += 1;
                if (transformCalls === 1) return { status: "need_full_sync" };
                return {
                    decision: "HARD",
                    row_version: 2,
                    native_messages: makeMessages(sessionId),
                };
            },
        };
        const transform = createRustModeTransformImpl(makeDeps(db, moduleClient), { moduleClient });
        const input = makeMessages(sessionId);
        await transform.run(sessionId, input, { messages: [...input] }, makeMeta(db, sessionId));

        expect(stateSyncBodies).toHaveLength(1);
        expect(JSON.stringify(stateSyncBodies)).not.toContain("stale TS memory");
        expect(JSON.stringify(stateSyncBodies)).not.toContain("stale TS note");
        expect(db.prepare("SELECT content FROM memories WHERE id = 501").get()).toEqual({
            content: "MODULE memory wins",
        });
        expect(db.prepare("SELECT content FROM notes WHERE id = 601").get()).toEqual({
            content: "MODULE note wins",
        });
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
                        native_messages: structuredClone(request.native_messages),
                    };
                }
                if (request.tail_delta) return { status: "ok", served_from: "transform" };
                return { decision: "SOFT+", native_messages: structuredClone(healedNative) };
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
                    ? { decision: "SOFT+", native_messages: [] }
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

    it("releases a valid frozen replay on the eighth consecutive healthy defer", async () => {
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
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
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

        const healthyDeferLimit = 8;
        for (let healthyPass = 1; healthyPass <= healthyDeferLimit; healthyPass += 1) {
            const output = { messages: [...input] as unknown[] };
            await transform.run(sessionId, input, output, makeMeta(db, sessionId));
            if (healthyPass < healthyDeferLimit) {
                expect(output.messages).toEqual(representationA);
                expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(true);
            } else {
                expect(output.messages).toEqual(representationB);
                expect(transform.getState(sessionId).lkgRepresentationFrozen).toBe(false);
            }
        }
    });

    it("releases a valid frozen replay when the raw tail grows by sixteen messages", async () => {
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
        const moduleClient: RustModeModuleClient = {
            call: async ({ method }) => {
                if (method !== "transform") return { ok: true };
                pass += 1;
                if (pass === 2) throw new Error("daemon unavailable");
                return {
                    decision: pass === 1 ? "HARD" : "SOFT+",
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

    function insert(db: ContextDatabase, project: string, content: string, status: string): number {
        const now = Date.now();
        db.prepare(
            `INSERT INTO memories
               (project_path, category, content, normalized_hash, source_type,
                seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                last_seen_at, status)
             VALUES (?, 'ARCHITECTURE', ?, ?, 'agent', 1, 0, ?, ?, ?, ?, ?)`,
        ).run(project, content, `hash-${content}`, now, now, now, now, status);
        return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
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

it("unknown calibrated raw fallback refuses a locally fitting request and admits a safe request", async () => {
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
            await transform.run(sessionId, input, output, meta);
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
