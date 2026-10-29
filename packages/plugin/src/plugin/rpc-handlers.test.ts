/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../config";
import { pluginConfigReader } from "../config/live-run-config";
import { MagicContextConfigSchema } from "../config/schema/magic-context";
import { seedSessionMeta } from "../features/magic-context/__tests__/session-meta-fixture";
import { replaceAllCompartmentState } from "../features/magic-context/compartment-storage";
import { insertMemory } from "../features/magic-context/memory";
import {
    __clearProjectIdentityTransientCooldownForTests,
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentity,
    setHomeProjectPermission,
} from "../features/magic-context/memory/project-identity";
import { FORK_MIGRATION_VERSION_FLOOR, runMigrations } from "../features/magic-context/migrations";
import { upsertMural } from "../features/magic-context/mural/storage-mural";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import {
    resetEpochFloorRegistryForTest,
    resolveEpochFloorForPass,
} from "../features/magic-context/storage-meta-persisted";
import type { HiddenCompletionExecutor } from "../hooks/magic-context/compartment-runner-types";
import { createLiveSessionState } from "../hooks/magic-context/live-session-state";
import { setRawMessageProvider } from "../hooks/magic-context/read-session-chunk";
import { closeReadOnlySessionDb } from "../hooks/magic-context/read-session-db";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { _resetHarnessForTesting, setHarness } from "../shared/harness";
import * as logger from "../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../shared/models-dev-cache";
import { pluginPackageVersion } from "../shared/plugin-package-version";
import { MagicContextRpcServer } from "../shared/rpc-server";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { buildStatusViewFor } from "../shared/status-view";
import { checkStatusDetailPayload } from "../shared/status-view-check";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { registerV2Commands } from "../v2/hooks/commands";
import {
    buildDebugMemoryUsage,
    buildSidebarSnapshot,
    buildSidebarSnapshotRpcResponse,
    buildStatusDetail,
    isDebugRpcEnabled,
    registerRpcHandlers,
} from "./rpc-handlers";
import { resetSidebarSnapshotCache } from "./sidebar-snapshot-cache";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

type TestRpcHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

function registeredRpcMethods(
    debugRpc: boolean,
    getDatabase?: () => Database | null,
): Map<string, TestRpcHandler> {
    const handlers = new Map<string, TestRpcHandler>();
    const rpcServer = {
        handle(method: string, handler: TestRpcHandler) {
            handlers.set(method, handler);
        },
    } as unknown as MagicContextRpcServer;
    registerRpcHandlers(rpcServer, {
        directory: process.cwd(),
        config: MagicContextConfigSchema.parse({ debug_rpc: debugRpc }),
        client: {},
        liveSessionState: createLiveSessionState(),
        getDatabase,
    });
    return handlers;
}

function createLiveHistorianConfig(targetMaxTokens: number | undefined) {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-rpc-historian-cap-"));
    const previousHome = process.env.HOME;
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    const directory = join(root, "project");
    const userConfigDirectory = join(root, "config", "cortexkit");
    mkdirSync(directory, { recursive: true });
    mkdirSync(userConfigDirectory, { recursive: true });
    const configPath = join(userConfigDirectory, "magic-context.jsonc");
    const writeConfig = (maxTokens: number | undefined): void => {
        writeFileSync(
            configPath,
            JSON.stringify({
                historian: {
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    opencode: { model: "test/rpc-historian" },
                },
            }),
        );
    };
    writeConfig(4096);
    const bootConfig = loadPluginConfigDetailed(directory, false).config;
    const reader = pluginConfigReader(directory, bootConfig);
    writeConfig(targetMaxTokens);
    const effective = reader.poll().effective;
    expect(effective.historian?.maxTokens).toBe(targetMaxTokens);

    return {
        root,
        directory,
        bootConfig,
        restoreEnvironment() {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousConfigHome;
        },
    };
}

