/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    appendCompartments,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import {
    getMemoriesByProject,
    insertMemory,
    setMemoryClassification,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { unifiedSearch } from "../../features/magic-context/search";
import {
    bumpSessionFactsVersion,
    getOrCreateSessionMeta,
    queueM0Mutation,
    queueMemoryMutation,
    setProjectState,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { insertUserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    COMPARTMENT_RENDER_EPOCH,
    encodeCachedM0UpgradeIdentity,
} from "./compartment-render-epoch";
import {
    clearInjectionCache,
    getVisibleMemoryIds,
    injectM0M1,
    MaterializeContentionError,
    materializeM0,
    materializeWithRetry,
    mustMaterialize,
    prepareCompartmentInjection,
    readCurrentM0SnapshotMarkers,
    renderCompartmentInjection,
    renderM1,
    renderMemoryBlockV2,
    renderMemoryLineV2,
    trimMemoriesToBudgetV2,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_test_inject";
const PROJECT_PATH = "/tmp/test-inject-project";

let db: Database;
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    // session_meta row must exist for memory_block_cache writes
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-renderer-test-"));
    tempDirs.push(dir);
    return dir;
}

function createUserMemoryTable(): void {
    db.exec(`
        CREATE TABLE user_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            promoted_at INTEGER NOT NULL,
            source_candidate_ids TEXT DEFAULT '[]',
            source_candidate_provenance TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
}

function createOpenCodeMessageTimes(rows: Array<{ id: string; timestamp: number }>): void {
    const dataHome = mkdtempSync(join(tmpdir(), "mc-inject-dates-"));
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_CACHE_HOME = dataHome;
    closeReadOnlySessionDb();

    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const source = new Database(dbPath);
    try {
        source.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL
            );
        `);
        const insert = source.prepare(
            "INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)",
        );
        for (const row of rows) insert.run(row.id, SESSION_ID, row.timestamp);
    } finally {
        source.close();
    }
}

function readStateFromMeta(): ReturnType<typeof getOrCreateSessionMeta> {
    return getOrCreateSessionMeta(db, SESSION_ID);
}

function renderedText(message: MessageLike): string {
    const part = message.parts[0] as { type: string; text?: string } | undefined;
    return part?.type === "text" ? (part.text ?? "") : "";
}

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    };
}

function storeDatedCompartment(): void {
    replaceAllCompartmentState(
        db,
        SESSION_ID,
        [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "dated compartment",
                content: "full summary",
                p1: "full summary",
                p2: "dense summary",
                p3: "brief summary",
                p4: "anchor",
                importance: 80,
            },
        ],
        [],
    );
}

