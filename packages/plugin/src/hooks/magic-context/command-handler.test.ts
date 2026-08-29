/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    __resetNotificationStateForTests,
    drainNotifications,
    registerNotificationSink,
} from "../../shared/rpc-notifications";
import type { StatusDetail } from "../../shared/rpc-types";
import { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";
import { MAX_WRAPUP_REQUEST_BUDGET_MS } from "./module-transport";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
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
      legacy INTEGER NOT NULL DEFAULT 0,
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
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash INTEGER DEFAULT 0,
      system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
      cleared_reasoning_through_tag INTEGER DEFAULT 0,
      last_todo_state TEXT DEFAULT '',
      cached_m0_bytes BLOB,
      cached_m0_project_memory_epoch INTEGER,
      cached_m0_project_user_profile_version INTEGER,
      cached_m0_max_compartment_seq INTEGER,
      cached_m0_max_memory_id INTEGER,
      cached_m0_max_mutation_id INTEGER,
      cached_m0_project_docs_hash TEXT,
      cached_m0_materialized_at INTEGER,
      cached_m0_session_facts_version INTEGER,
      cached_m0_upgrade_state TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      session_id TEXT,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);
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
        isSubagent?: boolean;
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
        opts.isSubagent ? 1 : 0,
        0,
        0,
        0,
        0,
    );
}

function seedCachedM0(db: Database, sessionId: string): void {
    insertSessionMeta(db, sessionId);
    db.prepare(
        `UPDATE session_meta SET
            cached_m0_bytes = ?,
            cached_m0_project_memory_epoch = 7,
            cached_m0_project_user_profile_version = 3,
            cached_m0_max_compartment_seq = 42,
            cached_m0_max_memory_id = 99,
            cached_m0_max_mutation_id = 12,
            cached_m0_project_docs_hash = 'docs-hash',
            cached_m0_materialized_at = 123456,
            cached_m0_session_facts_version = 5,
            cached_m0_upgrade_state = 'pending'
         WHERE session_id = ?`,
    ).run(Buffer.from("cached m0"), sessionId);
}

