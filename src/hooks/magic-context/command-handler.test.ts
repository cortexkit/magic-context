/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ensureDreamQueueTable } from "../../features/magic-context/dreamer/queue";
import { createMagicContextCommandHandler } from "./command-handler";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      system_prompt_hash INTEGER DEFAULT 0
    );
  `);
    ensureDreamQueueTable(db);
    return db;
}

function insertTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
    byteSize: number,
    status = "active",
): void {
    db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, `msg-${tagNumber}`, "message", status, byteSize, tagNumber);
}

function insertPendingOp(db: Database, sessionId: string, tagId: number): void {
    db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)",
    ).run(sessionId, tagId, Date.now());
}

function insertSessionMeta(
    db: Database,
    sessionId: string,
    opts: {
        cacheTtl?: string;
        counter?: number;
        lastNudgeTokens?: number;
        lastResponseTime?: number;
    } = {},
): void {
    db.prepare(
        "INSERT OR REPLACE INTO session_meta (session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, times_execute_threshold_reached, compartment_in_progress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        sessionId,
        opts.lastResponseTime ?? 0,
        opts.cacheTtl ?? "5m",
        opts.counter ?? 0,
        opts.lastNudgeTokens ?? 0,
        "",
        "",
        0,
        0,
        0,
        0,
        0,
    );
}

function getPendingOpsCount(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?")
        .get(sessionId) as { count: number };
    return row.count;
}

function getTagStatus(db: Database, sessionId: string, tagNumber: number): string {
    const row = db
        .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ?")
        .get(sessionId, tagNumber) as { status: string };
    return row.status;
}

function getStickyTurnReminder(db: Database, sessionId: string): string {
    const row = db
        .prepare("SELECT sticky_turn_reminder_text AS text FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { text: string } | null;
    return row?.text ?? "";
}

function makeOutput(text: string) {
    return { parts: [{ type: "text", text }] };
}

async function expectSentinel(promise: Promise<unknown>, sentinel: string): Promise<void> {
    try {
        await promise;
        throw new Error(`Expected sentinel ${sentinel}`);
    } catch (error) {
        expect(String(error)).toContain(sentinel);
    }
}

describe("createMagicContextCommandHandler", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("ignores unrelated commands", async () => {
        const sendNotification = mock(async () => {});
        const handler = createMagicContextCommandHandler({
            db,
            protectedTags: 3,
            sendNotification,
        });

        await handler["command.execute.before"](
            { command: "something-else", sessionID: "ses-noop", arguments: "" },
            makeOutput(""),
            {},
        );

        expect(sendNotification).not.toHaveBeenCalled();
    });

    describe("ctx-flush", () => {
        it("reports an empty queue", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-flush", sessionID: "ses-empty", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-empty",
                expect.stringContaining("No pending operations to flush."),
                {},
            );
        });

        it("drops queued tags and clears the queue", async () => {
            insertTag(db, "ses-flush", 1, 500);
            insertTag(db, "ses-flush", 2, 300);
            insertPendingOp(db, "ses-flush", 1);
            insertPendingOp(db, "ses-flush", 2);
            db.prepare(
                "INSERT INTO session_meta (session_id, sticky_turn_reminder_text) VALUES (?, ?)",
            ).run("ses-flush", "\n[sticky reminder]");
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-flush", sessionID: "ses-flush", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-flush",
                expect.stringContaining("2 dropped"),
                {},
            );
            expect(getPendingOpsCount(db, "ses-flush")).toBe(0);
            expect(getTagStatus(db, "ses-flush", 1)).toBe("dropped");
            expect(getTagStatus(db, "ses-flush", 2)).toBe("dropped");
            expect(getStickyTurnReminder(db, "ses-flush")).toBe("");
        });
    });

    describe("ctx-status", () => {
        it("returns the expected sections for a populated session", async () => {
            insertTag(db, "ses-status", 1, 1024);
            insertTag(db, "ses-status", 2, 512, "dropped");
            insertPendingOp(db, "ses-status", 3);
            insertTag(db, "ses-status", 3, 100);
            insertSessionMeta(db, "ses-status", {
                cacheTtl: "10m",
                counter: 3,
                lastNudgeTokens: 80_000,
            });
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 5,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-status", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            const calls = sendNotification.mock.calls as unknown as Array<
                [string, string, unknown]
            >;
            const [, text] = calls[0]!;
            expect(text).toContain("## Magic Status");
            expect(text).toContain("### Tags");
            expect(text).toContain("### Pending Queue");
            expect(text).toContain("### Cache TTL");
            expect(text).toContain("### Rolling Nudges");
            expect(text).toContain("- Active: 2");
            expect(text).toContain("- Dropped: 1");
            expect(text).toContain("- Drops: 1");
            expect(text).toContain("Rolling anchor: 80,000 tokens");
            expect(text).toContain("Effective interval: 10,000 tokens");
            expect(text).toContain("**Protected tags:** 5");
        });

        it("lists queued drop operations", async () => {
            insertTag(db, "ses-status-ops", 10, 300);
            insertPendingOp(db, "ses-status-ops", 10);
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-status-ops", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            const calls = sendNotification.mock.calls as unknown as Array<
                [string, string, unknown]
            >;
            const [, text] = calls[0]!;
            expect(text).toContain("### Queued Operations");
            expect(text).toContain("§10§ → drop");
            expect(text).toContain("- Drops: 1");
        });

        it("returns defaults for an empty session", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 2,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-empty-status", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            const calls = sendNotification.mock.calls as unknown as Array<
                [string, string, unknown]
            >;
            const [, text] = calls[0]!;
            expect(text).toContain("- Active: 0");
            expect(text).toContain("- Dropped: 0");
            expect(text).toContain("- Total queued: 0");
            expect(text).toContain("**Protected tags:** 2");
        });
    });

    describe("ctx-recomp", () => {
        it("sends start and completion notifications around recomp and throws the sentinel", async () => {
            const sendNotification = mock(async () => {});
            const executeRecomp = mock(async () => "## Magic Recomp\n\nRebuilt state.");
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                executeRecomp,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-recomp", sessionID: "ses-recomp", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            expect(executeRecomp).toHaveBeenCalledWith("ses-recomp");
            expect(sendNotification).toHaveBeenCalledTimes(2);
            expect(sendNotification).toHaveBeenNthCalledWith(
                1,
                "ses-recomp",
                expect.stringContaining("Historian recomp started"),
                {},
            );
            expect(sendNotification).toHaveBeenNthCalledWith(
                2,
                "ses-recomp",
                expect.stringContaining("## Magic Recomp"),
                {},
            );
        });
    });

    describe("ctx-dream", () => {
        it("starts a dream run, sends summary, and throws the sentinel", async () => {
            const sendNotification = mock(async () => {});
            const executeDream = mock(async () => ({
                startedAt: 1,
                finishedAt: 2,
                holderId: "dream-holder",
                tasks: [
                    {
                        name: "consolidate",
                        durationMs: 500,
                        result: "merged duplicates",
                    },
                ],
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                dreamer: {
                    config: {
                        enabled: true,
                        schedule: "02:00-06:00",
                        max_runtime_minutes: 60,
                        tasks: ["consolidate"],
                        task_timeout_minutes: 10,
                    },
                    projectPath: "/repo/project",
                    client: {},
                    directory: "/repo/project",
                    executeDream,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            expect(executeDream).toHaveBeenCalledWith("ses-dream");
            expect(sendNotification).toHaveBeenNthCalledWith(
                1,
                "ses-dream",
                "Starting dream run...",
                {},
            );
            expect(sendNotification).toHaveBeenNthCalledWith(
                2,
                "ses-dream",
                expect.stringContaining("### Tasks"),
                {},
            );
        });

        it("notifies when the project is already queued", async () => {
            const sendNotification = mock(async () => {});
            const executeDream = mock(async () => null);
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                dreamer: {
                    config: {
                        enabled: true,
                        schedule: "02:00-06:00",
                        max_runtime_minutes: 60,
                        tasks: ["consolidate"],
                        task_timeout_minutes: 10,
                    },
                    projectPath: "/repo/project",
                    client: {},
                    directory: "/repo/project",
                    executeDream,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            expect(sendNotification).toHaveBeenNthCalledWith(
                3,
                "ses-dream",
                "Dream already queued for this project",
                {},
            );
            expect(executeDream).toHaveBeenCalledTimes(1);
        });
    });

    describe("ctx-aug", () => {
        it("runs sidekick in a child session and sends the augmented prompt", async () => {
            const sendNotification = mock(async () => {});
            const client = {
                session: {
                    create: mock(async () => ({ data: { id: "sidekick-child" } })),
                    prompt: mock(async () => undefined),
                    promptAsync: mock(async () => undefined),
                    messages: mock(async () => ({
                        data: [
                            {
                                info: { role: "assistant", time: { created: Date.now() } },
                                parts: [{ type: "text", text: "Use Bun for commands" }],
                            },
                        ],
                    })),
                    delete: mock(async () => ({ data: undefined })),
                },
            };
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                sidekick: {
                    config: {
                        enabled: true,
                        timeout_ms: 5_000,
                    },
                    projectPath: "/repo/project",
                    sessionDirectory: "/repo/project",
                    client: client as never,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-aug",
                        sessionID: "ses-aug",
                        arguments: "Implement sidekick migration",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-AUG_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-aug",
                "🔍 Preparing augmentation… this may take 2-10s depending on your sidekick provider.",
                {},
            );
            expect(client.session.create).toHaveBeenCalledTimes(1);
            expect(client.session.promptAsync).toHaveBeenCalledWith({
                path: { id: "ses-aug" },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: "Implement sidekick migration\n\n<sidekick-augmentation>\nUse Bun for commands\n</sidekick-augmentation>",
                        },
                    ],
                },
            });
        });

        it("reports when sidekick is not configured", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-aug", sessionID: "ses-aug-missing", arguments: "Help" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-AUG_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-aug-missing",
                expect.stringContaining("Sidekick is not configured"),
                {},
            );
        });
    });

    it("handles flush and status as independent commands", async () => {
        insertTag(db, "ses-both", 1, 200);
        insertPendingOp(db, "ses-both", 1);
        const sendNotificationFlush = mock(async () => {});
        const sendNotificationStatus = mock(async () => {});
        const handlerFlush = createMagicContextCommandHandler({
            db,
            protectedTags: 4,
            sendNotification: sendNotificationFlush,
        });
        const handlerStatus = createMagicContextCommandHandler({
            db,
            protectedTags: 4,
            sendNotification: sendNotificationStatus,
        });

        await expectSentinel(
            handlerFlush["command.execute.before"](
                { command: "ctx-flush", sessionID: "ses-both", arguments: "" },
                makeOutput(""),
                {},
            ),
            "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
        );

        await expectSentinel(
            handlerStatus["command.execute.before"](
                { command: "ctx-status", sessionID: "ses-both", arguments: "" },
                makeOutput(""),
                {},
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        const flushCalls = sendNotificationFlush.mock.calls as unknown as Array<
            [string, string, unknown]
        >;
        const statusCalls = sendNotificationStatus.mock.calls as unknown as Array<
            [string, string, unknown]
        >;
        const [, flushText] = flushCalls[0]!;
        const [, statusText] = statusCalls[0]!;
        expect(flushText).toContain("1 dropped");
        expect(statusText).toContain("## Magic Status");
    });

    it("delivers notification text before throwing the sentinel", async () => {
        const sendNotification = mock(async () => {});
        const handler = createMagicContextCommandHandler({
            db,
            protectedTags: 3,
            sendNotification,
        });

        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-flush", sessionID: "ses-notify", arguments: "" },
                makeOutput(""),
                {},
            ),
            "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
        );

        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(sendNotification).toHaveBeenCalledWith(
            "ses-notify",
            expect.stringContaining("No pending operations to flush."),
            {},
        );
    });

    it("strips agent and model params from context command notifications", async () => {
        const sendNotification = mock(async () => {});
        const handler = createMagicContextCommandHandler({
            db,
            protectedTags: 3,
            sendNotification,
        });

        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-status", sessionID: "ses-stable-model", arguments: "" },
                makeOutput(""),
                {
                    agent: "oracle",
                    variant: "fast",
                    providerId: "anthropic",
                    modelId: "claude-sonnet-4-6",
                },
            ),
            "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
        );

        expect(sendNotification).toHaveBeenCalledWith(
            "ses-stable-model",
            expect.stringContaining("## Magic Status"),
            {},
        );
    });
});