afterEach(() => {
    if (db) db.close();
    closeReadOnlySessionDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function renderMemory(id: number, category: string, content: string, importance = 50): Memory {
    return { id, category, content, importance } as unknown as Memory;
}

describe("compact project-memory wire", () => {
    it("groups by canonical then alphabetical categories and escapes facts and attribution", () => {
        const memories = [
            renderMemory(9, "Z_LEGACY", "last"),
            renderMemory(5, "ARCHITECTURE", "owned by service"),
            renderMemory(4, "PROJECT_RULES", "second rule"),
            renderMemory(3, "PROJECT_RULES", "use <fast> & safe mode"),
            renderMemory(8, "A&LEGACY", "first unknown"),
        ];

        expect(
            renderMemoryBlockV2(memories, "project-memory", {
                sourceNameByMemoryId: new Map([[5, "svc<&"]]),
            }),
        ).toBe(`<project-memory>
<PROJECT_RULES>
#3: use &lt;fast&gt; &amp; safe mode
#4: second rule
</PROJECT_RULES>
<ARCHITECTURE>
#5 [svc&lt;&amp;]: owned by service
</ARCHITECTURE>
<A&amp;LEGACY>
#8: first unknown
</A&amp;LEGACY>
<Z_LEGACY>
#9: last
</Z_LEGACY>
</project-memory>`);
        expect(renderMemoryLineV2(memories[0]!)).toBe("#9: last");
    });

    it("measures the complete grouped block so a dropped category has no tag overhead", () => {
        const kept = renderMemory(1, "PROJECT_RULES", "always run focused tests", 100);
        const dropped = renderMemory(2, "ARCHITECTURE", "a separate category", 1);
        const budget = estimateTokens(renderMemoryBlockV2([kept]));
        expect(estimateTokens(renderMemoryBlockV2([kept, dropped]))).toBeGreaterThan(budget);

        const trimmed = trimMemoriesToBudgetV2(SESSION_ID, [dropped, kept], budget);
        expect(trimmed.selected.map((memory) => memory.id)).toEqual([kept.id]);
        const block = renderMemoryBlockV2(trimmed.renderOrder);
        expect(estimateTokens(block)).toBeLessThanOrEqual(budget);
        expect(block).not.toContain("<ARCHITECTURE>");
    });

    it("keeps rendered bytes identical across importance-only classification updates", () => {
        db = makeDb();
        const inserted = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "Never bypass the validation gate.",
            importance: 20,
        });
        const before = renderMemoryBlockV2(getMemoriesByProject(db, PROJECT_PATH));

        expect(setMemoryClassification(db, inserted.id, { importance: 95 })).toBe(true);
        const after = renderMemoryBlockV2(getMemoriesByProject(db, PROJECT_PATH));

        expect(after).toBe(before);
        expect(after).not.toContain("importance");
    });
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

    it("does NOT render session_facts (v2: facts retired as a render source)", () => {
        db = makeDb();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [],
            [{ category: "DECISIONS", content: "Use SQLite" }],
        );

        const messages: MessageLike[] = [userMessage("m1", "go")];
        const result = prepareCompartmentInjection(db, SESSION_ID, messages, true, PROJECT_PATH);

        // v2 faithful facts: session_facts is no longer a render source. With no
        // compartments and no memories, there is nothing to inject — facts alone
        // do NOT produce a block (they live as promoted memories instead).
        expect(result).toBeNull();
    });

    it("injects memories block (facts not rendered) when no compartments", () => {
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
        // v2: facts are retired from rendering (factCount reflects rendered facts = 0).
        expect(result?.memoryCount).toBe(1);
        expect(result?.block).toContain("<project-memory>");
        expect(result?.block).toContain("Never commit without tests");
        // The session_fact ("Monorepo layout") must NOT appear in the block.
        expect(result?.block).not.toContain("Monorepo layout");
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

describe("prepareCompartmentInjection — cross-database cache isolation", () => {
    it("does not replay a block rendered from a different database", () => {
        // The injection cache is process-global and keyed by session id alone,
        // while the value it holds is rendered FROM a database. Two independent
        // stores that share a session id must not see each other's blocks.
        const first = makeDb();
        try {
            insertMemory(first, {
                projectPath: PROJECT_PATH,
                category: "CONSTRAINTS",
                content: "MEMORY-ONLY-IN-FIRST-DATABASE",
            });
            const populated = prepareCompartmentInjection(
                first,
                SESSION_ID,
                [userMessage("m1", "hi")],
                true,
                PROJECT_PATH,
            );
            expect(populated?.block).toContain("MEMORY-ONLY-IN-FIRST-DATABASE");
        } finally {
            closeQuietly(first);
        }

        // Second store: same session id, no memories, and a DEFER pass — the
        // path that replays the cached injection.
        db = makeDb();
        const messages: MessageLike[] = [userMessage("m1", "hi")];
        const replayed = prepareCompartmentInjection(db, SESSION_ID, messages, false, PROJECT_PATH);

        expect(replayed?.block ?? "").not.toContain("MEMORY-ONLY-IN-FIRST-DATABASE");
        expect(replayed).toBeNull();
    });
});

describe("prepareCompartmentInjection — workspace memory sharing", () => {
    it("renders only explicitly shared foreign memory categories", () => {
        db = makeDb();
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, '${PROJECT_PATH}', 'Own', '${PROJECT_PATH}', 1),
                   (1, '/tmp/foreign-project', 'Foreign', '/tmp/foreign-project', 1);
        `);
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "NAMING",
            content: "own workspace naming remains visible",
        });
        const foreignShared = insertMemory(db, {
            projectPath: "/tmp/foreign-project",
            category: "CONSTRAINTS",
            content: "foreign workspace constraint is shared",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignShared.id);
        insertMemory(db, {
            projectPath: "/tmp/foreign-project",
            category: "NAMING",
            content: "foreign workspace naming is hidden",
        });
        insertMemory(db, {
            projectPath: "/tmp/foreign-project",
            category: "CONSTRAINTS",
            content: "foreign private constraint is hidden",
        });
        const archived = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "archived high id is hidden",
        });
        db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);
        const expired = insertMemory(db, {
            projectPath: "/tmp/foreign-project",
            category: "CONSTRAINTS",
            content: "expired high id is hidden",
            expiresAt: 1,
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(expired.id);

        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });

        expect(result.m0Text).toContain("own workspace naming remains visible");
        expect(result.m0Text).toContain("foreign workspace constraint is shared");
        expect(result.m0Text).not.toContain("foreign workspace naming is hidden");
        expect(result.m0Text).not.toContain("foreign private constraint is hidden");
        expect(result.m0Text).not.toContain("archived high id is hidden");
        expect(result.m0Text).not.toContain("expired high id is hidden");
        expect(result.snapshotMarkers.maxMemoryId).toBe(foreignShared.id);
    });

    it("does not render foreign memories when share_categories is malformed", () => {
        db = makeDb();
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', 'not-json', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, '${PROJECT_PATH}', 'Own', '${PROJECT_PATH}', 1),
                   (1, '/tmp/foreign-project', 'Foreign', '/tmp/foreign-project', 1);
        `);
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "CONSTRAINTS",
            content: "own malformed workspace memory remains visible",
        });
        insertMemory(db, {
            projectPath: "/tmp/foreign-project",
            category: "CONSTRAINTS",
            content: "foreign malformed workspace memory is hidden",
        });

        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });

        expect(result.m0Text).toContain("own malformed workspace memory remains visible");
        expect(result.m0Text).not.toContain("foreign malformed workspace memory is hidden");
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
        // Replayed-from-cache output must match the busted output structurally
        // on every field except `rebuiltFromDb` — that flag intentionally
        // differs (true on bust, false on replay) as a per-pass provenance
        // signal consumed by the postprocess drain. Plan v6.
        expect(busted?.rebuiltFromDb).toBe(true);
        expect(cached?.rebuiltFromDb).toBe(false);
        expect(cached?.block).toBe(busted?.block);
        expect(cached?.compartmentEndMessage).toBe(busted?.compartmentEndMessage);
        expect(cached?.compartmentEndMessageId).toBe(busted?.compartmentEndMessageId);
        expect(cached?.compartmentCount).toBe(busted?.compartmentCount);
        expect(cached?.skippedVisibleMessages).toBe(busted?.skippedVisibleMessages);
        expect(cached?.factCount).toBe(busted?.factCount);
        expect(cached?.memoryCount).toBe(busted?.memoryCount);
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

describe("m[0]/m[1] materialization", () => {
    it("renders complete date ranges into m[0] only when temporal awareness is enabled", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);

        const rendered = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            temporalAwareness: true,
        });

        expect(rendered.m0Text).toContain("## 1-2 · 2026-01-02→03 · dated compartment");
    });

    it("omits compartment date ranges from m[0] when temporal awareness is disabled", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);

        const rendered = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            temporalAwareness: false,
        });

        expect(rendered.m0Text).toContain("## 1-2 · dated compartment");
        expect(rendered.m0Text).not.toContain("2026-01-02");
    });

    it("replays date-bearing m[0]/m[1] bytes unchanged on consecutive defer passes", () => {
        db = makeDb();
        storeDatedCompartment();
        createOpenCodeMessageTimes([
            { id: "m1", timestamp: new Date(2026, 0, 2, 12).getTime() },
            { id: "m2", timestamp: new Date(2026, 0, 3, 12).getTime() },
        ]);
        const state = readStateFromMeta();

        const first = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: true,
        });
        const second = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: false,
        });
        const third = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            temporalAwareness: true,
            isCacheBustingPass: false,
        });

        expect(first.m0Bytes?.toString("utf8")).toContain(
            "## 1-2 · 2026-01-02→03 · dated compartment",
        );
        expect(second.m0Bytes).toEqual(first.m0Bytes);
        expect(second.m1Text).toBe(first.m1Text);
        expect(third.m0Bytes).toEqual(second.m0Bytes);
        expect(third.m1Text).toBe(second.m1Text);
    });

    it("keeps mixed message bytes identical when the marker probe replays cached injection", () => {
        db = makeDb();
        const state = readStateFromMeta();
        const fixture = [
            userMessage("mixed-user", "[dropped §1§] user boundary"),
            {
                info: { id: "mixed-a", role: "assistant", sessionID: SESSION_ID },
                parts: [
                    { type: "reasoning", text: "signed reasoning", signature: "sig" },
                    { type: "text", text: "<thinking>inline trace</thinking>answer" },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
                ],
            },
            {
                info: { id: "mixed-b", role: "assistant", sessionID: SESSION_ID },
                parts: [{ type: "text", text: "[dropped §2§]" }],
            },
        ] as unknown as MessageLike[];
        const firstMessages = structuredClone(fixture) as MessageLike[];
        const secondMessages = structuredClone(fixture) as MessageLike[];

        const first = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            isCacheBustingPass: true,
        });
        const second = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: secondMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            isCacheBustingPass: false,
        });

        expect(first.prependedMessageCount).toBe(2);
        expect(second.prependedMessageCount).toBe(2);
        expect(second.m0Bytes).toEqual(first.m0Bytes);
        expect(second.m1Text).toBe(first.m1Text);
        expect(JSON.stringify(secondMessages)).toBe(JSON.stringify(firstMessages));
    });

    it("mustMaterialize returns true on first call", () => {
        db = makeDb();
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: makeProjectDir(),
        });
        expect(decision).toEqual({ value: true, reason: "first_render" });
    });

    it("mustMaterialize returns false when cached markers match current state", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();

        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(decision).toEqual({ value: false, reason: null });
    });

    it("invalidates cached marker reads after background writes for every observed marker", () => {
        type MutableMarkerField =
            | "projectMemoryEpoch"
            | "workspaceFingerprint"
            | "projectUserProfileVersion"
            | "maxCompartmentSeq"
            | "maxMemoryId"
            | "maxMutationId"
            | "maxMemoryMutationId"
            | "sessionFactsVersion"
            | "upgradeState";
        const cases: Array<{
            name: string;
            field: MutableMarkerField;
            mutate: (writer: Database) => void;
            changes: boolean;
        }> = [
            {
                name: "project memory epoch",
                field: "projectMemoryEpoch",
                mutate: (writer) => {
                    setProjectState(writer, PROJECT_PATH, { projectMemoryEpoch: 1 });
                },
                changes: true,
            },
            {
                name: "workspace membership",
                field: "workspaceFingerprint",
                mutate: (writer) => {
                    const workspaceId = Number(
                        (
                            writer
                                .prepare(
                                    "INSERT INTO workspaces (name, created_at, updated_at) VALUES (?, ?, ?)",
                                )
                                .run("background-workspace", 1, 1) as { lastInsertRowid: number }
                        ).lastInsertRowid,
                    );
                    const insertMember = writer.prepare(
                        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at) VALUES (?, ?, ?, ?, ?)",
                    );
                    insertMember.run(workspaceId, PROJECT_PATH, "primary", PROJECT_PATH, 1);
                    insertMember.run(
                        workspaceId,
                        "/tmp/background-member",
                        "background",
                        "/tmp/background-member",
                        1,
                    );
                },
                changes: true,
            },
            {
                name: "global user profile version",
                field: "projectUserProfileVersion",
                mutate: (writer) => {
                    setProjectState(writer, "__global__", { projectUserProfileVersion: 1 });
                },
                changes: true,
            },
            {
                name: "historian compartment publish",
                field: "maxCompartmentSeq",
                mutate: (writer) => {
                    appendCompartments(writer, SESSION_ID, [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 1,
                            title: "background publish",
                            content: "background summary",
                        },
                    ]);
                },
                changes: true,
            },
            {
                name: "memory write",
                field: "maxMemoryId",
                mutate: (writer) => {
                    insertMemory(writer, {
                        projectPath: PROJECT_PATH,
                        category: "PROJECT_RULES",
                        content: "Background memory write must invalidate the probe.",
                    });
                },
                changes: true,
            },
            {
                name: "m0 mutation",
                field: "maxMutationId",
                mutate: (writer) => {
                    queueM0Mutation(writer, {
                        sessionId: SESSION_ID,
                        mutationType: "compartment_merge",
                        queuedAt: 1,
                    });
                },
                changes: true,
            },
            {
                name: "memory mutation",
                field: "maxMemoryMutationId",
                mutate: (writer) => {
                    queueMemoryMutation(writer, {
                        projectPath: PROJECT_PATH,
                        mutationType: "update",
                        targetMemoryId: 1,
                        newContent: "updated in background",
                        queuedAt: 1,
                    });
                },
                changes: true,
            },
            {
                name: "retired session facts version",
                field: "sessionFactsVersion",
                mutate: (writer) => {
                    bumpSessionFactsVersion(writer, SESSION_ID);
                },
                changes: false,
            },
            {
                name: "legacy upgrade state",
                field: "upgradeState",
                mutate: (writer) => {
                    writer
                        .prepare(
                            `INSERT INTO compartments
                                (session_id, sequence, start_message, end_message, title, content, legacy, created_at)
                             VALUES (?, 0, 1, 1, 'legacy', 'legacy summary', 1, 1)`,
                        )
                        .run(SESSION_ID);
                },
                changes: true,
            },
        ];

        for (const testCase of cases) {
            const directory = makeProjectDir();
            const reader = new Database(join(directory, `${testCase.field}.db`));
            initializeDatabase(reader);
            getOrCreateSessionMeta(reader, SESSION_ID);
            const writer = new Database(join(directory, `${testCase.field}.db`));
            initializeDatabase(writer);
            try {
                const before = readCurrentM0SnapshotMarkers({
                    db: reader,
                    sessionId: SESSION_ID,
                    projectPath: PROJECT_PATH,
                    projectDirectory: "",
                });
                testCase.mutate(writer);
                const after = readCurrentM0SnapshotMarkers({
                    db: reader,
                    sessionId: SESSION_ID,
                    projectPath: PROJECT_PATH,
                    projectDirectory: "",
                });

                if (testCase.changes) {
                    expect(after[testCase.field], testCase.name).not.toEqual(
                        before[testCase.field],
                    );
                } else {
                    expect(after[testCase.field], testCase.name).toEqual(before[testCase.field]);
                }
            } finally {
                closeQuietly(writer);
                closeQuietly(reader);
            }
        }
    });

    it("uses one cached statement execution for an unchanged marker decision", () => {
        db = makeDb();
        let prepares = 0;
        let executions = 0;
        const observedDb = new Proxy(db, {
            get(target, property, receiver) {
                if (property !== "prepare") return Reflect.get(target, property, receiver);
                return (sql: string) => {
                    prepares += 1;
                    const statement = target.prepare(sql);
                    if (!sql.includes("json_each(?)")) return statement;
                    return {
                        get: (...parameters: unknown[]) => {
                            executions += 1;
                            return statement.get(...parameters);
                        },
                    };
                };
            },
        }) as Database;
        const args = {
            db: observedDb,
            sessionId: SESSION_ID,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        };

        const before = readCurrentM0SnapshotMarkers(args);
        prepares = 0;
        executions = 0;
        const after = readCurrentM0SnapshotMarkers(args);

        expect(after).toMatchObject({
            projectMemoryEpoch: before.projectMemoryEpoch,
            workspaceFingerprint: before.workspaceFingerprint,
            projectUserProfileVersion: before.projectUserProfileVersion,
            maxCompartmentSeq: before.maxCompartmentSeq,
            maxMemoryId: before.maxMemoryId,
            maxMutationId: before.maxMutationId,
            maxMemoryMutationId: before.maxMemoryMutationId,
            sessionFactsVersion: before.sessionFactsVersion,
            upgradeState: before.upgradeState,
        });
        expect(prepares).toBe(0);
        expect(executions).toBe(1);
    });

    it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
        ).run(
            Buffer.from("<session-history>legacy renderer bytes</session-history>"),
            "ready",
            SESSION_ID,
        );
        const state = readStateFromMeta();

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: true, reason: "compartment_render_epoch" });

        const folded = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const replay1 = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const replay2 = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(folded.m0RematerializedThisPass).toBe(true);
        expect(folded.decision.reason).toBe("compartment_render_epoch");
        expect(replay1.m0RematerializedThisPass).toBe(false);
        expect(replay2.m0RematerializedThisPass).toBe(false);
        expect(replay1.m0Bytes).toEqual(folded.m0Bytes);
        expect(replay2.m0Bytes).toEqual(folded.m0Bytes);
        expect(replay1.m1Text).toBe(folded.m1Text);
        expect(replay2.m1Text).toBe(folded.m1Text);
        expect(state.cachedM0UpgradeState).toContain(COMPARTMENT_RENDER_EPOCH);
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: false, reason: null });
    });

    it("keeps single-project m[0]/m[1] bytes identical with the no-workspace context", () => {
        const render = (explicitSingleProjectContext: boolean): string => {
            const localDb = makeDb();
            try {
                insertMemory(localDb, {
                    projectPath: PROJECT_PATH,
                    category: "CONSTRAINTS",
                    content: "Never commit without tests",
                });
                const rendered = materializeM0({
                    db: localDb,
                    sessionId: SESSION_ID,
                    state: getOrCreateSessionMeta(localDb, SESSION_ID),
                    projectPath: PROJECT_PATH,
                    projectDirectory: "",
                    workspaceIdentitySet: explicitSingleProjectContext
                        ? { identities: [PROJECT_PATH], namesByIdentity: new Map() }
                        : undefined,
                });
                return `${rendered.m0Bytes.toString("utf8")}\n---m1---\n${rendered.m1Text}`;
            } finally {
                closeQuietly(localDb);
            }
        };

        expect(render(true)).toBe(render(false));
    });

    it("mustMaterialize detects project_memory_epoch decreases after DB restore", () => {
        db = makeDb();
        setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 4 });
        const state = {
            ...readStateFromMeta(),
            cachedM0Bytes: Buffer.from("<session-history></session-history>"),
            cachedM1Bytes: Buffer.from("<session-history-since></session-history-since>"),
            cachedM0ProjectMemoryEpoch: 5,
            cachedM0ProjectUserProfileVersion: 0,
            cachedM0MaxCompartmentSeq: 0,
            cachedM0MaxMemoryId: 0,
            cachedM0MaxMutationId: 0,
            cachedM0ProjectDocsHash: "",
            cachedM0SessionFactsVersion: 0,
            cachedM0UpgradeState: encodeCachedM0UpgradeIdentity(
                "ready",
                COMPARTMENT_RENDER_EPOCH,
                false,
                "m8000-h60000",
            ),
        };

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory: makeProjectDir(),
            }).reason,
        ).toBe("project_memory_epoch");
    });

    it("mustMaterialize folds when a cached WORKSPACED m[0] becomes single-project", () => {
        // Transition guard: a cached union m[0] carries a non-null workspace
        // fingerprint; if the session then LEAVES its workspace, the current pass
        // is single-project (fingerprint null). Keying the HARD gate only on the
        // current `isWorkspaced` would fall through to the integer-epoch compare
        // and keep rendering the stale union if a membership bump were missed.
        // The fix compares fingerprints whenever EITHER side is non-null.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        // Simulate a cached baseline that WAS workspaced (non-null fingerprint),
        // while the live project (PROJECT_PATH) is not in any workspace, so the
        // current pass resolves to single-project (fingerprint null).
        const state = {
            ...readStateFromMeta(),
            cachedM0WorkspaceFingerprint: "ws:deadbeef",
        };

        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("project_memory_epoch");
    });

    it("mustMaterialize does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
        // Taxonomy invariant: a new compartment is a SOFT delta that surfaces in
        // m[1] via renderM1's <new-compartments> (sequence > cachedM0Seq). It must
        // NEVER fold m[0] — folding on every historian publish busts the prompt-
        // cache prefix on a routine background publish, the exact bug the m[0]/m[1]
        // split exists to prevent. New compartments fold into m[0] only on a HARD
        // bust (TTL/system/tools/model change).
        db = makeDb();
        createOpenCodeMessageTimes([{ id: "m1", timestamp: new Date(2026, 0, 4, 12).getTime() }]);
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
            temporalAwareness: true,
        });
        const state = readStateFromMeta();
        appendCompartments(db, SESSION_ID, [
            {
                sequence: 2,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                title: "New",
                content: "New summary",
                p1: "New summary",
            },
        ]);

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
        const refreshed = injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            temporalAwareness: true,
            isCacheBustingPass: true,
        });
        expect(refreshed.m0RematerializedThisPass).toBe(false);
        expect(refreshed.m1Text).toContain("## 1-1 · 2026-01-04 · New");
    });

    it("mustMaterialize does NOT materialize m[0] on a retrospective memory write", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();

        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "PROJECT_RULES",
            content:
                "Verify provider-executed tool availability before describing it as supported.",
            sourceSessionId: SESSION_ID,
            sourceType: "dreamer",
            metadataJson: JSON.stringify({ source: "retrospective" }),
        });

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("mustMaterialize does NOT materialize m[0] on the FIRST compartment (sequence 0)", () => {
        // The first compartment (sequence 0) is also a SOFT m[1] delta — the
        // EMPTY_MAX_COMPARTMENT_SEQ=-1 sentinel makes readNewCompartments(-1)
        // include seq 0, so renderM1 surfaces it. mustMaterialize must NOT fold it
        // into m[0]; that happens on the next HARD bust.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        // First compartment for this session — sequence 0.
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m1",
                    endMessageId: "m1",
                    title: "First",
                    content: "First summary",
                    p1: "First summary",
                },
            ],
            [],
        );

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("mustMaterialize detects a new m0_mutation_log entry by monotonic id", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).toBe("max_mutation_id");
    });

    it("mustMaterialize treats project docs hash changes as a SOFT defer input", () => {
        // Project docs live in the frozen prefix, but docs-only edits must not
        // force a fold: they ride along until a natural HARD bust refreshes m[0].
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        writeFileSync(join(projectDirectory, "ARCHITECTURE.md"), "# New architecture\n");

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }),
        ).toEqual({ value: false, reason: null });
    });

    it("omits project docs with injectDocs=false and replays byte-identical defer bytes", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        writeFileSync(
            join(projectDirectory, "ARCHITECTURE.md"),
            "# FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
        );
        writeFileSync(
            join(projectDirectory, "STRUCTURE.md"),
            "# FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
        );
        const state = readStateFromMeta();
        const hardSignals = {
            systemHash: "sys-docs-off",
            modelKey: "model-docs-off",
            cacheExpired: false,
            lastResponseTime: 0,
        };

        const first = [userMessage("m1", "hello")];
        const firstResult = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            injectDocs: false,
            hardSignals,
        });
        const firstM0 = renderedText(first[0]);
        const firstM1 = renderedText(first[1]);

        expect(firstResult.m0RematerializedThisPass).toBe(true);
        expect(firstM0).not.toContain("<project-docs>");
        expect(firstM0).not.toContain("FLAG_OFF_ARCH_DOCS");
        expect(firstM0).not.toContain("FLAG_OFF_STRUCTURE_DOCS");
        expect(state.cachedM0ProjectDocsHash).toBe("");
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                injectDocs: false,
                hardSignals,
            }),
        ).toEqual({ value: false, reason: null });

        const second = [userMessage("m2", "hello again")];
        const secondResult = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            injectDocs: false,
            hardSignals,
        });

        expect(secondResult.m0RematerializedThisPass).toBe(false);
        expect(renderedText(second[0])).toBe(firstM0);
        expect(renderedText(second[1])).toBe(firstM1);
        expect(renderedText(second[0])).not.toContain("FLAG_OFF_ARCH_DOCS");
        expect(renderedText(second[0])).not.toContain("FLAG_OFF_STRUCTURE_DOCS");
    });

    it("folds current project docs on the next natural HARD materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        writeFileSync(join(projectDirectory, "ARCHITECTURE.md"), "# Old architecture\n");
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: {
                systemHash: "sys-v1",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(renderedText(first[0])).toContain("Old architecture");
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                injectDocs: false,
                hardSignals: {
                    systemHash: "sys-v1",
                    modelKey: "model-v1",
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            }),
        ).toEqual({ value: false, reason: null });

        writeFileSync(
            join(projectDirectory, "ARCHITECTURE.md"),
            "# Updated architecture\nFresh docs folded on hard bust.\n",
        );
        const second = [userMessage("m2", "hello again")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: {
                systemHash: "sys-v2",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });

        expect(result.m0RematerializedThisPass).toBe(true);
        expect(result.decision.reason).toBe("system_hash");
        expect(renderedText(second[0])).toContain("Updated architecture");
        expect(renderedText(second[0])).toContain("Fresh docs folded on hard bust.");
        expect(renderedText(second[0])).not.toContain("Old architecture");
    });

    it("classify writes stay cache-neutral until the next natural HARD materialization", () => {
        db = makeDb();
        const high = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "PROJECT_RULES",
            content: "HIGH_PRIORITY_MEMORY: Always run focused tests before shipping.",
            importance: 90,
        });
        const low = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "PROJECT_RULES",
            content: "LOW_PRIORITY_MEMORY: Use lint alias.",
            importance: 10,
        });

        let budget = 1;
        while (
            !(() => {
                const selected = trimMemoriesToBudgetV2(
                    SESSION_ID,
                    getMemoriesByProject(db, PROJECT_PATH),
                    budget,
                ).selected;
                return selected.length === 1 && selected[0]?.id === high.id;
            })() &&
            budget < 500
        ) {
            budget += 1;
        }
        expect(budget).toBeLessThan(500);

        const state = readStateFromMeta();
        const hardV1 = {
            systemHash: "sys-v1",
            modelKey: "model-v1",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: budget,
            hardSignals: hardV1,
        });
        const initialM0 = renderedText(first[0]);
        const initialM1 = renderedText(first[1]);
        expect(initialM0).toContain("HIGH_PRIORITY_MEMORY");
        expect(initialM0).not.toContain("LOW_PRIORITY_MEMORY");

        expect(setMemoryClassification(db, high.id, { importance: 1 })).toBe(true);
        expect(setMemoryClassification(db, low.id, { importance: 100 })).toBe(true);
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                memoryInjectionBudgetTokens: budget,
                hardSignals: hardV1,
            }),
        ).toEqual({ value: false, reason: null });

        const second = [userMessage("m2", "after classify defer")];
        const soft = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: budget,
            hardSignals: hardV1,
        });
        expect(soft.m0RematerializedThisPass).toBe(false);
        expect(renderedText(second[0])).toBe(initialM0);
        expect(renderedText(second[1])).toBe(initialM1);

        const third = [userMessage("m3", "natural hard bust")];
        const hard = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: third,
            state,
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: budget,
            hardSignals: { ...hardV1, systemHash: "sys-v2" },
        });
        expect(hard.m0RematerializedThisPass).toBe(true);
        expect(renderedText(third[0])).not.toContain("importance=");
        expect(renderedText(third[0])).toContain("LOW_PRIORITY_MEMORY");
        expect(renderedText(third[0])).not.toContain("HIGH_PRIORITY_MEMORY");
    });

    it("MANY classify writes do NOT cross the memoryUpdateCount>40 pressure-refold threshold", () => {
        db = makeDb();
        // Materialize m[0] over a pool of 50 existing memories.
        const ids: number[] = [];
        for (let i = 0; i < 50; i++) {
            ids.push(
                insertMemory(db, {
                    projectPath: PROJECT_PATH,
                    category: "PROJECT_RULES",
                    content: `POOL_MEMORY_${i}: a durable project rule number ${i}.`,
                    importance: 50,
                }).id,
            );
        }
        const budget = 8000;
        const state = readStateFromMeta();
        const hardV1 = {
            systemHash: "sys-v1",
            modelKey: "model-v1",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: budget,
            hardSignals: hardV1,
        });

        // Classify ALL 50 existing memories (> the 40 mutation-count threshold).
        // The pressure-refold counts <memory-updates> mutation-log rows; classify
        // is column-only and logs NONE, so memoryUpdateCount stays 0 and the
        // >40 trigger never fires — even though 50 importances changed.
        for (let i = 0; i < ids.length; i++) {
            // 1..49 — always differs from the seeded importance of 50, so every
            // write is a real change (the no-op guard would otherwise skip it).
            expect(setMemoryClassification(db, ids[i], { importance: (i % 49) + 1 })).toBe(true);
        }

        // Cache-busting pass (soft refresh recomputes m[1]) — must NOT fold m[0]:
        // classify writes don't count toward the mutation-drift refold.
        const soft = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m2", "cache-busting soft pass")],
            state,
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: budget,
            isCacheBustingPass: true,
            hardSignals: hardV1,
        });
        expect(soft.m0RematerializedThisPass).toBe(false);
    });

    it("v2: a session facts version bump does NOT trigger re-materialization", () => {
        // v2 faithful facts: session_facts is retired as a render source, so a
        // facts-version bump must not force an m[0] rebuild (rendered bytes no
        // longer depend on session_facts). This guards against the old wasted
        // re-materialization on every fact change.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const state = readStateFromMeta();
        db.exec("BEGIN");
        bumpSessionFactsVersion(db, SESSION_ID);
        db.exec("COMMIT");

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).reason,
        ).not.toBe("session_facts_version");
    });

    it("materializeM0 Phase 3 commits all cached_m0 fields", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const row = db
            .prepare(
                `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_project_memory_epoch,
                        cached_m0_project_user_profile_version, cached_m0_max_compartment_seq,
                        cached_m0_max_memory_id, cached_m0_max_mutation_id,
                        cached_m0_max_memory_mutation_id, cached_m0_project_docs_hash,
                        cached_m0_materialized_at, cached_m0_session_facts_version,
                        cached_m0_upgrade_state
                   FROM session_meta WHERE session_id = ?`,
            )
            .get(SESSION_ID) as Record<string, unknown>;

        expect(row.cached_m0_bytes).not.toBeNull();
        expect(row.cached_m1_bytes).not.toBeNull();
        expect(Buffer.from(row.cached_m0_bytes as Buffer).toString("utf8")).toBe(result.m0Text);
        expect(Buffer.from(row.cached_m1_bytes as Buffer).toString("utf8")).toBe(result.m1Text);
        expect(row.cached_m0_project_memory_epoch).toBe(0);
        expect(row.cached_m0_project_user_profile_version).toBe(0);
        // Empty session: maxCompartmentSeq is the empty sentinel (-1), not 0, so
        // the first compartment (sequence 0) is correctly detected as a change.
        expect(row.cached_m0_max_compartment_seq).toBe(-1);
        expect(row.cached_m0_max_memory_id).toBe(0);
        expect(row.cached_m0_max_mutation_id).toBe(0);
        expect(row.cached_m0_max_memory_mutation_id).toBe(0);
        expect(row.cached_m0_project_docs_hash).toBe("");
        expect(typeof row.cached_m0_materialized_at).toBe("number");
        expect(row.cached_m0_session_facts_version).toBe(0);
        expect(row.cached_m0_upgrade_state).toBe(
            encodeCachedM0UpgradeIdentity("ready", COMPARTMENT_RENDER_EPOCH, false, "m8000-h60000"),
        );
    });

    it("materializeM0 persists memory_block_ids/count for the rendered memory set", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Two active project memories — both should render into m[0] under the
        // default budget, so memory_block_ids must list exactly their ids and
        // memory_block_count must equal 2 (regression: v2 path never wrote these,
        // so a post-migration session showed a stale legacy count — dogfood
        // 2026-05-30, AFT "Injected 256" against 124 live memories).
        const id1 = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "memory one",
        }).id;
        const id2 = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "memory two",
        }).id;
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const row = db
            .prepare(
                "SELECT memory_block_count, memory_block_ids FROM session_meta WHERE session_id = ?",
            )
            .get(SESSION_ID) as { memory_block_count: number; memory_block_ids: string };
        expect(row.memory_block_count).toBe(2);
        const ids = JSON.parse(row.memory_block_ids) as number[];
        expect(new Set(ids)).toEqual(new Set([id1, id2]));
    });

    it("filters a memory rendered only in m[1] while returning a memory rendered in neither", async () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        let m1OnlyId = 0;
        const materialized = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: () => {
                m1OnlyId = insertMemory(db, {
                    projectPath: PROJECT_PATH,
                    category: "ARCHITECTURE",
                    content: "RecallFilterToken rendered only in the incremental block",
                }).id;
            },
        });
        expect(materialized.m1Text).toContain("RecallFilterToken");

        const hiddenId = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "RecallFilterToken created after both cached blocks",
        }).id;
        const visibleMemoryIds = getVisibleMemoryIds(db, SESSION_ID);
        expect(visibleMemoryIds?.has(m1OnlyId)).toBe(true);
        expect(visibleMemoryIds?.has(hiddenId)).toBe(false);

        const results = await unifiedSearch(db, SESSION_ID, PROJECT_PATH, "RecallFilterToken", {
            memoryEnabled: true,
            embeddingEnabled: false,
            sources: ["memory"],
            visibleMemoryIds: visibleMemoryIds ?? undefined,
            countRetrievals: false,
            measurementDisabled: true,
        });
        const resultIds = results
            .filter((result) => result.source === "memory")
            .map((result) => result.memoryId);
        expect(resultIds).not.toContain(m1OnlyId);
        expect(resultIds).toContain(hiddenId);
    });

    it("materializeM0 sizes session-history to the HISTORY budget, not budget minus project-docs", () => {
        // Regression: the over-budget tightening loop measured the WHOLE m[0]
        // (which includes <project-docs>/<user-profile>/<project-memory>) against
        // the history-only budget. A large project-docs block therefore stole
        // from the history budget and over-archived compartments (live dogfood:
        // ~20K docs collapsed a 98K history budget to ~73K effective). The loop
        // must now measure ONLY the <session-history> slice.
        const HISTORY_BUDGET = 40_000;
        const mkCompartments = () =>
            Array.from({ length: 120 }, (_, i) => ({
                sequence: i,
                startMessage: i * 10 + 1,
                endMessage: i * 10 + 9,
                startMessageId: `s${i}`,
                endMessageId: `e${i}`,
                title: `Compartment ${i} doing substantive work`,
                content: `P1 full body ${i}: ${"detail ".repeat(40)}`,
                p1: `P1 full body ${i}: ${"detail ".repeat(40)}`,
                p2: `P2 body ${i}: ${"detail ".repeat(20)}`,
                p3: `P3 body ${i}: ${"detail ".repeat(8)}`,
                p4: `P4 ${i}; anchor${i}`,
                importance: 70,
                episodeType: "feature",
                legacy: 0,
            }));

        // Run 1: tiny project-docs.
        db = makeDb();
        const smallDir = makeProjectDir();
        writeFileSync(join(smallDir, "ARCHITECTURE.md"), "# Small\n");
        replaceAllCompartmentState(db, SESSION_ID, mkCompartments(), []);
        const small = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: smallDir,
            historyBudgetTokens: HISTORY_BUDGET,
        });
        const smallHist =
            small.m0Text.match(/<session-history>[\s\S]*?<\/session-history>/)?.[0] ?? "";
        const smallTags = (smallHist.match(/<compartment\b/g) ?? []).length;
        db.close();

        // Run 2: large project-docs (~15K chars) — must NOT shrink session-history.
        db = makeDb();
        const bigDir = makeProjectDir();
        writeFileSync(
            join(bigDir, "ARCHITECTURE.md"),
            `# Big\n${"docs line of content\n".repeat(800)}`,
        );
        replaceAllCompartmentState(db, SESSION_ID, mkCompartments(), []);
        const big = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory: bigDir,
            historyBudgetTokens: HISTORY_BUDGET,
        });
        const bigHist = big.m0Text.match(/<session-history>[\s\S]*?<\/session-history>/)?.[0] ?? "";
        const bigTags = (bigHist.match(/<compartment\b/g) ?? []).length;

        // The big-docs m[0] is larger overall (it carries the big docs block)...
        expect(big.m0Text.length).toBeGreaterThan(small.m0Text.length);
        // ...but session-history renders the SAME number of compartments — docs
        // size does not steal from the history budget anymore.
        expect(bigTags).toBe(smallTags);
        expect(bigHist.length).toBe(smallHist.length);
    });

    it("materializeM0 throws MaterializeContentionError when epoch changes between snapshot and swap", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();

        expect(() =>
            materializeM0({
                db,
                sessionId: SESSION_ID,
                state: readStateFromMeta(),
                projectPath: PROJECT_PATH,
                projectDirectory,
                beforePhase3ForTest: () => {
                    setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 1 });
                },
            }),
        ).toThrow(MaterializeContentionError);
    });

    it("materializeWithRetry retries three times then throws", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        let attempts = 0;

        expect(() =>
            materializeWithRetry(
                {
                    db,
                    sessionId: SESSION_ID,
                    state: readStateFromMeta(),
                    projectPath: PROJECT_PATH,
                    projectDirectory,
                    beforePhase3ForTest: () => {
                        attempts += 1;
                        queueM0Mutation(db, {
                            sessionId: SESSION_ID,
                            mutationType: "compartment_merge",
                        });
                    },
                },
                3,
            ),
        ).toThrow(MaterializeContentionError);
        expect(attempts).toBe(3);
    });

    it("injectM0M1 updates root cached state after successful materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(result.injected).toBe(true);
        expect(result.m0RematerializedThisPass).toBe(true);
        expect(state.cachedM0Bytes).toBeInstanceOf(Buffer);
        expect(state.cachedM1Bytes).toBeInstanceOf(Buffer);
        expect(state.cachedM0ProjectMemoryEpoch).toBe(0);
        // Empty session: maxCompartmentSeq is the empty sentinel (-1), not 0.
        expect(state.cachedM0MaxCompartmentSeq).toBe(-1);
        expect(state.cachedM0MaxMutationId).toBe(0);
        expect(state.cachedM0MaxMemoryMutationId).toBe(0);
        expect(state.cachedM0ProjectDocsHash).toBe("");
        expect(typeof state.cachedM0MaterializedAt).toBe("number");
        expect(state.cachedM0SessionFactsVersion).toBe(0);
        expect(state.cachedM0UpgradeState).toBe(
            encodeCachedM0UpgradeIdentity("ready", COMPARTMENT_RENDER_EPOCH, false, "m8000-h60000"),
        );
        expect(state.snapshotMarkers?.maxMemoryId).toBe(0);
        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
            }).value,
        ).toBe(false);
    });

    it("suppresses every memory-derived surface when memory.enabled=false", () => {
        // Regression: the caller deliberately omits projectPath when memory is
        // disabled, but user-profile and mural rendering used separate ungated
        // reads. Cover the baseline, delta, and multipart mural together.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        createUserMemoryTable();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "project memory must not leak when disabled",
        });
        insertUserMemory(db, "profile baseline must not leak", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
        const state = readStateFromMeta();
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: undefined,
            projectDirectory,
            memoryEnabled: false,
            mural: {
                enabled: true,
                supportsVision: true,
                dataUrl: "data:image/png;base64,cHJvZmlsZS1tdXJhbA==",
            },
        });

        expect(result.injected).toBe(true);
        const m0 = renderedText(messages[0]);
        expect(m0).not.toContain("<project-memory>");
        expect(m0).not.toContain("project memory must not leak when disabled");
        expect(m0).not.toContain("<user-profile>");
        expect(m0).not.toContain("profile baseline must not leak");
        expect(m0).not.toContain("<memory-mural>");
        expect(messages[0].parts).toHaveLength(1);

        // A cache-busting m[1] refresh sees a newer profile version but must not
        // turn it into a <new-user-profile> delta while memory remains disabled.
        insertUserMemory(db, "profile delta must not leak", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 2 });
        const refreshed = [userMessage("m2", "again")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: refreshed,
            state,
            projectPath: undefined,
            projectDirectory,
            memoryEnabled: false,
            isCacheBustingPass: true,
        });
        const m1 = renderedText(refreshed[1]);
        expect(m1).not.toContain("<new-user-profile>");
        expect(m1).not.toContain("profile delta must not leak");
    });

    it("uses an immediate render-config HARD path for a memory-on to memory-off transition", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        createUserMemoryTable();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "transition project fact",
        });
        insertUserMemory(db, "transition profile fact", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
        const state = readStateFromMeta();

        const on = [userMessage("m1", "before")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: on,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            memoryEnabled: true,
            hardSignals: { systemHash: "memory-guidance-on", modelKey: "test/model" },
        });
        expect(renderedText(on[0])).toContain("transition profile fact");

        const off = [userMessage("m2", "after")];
        const transition = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: off,
            state,
            projectPath: undefined,
            projectDirectory,
            memoryEnabled: false,
            // The system hook publishes its changed hash after message transform.
            // Keep the old hash here to prove the memory gate itself prevents a
            // one-request replay of the memory-bearing cache.
            hardSignals: { systemHash: "memory-guidance-on", modelKey: "test/model" },
        });
        expect(transition.decision.reason).toBe("render_config");
        expect(transition.m0RematerializedThisPass).toBe(true);
        expect(renderedText(off[0])).not.toContain("transition profile fact");
        const suppressedBytes = transition.m0Bytes?.toString("utf8");

        // When injection is deferred, replay the frozen suppressed m[0] unchanged instead of rendering it again.
        const defer = [userMessage("m3", "still off")];
        const replay = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: defer,
            state,
            projectPath: undefined,
            projectDirectory,
            memoryEnabled: false,
            hardSignals: { systemHash: "memory-guidance-on", modelKey: "test/model" },
        });
        expect(replay.m0RematerializedThisPass).toBe(false);
        expect(replay.m0Bytes?.toString("utf8")).toBe(suppressedBytes);
        expect(renderedText(defer[0])).not.toContain("transition profile fact");
    });

    it("keeps the memory-on m[0]/m[1] shape byte-identical", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        createUserMemoryTable();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "memory-on project fact",
        });
        insertUserMemory(db, "memory-on profile fact", []);
        setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

        const defaultRender = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const explicitlyEnabledRender = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            projectDirectory,
            memoryEnabled: true,
        });

        expect(explicitlyEnabledRender.m0Text).toBe(defaultRender.m0Text);
        expect(explicitlyEnabledRender.m1Text).toBe(defaultRender.m1Text);
        expect(defaultRender.m0Text).toContain("memory-on profile fact");
        expect(defaultRender.m0Text).toContain("memory-on project fact");
    });

    it("injectM0M1 still injects history when materialization contention exhausts with NO cached baseline (no throw, no empty history)", () => {
        // Regression for the round-4 BLOCKER: a cache-bust pass clears
        // cachedM0Bytes, then materialization loses the lock on every retry
        // (a sibling process keeps mutating). The old code threw → the model got
        // ZERO session history. The fix renders a fresh non-persisted m[0].
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        // Empty cache (simulates a history-refresh clear earlier this pass).
        state.cachedM0Bytes = null;
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            // Force perpetual contention: every materialize attempt sees a fresh
            // mutation between snapshot and swap, so all retries fail.
            beforePhase3ForTest: () => {
                queueM0Mutation(db, {
                    sessionId: SESSION_ID,
                    mutationType: "compartment_merge",
                });
            },
        });

        // Must NOT throw, must still inject, and m[0] must carry the history
        // wrapper (not be empty / missing).
        expect(result.injected).toBe(true);
        const m0 = renderedText(messages[0]);
        expect(m0).toContain("<session-history>");
        // Fresh fallback is non-persisted: the durable cache stays null so the
        // next (uncontended) pass re-materializes and persists.
        expect(state.cachedM0Bytes).toBeInstanceOf(Buffer);
    });

    it("injectM0M1 does not throw on contention when m[0] is cached but m[1] is missing (partial-cache state)", () => {
        // Regression: the contention-reuse guard checked only cachedM0Bytes. A
        // prior fresh-fallback pass sets in-memory cachedM0Bytes WITHOUT
        // persisting cachedM1Bytes — so a subsequent contention pass entered the
        // reuse branch, then replayCachedM1 threw RenderM1InvalidMarkersError
        // (m[1] null) and propagated out, dropping injection entirely. The fix
        // requires BOTH buffers to reuse; the partial state falls through to the
        // fresh-render branch, which produces a complete m[0]/m[1] pair.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        // Partial cache: m[0] present in memory, m[1] absent.
        state.cachedM0Bytes = Buffer.from("<session-history>stale</session-history>", "utf8");
        state.cachedM1Bytes = null;
        const messages = [userMessage("m1", "hello")];

        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: () => {
                queueM0Mutation(db, {
                    sessionId: SESSION_ID,
                    mutationType: "compartment_merge",
                });
            },
        });

        // Must NOT throw, and must still inject a complete history block.
        expect(result.injected).toBe(true);
        expect(renderedText(messages[0])).toContain("<session-history>");
    });

    it("fresh-render contention fallback freezes materializedAt (stable across passes, not live Date.now())", () => {
        // Regression for the round-5 CRITICAL: the fresh-render fallback fed the
        // m[1] memory-expiry cutoff from live Date.now(), so two consecutive
        // contention-fallback defer passes straddling a memory's expires_at would
        // render different m[1] bytes with ZERO DB mutation — a silent cache bust.
        // The fix freezes materializedAt to the persisted value (or 0 when none).
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        state.cachedM0Bytes = null;
        state.cachedM0MaterializedAt = null;
        const messages = [userMessage("m1", "hello")];
        const forceContention = () => {
            queueM0Mutation(db, {
                sessionId: SESSION_ID,
                mutationType: "compartment_merge",
            });
        };
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            beforePhase3ForTest: forceContention,
        });
        // The frozen cutoff must NOT be a live wall-clock timestamp — it is 0
        // (no prior persisted materialization), which is deterministic and stable.
        expect(state.snapshotMarkers?.materializedAt).toBe(0);
    });

    it("defer pass reuses byte-identical m[0] bytes from the prior materialization", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const firstMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const firstM0 = renderedText(firstMessages[0]);

        const secondMessages = [userMessage("m2", "hello again")];
        const second = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: secondMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        expect(second.m0RematerializedThisPass).toBe(false);
        expect(renderedText(secondMessages[0])).toBe(firstM0);
    });

    it("project identity changes hard-materialize while legacy null adopts silently", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const firstMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: firstMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        state.cachedM0ProjectIdentity = null;
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
        ).run(SESSION_ID);
        const legacyNullDecision = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m2", "legacy")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(legacyNullDecision.m0RematerializedThisPass).toBe(false);
        expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0ProjectIdentity).toBe(PROJECT_PATH);

        const changedDecision = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m3", "changed")],
            state,
            projectPath: "git:changed-project",
            projectDirectory,
        });
        expect(changedDecision.decision).toEqual({ value: true, reason: "project_change" });
        expect(changedDecision.m0RematerializedThisPass).toBe(true);
    });

    it("SOFT /ctx-flush pass keeps m0 byte-identical, refreshes m1, and avoids first_render", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const hardV1 = {
            systemHash: "sys-v1",
            modelKey: "model-v1",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        const baselineMessages = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: baselineMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: hardV1,
        });
        const m0BeforeFlush =
            baselineMessages[0].parts[0] &&
            renderedText(baselineMessages[0]).match(
                /<session-history>[\s\S]*?<\/session-history>/,
            )?.[0];
        expect(m0BeforeFlush).toBeTruthy();

        const flushMessages = [userMessage("m2", "after flush")];
        const flushPass = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: flushMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        expect(flushPass.decision.reason).not.toBe("first_render");
        expect(flushPass.m0RematerializedThisPass).toBe(false);
        const m0AfterFlush = renderedText(flushMessages[0]).match(
            /<session-history>[\s\S]*?<\/session-history>/,
        )?.[0];
        expect(m0AfterFlush).toBe(m0BeforeFlush);

        const deferMessages = [userMessage("m3", "defer")];
        const deferPass = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: deferMessages,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        expect(deferPass.m0RematerializedThisPass).toBe(false);
        expect(renderedText(deferMessages[0])).toBe(renderedText(flushMessages[0]));
    });

    it("HARD fold binds memory expiry cutoff and materializedAt to one timestamp", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "KNOWN_ISSUES",
            content: "D16c expiry-gap memory",
            expiresAt: 10_500,
        });
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "D16c permanent anchor",
        });

        const realNow = Date.now;
        const foldAt = 10_000;
        let nowCalls = 0;
        Date.now = () => {
            nowCalls += 1;
            return nowCalls === 1 ? foldAt : 99_000;
        };

        try {
            const state = readStateFromMeta();
            const hard = {
                systemHash: "fold-a",
                modelKey: "model-v1",
                cacheExpired: false,
                lastResponseTime: 0,
            };
            const first = materializeM0({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: hard,
            });
            expect(first.m0Text).toContain("D16c expiry-gap memory");
            expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0MaterializedAt).toBe(foldAt);

            nowCalls = 0;
            const state2 = readStateFromMeta();
            const second = materializeM0({
                db,
                sessionId: SESSION_ID,
                state: state2,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: { ...hard, systemHash: "fold-b" },
            });
            expect(second.m0Text).toContain("D16c expiry-gap memory");
            expect(second.m0Text.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0]).toBe(
                first.m0Text.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
            );
        } finally {
            Date.now = realNow;
        }
    });

    it("does NOT drift-refold on a defer pass when m[1] is the empty placeholder (tiny-baseline guard)", () => {
        // Regression: the +15% drift refold must key off GENUINE accumulated
        // delta, not the placeholder. With a tiny m[0], the ~80-byte empty
        // placeholder can exceed m0*0.15 and wrongly trigger a refold every
        // defer pass — busting the byte-identical-defer cache invariant.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hi")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });
        const firstM0 = renderedText(first[0]);

        // Defer pass: no new memories/compartments → m[1] is the placeholder.
        const second = [userMessage("m2", "hi again")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: second,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
        });

        // Must NOT refold: placeholder m[1] is the empty state, not delta.
        expect(result.m0RematerializedThisPass).toBe(false);
        expect(renderedText(second[0])).toBe(firstM0);
        expect(result.m1Text).toContain("no new content since last materialization");
    });

    it("replays byte-identical m[1] on defer and surfaces additive memory on next cache-busting pass", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m0",
                    endMessageId: "m0",
                    title: "large baseline",
                    content: "baseline ".repeat(300),
                },
            ],
            [],
        );
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Large baseline memory. ".repeat(300),
        });
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const initialM1 = renderedText(first[1]);

        const m1MemoryId = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "New additive memory appears only after a bust.",
        }).id;

        const deferOne = [userMessage("m2", "defer one")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: deferOne,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: false,
        });
        const deferTwo = [userMessage("m3", "defer two")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: deferTwo,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: false,
        });

        expect(renderedText(deferOne[1])).toBe(initialM1);
        expect(renderedText(deferTwo[1])).toBe(initialM1);
        expect(initialM1).not.toContain("New additive memory");

        const bust = [userMessage("m4", "bust")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        expect(renderedText(bust[1])).toContain("<new-memories>");
        expect(renderedText(bust[1])).toContain("New additive memory appears only after a bust.");
        expect(getVisibleMemoryIds(db, SESSION_ID)?.has(m1MemoryId)).toBe(true);
    });

    it("resolves direct and chained merge replacements with bounded failure semantics", () => {
        const cases = [
            {
                name: "direct-old-target",
                seedTargetBeforeMarker: true,
                mutate(caseDb: Database, source: Memory, targets: Memory[]) {
                    caseDb
                        .prepare(
                            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
                        )
                        .run(targets[0].id, source.id);
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: source.id,
                        supersededById: targets[0].id,
                    });
                },
                expectedTarget: 0,
                removed: false,
            },
            {
                name: "new-target",
                seedTargetBeforeMarker: false,
                mutate(caseDb: Database, source: Memory, targets: Memory[]) {
                    caseDb
                        .prepare(
                            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
                        )
                        .run(targets[0].id, source.id);
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: source.id,
                        supersededById: targets[0].id,
                    });
                },
                expectedTarget: 0,
                removed: false,
            },
            {
                name: "two-hop-chain",
                seedTargetBeforeMarker: true,
                targetCount: 2,
                mutate(caseDb: Database, source: Memory, targets: Memory[]) {
                    caseDb
                        .prepare(
                            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
                        )
                        .run(targets[0].id, source.id);
                    caseDb
                        .prepare(
                            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
                        )
                        .run(targets[1].id, targets[0].id);
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: source.id,
                        supersededById: targets[0].id,
                    });
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: targets[0].id,
                        supersededById: targets[1].id,
                    });
                },
                expectedTarget: 1,
                removed: false,
            },
            {
                name: "cycle",
                seedTargetBeforeMarker: true,
                mutate(caseDb: Database, source: Memory, targets: Memory[]) {
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: source.id,
                        supersededById: targets[0].id,
                    });
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: targets[0].id,
                        supersededById: source.id,
                    });
                },
                expectedTarget: null,
                removed: true,
            },
            {
                name: "archived-terminal",
                seedTargetBeforeMarker: true,
                mutate(caseDb: Database, source: Memory, targets: Memory[]) {
                    caseDb
                        .prepare(
                            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
                        )
                        .run(targets[0].id, source.id);
                    caseDb
                        .prepare("UPDATE memories SET status = 'archived' WHERE id = ?")
                        .run(targets[0].id);
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "superseded",
                        targetMemoryId: source.id,
                        supersededById: targets[0].id,
                    });
                    queueMemoryMutation(caseDb, {
                        projectPath: PROJECT_PATH,
                        mutationType: "archive",
                        targetMemoryId: targets[0].id,
                    });
                },
                expectedTarget: null,
                removed: true,
            },
        ] as const;

        for (const fixture of cases) {
            const caseDb = makeDb();
            try {
                const source = insertMemory(caseDb, {
                    projectPath: PROJECT_PATH,
                    category: "CONSTRAINTS",
                    content: `${fixture.name} source`,
                });
                const targetCount = "targetCount" in fixture ? fixture.targetCount : 1;
                const targets: Memory[] = [];
                if (fixture.seedTargetBeforeMarker) {
                    for (let index = 0; index < targetCount; index += 1) {
                        targets.push(
                            insertMemory(caseDb, {
                                projectPath: PROJECT_PATH,
                                category: "CONSTRAINTS",
                                content: `${fixture.name} target ${index}`,
                            }),
                        );
                    }
                }
                const markers = readCurrentM0SnapshotMarkers({
                    db: caseDb,
                    sessionId: SESSION_ID,
                    projectPath: PROJECT_PATH,
                });
                if (!fixture.seedTargetBeforeMarker) {
                    targets.push(
                        insertMemory(caseDb, {
                            projectPath: PROJECT_PATH,
                            category: "CONSTRAINTS",
                            content: `${fixture.name} target 0`,
                        }),
                    );
                }
                fixture.mutate(caseDb, source, targets);
                const m1 = renderM1(
                    {
                        db: caseDb,
                        sessionId: SESSION_ID,
                        state: getOrCreateSessionMeta(caseDb, SESSION_ID),
                        projectPath: PROJECT_PATH,
                        memoryInjectionBudgetTokens: 8_000,
                    },
                    markers,
                    [source.id],
                );
                const renderedIds = [...m1.matchAll(/^#(\d+)(?:\s|\[|:)/gm)].map((match) =>
                    Number(match[1]),
                );
                const expectedId =
                    fixture.expectedTarget === null ? null : targets[fixture.expectedTarget]?.id;
                expect(renderedIds, fixture.name).toEqual(expectedId === null ? [] : [expectedId]);
                if (expectedId === null) {
                    expect(m1, fixture.name).toContain(`<removed id="${source.id}"/>`);
                    expect(m1, fixture.name).not.toContain("<superseded");
                } else {
                    expect(m1, fixture.name).toContain(
                        `<superseded id="${source.id}" by="${expectedId}"/>`,
                    );
                    expect(m1.match(new RegExp(`^#${expectedId}(?:\\s|\\[|:)`, "gm"))?.length).toBe(
                        1,
                    );
                }
            } finally {
                caseDb.close();
            }
        }
    });

    it("follows a merge chain through an invisible workspace intermediate", () => {
        db = makeDb();
        const foreign = "/tmp/foreign-replacement-project";
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'replacement-ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, '${PROJECT_PATH}', 'Own', '${PROJECT_PATH}', 1),
                   (1, '${foreign}', 'Foreign', '${foreign}', 1);
        `);
        const source = insertMemory(db, {
            projectPath: foreign,
            category: "CONSTRAINTS",
            content: "workspace chain source",
        });
        const middle = insertMemory(db, {
            projectPath: foreign,
            category: "CONSTRAINTS",
            content: "workspace invisible middle",
        });
        const terminal = insertMemory(db, {
            projectPath: foreign,
            category: "CONSTRAINTS",
            content: "workspace visible terminal",
        });
        db.prepare("UPDATE memories SET shareable = 1 WHERE id IN (?, ?)").run(
            source.id,
            terminal.id,
        );
        const markers = readCurrentM0SnapshotMarkers({
            db,
            sessionId: SESSION_ID,
            projectPath: PROJECT_PATH,
        });
        db.prepare(
            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
        ).run(middle.id, source.id);
        db.prepare(
            "UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
        ).run(terminal.id, middle.id);
        queueMemoryMutation(db, {
            projectPath: foreign,
            mutationType: "superseded",
            targetMemoryId: source.id,
            supersededById: middle.id,
        });
        queueMemoryMutation(db, {
            projectPath: foreign,
            mutationType: "superseded",
            targetMemoryId: middle.id,
            supersededById: terminal.id,
        });

        const m1 = renderM1(
            {
                db,
                sessionId: SESSION_ID,
                state: readStateFromMeta(),
                projectPath: PROJECT_PATH,
                memoryInjectionBudgetTokens: 8_000,
            },
            markers,
            [source.id],
        );
        expect(m1).toContain(`<superseded id="${source.id}" by="${terminal.id}"/>`);
        expect(m1).toContain("workspace visible terminal");
        expect(m1).not.toContain("workspace invisible middle");
    });

    it("renders workspace visibility grants and revocations independent of insertion id", () => {
        db = makeDb();
        const foreign = "/tmp/foreign-visibility-project";
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'visibility-ws', '["CONSTRAINTS"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, '${PROJECT_PATH}', 'Own', '${PROJECT_PATH}', 1),
                   (1, '${foreign}', 'Foreign', '${foreign}', 1);
        `);
        const foreignMemory = insertMemory(db, {
            projectPath: foreign,
            category: "CONSTRAINTS",
            content: "foreign visibility memory below watermark",
        });
        const ownMemory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "own high watermark",
        });
        const markers = readCurrentM0SnapshotMarkers({
            db,
            sessionId: SESSION_ID,
            projectPath: PROJECT_PATH,
        });
        expect(markers.maxMemoryId).toBe(ownMemory.id);
        db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(foreignMemory.id);
        const grantMutation = queueMemoryMutation(db, {
            projectPath: foreign,
            mutationType: "update",
            targetMemoryId: foreignMemory.id,
            category: "__mc_visibility__",
        });
        const options = {
            db,
            sessionId: SESSION_ID,
            state: readStateFromMeta(),
            projectPath: PROJECT_PATH,
            memoryInjectionBudgetTokens: 8_000,
        };
        const grant = renderM1(options, markers, [ownMemory.id]);
        expect(grant).toContain("foreign visibility memory below watermark");
        expect(grant.match(new RegExp(`^#${foreignMemory.id}(?:\\s|\\[|:)`, "gm"))?.length).toBe(1);

        db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(foreignMemory.id);
        queueMemoryMutation(db, {
            projectPath: foreign,
            mutationType: "update",
            targetMemoryId: foreignMemory.id,
            category: "__mc_visibility__",
        });
        const revoke = renderM1(options, { ...markers, maxMemoryMutationId: grantMutation.id }, [
            foreignMemory.id,
            ownMemory.id,
        ]);
        expect(revoke).toContain(`<removed id="${foreignMemory.id}"/>`);
        expect(revoke).not.toContain("foreign visibility memory below watermark");
    });

    it("renders memory mutation removals on cache-busting pass and replays them on defer", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        replaceAllCompartmentState(
            db,
            SESSION_ID,
            [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "m0",
                    endMessageId: "m0",
                    title: "large baseline",
                    content: "baseline ".repeat(300),
                },
            ],
            [],
        );
        const memory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Baseline memory to remove from m0. ".repeat(300),
        });
        const state = readStateFromMeta();
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        queueMemoryMutation(db, {
            projectPath: PROJECT_PATH,
            mutationType: "archive",
            targetMemoryId: memory.id,
            queuedAt: 10,
        });

        const bust = [userMessage("m2", "bust")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const m1 = renderedText(bust[1]);
        expect(m1).toContain("<memory-updates>");
        expect(m1).toContain(`These memories changed since the snapshot below — trust these:`);
        expect(m1).toContain(`<removed id="${memory.id}"/>`);

        const defer = [userMessage("m3", "defer")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: defer,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: false,
        });
        expect(renderedText(defer[1])).toBe(m1);
    });

    it("skips memory mutation deltas for memories trimmed out of m0", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const memory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "This memory is too large for a one-token m0 budget.",
        });
        const state = readStateFromMeta();
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            memoryInjectionBudgetTokens: 1,
            isCacheBustingPass: true,
        });
        queueMemoryMutation(db, {
            projectPath: PROJECT_PATH,
            mutationType: "update",
            targetMemoryId: memory.id,
            newContent: "Updated but not resident.",
            queuedAt: 10,
        });

        const bust = [userMessage("m2", "bust")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            memoryInjectionBudgetTokens: 1,
            isCacheBustingPass: true,
        });

        expect(renderedText(bust[1])).not.toContain("<memory-updates>");
        expect(renderedText(bust[1])).not.toContain("Updated but not resident.");
    });

    it("reconcile rematerialization advances the memory mutation cursor and omits memory-updates", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const memory = insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "Old baseline content.",
        });
        const state = readStateFromMeta();
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        db.prepare(
            "UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
        ).run("Reconciled content.", "reconciled-hash", Date.now(), memory.id);
        queueMemoryMutation(db, {
            projectPath: PROJECT_PATH,
            mutationType: "update",
            targetMemoryId: memory.id,
            newContent: "Reconciled content.",
            queuedAt: 10,
        });
        setProjectState(db, PROJECT_PATH, { projectMemoryEpoch: 1 });

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(true);
        expect(renderedText(bust[0])).toContain("Reconciled content.");
        expect(renderedText(bust[1])).not.toContain("<memory-updates>");
    });

    it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(
            Buffer.from(`<session-history>${"baseline ".repeat(300)}</session-history>`, "utf8"),
            99,
            Buffer.from("sibling cached m1", "utf8"),
            SESSION_ID,
        );

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(result.m1Text).toBe("sibling cached m1");
        expect(renderedText(bust[1])).toBe("sibling cached m1");
        expect(state.cachedM0MaxMemoryId).toBe(99);
    });

    it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: [userMessage("m1", "hello")],
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const siblingM0 = Buffer.from(
            `<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
            "utf8",
        );
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(siblingM0, Buffer.from("sibling cached m1 byte mismatch", "utf8"), SESSION_ID);

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(result.m1Text).toBe("sibling cached m1 byte mismatch");
        expect(renderedText(bust[0])).toBe(siblingM0.toString("utf8"));
        expect(state.cachedM0Bytes?.toString("utf8")).toBe(siblingM0.toString("utf8"));
    });

    it("soft m1 refresh CAS accepts docs-hash-only marker drift when m[0] bytes match", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const state = readStateFromMeta();
        const first = [userMessage("m1", "hello")];
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: first,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });
        const baselineM0 = renderedText(first[0]);
        insertMemory(db, {
            projectPath: PROJECT_PATH,
            category: "ARCHITECTURE",
            content: "docs-hash-only CAS delta memory",
        });
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
        ).run("docs-only-marker-drift", SESSION_ID);

        const bust = [userMessage("m2", "bust")];
        const result = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: bust,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            isCacheBustingPass: true,
        });

        expect(result.m0RematerializedThisPass).toBe(false);
        expect(renderedText(bust[0])).toBe(baselineM0);
        expect(result.m1Text).toContain("docs-hash-only CAS delta memory");
        expect(renderedText(bust[1])).toContain("docs-hash-only CAS delta memory");
    });
    it("records NULL for an unmaterialized tool-set baseline", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const baselineSignals = {
            systemHash: "sys-tool-observation-null",
            modelKey: "model-tool-observation-null",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        const state = readStateFromMeta();

        injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: baselineSignals,
        });

        // Simulate a cached m[0] created before tool-set telemetry existed.
        state.cachedM0ToolSetHash = null;
        db.prepare(
            "UPDATE session_meta SET cached_m0_tool_set_hash = NULL WHERE session_id = ?",
        ).run(SESSION_ID);

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: { ...baselineSignals, toolSetHash: "tools-v2" },
            }),
        ).toEqual({
            value: false,
            reason: null,
            m0ToolSetHashPrev: null,
            m0ToolSetHashNew: "tools-v2",
        });
    });

    it("persists observed tool-set hashes without turning tool changes into a fold trigger", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const baselineSignals = {
            systemHash: "sys-tool-observation",
            modelKey: "model-tool-observation",
            toolSetHash: "tools-v1",
            cacheExpired: false,
            lastResponseTime: 0,
        };
        const state = readStateFromMeta();

        injectM0M1({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            hardSignals: baselineSignals,
        });

        expect(state.cachedM0ToolSetHash).toBe("tools-v1");
        expect(
            db
                .prepare("SELECT cached_m0_tool_set_hash FROM session_meta WHERE session_id = ?")
                .get(SESSION_ID),
        ).toEqual({ cached_m0_tool_set_hash: "tools-v1" });

        expect(
            mustMaterialize({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory,
                hardSignals: { ...baselineSignals, toolSetHash: "tools-v2" },
            }),
        ).toEqual({
            value: false,
            reason: null,
            m0ToolSetHashPrev: "tools-v1",
            m0ToolSetHashNew: "tools-v2",
        });
    });
});
