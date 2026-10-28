import { beforeEach, describe, expect, it } from "bun:test";
import { markWhitespaceAssistantTagInert } from "../../features/magic-context/storage-tags";
import {
    clearLegacyForeignTextTagsForTest,
    rememberLegacyForeignTextTags,
} from "../../hooks/magic-context/foreign-text-parts";
import { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "./tools";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      token_count INTEGER DEFAULT NULL,
      entry_fingerprint TEXT DEFAULT NULL
    );
    CREATE TABLE pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
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
      cached_m0_workspace_fingerprint TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

function seedTags(
    db: Database,
    tags: Array<{
        id: number;
        sessionId: string;
        status?: string;
        type?: string;
        toolName?: string | null;
    }>,
) {
    for (const [index, tag] of tags.entries()) {
        const rowId = 10_000 + tag.id + index;
        db.prepare(
            "INSERT INTO tags (id, message_id, type, status, byte_size, session_id, tag_number, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            rowId,
            `msg-${tag.id}`,
            tag.type ?? "message",
            tag.status ?? "active",
            100,
            tag.sessionId,
            tag.id,
            tag.toolName ?? null,
        );
    }
}

function getPendingOps(db: Database, sessionId: string) {
    return db
        .prepare("SELECT * FROM pending_ops WHERE session_id = ? ORDER BY tag_id ASC")
        .all(sessionId) as Array<{
        tag_id: number;
        operation: string;
    }>;
}

function getLastNudgeTokens(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT last_nudge_tokens FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { last_nudge_tokens: number } | null;
    return row?.last_nudge_tokens ?? 0;
}

const toolContext = (sessionID = "ses-1") => ({ sessionID }) as never;

