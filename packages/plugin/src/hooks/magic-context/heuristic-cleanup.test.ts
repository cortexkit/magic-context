/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTagsBySession, insertTag, updateTagStatus } from "../../features/magic-context/storage";
import { Database } from "../../shared/sqlite";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import type { MessageLike, TagTarget } from "./tag-messages";

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
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
      UNIQUE(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE IF NOT EXISTS session_meta (
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
    return d;
}

function makeTarget(message: { parts: unknown[] }): TagTarget {
    return {
        message: message as TagTarget["message"],
        setContent: (content: string) => {
            const textPart = message.parts.find((p: any) => p.type === "text") as any;
            if (!textPart) return false;
            if (textPart.text === content) return false;
            textPart.text = content;
            return true;
        },
        drop: () => {
            const idx = message.parts.findIndex((p: any) => p.type === "tool");
            if (idx >= 0) {
                message.parts.splice(idx, 1);
                return "removed" as const;
            }
            return "absent" as const;
        },
        truncate: () => {
            const toolPart = message.parts.find((p: any) => p.type === "tool") as
                | {
                      state?: {
                          input?: Record<string, unknown>;
                          output?: unknown;
                      };
                  }
                | undefined;
            if (!toolPart?.state) return "absent" as const;

            toolPart.state.output = "[truncated]";
            const inputSize = toolPart.state.input
                ? JSON.stringify(toolPart.state.input).length
                : 0;
            if (toolPart.state.input && inputSize > 500) {
                for (const key of Object.keys(toolPart.state.input)) {
                    const value = toolPart.state.input[key];
                    if (typeof value === "string") {
                        toolPart.state.input[key] =
                            value.length > 5 ? `${value.slice(0, 5)}...[truncated]` : value;
                    } else if (Array.isArray(value)) {
                        toolPart.state.input[key] = `[${value.length} items]`;
                    } else if (value !== null && typeof value === "object") {
                        toolPart.state.input[key] = "[object]";
                    }
                }
            }

            return "truncated" as const;
        },
    };
}

function buildMessageTagNumbers(
    entries: [number, { parts: unknown[] }][],
): Map<MessageLike, number> {
    const map = new Map<MessageLike, number>();
    for (const [tagNumber, msg] of entries) {
        map.set({ info: { role: "assistant" }, parts: msg.parts } as MessageLike, tagNumber);
    }
    return map;
}

describe("applyHeuristicCleanup", () => {
    const SESSION = "ses_test";
    let db: Database;

    beforeEach(() => {
        db = makeMemoryDatabase();
    });

    afterEach(() => {
        db.close();
    });

    describe("#given tool tags older than autoDropToolAge", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then auto-drops old tool tags beyond the age threshold", () => {
                //#given
                for (let i = 1; i <= 10; i++) {
                    insertTag(db, SESSION, `msg-${i}`, i <= 5 ? "tool" : "message", 1000, i);
                }
                const targets = new Map<number, TagTarget>();
                for (let i = 1; i <= 10; i++) {
                    const msg = {
                        parts:
                            i <= 5
                                ? [
                                      {
                                          type: "tool",
                                          tool: "grep",
                                          state: { output: "results", status: "completed" },
                                      },
                                  ]
                                : [{ type: "text", text: `message ${i}` }],
                    };
                    targets.set(i, makeTarget(msg));
                }

                //#when — autoDropToolAge=5 means tags 1-5 are within age (maxTag=10, cutoff=10-5=5)
                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 7,
                    dropToolStructure: true,
                    protectedTags: 2,
                });

                //#then — tags 1-3 are tool tags older than cutoff (10-7=3), tags 4-5 are within age
                expect(result.droppedTools).toBe(3);
                const tags = getTagsBySession(db, SESSION);
                expect(tags.filter((t) => t.status === "dropped").length).toBe(3);
                expect(tags.filter((t) => t.status === "active").length).toBe(7);
                expect(
                    tags.filter((t) => t.status === "dropped").every((t) => t.dropMode === "full"),
                ).toBe(true);
            });
        });
    });

    describe("#given reasoning with actual content", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then preserves non-cleared reasoning", () => {
                //#given
                insertTag(db, SESSION, "msg-1", "message", 500, 1);
                const msg = {
                    parts: [
                        { type: "reasoning", text: "I need to think about this carefully..." },
                        { type: "text", text: "my response" },
                    ],
                };
                const targets = new Map<number, TagTarget>();
                targets.set(1, makeTarget(msg));

                //#when
                applyHeuristicCleanup(SESSION, db, targets, buildMessageTagNumbers([[1, msg]]), {
                    autoDropToolAge: 100,
                    dropToolStructure: true,
                    protectedTags: 0,
                });

                //#then — reasoning preserved because it has real content
                expect(msg.parts).toHaveLength(2);
            });
        });
    });

    describe("#given protected tags", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then skips protected tags even if they are old tool outputs", () => {
                //#given
                for (let i = 1; i <= 5; i++) {
                    insertTag(db, SESSION, `msg-${i}`, "tool", 1000, i);
                }
                const targets = new Map<number, TagTarget>();
                for (let i = 1; i <= 5; i++) {
                    const msg = {
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "ok", status: "completed" },
                            },
                        ],
                    };
                    targets.set(i, makeTarget(msg));
                }

                //#when — protect last 3 tags (tags 3,4,5), autoDropToolAge=1 (cutoff=5-1=4)
                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 1,
                    dropToolStructure: true,
                    protectedTags: 3,
                });

                //#then — only tags 1-2 are outside protection AND older than age
                expect(result.droppedTools).toBe(2);
                const tags = getTagsBySession(db, SESSION);
                expect(tags.filter((t) => t.status === "dropped").map((t) => t.tagNumber)).toEqual([
                    1, 2,
                ]);
            });
        });
    });

    describe("#given already dropped tags", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then skips already dropped tags", () => {
                //#given
                insertTag(db, SESSION, "msg-1", "tool", 1000, 1);
                insertTag(db, SESSION, "msg-2", "tool", 1000, 2);
                insertTag(db, SESSION, "msg-10", "message", 500, 10);
                updateTagStatus(db, SESSION, 1, "dropped");

                const targets = new Map<number, TagTarget>();
                targets.set(
                    2,
                    makeTarget({
                        parts: [
                            {
                                type: "tool",
                                tool: "grep",
                                state: { output: "x", status: "completed" },
                            },
                        ],
                    }),
                );

                //#when
                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 5,
                    dropToolStructure: true,
                    protectedTags: 1,
                });

                //#then — only tag 2 dropped (tag 1 already dropped)
                expect(result.droppedTools).toBe(1);
            });
        });
    });

    describe("#given emergency materialization above 85%", () => {
        describe("#when executing heuristic cleanup with dropAllTools", () => {
            it("#then drops all unprotected tool tags regardless of age", () => {
                //#given
                for (let i = 1; i <= 5; i++) {
                    insertTag(db, SESSION, `msg-${i}`, "tool", 1000, i);
                }
                const targets = new Map<number, TagTarget>();
                for (let i = 1; i <= 5; i++) {
                    const msg = {
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "ok", status: "completed" },
                            },
                        ],
                    };
                    targets.set(i, makeTarget(msg));
                }

                //#when
                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 100,
                    dropToolStructure: true,
                    protectedTags: 2,
                    dropAllTools: true,
                });

                //#then
                expect(result.droppedTools).toBe(3);
                const tags = getTagsBySession(db, SESSION);
                expect(tags.filter((t) => t.status === "dropped").map((t) => t.tagNumber)).toEqual([
                    1, 2, 3,
                ]);
                expect(
                    tags.filter((t) => t.status === "dropped").every((t) => t.dropMode === "full"),
                ).toBe(true);
            });
        });
    });

    describe("#given old tool tags in truncation mode", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then keeps tool structure and truncates tool input/output in place", () => {
                insertTag(db, SESSION, "msg-1", "tool", 1000, 1);
                insertTag(db, SESSION, "msg-10", "message", 500, 10);

                const msg = {
                    parts: [
                        {
                            type: "tool",
                            tool: "grep",
                            state: {
                                input: {
                                    query: "abcdef",
                                    short: "abc",
                                    files: ["a", "b"],
                                    metadata: { nested: true },
                                    limit: 3,
                                    exact: true,
                                },
                                output: "full output",
                                status: "completed",
                            },
                        },
                    ],
                };
                const targets = new Map<number, TagTarget>([[1, makeTarget(msg)]]);

                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 5,
                    dropToolStructure: false,
                    protectedTags: 0,
                });

                expect(result.droppedTools).toBe(1);
                expect(msg.parts).toHaveLength(1);
                expect(msg.parts[0] as Record<string, unknown>).toEqual({
                    type: "tool",
                    tool: "grep",
                    state: {
                        input: {
                            query: "abcdef",
                            short: "abc",
                            files: ["a", "b"],
                            metadata: { nested: true },
                            limit: 3,
                            exact: true,
                        },
                        output: "[truncated]",
                        status: "completed",
                    },
                });
                expect(
                    getTagsBySession(db, SESSION).find((tag) => tag.tagNumber === 1)?.status,
                ).toBe("dropped");
                expect(
                    getTagsBySession(db, SESSION).find((tag) => tag.tagNumber === 1)?.dropMode,
                ).toBe("truncated");
            });

            it("#then fully removes tool parts when dropToolStructure is enabled", () => {
                insertTag(db, SESSION, "msg-1", "tool", 1000, 1);
                insertTag(db, SESSION, "msg-10", "message", 500, 10);

                const msg = {
                    parts: [
                        {
                            type: "tool",
                            tool: "grep",
                            state: {
                                input: { query: "abcdef" },
                                output: "full output",
                                status: "completed",
                            },
                        },
                    ],
                };
                const targets = new Map<number, TagTarget>([[1, makeTarget(msg)]]);

                const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                    autoDropToolAge: 5,
                    dropToolStructure: true,
                    protectedTags: 0,
                });

                expect(result.droppedTools).toBe(1);
                expect(msg.parts).toHaveLength(0);
                expect(
                    getTagsBySession(db, SESSION).find((tag) => tag.tagNumber === 1)?.status,
                ).toBe("dropped");
            });
        });
    });
});
