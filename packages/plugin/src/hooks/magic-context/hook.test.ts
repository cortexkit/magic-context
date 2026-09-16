/// <reference types="bun-types" />
// Tests exercise server-side (Desktop) notification behavior — set OPENCODE_CLIENT
// to prevent the TUI toast path from intercepting sendIgnoredMessage calls.
process.env.OPENCODE_CLIENT = "desktop";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { ensureContextStoreUuid } from "../../features/magic-context/context-authority";
import { writeTaskScheduleState } from "../../features/magic-context/dreamer/storage-task-schedule";
import { insertMemory } from "../../features/magic-context/memory";
import type {
    EmbeddingProvider,
    EmbeddingPurpose,
} from "../../features/magic-context/memory/embedding-provider";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentity,
} from "../../features/magic-context/memory/project-identity";
import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    getEmbeddingCoverageStatus,
} from "../../features/magic-context/project-embedding-registry";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    setPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { autoEmbedAttemptedBySession, clearEmbedSessionState } from "./embed-session-state";
import { createMagicContextHook, type MagicContextDeps } from "./hook";
import { createLiveSessionState } from "./live-session-state";
import { closeReadOnlySessionDb } from "./read-session-db";
import { __ignoredNotificationTest } from "./send-session-notification";

// Command-routing units model an already idle host; lifecycle ordering has its own timeline regression.
beforeEach(() => __ignoredNotificationTest.setHoldDetector(() => false));

type PromptMocks = {
    prompt?: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
    createSession: ReturnType<typeof mock>;
    listMessages: ReturnType<typeof mock>;
    deleteSession: ReturnType<typeof mock>;
    showToast: ReturnType<typeof mock>;
};

class HookFakeEmbeddingProvider implements EmbeddingProvider {
    readonly modelId = "hook-fake-embedding-model";

    async initialize(): Promise<boolean> {
        return true;
    }

    async embed(text: string, _signal?: AbortSignal): Promise<Float32Array> {
        return new Float32Array([text.length, 1]);
    }

    async embedBatch(
        texts: string[],
        _signal?: AbortSignal,
        _purpose?: EmbeddingPurpose,
    ): Promise<Float32Array[]> {
        return texts.map((text) => new Float32Array([text.length, 1]));
    }

    async dispose(): Promise<void> {}

    isLoaded(): boolean {
        return true;
    }
}

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    __ignoredNotificationTest.reset();
    autoEmbedAttemptedBySession.clear();
    _resetProjectEmbeddingRegistryForTests();
    _setTestProviderFactoryForProject(null);
    __resetProjectIdentityForTests();
    __resetMessageIndexAsyncForTests();
    closeReadOnlySessionDb();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 100,
            });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function createPromptMocks(withSyncPrompt = true): PromptMocks {
    return {
        prompt: withSyncPrompt ? mock(() => undefined) : undefined,
        promptAsync: mock(async () => undefined),
        createSession: mock(async () => ({ data: { id: "dream-child" } })),
        listMessages: mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: Date.now() } },
                    parts: [{ type: "text", text: "dream complete" }],
                },
            ],
        })),
        deleteSession: mock(async () => ({ data: undefined })),
        showToast: mock(async () => undefined),
    };
}

function createMockDeps(promptMocks: PromptMocks = createPromptMocks()): MagicContextDeps {
    const tagger: Tagger = {
        assignTag: mock(() => 1),
        bindTag: mock(() => {}),
        getTag: mock(() => undefined),
        getAssignments: mock(() => new Map()),
        resetCounter: mock(() => {}),
        getCounter: mock(() => 0),
        initFromDb: mock(() => {}),
        cleanup: mock(() => {}),
    };

    const scheduler: Scheduler = {
        shouldExecute: mock(() => "defer" as const),
    };

    const compactionHandler = {
        onCompacted: mock(() => {}),
    };

    return {
        client: {
            session: {
                create: promptMocks.createSession,
                ...(promptMocks.prompt ? { prompt: promptMocks.prompt } : {}),
                promptAsync: promptMocks.promptAsync,
                messages: promptMocks.listMessages,
                delete: promptMocks.deleteSession,
            },
            tui: {
                showToast: promptMocks.showToast,
            },
        } as unknown as MagicContextDeps["client"],
        tagger,
        scheduler,
        compactionHandler,
        directory: "/tmp",
        config: { protected_tokens: 4_000, cache_ttl: "5m" },
    };
}

