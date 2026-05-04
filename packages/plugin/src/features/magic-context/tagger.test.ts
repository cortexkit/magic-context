/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { toDatabase } from "./mock-database";
import { createTagger } from "./tagger";
import type { TagEntry } from "./types";

interface StoredTag extends TagEntry {
    rowId: number;
}

// Mock DB that simulates bun:sqlite interface
function createMockDb(options?: { failCounterWrite?: boolean; rollbackTransactions?: boolean }) {
    const tags: StoredTag[] = [];
    const sessionMeta: Record<string, { counter: number }> = {};
    let nextId = 1;

    const prepare = mock((sql: string) => {
        if (sql.includes("INSERT INTO tags")) {
            return {
                run: (
                    sessionId: string,
                    messageId: string,
                    type: TagEntry["type"],
                    byteSize: number,
                    _reasoningByteSize: number,
                    _tagNumber: number,
                    toolName?: string | null,
                    inputByteSize?: number,
                ) => {
                    const tag: StoredTag = {
                        rowId: nextId++,
                        messageId,
                        type,
                        status: "active",
                        dropMode: "full",
                        toolName: toolName ?? null,
                        inputByteSize: inputByteSize ?? 0,
                        byteSize,
                        reasoningByteSize: _reasoningByteSize ?? 0,
                        sessionId,
                        tagNumber: _tagNumber,
                    };
                    tags.push(tag);
                    return { lastInsertRowid: tag.rowId };
                },
                get: () => undefined,
            };
        }
        if (sql.includes("SELECT counter FROM session_meta")) {
            return {
                get: (sessionId: string) => sessionMeta[sessionId] ?? null,
                run: () => {},
            };
        }
        if (sql.includes("SELECT message_id, tag_number FROM tags")) {
            return {
                all: (sessionId: string) =>
                    tags
                        .filter((tag) => tag.sessionId === sessionId)
                        .map((tag) => ({ message_id: tag.messageId, tag_number: tag.tagNumber })),
            };
        }
        if (sql.includes("UPDATE session_meta") || sql.includes("INSERT INTO session_meta")) {
            return {
                run: (sessionId: string, counter: number) => {
                    if (options?.failCounterWrite) {
                        throw new Error("counter write failed");
                    }
                    if (!sessionMeta[sessionId]) {
                        sessionMeta[sessionId] = { counter: 0 };
                    }
                    sessionMeta[sessionId].counter = counter;
                },
                get: () => undefined,
            };
        }
        return { run: () => {}, get: () => undefined };
    });

    const transaction = mock((callback: () => void) => {
        return () => {
            if (!options?.rollbackTransactions) {
                callback();
                return;
            }

            const tagsSnapshot = tags.map((tag) => ({ ...tag }));
            const sessionMetaSnapshot = structuredClone(sessionMeta);
            try {
                callback();
            } catch (error) {
                tags.splice(0, tags.length, ...tagsSnapshot);
                for (const key of Object.keys(sessionMeta)) {
                    delete sessionMeta[key];
                }
                Object.assign(sessionMeta, sessionMetaSnapshot);
                throw error;
            }
        };
    });

    return {
        tags,
        sessionMeta,
        prepare,
        transaction,
    };
}