describe("createCtxReduceTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxReduceTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxReduceTools({ db });
    });

    describe("ctx_reduce", () => {
        it("requires the drop parameter", async () => {
            const result = await tools.ctx_reduce.execute({}, toolContext());

            expect(result).toContain("Error");
            expect(result).toBe(
                `Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}.`,
            );
        });

        it("refuses empty drop filler without queuing a phantom command", async () => {
            seedTags(db, [{ id: 1, sessionId: "ses-1" }]);
            const omitted = await tools.ctx_reduce.execute({}, toolContext());
            const empty = await tools.ctx_reduce.execute({ drop: "" }, toolContext());
            expect(empty).toBe(omitted);
            expect(empty).toBe(
                `Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}.`,
            );
            expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        });

        it("accepts reduced compatibility fields alongside a real drop", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 2, sessionId: "ses-1" },
                { id: 3, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const result = await tools.ctx_reduce.execute(
                {
                    drop: "3",
                    reduced: true,
                    summary: JSON.stringify({ drop: "8" }),
                },
                toolContext(),
            );

            expect(result).toBe("1 tag stamped.");
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 3, operation: "drop" }),
            ]);
        });

        it("queues drop ops and returns an acknowledgement", async () => {
            seedTags(db, [
                { id: 3, sessionId: "ses-1" },
                { id: 4, sessionId: "ses-1" },
                { id: 5, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const result = await tools.ctx_reduce.execute({ drop: "3-5" }, toolContext());

            expect(result).toBe("3 tags stamped.");
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 3, operation: "drop" }),
                expect.objectContaining({ tag_id: 4, operation: "drop" }),
                expect.objectContaining({ tag_id: 5, operation: "drop" }),
            ]);
        });

        it("skips ctx_reduce stamps while still queueing sibling tags", async () => {
            seedTags(db, [
                { id: 41, sessionId: "ses-1", type: "tool", toolName: "ctx_reduce" },
                { id: 42, sessionId: "ses-1", type: "tool", toolName: "read" },
            ]);
            const tool = createCtxReduceTools({ db, protectedSet: new Set() });

            const result = await tool.ctx_reduce.execute({ drop: "41,42" }, toolContext());

            expect(result).toBe(
                "1 tag stamped. 1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.",
            );
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 42, operation: "drop" }),
            ]);
            expect(await tool.ctx_reduce.execute({ drop: "41" }, toolContext())).toBe(
                "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.",
            );
        });

        it("orders free drops, protected tags, then ctx_reduce self-stamp counts", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1", type: "tool", toolName: "custom" },
                { id: 2, sessionId: "ses-1", type: "tool", toolName: "ctx_reduce" },
                { id: 3, sessionId: "ses-1", type: "tool", toolName: "bash" },
            ]);
            const tool = createCtxReduceTools({
                db,
                protectedSet: new Set(),
                protectedTools: { custom: 1 },
            });
            const result = await tool.ctx_reduce.execute({ drop: "2,1,3" }, toolContext());
            expect(result).toBe(
                "2 tags stamped. 1 was a ctx_reduce call; leave those alone, they are cleaned up automatically.",
            );
            expect(
                getPendingOps(db, "ses-1")
                    .map((op) => op.tag_id)
                    .sort(),
            ).toEqual([1, 3]);
        });

        it("resets the rolling nudge anchor to the current token count", async () => {
            seedTags(db, [
                { id: 3, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time, cache_ttl, counter, last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent, last_context_percentage, last_input_tokens, times_execute_threshold_reached, compartment_in_progress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run("ses-1", Date.now(), "5m", 0, 80_000, "near", "", 0, 50, 125_000, 0, 0);

            await tools.ctx_reduce.execute({ drop: "3" }, toolContext());

            expect(getLastNudgeTokens(db, "ses-1")).toBe(125_000);
        });

        it("counts protected tags as stamped for single and plural requests", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1", type: "tool" },
                { id: 9, sessionId: "ses-1", type: "tool" },
                { id: 10, sessionId: "ses-1", type: "tool" },
            ]);

            // Plural held copy
            const resultPlural = await tools.ctx_reduce.execute({ drop: "9,10" }, toolContext());
            expect(resultPlural).toBe("2 tags stamped.");

            // Single held copy on fresh session
            seedTags(db, [
                { id: 101, sessionId: "ses-2" },
                { id: 108, sessionId: "ses-2", type: "tool" },
                { id: 109, sessionId: "ses-2", type: "tool" },
                { id: 110, sessionId: "ses-2", type: "tool" },
            ]);
            const singleTools = createCtxReduceTools({ db });
            const resultSingle = await singleTools.ctx_reduce.execute(
                { drop: "110" },
                { ...toolContext(), sessionID: "ses-2" },
            );
            expect(resultSingle).toBe("1 tag stamped.");
        });

        it("counts immediate and protected drops together", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1", type: "tool" },
                { id: 9, sessionId: "ses-1", type: "tool" },
                { id: 10, sessionId: "ses-1", type: "tool" },
            ]);

            const result = await tools.ctx_reduce.execute({ drop: "1,9,10" }, toolContext());

            expect(result).toBe("3 tags stamped.");
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 1, operation: "drop" }),
                expect.objectContaining({ tag_id: 9, operation: "drop" }),
                expect.objectContaining({ tag_id: 10, operation: "drop" }),
            ]);
        });

        it("reports unknown tags", async () => {
            seedTags(db, [{ id: 1, sessionId: "ses-1" }]);

            const result = await tools.ctx_reduce.execute({ drop: "1,99" }, toolContext());

            expect(result).toContain("Unknown");
            expect(result).toContain("§99§");
        });

        it("returns parse errors for invalid ranges", async () => {
            const result = await tools.ctx_reduce.execute({ drop: "abc" }, toolContext());

            expect(result).toContain("Invalid range syntax");
        });

        it("rejects compacted tags", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1", status: "compacted" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const result = await tools.ctx_reduce.execute({ drop: "1" }, toolContext());

            expect(result).toContain("Conflicting");
            expect(result).toContain("from before compaction");
        });

        it("acknowledges an inert whitespace tag without queueing it", async () => {
            seedTags(db, [{ id: 7, sessionId: "ses-1" }]);
            markWhitespaceAssistantTagInert(db, "ses-1", 7, "assistant:p0");

            const result = await tools.ctx_reduce.execute({ drop: "7" }, toolContext());

            expect(result).toContain("§7§ is provider framing, nothing to reclaim");
            expect(result).not.toContain("Error:");
            expect(getPendingOps(db, "ses-1")).toEqual([]);
        });

        it("skips inert whitespace inside a range while queueing every live tag", async () => {
            seedTags(db, [
                { id: 6, sessionId: "ses-1" },
                { id: 7, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
                { id: 11, sessionId: "ses-1" },
                { id: 12, sessionId: "ses-1" },
            ]);
            markWhitespaceAssistantTagInert(db, "ses-1", 7, "assistant:p0");

            const result = await tools.ctx_reduce.execute({ drop: "6-8" }, toolContext());

            expect(result).toBe(
                "2 tags stamped. Skipped: §7§ is provider framing, nothing to reclaim.",
            );
            expect(getPendingOps(db, "ses-1").map((op) => op.tag_id)).toEqual([6, 8]);
        });

        it("skips another plugin's legacy text tag per id while queueing every live tag", async () => {
            seedTags(db, [
                { id: 6, sessionId: "ses-1" },
                { id: 7, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
            ]);
            // The transform records a tag an older release put on another
            // plugin's appended text part when it serves that part.
            rememberLegacyForeignTextTags("ses-1", [7]);
            try {
                const result = await tools.ctx_reduce.execute({ drop: "6-8" }, toolContext());

                expect(result).toBe(
                    "2 tags stamped. Skipped: §7§ is another plugin's text, nothing to reclaim.",
                );
                expect(getPendingOps(db, "ses-1").map((op) => op.tag_id)).toEqual([6, 8]);
            } finally {
                clearLegacyForeignTextTagsForTest();
            }
        });

        it("reads inert whitespace state only for the requested tags", async () => {
            seedTags(
                db,
                Array.from({ length: 30 }, (_, index) => ({ id: index + 1, sessionId: "ses-1" })),
            );
            // Inert tags outside the request must neither be read nor change the answer.
            for (const tag of [2, 7, 20, 25]) {
                markWhitespaceAssistantTagInert(db, "ses-1", tag, `assistant-${tag}:p0`);
            }
            const statements: string[] = [];
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return prepare(sql);
            }) as typeof db.prepare;

            const result = await tools.ctx_reduce.execute({ drop: "6-8" }, toolContext());

            expect(result).toBe(
                "2 tags stamped. Skipped: §7§ is provider framing, nothing to reclaim.",
            );
            const inertReads = statements.filter((sql) => sql.includes("entry_fingerprint LIKE"));
            expect(inertReads.length).toBe(1);
            // Bounded by the requested tag numbers, not a scan of every retired tag.
            expect(inertReads[0]).toContain("tags.tag_number = wanted.value");
        });

        it("counts previously queued tags without listing them", async () => {
            seedTags(db, [
                { id: 10, sessionId: "ses-1" },
                { id: 11, sessionId: "ses-1" },
                { id: 12, sessionId: "ses-1" },
                { id: 13, sessionId: "ses-1" },
                { id: 14, sessionId: "ses-1" },
                { id: 15, sessionId: "ses-1" },
                { id: 18, sessionId: "ses-1" },
                { id: 19, sessionId: "ses-1" },
                { id: 20, sessionId: "ses-1" },
            ]);
            await tools.ctx_reduce.execute({ drop: "10-12" }, toolContext());

            const result = await tools.ctx_reduce.execute({ drop: "11-14" }, toolContext());

            expect(result).toBe("4 tags stamped.");
        });

        it("returns a stamped count when all requested tags are already queued", async () => {
            seedTags(db, [
                { id: 10, sessionId: "ses-1" },
                { id: 11, sessionId: "ses-1" },
                { id: 12, sessionId: "ses-1" },
                { id: 15, sessionId: "ses-1" },
                { id: 16, sessionId: "ses-1" },
                { id: 17, sessionId: "ses-1" },
            ]);
            await tools.ctx_reduce.execute({ drop: "10-12" }, toolContext());

            const result = await tools.ctx_reduce.execute({ drop: "10-12" }, toolContext());

            expect(result).toBe("3 tags stamped.");
        });

        it("queues a single drop on the TypeScript path", async () => {
            seedTags(db, [{ id: 3, sessionId: "ses-1" }]);

            const result = await createCtxReduceTools({
                db,
                protectedSet: new Set(),
            }).ctx_reduce.execute({ drop: "3" }, toolContext());

            expect(result).toBe("1 tag stamped.");
            expect(getPendingOps(db, "ses-1")).toHaveLength(1);
        });

        it("rolls back partial queue writes on failure", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 2, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const originalPrepare = db.prepare.bind(db);
            let insertCount = 0;
            Object.defineProperty(db, "prepare", {
                configurable: true,
                value: (sql: string) => {
                    const statement = originalPrepare(sql);
                    if (!sql.includes("INSERT INTO pending_ops")) {
                        return statement;
                    }

                    return {
                        ...statement,
                        run: (...args: unknown[]) => {
                            insertCount += 1;
                            if (insertCount === 2) {
                                throw new Error("forced pending_ops failure");
                            }

                            return Reflect.apply(
                                statement.run as (...input: unknown[]) => unknown,
                                statement,
                                args,
                            );
                        },
                    };
                },
            });

            const result = await tools.ctx_reduce.execute({ drop: "1,2" }, toolContext());

            expect(result).toContain("Failed to queue ctx_reduce operations");
            expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        });
    });
});
