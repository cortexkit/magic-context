import { beforeEach, describe, expect, it } from "bun:test";
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
      harness TEXT NOT NULL DEFAULT 'opencode'
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
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

function seedTags(
    db: Database,
    tags: Array<{ id: number; sessionId: string; status?: string; type?: string }>,
) {
    for (const [index, tag] of tags.entries()) {
        const rowId = 10_000 + tag.id + index;
        db.prepare(
            "INSERT INTO tags (id, message_id, type, status, byte_size, session_id, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            rowId,
            `msg-${tag.id}`,
            tag.type ?? "message",
            tag.status ?? "active",
            100,
            tag.sessionId,
            tag.id,
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
        tools = createCtxReduceTools({ db, protectedTags: 3 });
    });

    describe("ctx_reduce", () => {
        it("requires the drop parameter", async () => {
            const result = await tools.ctx_reduce.execute({}, toolContext());

            expect(result).toContain("Error");
            expect(result).toContain("'drop' must be provided");
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

            expect(result).toContain("Queued");
            expect(result).toContain("drop §3§, §4§, §5§");
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 3, operation: "drop" }),
                expect.objectContaining({ tag_id: 4, operation: "drop" }),
                expect.objectContaining({ tag_id: 5, operation: "drop" }),
            ]);
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

        it("queues protected tags as deferred when nothing else can be queued", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const result = await tools.ctx_reduce.execute({ drop: "9,10" }, toolContext());

            expect(result).toContain("Queued");
            expect(result).toContain("deferred drop §9§, §10§");
            expect(result).not.toContain("leave the last 3 active tags");
            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tag_id: 9, operation: "drop" }),
                expect.objectContaining({ tag_id: 10, operation: "drop" }),
            ]);
        });

        it("queues protected tags alongside immediate drops", async () => {
            seedTags(db, [
                { id: 1, sessionId: "ses-1" },
                { id: 8, sessionId: "ses-1" },
                { id: 9, sessionId: "ses-1" },
                { id: 10, sessionId: "ses-1" },
            ]);

            const result = await tools.ctx_reduce.execute({ drop: "1,9,10" }, toolContext());

            expect(result).toContain("Queued");
            expect(result).toContain("drop §1§");
            expect(result).toContain("deferred drop §9§, §10§");
            expect(result).not.toContain("Immediate drops will execute at optimal time");
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

        it("skips duplicate drop requests", async () => {
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

            expect(result).toContain("Queued");
            expect(result).toContain("§13§");
            expect(result).toContain("§14§");
            expect(result).toContain("2 requested tags were already queued and need no action");
        });

        it("returns terminal success wording when all requested tags are already queued", async () => {
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

            expect(result).toBe(
                "All requested tags were already queued or processed. No new action is needed.",
            );
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
