/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { patchSessionMeta } from "../../features/magic-context/__tests__/session-meta-fixture";
import { CANONICAL_DREAM_TASKS } from "../../features/magic-context/dreamer/task-registry";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    __resetNotificationStateForTests,
    drainNotifications,
    registerNotificationSink,
} from "../../shared/rpc-notifications";
import type { StatusDetail } from "../../shared/rpc-types";
import { Database } from "../../shared/sqlite";
import { createMagicContextCommandHandler } from "./command-handler";

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
    patchSessionMeta(db, sessionId, {
        cached_m0_bytes: Buffer.from("cached m0"),
        cached_m0_project_memory_epoch: 7,
        cached_m0_project_user_profile_version: 3,
        cached_m0_max_compartment_seq: 42,
        cached_m0_max_memory_id: 99,
        cached_m0_max_mutation_id: 12,
        cached_m0_project_docs_hash: "docs-hash",
        cached_m0_materialized_at: 123456,
        cached_m0_session_facts_version: 5,
        cached_m0_upgrade_state: "pending",
    });
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

    // Moving a session to a runner needs its summaries to reach the newest
    // message, so `/ctx-wrapup 0` must not add its own result as a newer row.
    it("ctx-wrapup 0 reports without writing into the session; a kept tail still does", async () => {
        insertSessionMeta(db, "ses-wrap");
        const sendNotification = mock(async () => {});
        const sendStatus = mock(async () => {});
        const executeWrapup = mock(async () => "## Magic Wrapup\n\nWrapped up 40 messages.");
        const handler = createMagicContextCommandHandler({
            db,
            sendNotification,
            sendStatus,
            executeWrapup,
        });

        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-wrapup", sessionID: "ses-wrap", arguments: "0" },
                makeOutput(""),
                {},
            ),
            "CTX-WRAPUP",
        );
        expect(executeWrapup).toHaveBeenCalledWith("ses-wrap", { messagesToKeep: 0 });
        expect(sendNotification).not.toHaveBeenCalled();
        expect(sendStatus).toHaveBeenCalledWith(
            "ses-wrap",
            expect.stringContaining("Wrapped up 40 messages"),
            {},
        );

        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-wrapup", sessionID: "ses-wrap", arguments: "5" },
                makeOutput(""),
                {},
            ),
            "CTX-WRAPUP",
        );
        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(sendStatus).toHaveBeenCalledTimes(1);
    });

    it("a failing ctx-wrapup 0 status delivery still ends in the sentinel", async () => {
        insertSessionMeta(db, "ses-wrap-fail");
        const handler = createMagicContextCommandHandler({
            db,
            sendNotification: mock(async () => {}),
            sendStatus: mock(async () => {
                throw new Error("rpc down");
            }),
            executeWrapup: mock(async () => "done"),
        });
        await expectSentinel(
            handler["command.execute.before"](
                { command: "ctx-wrapup", sessionID: "ses-wrap-fail", arguments: "0" },
                makeOutput(""),
                {},
            ),
            "CTX-WRAPUP",
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
        // The mode used to be labelled by a diagnostics-only prefix naming the
        // config path. `/ctx-status` now has one view and no argument to reach
        // that prefix, so the summary's own compression line labels the mode.
        it("keeps /ctx-status functional and labels the mode", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                compactionOff: true,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-status",
                        sessionID: "ses-status-off",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            expect(sendNotification).toHaveBeenCalledWith(
                "ses-status-off",
                expect.stringContaining("- **Automatic compression:** Off"),
                {},
            );
        });

        it("keeps /ctx-embed functional", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
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
    });

    describe("ctx-flush", () => {
        it("leaves queued tag statuses to transform admission when signed holds are enabled", async () => {
            insertTag(db, "ses-held-flush", 1, 500);
            insertPendingOp(db, "ses-held-flush", 1);
            const onFlush = mock(() => {});
            const handler = createMagicContextCommandHandler({
                db,
                signedThinkingHold: "on",
                onFlush,
                sendNotification: mock(async () => {}),
            });
            await expectSentinel(
                handler["command.execute.before"](
                    { command: "ctx-flush", sessionID: "ses-held-flush", arguments: "" },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-FLUSH_HANDLED__",
            );
            expect(getPendingOpsCount(db, "ses-held-flush")).toBe(1);
            expect(getTagStatus(db, "ses-held-flush", 1)).toBe("active");
            expect(onFlush).toHaveBeenCalledWith("ses-held-flush");
        });
        it("reports an empty queue", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
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
            expect(text).toContain("## Magic Context Status");
            expect(text).toContain("**Context:**");
            expect(text).toContain("**History compression:**");
            expect(text).toContain("**Memory:**");
            expect(text).toContain("**Search indexing:**");
            expect(text).not.toContain("### Tags");
            expect(text).not.toContain("Protected tool tags");
            expect(text).not.toContain("Host backends → MODULE");
        });

        // Was "lists queued drop operations": that per-tag list belongs to the
        // legacy dump, which `/ctx-status diagnostics` used to reach. The
        // argument is gone, so chat gets the summary; the legacy renderer still
        // lists the queue and execute-status.test.ts covers that directly.
        it("answers with the status summary, not the legacy per-tag dump", async () => {
            insertTag(db, "ses-status-ops", 10, 300);
            insertPendingOp(db, "ses-status-ops", 10);
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                sendNotification,
            });

            await expectSentinel(
                handler["command.execute.before"](
                    {
                        command: "ctx-status",
                        sessionID: "ses-status-ops",
                        arguments: "",
                    },
                    makeOutput(""),
                    {},
                ),
                "__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__",
            );

            const calls = sendNotification.mock.calls as unknown as Array<
                [string, string, unknown]
            >;
            const [, text] = calls[0]!;
            expect(text).toContain("## Magic Context Status");
            expect(text).not.toContain("### Queued Operations");
            expect(text).not.toContain("§10§ → drop");
        });

        it("returns defaults for an empty session", async () => {
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
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
            expect(text).toContain("## Magic Context Status");
            expect(text).toContain("0 memories · 0 notes");
            expect(text).not.toContain("Total queued");
            expect(text).not.toContain("Protected tool tags");
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
            const getStatusDetail = mock(statusDetail);
            const handler = createMagicContextCommandHandler({
                db,
                getStatusDetail,
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
                expect.stringContaining(
                    "**Context:** 75.0% of usable context (96,000 / 128,000 tokens)",
                ),
                {},
            );
            expect(getStatusDetail).toHaveBeenCalledTimes(1);
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
                expect.stringContaining("Recomp started"),
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

        it("points /ctx-recomp --upgrade at a plain rebuild", async () => {
            insertLegacyCompartment(db, "ses-upgrade-legacy");
            const sendNotification = mock(async () => {});
            const executeRecomp = mock(async () => "## Magic Recomp\n\nRebuilt state.");
            const handler = createMagicContextCommandHandler({
                db,
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

            // Deprecated flag does not run recomp itself; it points at /ctx-recomp.
            expect(executeRecomp).not.toHaveBeenCalled();
            expect(sendNotification).toHaveBeenCalledWith(
                "ses-upgrade-legacy",
                expect.stringContaining(
                    "The `--upgrade` flag is deprecated. Run `/ctx-recomp` to rebuild them in the current format.",
                ),
                {},
            );
        });
    });

    describe("ctx-dream", () => {
        it("runs all enabled tasks, sends summary, and throws the sentinel", async () => {
            // A migrated store, so the backlog panels have real rows to count.
            const dreamDb = new Database(":memory:");
            initializeDatabase(dreamDb);
            runMigrations(dreamDb);
            const sendNotification = mock(async () => {});
            const runManual = mock(async () => ({
                ran: ["verify"],
                details: ["curate: 8 memory operations applied"],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
                // The runner reports only the task it selected.
                backlogAfter: { verify: { pending: 0, total: 0 } },
            }));
            const handler = createMagicContextCommandHandler({
                db: dreamDb,
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
            expect(sendNotification.mock.calls[1]?.[1]).toContain(
                "curate: 8 memory operations applied",
            );
            const before = String(sendNotification.mock.calls[0]?.[1]);
            const after = String(sendNotification.mock.calls[1]?.[1]);
            // The end panel appears once and lists exactly the tasks the start panel listed,
            // even though the runner only reported the task it ran.
            expect(after.split("Backlog at run end:").length - 1).toBe(1);
            expect(after).not.toContain("Backlog at run start:");
            const taskNames = (panel: string) =>
                panel
                    .split("\n")
                    .map((line) => /^\s*[-*]?\s*([a-z-]+):/.exec(line)?.[1])
                    .filter((name): name is string =>
                        CANONICAL_DREAM_TASKS.includes(name as never),
                    );
            const beforeTasks = taskNames(before.split("Backlog before starting:")[1] ?? "");
            const afterTasks = taskNames(after.split("Backlog at run end:")[1] ?? "");
            expect(beforeTasks.length).toBe(CANONICAL_DREAM_TASKS.length);
            expect(afterTasks).toEqual(beforeTasks);
        });

        it("samples toast duration once when a dream run starts", async () => {
            let duration = 3000;
            const sampleToastDurationMs = mock(() => duration);
            const sendNotification = mock(async () => {});
            const handler = createMagicContextCommandHandler({
                db,
                sendNotification,
                sampleToastDurationMs,
                dreamer: {
                    config: {} as never,
                    projectPath: "/repo/project",
                    runManual: async () => {
                        duration = 9000;
                        return {
                            ran: ["verify"],
                            details: [],
                            skippedNoWork: [],
                            deferredBusy: [],
                            failed: [],
                        };
                    },
                },
            });
            const run = () =>
                expectSentinel(
                    handler["command.execute.before"](
                        { command: "ctx-dream", sessionID: "ses-dream", arguments: "" },
                        makeOutput(""),
                        {},
                    ),
                    "__CONTEXT_MANAGEMENT_CTX-DREAM_HANDLED__",
                );
            await run();
            expect(sampleToastDurationMs).toHaveBeenCalledTimes(1);
            expect(sendNotification.mock.calls.slice(0, 2).map((call) => call[2])).toEqual([
                { toastDurationMs: 3000 },
                { toastDurationMs: 3000 },
            ]);
            await run();
            expect(sampleToastDurationMs).toHaveBeenCalledTimes(2);
            expect(sendNotification.mock.calls.slice(2, 4).map((call) => call[2])).toEqual([
                { toastDurationMs: 9000 },
                { toastDurationMs: 9000 },
            ]);
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

    it("handles flush and status as independent commands", async () => {
        insertTag(db, "ses-both", 1, 200);
        insertPendingOp(db, "ses-both", 1);
        const sendNotificationFlush = mock(async () => {});
        const sendNotificationStatus = mock(async () => {});
        const handlerFlush = createMagicContextCommandHandler({
            db,
            sendNotification: sendNotificationFlush,
        });
        const handlerStatus = createMagicContextCommandHandler({
            db,
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
        expect(statusText).toContain("## Magic Context Status");
    });

    it("delivers notification text before throwing the sentinel", async () => {
        const sendNotification = mock(async () => {});
        const handler = createMagicContextCommandHandler({
            db,
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
            expect.stringContaining("## Magic Context Status"),
            {},
        );
    });
});