describe("createTagger", () => {
    let tagger: ReturnType<typeof createTagger>;
    let db: ReturnType<typeof createMockDb>;

    beforeEach(() => {
        tagger = createTagger();
        db = createMockDb();
    });

    describe("assignTag", () => {
        it("assigns sequential tags starting from 1", () => {
            //#given
            const sessionId = "session-1";

            //#when
            const tag1 = tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            const tag2 = tagger.assignTag(sessionId, "msg-2", "message", 200, toDatabase(db));
            const tag3 = tagger.assignTag(sessionId, "tool-1", "tool", 300, toDatabase(db));

            //#then
            expect(tag1).toBe(1);
            expect(tag2).toBe(2);
            expect(tag3).toBe(3);
        });

        it("is idempotent — same messageId returns same tag", () => {
            //#given
            const sessionId = "session-1";
            const messageId = "msg-1";

            //#when
            const first = tagger.assignTag(sessionId, messageId, "message", 100, toDatabase(db));
            const second = tagger.assignTag(sessionId, messageId, "message", 100, toDatabase(db));
            const third = tagger.assignTag(sessionId, messageId, "message", 999, toDatabase(db));

            //#then
            expect(first).toBe(second);
            expect(second).toBe(third);
        });

        it("does not increment counter on idempotent re-assignment", () => {
            //#given
            const sessionId = "session-1";

            //#when
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db)); // idempotent
            const tag2 = tagger.assignTag(sessionId, "msg-2", "message", 200, toDatabase(db));

            //#then
            expect(tag2).toBe(2); // counter only incremented once for msg-1
        });

        it("uses single unified counter for both tool and message types", () => {
            //#given
            const sessionId = "session-1";

            //#when
            const msgTag = tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            const toolTag = tagger.assignTag(sessionId, "tool-1", "tool", 200, toDatabase(db));

            //#then
            expect(msgTag).toBe(1);
            expect(toolTag).toBe(2); // unified counter, not separate namespaces
        });

        it("persists tool metadata when provided", () => {
            //#given
            const sessionId = "session-1";

            //#when
            tagger.assignTag(sessionId, "tool-1", "tool", 200, toDatabase(db), 0, "read", 321);

            //#then
            expect(db.tags[0]).toMatchObject({
                dropMode: "full",
                toolName: "read",
                inputByteSize: 321,
            });
        });

        it("wraps insert + counter upsert in a transaction", () => {
            //#given
            const sessionId = "session-1";

            //#when
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));

            //#then
            expect(db.transaction).toHaveBeenCalledTimes(1);
            const sqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            expect(sqls.some((sql: string) => sql.includes("INSERT INTO tags"))).toBe(true);
            expect(sqls.some((sql: string) => sql.includes("INSERT INTO session_meta"))).toBe(true);
        });

        it("does not increment counter when transaction fails", () => {
            //#given
            const sessionId = "session-1";
            const failingDb = createMockDb();
            failingDb.transaction = mock(() => {
                return () => {
                    throw new Error("DB write failed");
                };
            });

            //#when
            let threw = false;
            try {
                tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(failingDb));
            } catch {
                threw = true;
            }

            //#then
            expect(threw).toBe(true);
            expect(tagger.getCounter(sessionId)).toBe(0);
            expect(tagger.getTag(sessionId, "msg-1")).toBeUndefined();
        });

        it("rolls back inserted tag when counter persistence fails after insert", () => {
            //#given
            const sessionId = "session-1";
            const failingDb = createMockDb({ failCounterWrite: true, rollbackTransactions: true });

            //#when
            expect(() =>
                tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(failingDb)),
            ).toThrow("counter write failed");

            //#then
            expect(failingDb.tags).toHaveLength(0);
            expect(failingDb.sessionMeta[sessionId]).toBeUndefined();
            expect(tagger.getCounter(sessionId)).toBe(0);
            expect(tagger.getTag(sessionId, "msg-1")).toBeUndefined();
        });
    });

    describe("getTag", () => {
        it("returns undefined for unknown messageId", () => {
            //#given
            const sessionId = "session-1";

            //#when
            const result = tagger.getTag(sessionId, "unknown-msg");

            //#then
            expect(result).toBeUndefined();
        });

        it("returns existing tag after assignment", () => {
            //#given
            const sessionId = "session-1";
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));

            //#when
            const result = tagger.getTag(sessionId, "msg-1");

            //#then
            expect(result).toBe(1);
        });
    });

    describe("getCounter", () => {
        it("returns 0 for unseen session", () => {
            //#when
            const counter = tagger.getCounter("new-session");

            //#then
            expect(counter).toBe(0);
        });

        it("returns current counter value after assignments", () => {
            //#given
            const sessionId = "session-1";
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionId, "msg-2", "message", 200, toDatabase(db));

            //#when
            const counter = tagger.getCounter(sessionId);

            //#then
            expect(counter).toBe(2);
        });
    });

    describe("resetCounter", () => {
        it("resets counter to 0 and clears assignments", () => {
            //#given
            const sessionId = "session-1";
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionId, "msg-2", "message", 200, toDatabase(db));

            //#when
            tagger.resetCounter(sessionId, toDatabase(db));

            //#then
            expect(tagger.getCounter(sessionId)).toBe(0);
            expect(tagger.getTag(sessionId, "msg-1")).toBeUndefined();
            expect(tagger.getTag(sessionId, "msg-2")).toBeUndefined();
        });

        it("allows new sequential assignment after reset", () => {
            //#given
            const sessionId = "session-1";
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            tagger.resetCounter(sessionId, toDatabase(db));

            //#when
            const newTag = tagger.assignTag(sessionId, "msg-new", "message", 100, toDatabase(db));

            //#then
            expect(newTag).toBe(1); // starts from 1 again
        });
    });

    describe("separate counters per session", () => {
        it("maintains independent counters for different sessions", () => {
            //#given
            const sessionA = "session-a";
            const sessionB = "session-b";

            //#when
            const a1 = tagger.assignTag(sessionA, "msg-1", "message", 100, toDatabase(db));
            const b1 = tagger.assignTag(sessionB, "msg-1", "message", 100, toDatabase(db));
            const a2 = tagger.assignTag(sessionA, "msg-2", "message", 200, toDatabase(db));

            //#then
            expect(a1).toBe(1);
            expect(b1).toBe(1); // session B starts its own counter at 1
            expect(a2).toBe(2);
        });

        it("resetting one session does not affect another", () => {
            //#given
            const sessionA = "session-a";
            const sessionB = "session-b";
            tagger.assignTag(sessionA, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionB, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionB, "msg-2", "message", 200, toDatabase(db));

            //#when
            tagger.resetCounter(sessionA, toDatabase(db));

            //#then
            expect(tagger.getCounter(sessionA)).toBe(0);
            expect(tagger.getCounter(sessionB)).toBe(2); // unaffected
        });
    });

    describe("initFromDb", () => {
        it("loads counter from session_meta on init", () => {
            //#given
            const sessionId = "session-restored";
            db.sessionMeta[sessionId] = { counter: 5 };

            //#when
            tagger.initFromDb(sessionId, toDatabase(db));

            //#then
            expect(tagger.getCounter(sessionId)).toBe(5);
        });

        it("starts at 0 if no session_meta record exists", () => {
            //#given
            const sessionId = "brand-new-session";

            //#when
            tagger.initFromDb(sessionId, toDatabase(db));

            //#then
            expect(tagger.getCounter(sessionId)).toBe(0);
        });

        it("continues assigning from loaded counter value", () => {
            //#given
            const sessionId = "session-restored";
            db.sessionMeta[sessionId] = { counter: 3 };
            tagger.initFromDb(sessionId, toDatabase(db));

            //#when
            const nextTag = tagger.assignTag(sessionId, "msg-new", "message", 100, toDatabase(db));

            //#then
            expect(nextTag).toBe(4); // continues from 3
        });

        it("restores assignments so re-tagging existing message IDs is stable after restart", () => {
            //#given
            const sessionId = "session-restart";
            tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            tagger.assignTag(sessionId, "msg-2", "message", 100, toDatabase(db));

            const restarted = createTagger();
            restarted.initFromDb(sessionId, toDatabase(db));

            //#when
            const msg1Tag = restarted.assignTag(sessionId, "msg-1", "message", 100, toDatabase(db));
            const nextTag = restarted.assignTag(sessionId, "msg-3", "message", 100, toDatabase(db));

            //#then
            expect(msg1Tag).toBe(1);
            expect(nextTag).toBe(3);
        });
    });
});