function requireHook(
    hook: ReturnType<typeof createMagicContextHook>,
): NonNullable<ReturnType<typeof createMagicContextHook>> {
    expect(hook).not.toBeNull();
    return hook!;
}

async function expectSentinel(promise: Promise<unknown>, sentinel: string): Promise<void> {
    try {
        await promise;
        throw new Error(`Expected sentinel ${sentinel}`);
    } catch (error) {
        expect(String(error)).toContain(sentinel);
    }
}

function createOpenCodeDbForHook(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
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
                    sessionID: sessionId,
                }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        db.close();
    }
}

function countIndexedHookMessage(sessionId: string, messageId: string): number {
    const row = openDatabase()
        .prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, messageId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

describe("magic-context hook", () => {
    it("constructs with directory fallback when load-time identity resolution throws", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-identity-fallback-data-");
        const projectDir = makeTempDir("hook-identity-fallback-project-");
        mkdirSync(join(projectDir, ".git"));
        __setProjectIdentityTestHooks({
            execFileSync: mock(() => {
                const error = new Error("permission denied") as Error & {
                    code?: string;
                };
                error.code = "EACCES";
                throw error;
            }) as unknown as typeof execFileSync,
        });
        const deps = createMockDeps();
        deps.directory = projectDir;

        expect(createMagicContextHook(deps)).not.toBeNull();
    });

    it("constructs and resolves a project when sandbox policy denies realpath for the home directory", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-realpath-sandbox-data-");
        const projectDir = makeTempDir("hook-realpath-sandbox-project-");
        const deniedHome = makeTempDir("hook-realpath-sandbox-home-");
        const originalNative = realpathSync.native;
        const permissionDenied = new Error("sandbox denied realpath") as NodeJS.ErrnoException;
        permissionDenied.code = "EPERM";
        __setProjectIdentityTestHooks({ homeDirectory: () => deniedHome });
        Object.defineProperty(realpathSync, "native", {
            configurable: true,
            value: (() => {
                throw permissionDenied;
            }) as typeof realpathSync.native,
        });
        const deps = createMockDeps();
        deps.directory = projectDir;

        try {
            expect(createMagicContextHook(deps)).not.toBeNull();
            expect(resolveProjectIdentity(projectDir)).toMatch(/^dir:[0-9a-f]{12}$/);
        } finally {
            Object.defineProperty(realpathSync, "native", {
                configurable: true,
                value: originalNative,
            });
        }
    });

    it("rehydrates pending marker sessions into both deferred signal sets", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-marker-rehydrate-");
        const db = openDatabase();
        const sessionId = "ses-marker-rehydrate";
        setPendingCompactionMarkerState(db, sessionId, {
            endMessageId: "msg-2",
            ordinal: 2,
            publishedAt: 1,
        });
        const liveSessionState = createLiveSessionState();
        const deps = createMockDeps();
        deps.liveSessionState = liveSessionState;

        expect(createMagicContextHook(deps)).not.toBeNull();

        expect(liveSessionState.deferredHistoryRefreshSessions.has(sessionId)).toBe(true);
        expect(liveSessionState.deferredMaterializationSessions.has(sessionId)).toBe(true);
    });

    it("indexes terminal message.updated events asynchronously", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-message-index-");
        createOpenCodeDbForHook("ses-index", [
            { id: "u-1", role: "user", text: "index user text" },
            { id: "a-1", role: "assistant", text: "index assistant text" },
        ]);
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: { id: "u-1", role: "user", sessionID: "ses-index" },
                },
            },
        });
        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "a-1",
                        role: "assistant",
                        sessionID: "ses-index",
                        time: { completed: Date.now() },
                    },
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 140));

        expect(countIndexedHookMessage("ses-index", "u-1")).toBe(1);
        expect(countIndexedHookMessage("ses-index", "a-1")).toBe(1);

        createOpenCodeDbForHook("ses-index", [
            { id: "a-streaming", role: "assistant", text: "not terminal yet" },
        ]);
        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        id: "a-streaming",
                        role: "assistant",
                        sessionID: "ses-index",
                    },
                },
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 140));

        expect(countIndexedHookMessage("ses-index", "a-streaming")).toBe(0);
    });

    it("returns the expected hook keys", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-test-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        expect("experimental.chat.messages.transform" in hook).toBe(true);
        expect("experimental.text.complete" in hook).toBe(true);
        expect(hook).toHaveProperty("event");
        expect("command.execute.before" in hook).toBe(true);
    });

    it("returns functions for every hook entry", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-fns-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        expect(typeof hook["experimental.chat.messages.transform"]).toBe("function");
        expect(typeof hook["experimental.text.complete"]).toBe("function");
        expect(typeof hook.event).toBe("function");
        expect(typeof hook["command.execute.before"]).toBe("function");
        expect(typeof hook["tool.execute.after"]).toBe("function");
    });

    it("threads historian.disable over child reconciliation while retaining stored child history", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-disabled-child-reconciliation-");
        const prompts = createPromptMocks();
        const deps = createMockDeps(prompts);
        deps.config = {
            ...deps.config,
            historian: { disable: true, subagent_reconciliation: true },
        };
        const hook = requireHook(createMagicContextHook(deps));
        const db = openDatabase();
        const sessionId = "ses-hook-disabled-child-reconciliation";
        updateSessionMeta(db, sessionId, { isSubagent: true });
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "covered-child",
                endMessageId: "covered-child",
                title: "Retained child history",
                content: "stored child summary",
            },
        ]);
        const messages = [
            {
                info: {
                    id: "covered-child",
                    role: "user",
                    sessionID: sessionId,
                },
                parts: [{ type: "text", text: "covered child request" }],
            },
            {
                info: { id: "child-tail", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "live child tail" }],
            },
        ];

        await hook["experimental.chat.messages.transform"]!({}, { messages });

        expect(JSON.stringify(messages)).toContain("Retained child history");
        expect(JSON.stringify(messages)).not.toContain("covered child request");
        expect(JSON.stringify(messages)).toContain("live child tail");
        expect(prompts.createSession).not.toHaveBeenCalled();
        expect(prompts.promptAsync).not.toHaveBeenCalled();
    });

    it("intercepts a Desktop slashless status command before an LLM completion", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-stripped-status-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));
        let persistedCommandRows = 0;
        let llmCompletions = 0;

        const promptPipeline = async () => {
            await hook["chat.message"]!(
                {
                    sessionID: "ses-stripped-status",
                    agent: "build",
                    model: { providerID: "anthropic", modelID: "claude" },
                    variant: "high",
                },
                {
                    message: {} as never,
                    parts: [{ type: "text", text: "ctx-status" } as never],
                },
            );
            persistedCommandRows += 1;
            llmCompletions += 1;
        };

        await expectSentinel(promptPipeline(), "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");

        expect(persistedCommandRows).toBe(0);
        expect(llmCompletions).toBe(0);
        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const notification = promptMocks.prompt?.mock.calls[0]?.[0] as {
            body?: {
                noReply?: boolean;
                parts?: Array<{ text?: string; ignored?: boolean }>;
            };
        };
        expect(notification.body?.noReply).toBe(true);
        expect(notification.body?.parts?.[0]?.ignored).toBe(true);
        expect(notification.body?.parts?.[0]?.text).toContain("## Magic Context Status");
    });

    it("keeps the native slash-command path unchanged", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-native-status-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expectSentinel(
            hook["command.execute.before"]!(
                {
                    command: "ctx-status",
                    sessionID: "ses-native-status",
                    arguments: "",
                },
                { parts: [] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const notification = promptMocks.prompt?.mock.calls[0]?.[0] as {
            body?: { noReply?: boolean; parts?: Array<{ ignored?: boolean }> };
        };
        expect(notification.body?.noReply).toBe(true);
        expect(notification.body?.parts?.[0]?.ignored).toBe(true);
    });

    it("silently embeds seven compartments on idle and latches subsequent drains", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-auto-embed-data-");
        const projectDir = makeTempDir("hook-auto-embed-project-");
        mkdirSync(join(projectDir, ".cortexkit"));
        writeFileSync(
            join(projectDir, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                embedding: { provider: "local", model: "hook-fake-embedding-model" },
                memory: { enabled: true },
            }),
        );
        const provider = new HookFakeEmbeddingProvider();
        const embedBatch = mock(provider.embedBatch.bind(provider));
        provider.embedBatch = embedBatch;
        _setTestProviderFactoryForProject(() => provider);
        const prompts = createPromptMocks();
        const hostDb = new Database(":memory:");
        hostDb.exec("CREATE TABLE message (role TEXT, data TEXT)");
        const appendUserRow = (input: unknown) => {
            hostDb
                .prepare("INSERT INTO message (role, data) VALUES ('user', ?)")
                .run(JSON.stringify(input));
        };
        prompts.prompt = mock(appendUserRow);
        prompts.promptAsync = mock(async (input: unknown) => appendUserRow(input));
        const userRows = () => hostDb.prepare("SELECT * FROM message WHERE role = 'user'").all();
        const deps = createMockDeps(prompts);
        deps.directory = projectDir;
        const hook = requireHook(createMagicContextHook(deps));
        const db = openDatabase();
        const sessionId = "ses-hook-auto-embed";
        const projectIdentity = resolveProjectIdentity(projectDir);
        recordSessionProjectIdentity(db, sessionId, projectIdentity);
        const runTransform = async () => {
            const messages = [
                {
                    info: { id: "u1", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "hello" }],
                },
            ];
            await hook["experimental.chat.messages.transform"]!({}, { messages });
        };
        const waitUntil = async (predicate: () => boolean): Promise<void> => {
            const deadline = Date.now() + 3_000;
            while (!predicate() && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(predicate()).toBe(true);
        };

        try {
            await runTransform();
            await waitUntil(() => !autoEmbedAttemptedBySession.has(sessionId));

            for (let i = 1; i <= 7; i++) {
                appendCompartments(db, sessionId, [
                    {
                        sequence: i - 1,
                        startMessage: i,
                        endMessage: i,
                        startMessageId: `u${i}`,
                        endMessageId: `u${i}`,
                        title: `Compartment ${i}`,
                        content: `Content ${i}`,
                        p1: `Content ${i}`,
                    },
                ]);
                db.prepare(
                    "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
                ).run(sessionId, i, `u${i}`, "user", `Source text ${i}`);
            }

            await runTransform();
            await waitUntil(() => {
                const coverage = getEmbeddingCoverageStatus(db, projectIdentity, sessionId);
                return (
                    coverage.session.total === 7 &&
                    coverage.session.embedded === 7 &&
                    autoEmbedAttemptedBySession.has(sessionId)
                );
            });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(userRows()).toEqual([]);
            expect(prompts.prompt).not.toHaveBeenCalled();
            expect(prompts.promptAsync).not.toHaveBeenCalled();
            const calls = embedBatch.mock.calls.length;
            expect(calls).toBeGreaterThan(0);
            // Leave new work eligible: without the latch a second transform would drain it.
            appendCompartments(db, sessionId, [
                {
                    sequence: 7,
                    startMessage: 8,
                    endMessage: 8,
                    startMessageId: "u8",
                    endMessageId: "u8",
                    title: "Later",
                    content: "Later",
                    p1: "Later",
                },
            ]);
            db.prepare(
                "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
            ).run(sessionId, 8, "u8", "user", "Later source text");
            await runTransform();
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(embedBatch.mock.calls.length).toBe(calls);
            expect(getEmbeddingCoverageStatus(db, projectIdentity, sessionId).session).toEqual({
                total: 8,
                embedded: 7,
            });
            expect(userRows()).toEqual([]);
        } finally {
            clearEmbedSessionState(sessionId);
            hostDb.close();
        }
    });

    it("initializes the dream queue table during setup", () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-queue-init-");
        requireHook(createMagicContextHook(createMockDeps()));
        const db = openDatabase();

        const table = db
            .prepare<[], { name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dream_queue'",
            )
            .get();

        expect(table?.name).toBe("dream_queue");
    });

    it("disables magic-context and warns when persistent storage is unavailable", () => {
        const dataHome = makeTempDir("hook-storage-disabled-");
        process.env.XDG_DATA_HOME = dataHome;
        // Block mkdirSync at the cortexkit segment of the new shared path so
        // openDatabase() falls into its in-memory fallback. (Plugin v0.16+
        // moved DB to <XDG_DATA_HOME>/cortexkit/magic-context/.)
        writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

        const promptMocks = createPromptMocks();
        const hook = createMagicContextHook(createMockDeps(promptMocks));

        expect(hook).toBeNull();
        expect(promptMocks.showToast).toHaveBeenCalledTimes(1);
        expect(promptMocks.showToast.mock.calls[0]?.[0]).toEqual({
            body: expect.objectContaining({
                title: "Magic Context Disabled",
                message: expect.stringContaining("Persistent storage is unavailable"),
                variant: "warning",
            }),
        });
    });

    it("sends a notification for ctx-status and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-notification-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-status" },
                body: expect.objectContaining({
                    noReply: true,
                    parts: [
                        {
                            type: "text",
                            text: expect.stringContaining("## Magic Context Status"),
                            ignored: true,
                        },
                    ],
                }),
            }),
        );
    });

    it("preserves live model and variant when ignored notifications fall back to promptAsync", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-promptasync-live-selection-");
        const promptMocks = createPromptMocks(false);
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await hook["chat.message"]!({
            sessionID: "ses-status-async",
            variant: "thinking",
        });
        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-status-async",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 40_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-status", sessionID: "ses-status-async", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        expect(promptMocks.prompt).toBeUndefined();
        expect(promptMocks.promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.promptAsync.mock.calls[0]?.[0] as {
            body?: Record<string, unknown>;
        };
        expect(callArg.body?.model).toEqual({
            providerID: "openai",
            modelID: "gpt-4o",
        });
        expect(callArg.body?.variant).toBe("thinking");
    });

    it("does not forward stale model selection when sending ctx-status notification", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-status-no-model-reset-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expectSentinel(
            hook["command.execute.before"]!(
                {
                    command: "ctx-status",
                    sessionID: "ses-status-model",
                    arguments: "",
                    agent: "oracle",
                    variant: "fast",
                    providerID: "anthropic",
                    modelID: "claude-sonnet-4-6",
                },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as {
            body?: Record<string, unknown>;
        };
        expect(callArg.body).toBeDefined();
        expect(callArg.body?.agent).toBeUndefined();
        expect(callArg.body?.variant).toBeUndefined();
        expect(callArg.body?.model).toBeUndefined();
    });

    it("sends a notification for ctx-flush and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-flush-notification-");
        const promptMocks = createPromptMocks();
        const hook = requireHook(createMagicContextHook(createMockDeps(promptMocks)));

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-flush", sessionID: "ses-flush", arguments: "" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
        );

        expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
        const callArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(callArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-flush" },
                body: expect.objectContaining({
                    noReply: true,
                    parts: [
                        {
                            type: "text",
                            text: expect.stringContaining("No pending operations to flush."),
                            ignored: true,
                        },
                    ],
                }),
            }),
        );
    });

    it("sends dream notifications for ctx-dream and throws the sentinel", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-notification-");
        const promptMocks = createPromptMocks();
        const deps = createMockDeps(promptMocks);
        // Dreamer v2 per-task shape. Force a single AGENTIC task via
        // `/ctx-dream curate` so the run is deterministic and goes through the
        // generic dreamer-agent child-session path this test asserts. (verify now
        // has its own non-agentic manifest runner — covered by verify.test.)
        deps.config = {
            ...deps.config,
            dreamer: {
                inject_docs: true,
                tasks: {
                    curate: { schedule: "0 3 * * *", timeout_minutes: 10 },
                    verify: { schedule: "", timeout_minutes: 10 },
                    "maintain-docs": { schedule: "", timeout_minutes: 10 },
                    "evaluate-smart-notes": { schedule: "", timeout_minutes: 10 },
                    "review-user-memories": { schedule: "", timeout_minutes: 10 },
                },
            },
        };
        const hook = requireHook(createMagicContextHook(deps));
        const db = openDatabase();
        const projectPath = resolveProjectIdentity("/tmp");
        db.prepare(
            "INSERT INTO memories (project_path, category, content, normalized_hash, source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at, superseded_by_memory_id, merged_from, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            projectPath,
            "CONFIG_VALUES",
            "Dream me",
            "dream-me-notification",
            "ses-seed",
            "historian",
            1,
            0,
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now(),
            null,
            "active",
            null,
            "unverified",
            null,
            null,
            null,
            null,
        );

        await expectSentinel(
            hook["command.execute.before"]!(
                { command: "ctx-dream", sessionID: "ses-dream", arguments: "curate" },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
        );

        expect(promptMocks.prompt).toHaveBeenCalledTimes(3);
        expect(promptMocks.createSession).toHaveBeenCalledTimes(1);
        expect(promptMocks.deleteSession).toHaveBeenCalledTimes(1); // resolved prompt is safe to retire inline
        const firstCallArg = promptMocks.prompt?.mock.calls[0]?.[0] as Record<string, unknown>;
        const secondCallArg = promptMocks.prompt?.mock.calls[1]?.[0] as Record<string, unknown>;
        const thirdCallArg = promptMocks.prompt?.mock.calls[2]?.[0] as Record<string, unknown>;
        expect(firstCallArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-dream" },
                body: expect.objectContaining({
                    parts: expect.arrayContaining([
                        expect.objectContaining({
                            text: expect.stringContaining("Backlog before starting:"),
                        }),
                    ]),
                }),
            }),
        );
        expect(secondCallArg).toEqual(
            expect.objectContaining({
                path: { id: "dream-child" },
                query: { directory: "/tmp" },
                body: expect.objectContaining({
                    agent: "dreamer",
                    system: expect.stringContaining("memory-pool curator"),
                    parts: expect.arrayContaining([
                        expect.objectContaining({
                            text: expect.stringContaining("## Task: Curate Project Memory Pool"),
                        }),
                    ]),
                }),
            }),
        );
        expect(thirdCallArg).toEqual(
            expect.objectContaining({
                path: { id: "ses-dream" },
                body: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            text: expect.stringContaining("## /ctx-dream"),
                        }),
                    ],
                }),
            }),
        );
    });

    it("routes manual classify through MODULE before any transform has run", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-classify-module-manual-");
        const promptMocks = createPromptMocks();
        const deps = createMockDeps(promptMocks);
        const projectPath = resolveProjectIdentity("/tmp");
        deps.config = {
            ...deps.config,
            transform_mode: "rust",
            dreamer: {
                tasks: {
                    "classify-memories": {
                        schedule: "0 3 * * *",
                        timeout_minutes: 10,
                    },
                },
            },
        } as never;

        class StatefulModuleClient {
            private readonly instanceState = "hook-transport";
            readonly methods: string[] = [];

            async authorityStatus() {
                if (this.instanceState !== "hook-transport") throw new Error("lost transport this");
                return { authority: { state: "MODULE", generation: 4 } };
            }

            async call(args: { method: string; body: unknown }) {
                if (this.instanceState !== "hook-transport") throw new Error("lost transport this");
                this.methods.push(args.method);
                if (args.method === "dreamer.run_task") {
                    const body = args.body as {
                        payload: { items: Array<{ memory_id: number }> };
                    };
                    return {
                        manifest_text: `<classify>${body.payload.items
                            .map(
                                ({ memory_id }) =>
                                    `<memory id="${memory_id}" importance="75" scope="project" shareable="false"/>`,
                            )
                            .join("")}</classify>`,
                        truncated: false,
                    };
                }
                return {
                    accepted: (
                        args.body as { arguments: { rows: Array<{ memory_id: number }> } }
                    ).arguments.rows.map((row) => row.memory_id),
                    rejected: [],
                };
            }
        }
        const moduleClient = new StatefulModuleClient();
        deps.rustModeModuleClient = moduleClient as never;
        const hook = requireHook(createMagicContextHook(deps));
        const db = openDatabase();
        ensureContextStoreUuid(db);
        const memories = [];
        for (let i = 0; i < 12; i += 1) {
            memories.push(
                insertMemory(db, {
                    projectPath,
                    category: "ARCHITECTURE",
                    content: `Manual classify memory ${i}.`,
                }),
            );
        }
        for (const [index, memory] of memories.entries()) {
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(projectPath, 12000 + index, memory.id);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, ?, ?)",
            ).run(projectPath, 12000 + index, memory.category, memory.normalizedHash);
        }

        await expectSentinel(
            hook["command.execute.before"]!(
                {
                    command: "ctx-dream",
                    sessionID: "ses-classify-module-manual",
                    arguments: "classify-memories",
                },
                { parts: [{ type: "text", text: "" }] },
            ),
            "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
        );

        expect(moduleClient.methods).toEqual(["dreamer.run_task", "memory.set_classification"]);
        expect(promptMocks.createSession).not.toHaveBeenCalled();
    });

    it("checks the dream schedule in the background after message updates", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-dream-schedule-");
        const promptMocks = createPromptMocks();
        const deps = createMockDeps(promptMocks);
        deps.directory = "/repo/project";
        deps.config = {
            ...deps.config,
            dreamer: {
                inject_docs: true,
                tasks: {
                    // Use an AGENTIC task (curate) so the scheduler→executor wiring
                    // drives the generic dreamer child-session path this test counts.
                    // (verify now has its own non-agentic manifest runner.)
                    curate: { schedule: "0 3 * * *", timeout_minutes: 10 },
                    verify: { schedule: "", timeout_minutes: 10 },
                    "maintain-docs": { schedule: "", timeout_minutes: 10 },
                    "evaluate-smart-notes": { schedule: "", timeout_minutes: 10 },
                    "review-user-memories": { schedule: "", timeout_minutes: 10 },
                },
            },
        };
        const originalDateNow = Date.now;
        Date.now = () => originalDateNow() + 2 * 60 * 60 * 1000;

        try {
            const hook = requireHook(createMagicContextHook(deps));
            const db = openDatabase();
            const projectPath = resolveProjectIdentity("/repo/project");
            const now = Date.now();
            // Dreamer v2: a freshly-seeded task is NOT due until its next cron
            // time. Pre-seed curate's schedule row as DUE (next_due_at in the
            // past) so the background trigger actually runs it this pass.
            writeTaskScheduleState(db, {
                projectPath,
                task: "curate",
                lastRunAt: null,
                nextDueAt: now - 1000,
                schedule: "0 3 * * *",
                lastStatus: null,
                lastError: null,
                retryCount: 0,
            });

            db.prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, source_session_id, source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at, last_seen_at, last_retrieved_at, status, expires_at, verification_status, verified_at, superseded_by_memory_id, merged_from, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
                projectPath,
                "ARCHITECTURE_DECISIONS",
                "Dream me",
                "dream-me",
                "ses-seed",
                "historian",
                1,
                0,
                now,
                now,
                now,
                now,
                null,
                "active",
                null,
                "unverified",
                null,
                null,
                null,
                null,
            );

            await hook.event!({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            role: "assistant",
                            finish: "stop",
                            sessionID: "ses-dream-schedule",
                            providerID: "openai",
                            modelID: "gpt-4o",
                            tokens: {
                                input: 10,
                                output: 10,
                                cache: { read: 0, write: 0 },
                            },
                        },
                    },
                },
            });

            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(promptMocks.createSession).toHaveBeenCalledTimes(1);
            expect(promptMocks.deleteSession).toHaveBeenCalledTimes(1); // resolved prompt is safe to retire inline
        } finally {
            Date.now = originalDateNow;
        }
    });

    it("clears the reasoning watermark when message.updated reports a model change", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("hook-model-change-watermark-");
        const hook = requireHook(createMagicContextHook(createMockDeps()));

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-model-change",
                        providerID: "openai",
                        modelID: "gpt-4o",
                        tokens: {
                            input: 20_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        updateSessionMeta(openDatabase(), "ses-model-change", {
            clearedReasoningThroughTag: 7,
            observedSafeInputTokens: 20_000,
            cacheAlertSent: true,
        });

        await hook.event!({
            event: {
                type: "message.updated",
                properties: {
                    info: {
                        role: "assistant",
                        finish: "stop",
                        sessionID: "ses-model-change",
                        providerID: "opencode-go",
                        modelID: "kimi-k2.6",
                        tokens: {
                            input: 25_000,
                            output: 10,
                            cache: { read: 0, write: 0 },
                        },
                    },
                },
            },
        });

        const meta = getOrCreateSessionMeta(openDatabase(), "ses-model-change");
        expect(meta.clearedReasoningThroughTag).toBe(0);
        expect(meta.observedSafeInputTokens).toBe(0);
        expect(meta.cacheAlertSent).toBe(false);
    });
});

it("the event hook flushes notices on session.idle, never on a terminal assistant update", async () => {
    __ignoredNotificationTest.reset();
    process.env.XDG_DATA_HOME = makeTempDir("hook-notice-idle-");
    const promptMocks = createPromptMocks();
    const deps = createMockDeps(promptMocks);
    const hook = requireHook(createMagicContextHook(deps));
    const sessionID = "ses-hook-notice-idle";
    await hook.event!({
        event: {
            type: "message.updated",
            properties: {
                info: {
                    id: "done",
                    sessionID,
                    role: "assistant",
                    finish: "stop",
                    time: { created: 1, completed: 2 },
                },
            },
        },
    } as never);
    const { sendIgnoredMessage } = await import("./send-session-notification");
    expect(
        await sendIgnoredMessage(deps.client, sessionID, "⏳ Context at 95%", {
            agent: "build",
            variant: "high",
            providerId: "local",
            modelId: "27B",
        }),
    ).toBe("queued");
    expect(promptMocks.prompt).not.toHaveBeenCalled();
    await hook.event!({
        event: { type: "session.idle", properties: { sessionID } },
    } as never);
    expect(promptMocks.prompt).toHaveBeenCalledTimes(1);
});
