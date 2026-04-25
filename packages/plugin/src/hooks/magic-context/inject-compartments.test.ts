/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    prepareCompartmentInjection,
    renderCompartmentInjection,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_test_inject";
const PROJECT_PATH = "/tmp/test-inject-project";

let db: Database;

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    // session_meta row must exist for memory_block_cache writes
    d.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(SESSION_ID);
    return d;
}

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
});

describe("prepareCompartmentInjection — empty compartments fallback", () => {
    it("returns null when compartments, facts, and memories are all empty", () => {
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);
        expect(result).toBeNull();
        expect(messages.length).toBe(1);
    });

    it("injects memories-only block when no compartments exist", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "User prefers concise responses",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.compartmentEndMessage).toBe(0);
        expect(result?.compartmentEndMessageId).toBe("");
        expect(result?.skippedVisibleMessages).toBe(0);
        expect(result?.factCount).toBe(0);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("User prefers concise responses");
        // No splicing — original message preserved
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("m1");
    });

    it("injects facts-only block when compartments empty but facts exist", () => {
        db = makeDb();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Use SQLite" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "go")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.factCount).toBe(1);
        expect(result?.memoryCount).toBe(0);
        expect(result?.block).toContain("DECISIONS:");
        expect(result?.block).toContain("Use SQLite");
    });

    it("injects memories + facts combined block when no compartments", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "Never commit without tests",
        });
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Monorepo layout" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        expect(result).not.toBeNull();
        expect(result?.compartmentCount).toBe(0);
        expect(result?.factCount).toBe(1);
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("Never commit without tests");
        expect(result?.block).toContain("DECISIONS:");
    });

    it("renderCompartmentInjection wraps memory-only block in <session-history>", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const messages: MessageLike[] = [userMessage("m1", "original")];
        const prepared = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const renderResult = renderCompartmentInjection(SESSION_ID, messages, prepared);
        expect(renderResult.injected).toBe(true);
        expect(renderResult.compartmentCount).toBe(0);

        // First message should now contain session-history prefix
        const firstPart = messages[0].parts[0] as { type: string; text: string };
        expect(firstPart.text).toContain("<session-history>");
        expect(firstPart.text).toContain("</session-history>");
        expect(firstPart.text).toContain("test directive");
        expect(firstPart.text).toContain("original");
    });
});

describe("prepareCompartmentInjection — transition from empty to compartment", () => {
    it("switches from memories-only to boundary-based splice after first compartment", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "initial directive",
        });

        // Pass 1: no compartments yet — inject memories only
        const pass1Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass1 = prepareCompartmentInjection(
            db,
            SESSION_ID,
            pass1Messages,
            true,
            PROJECT_PATH,
        );
        expect(pass1?.compartmentCount).toBe(0);
        expect(pass1?.compartmentEndMessageId).toBe("");
        // No splice happened — both messages still present
        expect(pass1Messages.length).toBe(2);

        // Historian publishes compartment covering m1
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "first compartment",
                    content: "Summary of early messages.",
                },
            ],
            [],
        );
        clearInjectionCache(SESSION_ID);

        // Pass 2: compartment exists — boundary-based splice should remove m1
        const pass2Messages: MessageLike[] = [
            userMessage("m1", "hello"),
            userMessage("m2", "follow up"),
        ];
        const pass2 = prepareCompartmentInjection(
            db,
            SESSION_ID,
            pass2Messages,
            true,
            PROJECT_PATH,
        );
        expect(pass2?.compartmentCount).toBe(1);
        expect(pass2?.compartmentEndMessageId).toBe("m1");
        expect(pass2?.skippedVisibleMessages).toBe(1);
        // m1 spliced out — only m2 remains
        expect(pass2Messages.length).toBe(1);
        expect(pass2Messages[0].info.id).toBe("m2");
        expect(pass2?.block).toContain("first compartment");
        expect(pass2?.block).toContain("initial directive");
    });

    it("defer pass replays memories-only cached injection without splicing", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "directive",
        });

        // Bust pass: populate cache
        const bustMessages: MessageLike[] = [userMessage("m1", "hi")];
        const busted = prepareCompartmentInjection(
            db,
            SESSION_ID,
            bustMessages,
            true,
            PROJECT_PATH,
        );
        expect(busted?.compartmentCount).toBe(0);

        // Defer pass: should return cached without changing messages
        const deferMessages: MessageLike[] = [userMessage("m1", "hi"), userMessage("m2", "new")];
        const cached = prepareCompartmentInjection(
            db,
            SESSION_ID,
            deferMessages,
            false,
            PROJECT_PATH,
        );
        expect(cached).toBe(busted);
        // Empty boundary id ⇒ no splice
        expect(deferMessages.length).toBe(2);
    });
});

describe("prepareCompartmentInjection — SQLITE_BUSY handling (issue #23)", () => {
    it("swallows SQLITE_BUSY on memory_block_cache UPDATE and returns computed block anyway", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "never run migrations manually",
        });

        // Proxy the db to throw SQLITE_BUSY specifically on the UPDATE statement
        // used by memory_block_cache. Other prepares pass through unchanged so
        // the rest of prepareCompartmentInjection can complete normally.
        const busyProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_cache")) {
                            return {
                                run: () => {
                                    const err = new Error("database is locked") as Error & {
                                        code: string;
                                        errno: number;
                                    };
                                    err.code = "SQLITE_BUSY";
                                    err.errno = 5;
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        // Should not throw — the BUSY on the optional cache write must be swallowed.
        const result = prepareCompartmentInjection(
            busyProxy,
            SESSION_ID,
            messages,
            true,
            PROJECT_PATH,
        );

        expect(result).not.toBeNull();
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("never run migrations manually");
    });

    it("rethrows non-BUSY errors from memory_block_cache UPDATE", () => {
        db = makeDb();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "USER_DIRECTIVES",
            content: "test directive",
        });

        const errorProxy: Database = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        if (sql.includes("UPDATE session_meta SET memory_block_cache")) {
                            return {
                                run: () => {
                                    const err = new Error("schema mismatch") as Error & {
                                        code: string;
                                    };
                                    err.code = "SQLITE_CORRUPT";
                                    throw err;
                                },
                                get: () => null,
                                all: () => [],
                            };
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });

        const messages: MessageLike[] = [userMessage("m1", "hello")];
        expect(() =>
            prepareCompartmentInjection(errorProxy, SESSION_ID, messages, true, PROJECT_PATH),
        ).toThrow("schema mismatch");
    });
});