function getCachedM0Row(db: Database, sessionId: string) {
    return db
        .prepare(
            `SELECT
                cached_m0_bytes AS bytes,
                cached_m0_project_memory_epoch AS projectMemoryEpoch,
                cached_m0_project_user_profile_version AS userProfileVersion,
                cached_m0_max_compartment_seq AS maxCompartmentSeq,
                cached_m0_max_memory_id AS maxMemoryId,
                cached_m0_max_mutation_id AS maxMutationId,
                cached_m0_project_docs_hash AS projectDocsHash,
                cached_m0_materialized_at AS materializedAt,
                cached_m0_session_facts_version AS sessionFactsVersion,
                cached_m0_upgrade_state AS upgradeState
             FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as
        | {
              bytes: Buffer | Uint8Array | null;
              projectMemoryEpoch: number | null;
              userProfileVersion: number | null;
              maxCompartmentSeq: number | null;
              maxMemoryId: number | null;
              maxMutationId: number | null;
              projectDocsHash: string | null;
              materializedAt: number | null;
              sessionFactsVersion: number | null;
              upgradeState: string | null;
          }
        | undefined;
}

function insertLegacyCompartment(db: Database, sessionId: string): void {
    db.prepare(
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at, legacy) VALUES (?, 0, 1, 10, 'Legacy', 'legacy content', ?, 1)",
    ).run(sessionId, Date.now());
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

function makeOutput(text: string) {
    return { parts: [{ type: "text", text }] };
}

async function expectSentinel(promise: Promise<unknown>, sentinel: string): Promise<void> {
    try {
        await promise;
        throw new Error(`Expected sentinel ${sentinel}`);
    } catch (error) {
        // Still a real Error carrying the sentinel message, the universal
        // fallback for any host that does not recognize the Effect HTTP tags.
        expect(String(error)).toContain(sentinel);
        // AND duck-types an Effect HttpServerResponse.empty({status:204}) so
        // OpenCode 1.17.x recognizes it (plain-string TypeId), suppresses the
        // JSON-500 log, and writes a clean 204 — no TUI/log leak. Lock the exact
        // shape Response.toWeb dereferences on the empty-body path.
        const e = error as Record<string, unknown>;
        expect(e["~effect/http/HttpServerResponse"]).toBe("~effect/http/HttpServerResponse");
        expect(e["~effect/ErrorReporter/ignore"]).toBe(true);
        expect(e.status).toBe(204);
        expect((e.body as { _tag?: unknown })?._tag).toBe("Empty");
        expect((e.cookies as { cookies?: unknown })?.cookies).toEqual({});
    }
}

describe("createMagicContextCommandHandler", () => {
    let db: Database;

    beforeEach(() => {
        __resetNotificationStateForTests();
        db = createTestDb();
    });

    afterEach(() => {
        __resetNotificationStateForTests();
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

    it("refuses ctx-wrapup in subagent sessions", async () => {
        insertSessionMeta(db, "ses-sub");
        db.prepare("UPDATE session_meta SET is_subagent = 1 WHERE session_id = ?").run("ses-sub");
        const sendNotification = mock(async () => {});
        const executeWrapup = mock(async () => "should not run");
        const handler = createMagicContextCommandHandler({
            db,
            protectedTags: 3,
            sendNotification,
            executeWrapup,
        });

        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-wrapup", sessionID: "ses-sub", arguments: "20" },
                makeOutput(""),
                {},
            ),
            "CTX-WRAPUP",
        );

        expect(executeWrapup).not.toHaveBeenCalled();
        expect(sendNotification).toHaveBeenCalledWith(
            "ses-sub",
            expect.stringContaining("only available in primary sessions"),
            {},
        );
    });

    for (const command of ["ctx-wrapup", "ctx-recomp", "ctx-flush"] as const) {
        it(`refuses /${command} without side effects when compaction is off`, async () => {
            insertTag(db, "ses-compaction-off", 1, 500);
            insertPendingOp(db, "ses-compaction-off", 1);
            const sendNotification = mock(async () => {});
            const executeWrapup = mock(async () => "should not run");
            const executeRecomp = mock(async () => "should not run");
            const onFlush = mock(() => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: true,
                executeWrapup,
                executeRecomp,
                onFlush,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command, sessionID: "ses-compaction-off", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                `__CONTEXT_MANAGEMENT_${command.toUpperCase()}_HANDLED__`,
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-compaction-off",
                `Magic Context compaction is disabled (compaction.enabled: false) — /${command} manages compacted history and has no effect in this mode.`,
                {},
            );
            expect(executeWrapup).not.toHaveBeenCalled();
            expect(executeRecomp).not.toHaveBeenCalled();
            expect(onFlush).not.toHaveBeenCalled();
            expect(getPendingOpsCount(db, "ses-compaction-off")).toBe(1);
            expect(getTagStatus(db, "ses-compaction-off", 1)).toBe("active");
        });
    }

    it("keeps compaction commands functional when compaction is on", async () => {
        for (const command of ["ctx-wrapup", "ctx-recomp", "ctx-flush"] as const) {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: false,
                executeWrapup: async () => "wrapup ran",
                executeRecomp: async () => "recomp ran",
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command, sessionID: `ses-compaction-on-${command}`, arguments: "" },
                    makeOutput(""),
                    {},
                ),
                `__CONTEXT_MANAGEMENT_${command.toUpperCase()}_HANDLED__`,
            );

            const notifications = (sendNotification.mock.calls as Array<[string, string]>).map(
                ([, text]) => text,
            );
            expect(notifications.join("\n")).not.toContain("Magic Context compaction is disabled");
        }
    });

    describe("knowledge-layer commands in compaction-off mode", () => {
        it("keeps /ctx-status functional and labels the mode", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: true,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-status-off", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-status-off",
                expect.stringContaining(
                    "**Compaction:** disabled (compaction.enabled: false) — native compaction owns the context window.",
                ),
                {},
            );
        });

        it("keeps /ctx-embed functional", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: true,
                getEmbedStatusText: () => "embedding is ready",
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-embed", sessionID: "ses-embed-off", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-EMBED_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-embed-off",
                "## Embedding Status\n\nembedding is ready",
                {},
            );
        });

        it("keeps /ctx-dream functional", async () => {
            const sendNotification = mock(async () => {});
            const runManual = mock(async () => ({
                ran: ["verify"],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: true,
                sendNotification,
                dreamer: { config: {} as never, projectPath: "/repo", runManual },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream-off", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            expect(runManual).toHaveBeenCalledWith(undefined);
        });

        it("keeps /ctx-aug functional", async () => {
            const sendNotification = mock(async () => {});
            const client = {
                session: {
                    create: mock(async () => ({ data: { id: "sidekick-child" } })),
                    promptAsync: mock(async () => undefined),
                    messages: mock(async () => ({
                        data: [
                            {
                                info: { role: "assistant", time: { created: Date.now() } },
                                parts: [{ type: "text", text: "Use Bun" }],
                            },
                        ],
                    })),
                    delete: mock(async () => ({ data: undefined })),
                },
            };
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                compactionOff: true,
                sendNotification,
                sidekick: {
                    config: { timeout_ms: 5_000 },
                    projectPath: "/repo",
                    sessionDirectory: "/repo",
                    client: client as never,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-aug", sessionID: "ses-aug-off", arguments: "Check this" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-AUG_HANDLED__",
            );

            expect(client.session.create).toHaveBeenCalledTimes(1);
            expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
        });
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
        });

        it("is SOFT: keeps cached m0/m1 bytes and invokes onFlush", async () => {
            seedCachedM0(db, "ses-flush-cache");
            const onFlush = mock(() => {});
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                onFlush,
            });

            const before = getCachedM0Row(db, "ses-flush-cache");
            expect(before?.bytes).not.toBeNull();

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-flush", sessionID: "ses-flush-cache", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
            );

            expect(onFlush).toHaveBeenCalledWith("ses-flush-cache");
            expect(getCachedM0Row(db, "ses-flush-cache")).toEqual(before);
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
            expect(text).toContain("- Active: 2");
            expect(text).toContain("- Dropped: 1");
            expect(text).toContain("- Drops: 1");
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

    describe("TUI dialog routing", () => {
        const statusDetail = (sessionId: string): StatusDetail =>
            ({
                sessionId,
                usagePercentage: 75,
                inputTokens: 96_000,
                contextLimit: 128_000,
                cacheTtl: "5m",
                cacheRemainingMs: 42_000,
                cacheExpired: false,
                cacheNeverExpires: false,
                historianRunning: false,
                boundaryPresent: undefined,
                coverageOrdinal: undefined,
                memoryCount: 8,
                memoryBlockCount: 3,
                activeTags: 4,
                droppedTags: 1,
                pendingOpsCount: 2,
                executeThreshold: 65,
                executeThresholdClamped: false,
                compaction_enabled: true,
                recompProgress: null,
                lastTransformError: null,
            }) as StatusDetail;

        it("renders shared status markdown through the normal response path without a live TUI sink", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                getStatusDetail: statusDetail,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-sinkless", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-sinkless",
                expect.stringContaining("**Usage:** 75.0% (96,000 / 128,000 usable tokens)"),
                {},
            );
            expect(drainNotifications()).toEqual([]);
        });

        it("uses the live TUI dialog instead of duplicating a Desktop response", async () => {
            const received: Array<Record<string, unknown>> = [];
            const unregister = registerNotificationSink({
                sessionId: "ses-live",
                protocol: 2,
                send: (notification) => received.push(notification.payload),
            });
            const sendNotification = mock(async () => {});
            const getStatusDetail = mock(statusDetail);
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                getStatusDetail,
                sendNotification,
            });

            try {
                await expectSentinel(
                    handler["command.execute.before"](
                        { command: "ctx-status", sessionID: "ses-live", arguments: "" },
                        makeOutput(""),
                        {},
                    ),
                    "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
                );

                expect(received).toEqual([{ action: "show-status-dialog" }]);
                expect(getStatusDetail).not.toHaveBeenCalled();
                expect(sendNotification).not.toHaveBeenCalled();
            } finally {
                unregister();
            }
        });

        it("routes recomp confirmation to text when sinkless and to a dialog when live", async () => {
            const sinklessNotification = mock(async () => {});
            const sinklessHandler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                executeRecomp: async () => "should not run",
                sendNotification: sinklessNotification,
            });

            await expectSentinel(
                sinklessHandler["command.execute.before"](
                    { command: "ctx-recomp", sessionID: "ses-recomp-sinkless", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );
            expect(sinklessNotification).toHaveBeenCalledWith(
                "ses-recomp-sinkless",
                expect.stringContaining("Recomp Confirmation Required"),
                {},
            );
            expect(drainNotifications()).toEqual([]);

            const received: Array<Record<string, unknown>> = [];
            const unregister = registerNotificationSink({
                sessionId: "ses-recomp-live",
                protocol: 2,
                send: (notification) => received.push(notification.payload),
            });
            const liveNotification = mock(async () => {});
            const liveHandler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                executeRecomp: async () => "should not run",
                sendNotification: liveNotification,
            });

            try {
                await expectSentinel(
                    liveHandler["command.execute.before"](
                        { command: "ctx-recomp", sessionID: "ses-recomp-live", arguments: "" },
                        makeOutput(""),
                        {},
                    ),
                    "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
                );

                expect(received).toEqual([{ action: "show-recomp-dialog" }]);
                expect(liveNotification).not.toHaveBeenCalled();
            } finally {
                unregister();
            }
        });
    });

    describe("ctx-recomp", () => {
        it("first call shows confirmation warning, second call within 60s runs recomp", async () => {
            const sendNotification = mock(async () => {});
            const executeRecomp = mock(async () => "## Magic Recomp\n\nRebuilt state.");
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                executeRecomp,
                sendNotification,
            });

            // First call — shows confirmation warning, does NOT run recomp
            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-recomp", sessionID: "ses-recomp", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            expect(executeRecomp).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledTimes(1);
            expect(sendNotification).toHaveBeenNthCalledWith(
                1,
                "ses-recomp",
                expect.stringContaining("Recomp Confirmation Required"),
                {},
            );

            // Second call within 60s — actually runs recomp
            sendNotification.mockClear();
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

        it("returns a no-op message for /ctx-recomp --upgrade when no legacy compartments exist", async () => {
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
                    {
                        command: "ctx-recomp",
                        sessionID: "ses-upgrade-empty",
                        arguments: "--upgrade",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            expect(executeRecomp).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-upgrade-empty",
                expect.stringContaining("Nothing to upgrade"),
                {},
            );
        });

        it("points /ctx-recomp --upgrade at the new /ctx-session-upgrade command", async () => {
            insertLegacyCompartment(db, "ses-upgrade-legacy");
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
                    {
                        command: "ctx-recomp",
                        sessionID: "ses-upgrade-legacy",
                        arguments: "--upgrade",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            // Deprecated flag does not run recomp itself; it redirects to the command.
            expect(executeRecomp).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-upgrade-legacy",
                expect.stringContaining("/ctx-session-upgrade"),
                {},
            );
        });
    });

    describe("Rust-mode command operations", () => {
        it("omits context.db mirrors when canonical status is unavailable", async () => {
            insertTag(db, "ses-rust-status-unavailable", 1, 1024);
            const sendNotification = mock(async () => {});
            const getStatusDetail = mock(() => {
                throw new Error("host mirror must not be formatted");
            });
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: {
                    call: async () => {
                        throw new Error("module offline");
                    },
                },
                getStatusDetail,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-status",
                        sessionID: "ses-rust-status-unavailable",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            expect(getStatusDetail).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-status-unavailable",
                expect.stringContaining("Rust module status could not be read"),
                {},
            );
            const text = String(sendNotification.mock.calls[0]?.[1]);
            expect(text).not.toContain("- Active: 1");
        });

        it("routes flush to the module while retaining flush wording", async () => {
            const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: {
                    call: async (request) => {
                        calls.push({
                            method: request.method,
                            body: request.body as Record<string, unknown>,
                        });
                        return { ok: true, armed: true };
                    },
                },
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-flush", sessionID: "ses-rust-flush", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
            );

            expect(calls).toHaveLength(1);
            expect(calls[0]?.method).toBe("session.flush");
            expect(calls[0]?.body).toMatchObject({
                method: "session.flush",
                v: 1,
                session_id: "ses-rust-flush",
            });
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-flush",
                "Flushed: Changes take effect on next message.",
                {},
            );
        });

        it("maps Rust wrapup and recomp dispositions while minting command ids", async () => {
            const sendNotification = mock(async () => {});
            const moduleCall = mock(
                async (args: {
                    method: string;
                    body: Record<string, unknown>;
                    timeoutMs?: number;
                }) => {
                    if (args.method === "session.wrapup") {
                        return { disposition: "completed", rounds: 2, summary: "Wrapped up." };
                    }
                    return { disposition: "started" };
                },
            );
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: { call: moduleCall },
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-wrapup", sessionID: "ses-rust-wrapup", arguments: "250" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-WRAPUP_HANDLED__",
            );
            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-recomp", sessionID: "ses-rust-recomp", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            const calls = moduleCall.mock.calls as unknown as Array<
                [{ method: string; body: Record<string, unknown>; timeoutMs?: number }]
            >;
            expect(calls[0]?.[0].method).toBe("session.wrapup");
            // The requested keep watermark is forwarded unchanged (no 5/100 clamp):
            // the module honors it as given, matching the TypeScript orchestrator.
            expect(calls[0]?.[0].body.keep).toBe(250);
            expect(calls[0]?.[0].body.command_id).toEqual(expect.any(String));
            expect(calls[0]?.[0].timeoutMs).toBe(MAX_WRAPUP_REQUEST_BUDGET_MS);
            expect(calls[1]?.[0].method).toBe("session.recomp");
            expect(calls[1]?.[0].body.command_id).toEqual(expect.any(String));
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-wrapup",
                expect.stringContaining("Wrapped up."),
                {},
            );
        });

        it("refuses Rust partial recomp and session upgrade without touching either authority store", async () => {
            const sendNotification = mock(async () => {});
            const moduleCall = mock(async () => ({ disposition: "started" }));
            const runUpgrade = mock(async () => "TS upgrade ran");
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: { call: moduleCall },
                runUpgrade,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-recomp",
                        sessionID: "ses-rust-maintenance",
                        arguments: "10-20",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );
            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-session-upgrade",
                        sessionID: "ses-rust-maintenance",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-SESSION-UPGRADE_HANDLED__",
            );

            expect(moduleCall).not.toHaveBeenCalled();
            expect(runUpgrade).not.toHaveBeenCalled();
            const text = (sendNotification.mock.calls as unknown as Array<[string, string]>)
                .map(([, notification]) => notification)
                .join("\n");
            expect(text).toContain("module supports only a full-session recomp");
            expect(text).toContain("switch authority through the documented drain flow");
        });

        it("maps every shared wrapup state cell to the TypeScript outcome contract", async () => {
            const matrix = [
                {
                    cell: "empty",
                    disposition: "nothing_to_compact",
                    expectedHeading: "## Magic Wrapup",
                    forbiddenHeading: "— Partial",
                },
                {
                    cell: "active",
                    disposition: "already_in_progress",
                    expectedHeading: "## Magic Wrapup — Skipped",
                },
                ...[
                    "lease_timeout",
                    "zero_progress",
                    "partial_progress",
                    "producer_failure",
                    "ownership_loss",
                ].map((cell) => ({
                    cell,
                    disposition: "retryable",
                    expectedHeading: "## Magic Wrapup — Partial",
                })),
                {
                    cell: "success",
                    disposition: "completed",
                    expectedHeading: "## Magic Wrapup",
                    forbiddenHeading: "— Partial",
                },
            ];

            for (const row of matrix) {
                const sendNotification = mock(async () => {});
                const moduleCall = mock(async () => ({
                    ok: true,
                    disposition: row.disposition,
                    rounds: row.cell === "success" ? 2 : 0,
                    summary: `matrix:${row.cell}`,
                }));
                const handler = createMagicContextCommandHandler({
                    db,
                    protectedTags: 3,
                    transformMode: "rust",
                    rustModeModuleClient: { call: moduleCall },
                    sendNotification,
                });
                const sessionId = `ses-rust-wrapup-matrix-${row.cell}`;

                await expectSentinel(
                    handler["command.execute.before"](
                        { command: "ctx-wrapup", sessionID: sessionId, arguments: "" },
                        makeOutput(""),
                        {},
                    ),
                    "__CONTEXT_MANAGEMENT_CTX-WRAPUP_HANDLED__",
                );

                const text = (sendNotification.mock.calls as unknown as Array<[string, string]>)
                    .filter(([notifiedSession]) => notifiedSession === sessionId)
                    .map(([, notification]) => notification)
                    .join("\n");
                expect(text, row.cell).toContain(row.expectedHeading);
                if (row.disposition !== "already_in_progress") {
                    expect(text, row.cell).toContain(`matrix:${row.cell}`);
                }
                if (row.forbiddenHeading)
                    expect(text, row.cell).not.toContain(row.forbiddenHeading);
                if (row.disposition === "retryable") {
                    expect(text, row.cell).toContain("Run /ctx-wrapup again to continue.");
                    expect(text, row.cell).not.toContain("— Failed");
                }
            }
        });

        it("presents a retryable Rust wrapup as Partial with a continuation, not Failed", async () => {
            const sendNotification = mock(async () => {});
            const moduleCall = mock(async () => ({
                ok: false,
                disposition: "retryable",
                reason: "budget_exhausted",
                summary:
                    "compacted 3 messages into 1 compartments; wrapup request budget expired; takes effect on your next message",
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: { call: moduleCall },
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-wrapup", sessionID: "ses-rust-wrapup-retry", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-WRAPUP_HANDLED__",
            );

            const texts = (sendNotification.mock.calls as unknown as Array<[string, string]>)
                .filter(([sessionId]) => sessionId === "ses-rust-wrapup-retry")
                .map(([, text]) => text)
                .join("\n");
            expect(texts).toContain("## Magic Wrapup — Partial");
            expect(texts).toContain("Run /ctx-wrapup again to continue.");
            expect(texts).not.toContain("— Failed");
        });

        it("keeps /ctx-embed on the TypeScript subsystem in Rust mode", async () => {
            const sendNotification = mock(async () => {});
            const moduleCall = mock(async () => {
                throw new Error("Rust module must not receive embed commands");
            });
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: { call: moduleCall },
                getEmbedStatusText: () => "embedding is ready",
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-embed", sessionID: "ses-rust-embed", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-EMBED_HANDLED__",
            );
            expect(moduleCall).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-embed",
                expect.stringContaining("embedding is ready"),
                {},
            );
        });

        it("merges structured module status into the desktop status output", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: {
                    call: async () => ({
                        ok: true,
                        usage: {
                            current_total_input_tokens: 42_000,
                            context_limit_tokens: 100_000,
                        },
                        boundary_present: true,
                        coverage_ordinal: 17,
                        compartment_count: 4,
                    }),
                },
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-status", sessionID: "ses-rust-status", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-status",
                expect.stringContaining("- Coverage ordinal: 17"),
                {},
            );
        });

        it("routes wrapup and recomp forwarding the requested keep and command ids", async () => {
            const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                rustModeModuleClient: {
                    call: async (request) => {
                        calls.push({
                            method: request.method,
                            body: request.body as Record<string, unknown>,
                        });
                        return request.method === "session.wrapup"
                            ? { ok: true, disposition: "nothing_to_compact", rounds: 0 }
                            : { ok: true, disposition: "started" };
                    },
                },
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-wrapup", sessionID: "ses-rust-ops", arguments: "999" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-WRAPUP_HANDLED__",
            );
            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-recomp", sessionID: "ses-rust-ops", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-RECOMP_HANDLED__",
            );

            expect(calls.map((call) => call.method)).toEqual(["session.wrapup", "session.recomp"]);
            // The requested keep watermark is forwarded unchanged; the module honors
            // it as given (no 5/100 clamp), matching the TypeScript orchestrator.
            expect(calls[0]?.body.keep).toBe(999);
            expect(typeof calls[0]?.body.command_id).toBe("string");
            expect(typeof calls[1]?.body.command_id).toBe("string");
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-ops",
                expect.stringContaining("Nothing to compact"),
                {},
            );
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-ops",
                expect.stringContaining("Historian recomp started"),
                {},
            );
        });

        it("keeps ctx-embed on its TypeScript-owned path in Rust mode", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                transformMode: "rust",
                getEmbedStatusText: () => "Embedding is ready.",
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-embed", sessionID: "ses-rust-embed", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-EMBED_HANDLED__",
            );
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-rust-embed",
                "## Embedding Status\n\nEmbedding is ready.",
                {},
            );
        });
    });

    describe("ctx-session-upgrade", () => {
        it("runs the managed upgrade (recomp + migration) and throws the sentinel", async () => {
            insertLegacyCompartment(db, "ses-su-legacy");
            const sendNotification = mock(async () => {});
            // The command path now delegates to the unified `runUpgrade` (shared
            // recomp-orchestrator: full recomp → once-per-project memory
            // migration), so it gets the same fallback + progress as the RPC
            // dialog path. The command handler just invokes it and reports.
            const runUpgrade = mock(
                async () => "## Session Upgrade — Complete\n\nRebuilt 1 compartment.",
            );
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                runUpgrade,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-session-upgrade",
                        sessionID: "ses-su-legacy",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-SESSION-UPGRADE_HANDLED__",
            );

            expect(runUpgrade).toHaveBeenCalledWith("ses-su-legacy");
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-su-legacy",
                expect.stringContaining("Session Upgrade"),
                {},
            );
        });

        it("reports a no-session message when the prompt has no session id", async () => {
            const sendNotification = mock(async () => {});
            const executeRecomp = mock(async () => "rebuilt");
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                executeRecomp,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-session-upgrade",
                        sessionID: "",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-SESSION-UPGRADE_HANDLED__",
            );

            expect(executeRecomp).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "",
                expect.stringContaining("not attached to a session"),
                {},
            );
        });
    });

    describe("ctx-dream", () => {
        it("runs all enabled tasks, sends summary, and throws the sentinel", async () => {
            const sendNotification = mock(async () => {});
            const runManual = mock(async () => ({
                ran: ["verify"],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                dreamer: {
                    // command handler only reads `config` for presence; runManual is the entry.
                    config: {} as never,
                    projectPath: "/repo/project",
                    runManual,
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

            // No arg → run all enabled tasks (task is undefined).
            expect(runManual).toHaveBeenCalledWith(undefined);
            expect(sendNotification.mock.calls[0]?.[1]).toContain("Backlog before starting:");
            expect(sendNotification.mock.calls[0]?.[1]).toContain("Starting dream run...");
            expect(sendNotification).toHaveBeenNthCalledWith(
                2,
                "ses-dream",
                expect.stringContaining("Ran: verify"),
                { toastDurationMs: 5000 },
            );
        });

        it("force-runs a single named task when given an argument", async () => {
            const sendNotification = mock(async () => {});
            const runManual = mock(async () => ({
                ran: ["verify"],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                dreamer: {
                    config: {} as never,
                    projectPath: "/repo/project",
                    runManual,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream", arguments: "verify" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            expect(runManual).toHaveBeenCalledWith("verify");
            expect(sendNotification.mock.calls[0]?.[1]).toContain('Running dream task "verify"...');
            expect(sendNotification.mock.calls[0]?.[1]).toContain("Backlog before starting:");
        });

        it("rejects an unknown task name without running", async () => {
            const sendNotification = mock(async () => {});
            const runManual = mock(async () => ({
                ran: [],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
            }));
            const handler = createMagicContextCommandHandler({
                db,
                protectedTags: 3,
                sendNotification,
                dreamer: {
                    config: {} as never,
                    projectPath: "/repo/project",
                    runManual,
                },
            });

            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-dream", sessionID: "ses-dream", arguments: "bogus-task" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
            );

            expect(runManual).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-dream",
                expect.stringContaining('Unknown task "bogus-task"'),
                { toastDurationMs: 5000 },
            );
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
