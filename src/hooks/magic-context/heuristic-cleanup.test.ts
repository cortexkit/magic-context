/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTagsBySession, insertTag, updateTagStatus } from "../../features/magic-context/storage";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import type { MessageLike, TagTarget } from "./tag-messages";

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      UNIQUE(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER
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
      system_prompt_hash INTEGER DEFAULT 0
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
                    protectedTags: 2,
                });

                //#then — tags 1-3 are tool tags older than cutoff (10-7=3), tags 4-5 are within age
                expect(result.droppedTools).toBe(3);
                const tags = getTagsBySession(db, SESSION);
                expect(tags.filter((t) => t.status === "dropped").length).toBe(3);
                expect(tags.filter((t) => t.status === "active").length).toBe(7);
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
                    protectedTags: 2,
                    dropAllTools: true,
                });

                //#then
                expect(result.droppedTools).toBe(3);
                const tags = getTagsBySession(db, SESSION);
                expect(tags.filter((t) => t.status === "dropped").map((t) => t.tagNumber)).toEqual([
                    1, 2, 3,
                ]);
            });
        });
    });
});