function terminalAwareLiveSessionState(sessionId: string) {
    const liveSessionState = createLiveSessionState();
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
    });
    const progress = liveSessionState.recompProgressBySession;
    liveSessionState.recompProgressBySession = new Proxy(progress, {
        get(target, property) {
            if (property === "set") {
                return (id: string, value: { phase?: string }) => {
                    const result = target.set(id, value as never);
                    if (
                        id === sessionId &&
                        (value.phase === "done" ||
                            value.phase === "failed" ||
                            value.phase === "skipped")
                    ) {
                        resolveTerminal();
                    }
                    return result;
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as typeof progress;
    return { liveSessionState, terminal };
}

function outputCapExecutor(caps: Array<number | undefined>): HiddenCompletionExecutor {
    let promptJson = "";
    let childNumber = 0;
    return {
        capabilities: { tools: false, harness: "opencode" },
        open: async (run) => {
            caps.push(run.maxOutputTokens);
            childNumber += 1;
            return {
                id: `rpc-cap-child-${childNumber}`,
                childSessionId: `rpc-cap-child-${childNumber}`,
            };
        },
        attempt: async (_handle, request) => {
            promptJson = JSON.stringify(request);
        },
        collect: async () => {
            const range = promptJson.match(/Messages (\d+)-(\d+):/);
            if (!range) throw new Error("historian prompt did not include a message range");
            return {
                text: `<output><compartment start="${range[1]}" end="${range[2]}" title="Rebuilt"><p1>Rebuilt ${range[1]}-${range[2]}.</p1></compartment></output>`,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
        },
        close: async () => {},
    };
}

async function exerciseManagedOutputCap(args: {
    surface: "tui-rpc" | "opencode2-command";
    method: "recomp" | "wrapup";
    maxTokens: number | undefined;
}): Promise<void> {
    const liveConfig = createLiveHistorianConfig(args.maxTokens);
    const db = createTestDb();
    const sessionId = `rpc-cap-${args.surface}-${args.method}-${String(args.maxTokens ?? "unset")}`;
    const rawMessages = Array.from({ length: 8 }, (_, index) => ({
        ordinal: index + 1,
        id: `message-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} alpha beta gamma delta` }],
    }));
    const unregisterProvider = setRawMessageProvider(sessionId, {
        readMessages: () => rawMessages,
        getMessageCount: () => rawMessages.length,
    });
    const { liveSessionState, terminal } = terminalAwareLiveSessionState(sessionId);
    const caps: Array<number | undefined> = [];
    const rpc = new MagicContextRpcServer(join(liveConfig.root, "storage"), liveConfig.directory);
    try {
        setHarness(args.surface === "opencode2-command" ? "opencode2" : "opencode");
        registerRpcHandlers(rpc, {
            directory: liveConfig.directory,
            config: liveConfig.bootConfig,
            client: undefined,
            hiddenCompletionExecutor: outputCapExecutor(caps),
            liveSessionState,
            getDatabase: () => db,
        });

        if (args.surface === "tui-rpc") {
            await rpc.dispatch(
                args.method,
                args.method === "recomp" ? { sessionId } : { sessionId, messagesToKeep: 2 },
            );
        } else {
            const registered: Array<{
                name: string;
                execute: (input: {
                    sessionID: string;
                    prompt: { text: string };
                    delivery: "steer";
                }) => Promise<void>;
            }> = [];
            const commandDomain = {
                async transform(callback: (editor: { add: (definition: never) => void }) => void) {
                    callback({ add: (definition) => registered.push(definition as never) });
                    return {};
                },
                async reload() {},
            };
            await registerV2Commands({
                command: commandDomain as never,
                rpc,
                directory: liveConfig.directory,
                compactionEnabled: true,
            });
            const command = registered.find((entry) => entry.name === `ctx-${args.method}`);
            if (!command) throw new Error(`OpenCode 2 did not register ctx-${args.method}`);
            await command.execute({
                sessionID: sessionId,
                prompt: { text: args.method === "recomp" ? "" : "/ctx-wrapup 2" },
                delivery: "steer",
            });
        }

        await terminal;
        expect(caps.length, `${args.surface} ${args.method}`).toBeGreaterThan(0);
        expect(
            caps.every((cap) => cap === args.maxTokens),
            `${args.surface} ${args.method}`,
        ).toBe(true);
    } finally {
        unregisterProvider();
        closeQuietly(db);
        _resetHarnessForTesting();
        liveConfig.restoreEnvironment();
        rmSync(liveConfig.root, { recursive: true, force: true });
    }
}

describe("manual historian cap reaches the OpenCode historian executor", () => {
    for (const surface of ["tui-rpc", "opencode2-command"] as const) {
        for (const method of ["recomp", "wrapup"] as const) {
            for (const maxTokens of [65_536, undefined]) {
                test(`${surface} ${method} passes ${maxTokens ?? "unset"} from live config`, async () => {
                    await exerciseManagedOutputCap({ surface, method, maxTokens });
                });
            }
        }
    }
});

afterEach(() => {
    resetSidebarSnapshotCache();
    clearModelsDevCache();
    __resetProjectIdentityForTests();
});

describe("home project sidebar", () => {
    test("does not poll memory while gated and serves a snapshot after opt-in", () => {
        const directory = process.cwd();
        __setProjectIdentityTestHooks({ homeDirectory: () => directory });
        const db = createTestDb();
        try {
            expect(buildSidebarSnapshotRpcResponse(db, "ses_home", directory)).toEqual({
                sessionId: "ses_home",
                disabled: true,
            });
            setHomeProjectPermission(true);
            const snapshot = buildSidebarSnapshotRpcResponse(db, "ses_home", directory);
            expect(snapshot.error).toBeUndefined();
            expect(snapshot).toHaveProperty("sessionId", "ses_home");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("session-owner", () => {
    test("moved-session recomp and recovery use fresh host ownership before opening local state", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "moved-history-owner-"));
        const handlers = new Map<string, TestRpcHandler>();
        const liveSessionState = createLiveSessionState();
        liveSessionState.sessionDirectoryBySession.set("moved", "/old");
        try {
            registerRpcHandlers(
                {
                    handle: (method: string, handler: TestRpcHandler) =>
                        handlers.set(method, handler),
                } as unknown as MagicContextRpcServer,
                {
                    directory: "/old",
                    config: MagicContextConfigSchema.parse({}),
                    client: undefined,
                    liveSessionState,
                    storageDir: root,
                    readSessionDirectory: async () => "/new",
                    getDatabase: () => {
                        throw new Error("old instance must not open history state");
                    },
                },
            );
            expect(await handlers.get("session-owner")!({ sessionId: "moved" })).toEqual({
                owner: false,
            });
            for (const method of ["recomp", "wrapup"]) {
                const reply = await handlers.get(method)!({ sessionId: "moved" });
                expect(reply.ok).toBe(false);
                expect(reply.error).toContain("current project directory (/new)");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function ownerHandler(directory: string, sessionDirectories: Record<string, string>) {
        const handlers = new Map<string, TestRpcHandler>();
        const rpcServer = {
            handle(method: string, handler: TestRpcHandler) {
                handlers.set(method, handler);
            },
        } as unknown as MagicContextRpcServer;
        registerRpcHandlers(rpcServer, {
            directory,
            config: MagicContextConfigSchema.parse({}),
            client: {
                session: {
                    get: async ({ path }: { path: { id: string } }) => ({
                        data: sessionDirectories[path.id]
                            ? { directory: sessionDirectories[path.id] }
                            : undefined,
                    }),
                },
            },
            liveSessionState: createLiveSessionState(),
        });
        const handler = handlers.get("session-owner");
        if (!handler) throw new Error("session-owner is not registered");
        return handler;
    }

    test("claims a session whose host directory is this server's directory in another spelling", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "session-owner-"));
        try {
            const handler = ownerHandler(root, {
                ses_mine: `${root}/`,
                ses_other: join(root, "elsewhere"),
            });
            expect(await handler({ sessionId: "ses_mine" })).toEqual({ owner: true });
            expect(await handler({ sessionId: "ses_other" })).toEqual({ owner: false });
            expect(await handler({ sessionId: "ses_unknown" })).toEqual({ owner: false });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("status-detail replies the /ctx-status dialog can draw", () => {
    test("a session with no stored state yet passes the dialog's check and names the server version", async () => {
        const db = createTestDb();
        try {
            const handler = registeredRpcMethods(false, () => db).get("status-detail");
            if (!handler) throw new Error("status-detail is not registered");
            const reply = await handler({ sessionId: "ses-never-seen", directory: process.cwd() });
            const version = pluginPackageVersion();
            expect(version).toMatch(/^\d+\.\d+\.\d+/);
            expect(reply.pluginVersion).toBe(version);
            const check = checkStatusDetailPayload(reply, version ?? "");
            expect(check.state).toBe("ready");
            const view = buildStatusViewFor(check, { version: version ?? "" });
            expect(view.headline.left.text).toBe("0.0% / 65%");
            expect(view.warnings).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("the home-directory reply carries the server version and draws as unavailable", async () => {
        const directory = process.cwd();
        __setProjectIdentityTestHooks({ homeDirectory: () => directory });
        const db = createTestDb();
        try {
            const handler = registeredRpcMethods(false, () => db).get("status-detail");
            if (!handler) throw new Error("status-detail is not registered");
            const reply = await handler({ sessionId: "ses_home", directory });
            expect(reply).toEqual({
                sessionId: "ses_home",
                disabled: true,
                pluginVersion: pluginPackageVersion() ?? undefined,
            });
            const check = checkStatusDetailPayload(reply, pluginPackageVersion() ?? "");
            expect(check.state === "unavailable" && check.reason).toEqual({
                kind: "not_tracked",
                cause: "home_directory",
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("debug RPC guard", () => {
    test("reports process and readable native allocation counters", () => {
        const memory = buildDebugMemoryUsage();
        expect(memory.memoryUsage).toMatchObject({
            rss: expect.any(Number),
            external: expect.any(Number),
            arrayBuffers: expect.any(Number),
        });
        expect(memory.native.sqlite).toMatchObject({
            connectionCount: expect.any(Number),
            cacheUpperBoundBytes: expect.any(Number),
            sqliteStatusApi: "unavailable",
        });
        expect(memory.native.tokenizer.loaded).toBeTypeOf("boolean");
        expect(memory.native.localEmbedding.loaded).toBeTypeOf("boolean");
        expect(memory.native.quickJs.loaded).toBeTypeOf("boolean");
        expect(memory.holders.lkgSlots.totalBytes).toBeTypeOf("number");
        expect(memory.holders.messageIndexQueue.activeBufferBytes).toBeTypeOf("number");
        expect(memory.holders.generateReplay).toEqual({ sessionCount: 0, estimatedBytes: 0 });
    });

    test("reports OpenCode 2's kept side-question requests in total and per session", () => {
        const memory = buildDebugMemoryUsage({
            generateReplay: {
                totalBytes: 300,
                sessions: [
                    { sessionId: "ses_b", bytes: 200 },
                    { sessionId: "ses_a", bytes: 100 },
                ],
            },
        });
        expect(memory.holders.generateReplay).toEqual({ sessionCount: 2, estimatedBytes: 300 });
        expect(
            memory.holders.sessions
                .filter(({ sessionId }) => sessionId === "ses_a" || sessionId === "ses_b")
                .map(({ sessionId, generateReplayBytes }) => ({
                    sessionId,
                    generateReplayBytes,
                })),
        ).toEqual([
            { sessionId: "ses_a", generateReplayBytes: 100 },
            { sessionId: "ses_b", generateReplayBytes: 200 },
        ]);
    });

    test("does not register heap diagnostics when the flag is off by default", () => {
        const previous = process.env.MAGIC_CONTEXT_DEBUG_RPC;
        delete process.env.MAGIC_CONTEXT_DEBUG_RPC;
        try {
            const handlers = registeredRpcMethods(false);
            expect(handlers.has("debug.memoryUsage")).toBe(false);
            expect(handlers.has("debug.heapSnapshot")).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_RPC;
            else process.env.MAGIC_CONTEXT_DEBUG_RPC = previous;
        }
    });

    test("registers diagnostics only for an explicit config or environment opt-in", () => {
        const previous = process.env.MAGIC_CONTEXT_DEBUG_RPC;
        delete process.env.MAGIC_CONTEXT_DEBUG_RPC;
        try {
            expect(isDebugRpcEnabled({ debug_rpc: true }, {})).toBe(true);
            expect(isDebugRpcEnabled({ debug_rpc: false }, { MAGIC_CONTEXT_DEBUG_RPC: "1" })).toBe(
                true,
            );
            expect(isDebugRpcEnabled({ debug_rpc: false }, {})).toBe(false);
            expect(registeredRpcMethods(true).has("debug.heapSnapshot")).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_RPC;
            else process.env.MAGIC_CONTEXT_DEBUG_RPC = previous;
        }
    });
});

describe("sidebar snapshot RPC failures", () => {
    test("unborn repo sidebar loads existing directory memories", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "sidebar-unborn-"));
        const db = createTestDb();
        try {
            execFileSync("git", ["init", "-q", directory], { windowsHide: true });
            const identity = `dir:${createHash("md5").update(directory).digest("hex").slice(0, 12)}`;
            insertMemory(db, {
                projectPath: identity,
                category: "USER_DIRECTIVES",
                content: "Existing unborn memory",
            });
            const snapshot = buildSidebarSnapshotRpcResponse(db, "ses_unborn", directory);
            expect(snapshot.error).toBeUndefined();
            expect(snapshot.memoryCount).toBe(1);
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("paused sidebar logs once per directory and reason without stacks", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "sidebar-paused-"));
        execFileSync("git", ["init", "-q", directory], { windowsHide: true });
        // A repository with commits: one with none is recognized from its files and gets its
        // directory identity without asking git, so a failing git could not pause it.
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "first",
            ],
            { cwd: directory, windowsHide: true },
        );
        const db = createTestDb();
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        try {
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
                }) as typeof execFileSync,
            });
            for (let i = 0; i < 4; i++) {
                expect(buildSidebarSnapshotRpcResponse(db, "ses_paused", directory)).toEqual({
                    sessionId: "ses_paused",
                    disabled: true,
                    paused: true,
                });
            }
            expect(logged).toHaveBeenCalledTimes(1);
            expect(logged.mock.calls[0]).toEqual([
                `[magic-context] memory features paused for ${directory}: git_timeout`,
            ]);
            __clearProjectIdentityTransientCooldownForTests(directory);
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw new Error("other git failure");
                }) as typeof execFileSync,
            });
            buildSidebarSnapshotRpcResponse(db, "ses_paused", directory);
            expect(logged).toHaveBeenCalledTimes(2);
            expect(logged.mock.calls[1]).toEqual([
                `[magic-context] memory features paused for ${directory}: unknown`,
            ]);
            __clearProjectIdentityTransientCooldownForTests(directory);
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
                }) as typeof execFileSync,
            });
            buildSidebarSnapshotRpcResponse(db, "ses_paused", directory);
            expect(logged).toHaveBeenCalledTimes(2);
        } finally {
            logged.mockRestore();
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });
    test("returns an error envelope when snapshot construction hits SQLITE_BUSY", () => {
        const busyDb = {
            prepare() {
                const error = new Error("database is locked") as Error & { code?: string };
                error.code = "SQLITE_BUSY";
                throw error;
            },
        } as unknown as Database;

        expect(buildSidebarSnapshotRpcResponse(busyDb, "ses_busy", process.cwd())).toEqual({
            error: "sidebar snapshot unavailable",
        });
    });
});

describe("buildStatusDetail — per-model execute threshold", () => {
    test.each([
        {
            name: "persisted model",
            persisted: "test/model-a",
            explicit: undefined,
            threshold: 50,
            tokens: 250_000,
        },
        {
            name: "explicit model takes precedence",
            persisted: "test/model-a",
            explicit: "test/model-b",
            threshold: 20,
            tokens: 100_000,
        },
        {
            name: "unknown model keeps the default",
            persisted: null,
            explicit: undefined,
            threshold: 65,
            tokens: undefined,
        },
    ])("$name", ({ persisted, explicit, threshold, tokens }) => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-threshold";
            // 100K input tokens at 20% gives the 500K context limit that tokens-mode
            // thresholds are converted against.
            db.prepare(
                "INSERT INTO session_meta (session_id, last_observed_model_key, last_input_tokens, last_context_percentage) VALUES (?, ?, 100000, 20)",
            ).run(sessionId, persisted);
            const detail = buildStatusDetail(db, sessionId, process.cwd(), explicit, {
                execute_threshold_tokens: {
                    "test/model-a": 250_000,
                    "test/model-b": 100_000,
                },
            });

            expect(detail.executeThreshold).toBe(threshold);
            expect(detail.executeThresholdTokens).toBe(tokens);
            expect(detail.executeThresholdMode).toBe(
                tokens === undefined ? "percentage" : "tokens",
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — active profile", () => {
    test("includes the resolved profile name in the RPC status payload", () => {
        const db = createTestDb();
        try {
            expect(
                buildStatusDetail(db, "ses-profile-status", process.cwd(), undefined, {
                    profile: "work",
                }).activeProfile,
            ).toBe("work");
            expect(
                buildStatusDetail(db, "ses-base-status", process.cwd()).activeProfile,
            ).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — memory importance histogram", () => {
    test("returns the exact active distribution and unclassified denominator", () => {
        const db = createTestDb();
        try {
            const projectIdentity = resolveProjectIdentity(process.cwd());
            const rows = [5, 25, 50, 65, 100].map((importance, index) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "CONSTRAINTS",
                    content: `rpc-status-memory-${index}`,
                    importance,
                }),
            );
            db.prepare("UPDATE memories SET classified_at = 123 WHERE id IN (?, ?, ?, ?)").run(
                rows[0]!.id,
                rows[1]!.id,
                rows[3]!.id,
                rows[4]!.id,
            );

            const detail = buildStatusDetail(db, "ses-memory-histogram", process.cwd());

            expect(detail.memoryImportanceHistogram).toEqual({
                total: 5,
                unclassified: 1,
                bands: {
                    "0-19": 1,
                    "20-39": 1,
                    "40-59": 1,
                    "60-79": 1,
                    "80-100": 1,
                },
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — protected-token floor", () => {
    test("uses the durable first-observed floor for pre-snapshot sessions after restart", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-pre-snapshot-floor";
            const insertTag = db.prepare(
                `INSERT INTO tags (
                    session_id, message_id, type, status, byte_size, tag_number,
                    token_count, input_token_count, reasoning_token_count
                ) VALUES (?, ?, 'tool', 'active', 1, ?, 2000, 0, 0)`,
            );
            for (let tagNumber = 1; tagNumber <= 10; tagNumber += 1) {
                insertTag.run(sessionId, `message-${tagNumber}`, tagNumber);
            }

            const defer = resolveEpochFloorForPass(db, sessionId, {
                usableSoft: 100_000,
                isCacheBustingPass: false,
            });
            expect(defer.floor).toBe(8_000);
            resetEpochFloorRegistryForTest();

            const detail = buildStatusDetail(db, sessionId, process.cwd());
            expect(detail.protectedTagCount).toBe(4);
        } finally {
            closeQuietly(db);
            resetEpochFloorRegistryForTest();
        }
    });
});

describe("buildStatusDetail — storage version probe", () => {
    test("reports the upstream lane when fork rows share context.db", () => {
        const db = createTestDb();
        try {
            db.prepare(
                "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?), (?, ?, ?)",
            ).run(
                FORK_MIGRATION_VERSION_FLOOR,
                "fork migration 10000",
                0,
                FORK_MIGRATION_VERSION_FLOOR + 1,
                "fork migration 10001",
                0,
            );

            const detail = buildStatusDetail(db, "ses-storage-version", process.cwd());

            expect(detail.storage_versions).toEqual({
                context_db_schema_version: LATEST_SUPPORTED_VERSION,
                plugin_supported_version: LATEST_SUPPORTED_VERSION,
            });
            expect(detail.loggerDiagnostics).toEqual({
                swallowedWriteCount: 0,
                lastErrorMessage: null,
                lastErrorTime: null,
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — host work metrics", () => {
    for (const store of ["migrated", "native"] as const) {
        test(`OpenCode 2 ${store} store replaces persisted zero with session_message totals`, () => {
            const root = createTestTempDirFromPath(join(tmpdir(), "sidebar-work-metrics-"));
            const previousDbPath = process.env.OPENCODE_DB;
            const previousDataHome = process.env.XDG_DATA_HOME;
            const previousChannel = process.env.OPENCODE_CHANNEL;
            mkdirSync(join(root, "opencode"));
            const hostPath = join(root, "opencode", "opencode.db");
            const host = new Database(hostPath);
            const db = createTestDb();
            const sessionId = `ses-work-metrics-${store}`;
            try {
                closeReadOnlySessionDb();
                _resetHarnessForTesting();
                process.env.OPENCODE_DB = hostPath;
                host.exec(`CREATE TABLE session_message (
                    id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
                    seq INTEGER, time_created INTEGER, data TEXT
                )`);
                if (store === "migrated") {
                    host.exec(`
                        CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                        CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
                        CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
                    `);
                    // Reproduce the old reader persisting zero from the empty
                    // v1 table before the same session is opened by OpenCode 2.
                    expect(
                        buildSidebarSnapshot(db, sessionId, process.cwd()).totalInputTokens,
                    ).toBe(0);
                } else {
                    // The dev channel uses opencode.db on OpenCode 2, but
                    // opencode-dev.db on OpenCode 1. Do not read the decoy v1 store.
                    delete process.env.OPENCODE_DB;
                    process.env.XDG_DATA_HOME = root;
                    process.env.OPENCODE_CHANNEL = "dev";
                    const decoy = new Database(join(root, "opencode", "opencode-dev.db"));
                    try {
                        decoy.exec(`
                            CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                            CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
                        `);
                    } finally {
                        closeQuietly(decoy);
                    }
                    db.prepare(
                        "INSERT INTO session_meta (session_id, new_work_tokens, total_input_tokens) VALUES (?, 0, 0)",
                    ).run(sessionId);
                }
                _resetHarnessForTesting();
                setHarness("opencode2");
                const insert = host.prepare(
                    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, 'assistant', ?, ?, ?)",
                );
                for (const [index, input] of [70, 170, 50, 90].entries()) {
                    insert.run(
                        `m${index}`,
                        sessionId,
                        index + 1,
                        index + 1,
                        JSON.stringify({
                            agent: "build",
                            tokens: { input, output: index + 1, cache: { read: 20, write: 10 } },
                        }),
                    );
                }

                for (let poll = 0; poll < 2; poll++) {
                    const snapshot = buildSidebarSnapshotRpcResponse(db, sessionId, process.cwd());
                    expect(snapshot).toMatchObject({ newWorkTokens: 244, totalInputTokens: 320 });
                    expect(
                        db
                            .prepare(
                                "SELECT new_work_tokens, total_input_tokens FROM session_meta WHERE session_id = ?",
                            )
                            .get(sessionId),
                    ).toEqual({ new_work_tokens: 244, total_input_tokens: 320 });
                }
            } finally {
                closeReadOnlySessionDb();
                _resetHarnessForTesting();
                if (previousDbPath === undefined) delete process.env.OPENCODE_DB;
                else process.env.OPENCODE_DB = previousDbPath;
                if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = previousDataHome;
                if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
                else process.env.OPENCODE_CHANNEL = previousChannel;
                closeQuietly(host);
                closeQuietly(db);
                rmSync(root, { recursive: true, force: true });
            }
        });
    }

    test("OpenCode 1 keeps reading message when session_message also exists", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "sidebar-work-metrics-v1-"));
        const previousDbPath = process.env.OPENCODE_DB;
        const host = new Database(join(root, "opencode.db"));
        const db = createTestDb();
        const sessionId = "ses-work-metrics-v1";
        try {
            closeReadOnlySessionDb();
            _resetHarnessForTesting();
            process.env.OPENCODE_DB = join(root, "opencode.db");
            host.exec(`
                CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
                CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
            `);
            host.prepare("INSERT INTO message VALUES ('v1', ?, 1, ?)").run(
                sessionId,
                JSON.stringify({
                    role: "assistant",
                    agent: "build",
                    tokens: { input: 100, output: 7, cache: { read: 20, write: 10 } },
                }),
            );
            host.prepare("INSERT INTO session_message VALUES ('v2', ?, 'assistant', 1, ?)").run(
                sessionId,
                JSON.stringify({ tokens: { input: 9999, output: 9999 } }),
            );

            expect(buildSidebarSnapshotRpcResponse(db, sessionId, process.cwd())).toMatchObject({
                newWorkTokens: 137,
                totalInputTokens: 130,
            });
        } finally {
            closeReadOnlySessionDb();
            _resetHarnessForTesting();
            if (previousDbPath === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previousDbPath;
            closeQuietly(host);
            closeQuietly(db);
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("buildSidebarSnapshot — stale build error state", () => {
    test("surfaces the persisted stale-build failure in the sidebar snapshot", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-stale-build";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_transform_error) VALUES (?, ?)",
            ).run(
                sessionId,
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd());

            expect(snapshot.lastTransformError).toBe(
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — persisted tail hygiene", () => {
    test("preserves zero-valued TypeScript baseline fields in the RPC payload", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-hygiene-zero";
            const live = createLiveSessionState();
            live.channel1StateBySession.set(sessionId, {
                baselineU: 0,
                baselineT: 0,
                turnDeltaU: 0,
                turnDeltaT: 0,
                usableWindow: 128_000,
                realUserTurnCount: 0,
                baselineGeneration: 0,
                computedAt: 0,
                evaluable: true,
                generationInvalidated: false,
                baselineParts: [],
                contentSignature: "empty",
                reducedSinceRefresh: false,
                oldestReclaimableToolTags: [],
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd(), live);

            expect(snapshot.tailHygiene).toEqual({
                u: 0,
                t: 0,
                severity: 0,
                evaluable: true,
                generationInvalidated: false,
                baselineGeneration: 0,
                computedAt: 0,
                reclaimableToolOutputCount: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — compartments served in m[1]", () => {
    test("counts compartments published since the last m[0] fold", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-m1-compartments";
            const m0History = "<session-history>\n</session-history>";
            const newCompartments =
                "<new-compartments>\n## 11-14 · Continued runtime inspection\nRead production, gear and ABI record code before implementing the plan.\n</new-compartments>";
            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 50000,
                last_context_percentage: 25,
                system_prompt_tokens: 5000,
                memory_block_cache: "",
                memory_block_count: 0,
                cached_m0_bytes: Buffer.from(m0History, "utf8"),
                cached_m1_bytes: Buffer.from(
                    `<session-history-since>\n${newCompartments}\n</session-history-since>`,
                    "utf8",
                ),
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd(), undefined, 4000);
            expect(snapshot.compartmentTokens).toBe(
                estimateTokens(m0History) + estimateTokens(newCompartments),
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — memory tokens fallback (bug #1)", () => {
    test("computes memoryTokens on-demand when memory_block_cache is empty but memory_block_count > 0", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-1";
            // Resolve a project identity that getMemoriesByProject will key on.
            // Using process.cwd() as the directory matches what the production
            // call site does (the RPC handler receives the user's directory).
            const directory = process.cwd();
            const projectIdentity = resolveProjectIdentity(directory);

            // Insert a few memories under this project so renderMemoryBlock has
            // real content to tokenize. Without these, the on-demand render
            // returns an empty block and tokens stay at 0.
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "USER_DIRECTIVES",
                content: "Always use Bun for builds",
                sourceSessionId: sessionId,
            });
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ENVIRONMENT",
                content:
                    "OpenCode source lives at ~/Work/OSS/opencode (cloned for cross-reference, not a workspace package).",
                sourceSessionId: sessionId,
            });

            // Seed session_meta with the regression-trigger shape:
            //   memory_block_cache = ''  (cleared by historian/recomp/etc.)
            //   memory_block_count > 0  (preserved across cache busts)
            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 50000,
                last_context_percentage: 25,
                system_prompt_tokens: 5000,
                memory_block_cache: "",
                memory_block_count: 2,
            });

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                directory,
                undefined,
                4000, // injection budget tokens, matching default config
            );

            // The bug: memoryTokens used to be 0 here because the fallback path
            // wasn't implemented. After the fix, it should be > 0 because we
            // render the memory block on-demand from the memories table.
            expect(snapshot.memoryBlockCount).toBe(2);
            expect(snapshot.memoryTokens).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("falls back to 0 when cache is empty AND memory_block_count is 0 (truly nothing to render)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-2";
            const directory = process.cwd();

            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 0,
                last_context_percentage: 0,
                system_prompt_tokens: 0,
                memory_block_cache: "",
                memory_block_count: 0,
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(0);
            expect(snapshot.memoryTokens).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("omits retired factCount from the RPC sidebar payload", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-no-fact-count";
            const directory = process.cwd();
            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 50000,
                last_context_percentage: 25,
                system_prompt_tokens: 5000,
                memory_block_cache: "",
                memory_block_count: 0,
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(Object.hasOwn(snapshot as object, "factCount")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("memory bucket measures the <project-memory> slice ACTUALLY in m[0] (v2 wire), not memory_block_cache", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-3";
            const directory = process.cwd();
            // m[0] carries the compact v2 category-grouped render.
            const m0 =
                "<session-history>\n</session-history>\n\n" +
                "<project-memory>\n<ARCHITECTURE>\n#1: a durable architectural fact about the system\n</ARCHITECTURE>\n</project-memory>";
            // memory_block_cache holds the LEGACY v1 shape — must be IGNORED for
            // the token bucket now (it under-counts the real injected cost).
            const v1Cache = "<project-memory>\n- a durable architectural fact\n</project-memory>";

            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 50000,
                last_context_percentage: 25,
                system_prompt_tokens: 5000,
                memory_block_cache: v1Cache,
                memory_block_count: 1,
                cached_m0_bytes: Buffer.from(m0, "utf8"),
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(1);
            // Tokens come from the actual m[0] v2 slice, not the stale cache.
            const v2SliceTokens = snapshot.memoryTokens;
            expect(v2SliceTokens).toBeGreaterThan(0);
            expect(
                estimateTokens(m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0] ?? ""),
            ).toBe(v2SliceTokens);
            expect(v2SliceTokens).not.toBe(estimateTokens(v1Cache));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — context limit", () => {
    test("keeps native full-window usage distinct from the reserved budget metric", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-native-full-window";
            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 120000,
                last_context_percentage: 80,
                system_prompt_tokens: 0,
                memory_block_cache: "",
                memory_block_count: 0,
            });
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "reserved-model": {
                                            limit: { context: 200_000, output: 64_000 },
                                        },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "reserved-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd(), live, 4000);

            // Output reserve is capped at 25%: 200K raw -> 150K safe input.
            expect(snapshot.contextLimit).toBe(150_000);
            expect(snapshot.usagePercentage).toBe(80);
            expect(snapshot.native_context_usage_percentage).toBe(60);
            expect(snapshot.native_context_usage_percentage).not.toBe(snapshot.usagePercentage);
        } finally {
            closeQuietly(db);
        }
    });

    test("populates contextLimit from the active session model", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-context-limit";
            const directory = process.cwd();
            seedSessionMeta(db, {
                session_id: sessionId,
                last_input_tokens: 80000,
                last_context_percentage: 40,
                system_prompt_tokens: 5000,
                memory_block_cache: "",
                memory_block_count: 0,
            });
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "test-model": { limit: { context: 200_000 } },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "test-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, live, 4000);

            expect(snapshot.contextLimit).toBe(200_000);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("compaction-off sidebar RPC data", () => {
    test("reports the resolved mode and raw native usage independently of threshold fill", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-native-sidebar";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_count
                ) VALUES (?, 63077, 97, 0, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Archived",
                        content: "Historical context retained for later expansion.",
                    },
                ],
                [],
            );

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                process.cwd(),
                undefined,
                4000,
                { execute_threshold_percentage: 65 },
                false,
            );
            const detail = buildStatusDetail(
                db,
                sessionId,
                process.cwd(),
                undefined,
                { execute_threshold_percentage: 65 },
                undefined,
                4000,
                false,
            );

            expect(snapshot.compaction_enabled).toBe(false);
            expect(detail.compaction_enabled).toBe(false);
            expect(snapshot.archivedCompartmentCount).toBe(1);

            const enabledDetail = buildStatusDetail(db, "ses-native-sidebar-on", process.cwd());
            expect(enabledDetail.compaction_enabled).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — history token reuse (council audit bg_51106601 #1)", () => {
    test("sets historyBlockTokens from compartmentTokens only (facts retired in v2)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-history-tokens";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, conversation_tokens
                ) VALUES (?, 50000, 25, 5000, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Setup",
                        content: "User configured the project and installed dependencies.",
                    },
                    {
                        sequence: 1,
                        startMessage: 5,
                        endMessage: 8,
                        startMessageId: "msg-5",
                        endMessageId: "msg-8",
                        title: "Implementation",
                        content: "Assistant implemented the requested performance fix.",
                    },
                ],
                [
                    { category: "preference", content: "Use Bun for plugin commands." },
                    { category: "environment", content: "The workspace is a git repository." },
                ],
            );

            const detail = buildStatusDetail(db, sessionId, directory);

            // v2: facts are retired as a render source (promoted to memories), so
            // factTokens is 0 and the history block is compartments only — facts
            // no longer contribute to rendered <session-history> bytes.
            expect(detail.compartmentTokens).toBeGreaterThan(0);
            expect(detail.factTokens).toBe(0);
            expect(detail.historyBlockTokens).toBe(detail.compartmentTokens);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — storage versions probe", () => {
    test("reports the live context.db schema version and the plugin fence", () => {
        const db = createTestDb();
        try {
            const detail = buildStatusDetail(db, "ses-storage-versions", process.cwd());

            // The probe must carry the live MAX(schema_migrations) value, not a
            // hardcoded one, plus this build's fence. A fully migrated test DB sits
            // exactly at the fence.
            expect(detail.storage_versions.context_db_schema_version).toBe(
                getPersistedSchemaVersion(db),
            );
            expect(detail.storage_versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(detail.storage_versions.context_db_schema_version).toBe(
                LATEST_SUPPORTED_VERSION,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("follows an older live DB version while the fence stays put", () => {
        const db = createTestDb();
        try {
            // Simulate a DB migrated by an older plugin: drop the recorded versions
            // above 50. The probe must follow the live value down.
            db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(50);

            const detail = buildStatusDetail(db, "ses-storage-versions-old", process.cwd());

            expect(detail.storage_versions.context_db_schema_version).toBe(50);
            expect(detail.storage_versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — mural read surface", () => {
    test("reads the graduated top-level mural config", () => {
        const db = createTestDb();
        try {
            const directory = process.cwd();
            const projectIdentity = resolveProjectIdentity(directory);
            upsertMural(db, {
                projectPath: projectIdentity,
                image: Buffer.from("png"),
                contentHash: "mural-content-hash",
                renderedAt: Date.now() - 1000,
                model: "deterministic",
                memoryIds: [1],
                width: 16,
                height: 8,
            });

            const detail = buildStatusDetail(db, "ses-mural-status", directory, undefined, {
                mural: { enabled: true },
            });

            expect(detail.mural?.present).toBe(true);
            expect(detail.mural?.ageMs).toBeGreaterThanOrEqual(1000);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — cacheNeverExpires with 'never' TTL", () => {
    test("sets cacheNeverExpires: true when cache_ttl is 'never'", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-never";
            const directory = process.cwd();

            // Force-create the session meta row so the UPDATE lands on an existing row.
            db.prepare(`INSERT INTO session_meta (session_id) VALUES (?)`).run(sessionId);
            // Seed last_response_time: the cacheNeverExpires branch only runs
            // inside `if (lastResponseTime > 0)` — without this the test would
            // pass even if Infinity leaked into cacheRemainingMs.
            db.prepare(
                "UPDATE session_meta SET cache_ttl = ?, last_response_time = ? WHERE session_id = ?",
            ).run("never", Date.now() - 60_000, sessionId);

            const detail = buildStatusDetail(db, sessionId, directory);

            expect(detail.cacheNeverExpires).toBe(true);
            expect(detail.cacheExpired).toBe(false);
            // Infinity must NOT leak into the numeric RPC field — JSON.stringify
            // converts Infinity to null, violating the StatusDetail contract.
            // -1 is the never-expires sentinel: distinguishable from 0 (expired)
            // by the value alone, so a consumer that never learned the flag cannot
            // misread a warm lane as expired.
            expect(detail.cacheRemainingMs).toBe(-1);
            expect(detail.cacheTtlMs).toBe(-1);
            const roundTripped = JSON.parse(JSON.stringify(detail));
            expect(roundTripped.cacheRemainingMs).toBe(-1);
            expect(roundTripped.cacheRemainingMs).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});

test("sidebar uses the host storage gate instead of reopening a refused database", async () => {
    let calls = 0;
    const handlers = registeredRpcMethods(false, () => {
        calls++;
        return null;
    });
    expect(await handlers.get("sidebar-snapshot")!({ sessionId: "blocked" })).toEqual({
        error: "unavailable",
    });
    expect(calls).toBe(1);
});
