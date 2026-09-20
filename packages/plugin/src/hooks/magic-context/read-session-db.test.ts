/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    __openCodeTurnStateTest,
    assistantAwaitingTools,
    assistantAwaitingToolsFromMessages,
    assistantAwaitingToolsFromOpenCodeDb,
    closeReadOnlySessionDb,
    findLastAssistantModelFromOpenCodeDb,
    hasNewerRealUserMessage,
    latestPersistedMessageForRecovery,
    observeOpenCodeTurnEvent,
    shouldHoldIgnoredNotification,
    shouldHoldIgnoredNotificationFromMessages,
    shouldHoldIgnoredNotificationFromOpenCodeDb,
} from "./read-session-db";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    // Close any cached OpenCode read-only DB handle so the new XDG_DATA_HOME
    // points to a fresh DB on the next test case.
    closeReadOnlySessionDb();
    __openCodeTurnStateTest.reset();
    resetOpenCodeDbPathStateForTesting();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function createTurnStateDb(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function messagesFromDb(db: Database, sessionId: string) {
    const messages = db
        .prepare(
            "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
        )
        .all(sessionId) as Array<{ id: string; data: string; time_created: number }>;
    return messages.map((row) => ({
        info: {
            id: row.id,
            ...(JSON.parse(row.data) as Record<string, unknown>),
            time: { created: row.time_created },
        },
        parts: (
            db
                .prepare("SELECT data FROM part WHERE session_id = ? AND message_id = ?")
                .all(sessionId, row.id) as Array<{ data: string }>
        ).map((part) => JSON.parse(part.data) as unknown),
    }));
}

function expectAssistantAwaitingTools(db: Database, sessionId: string, expected: boolean): void {
    const fromDb = assistantAwaitingToolsFromOpenCodeDb(db, sessionId);
    const fromMessages = assistantAwaitingToolsFromMessages(messagesFromDb(db, sessionId));
    expect(fromDb).toBe(expected);
    expect(fromMessages).toBe(fromDb);
}

function expectNoticeHold(db: Database, sessionId: string, expected: boolean): void {
    const fromDb = shouldHoldIgnoredNotificationFromOpenCodeDb(db, sessionId);
    const fromMessages = shouldHoldIgnoredNotificationFromMessages(messagesFromDb(db, sessionId));
    expect(fromDb).toBe(expected);
    expect(fromMessages).toBe(fromDb);
}

function insertAssistant(
    db: Database,
    sessionId: string,
    id: string,
    data: Record<string, unknown>,
    timeCreated = Date.now(),
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify({ role: "assistant", ...data }));
}

function insertUser(
    db: Database,
    sessionId: string,
    id: string,
    data: Record<string, unknown>,
    timeCreated: number,
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify({ role: "user", ...data }));
}

function insertPart(
    db: Database,
    sessionId: string,
    messageId: string,
    id: string,
    data: unknown,
): void {
    db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, messageId, sessionId, Date.now(), Date.now(), JSON.stringify(data));
}

describe("assistant tool-wait detection", () => {
    it("reports an assistant waiting for tools when the latest assistant finished with tool-calls", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("does not report an assistant waiting for tools when a newer real user message ends a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "new turn" }, 200);

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("keeps the assistant tool wait active for synthetic-part user messages after a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "agent nudge" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "agent nudge",
            synthetic: true,
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("reports an assistant waiting for tools when the latest assistant has a non-provider-executed tool part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" }, 100);
        insertPart(db, "session-1", "assistant-1", "part-1", {
            type: "tool",
            providerExecuted: false,
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("does not report an assistant waiting for tools when a newer real user message ends an unexecuted tool tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" }, 100);
        insertPart(db, "session-1", "assistant-1", "part-1", {
            type: "tool",
            providerExecuted: false,
        });
        insertUser(db, "session-1", "user-1", { content: "new turn" }, 200);

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("does not report an assistant waiting for tools for provider-executed tool parts", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" });
        insertPart(db, "session-1", "assistant-1", "part-1", {
            type: "tool",
            providerExecuted: true,
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("does not report an assistant waiting for tools when the latest assistant has no tool parts", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" });
        insertPart(db, "session-1", "assistant-1", "part-1", { type: "text", text: "done" });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("keeps the assistant tool wait active for marker-part user messages after a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "✉ Inbox from peer" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "✉ Inbox from peer",
            metadata: {
                marker: {
                    kind: "inbox",
                    from: "Peer Session",
                    sessionId: "ses_peer0000000000000000000",
                },
            },
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("ends the assistant tool wait for an @mention operator prompt with a synthetic agent part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "do the thing @research-deep" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "do the thing @research-deep",
        });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "agent",
            name: "research-deep",
            synthetic: true,
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("ends the assistant tool wait for a partless user message (vacuous-ALL fence)", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "new turn" }, 200);
        // No parts inserted — partless messages must count as real.

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("ends the assistant tool wait when a user message has a marker part AND a real text part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "real input with marker" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "✉ Inbox from peer",
            metadata: { marker: { kind: "inbox" } },
        });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "text",
            text: "real input with marker",
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("releases for real text with a file attachment part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "review this file" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "review this file",
        });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "file",
            mime: "text/plain",
            url: "file:///tmp/example.txt",
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("releases for a file-only user message without machine markers", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,AAAA",
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("releases when step boundary parts accompany real text", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "continue with the fix" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", { type: "step-start" });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "text",
            text: "continue with the fix",
        });
        insertPart(db, "session-1", "user-1", "part-3", { type: "step-finish" });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("does not release when every part is synthetic, including a patch part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "generated update" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "generated update",
            synthetic: true,
        });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "patch",
            hash: "abc123",
            files: ["src/example.ts"],
            synthetic: true,
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("does not report an assistant waiting for tools when there is no assistant message", () => {
        const db = createTurnStateDb();

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("keeps the assistant tool wait active for an ignored-only user part after a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "status notification" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "## Claude Routing Status",
            ignored: true,
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("ends the assistant tool wait when a user message has an ignored part AND a real text part", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "notification + real input" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "## Claude Quotas",
            ignored: true,
        });
        insertPart(db, "session-1", "user-1", "part-2", {
            type: "text",
            text: "actually do the thing",
        });

        expectAssistantAwaitingTools(db, "session-1", false);
    });

    it("keeps the assistant tool wait active when ignored is numeric 1 (truthy variant)", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "status notification" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "## Claude Quotas",
            ignored: 1,
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("keeps the assistant tool wait active for interrupt marker parts after a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "interrupt" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "interrupt",
            metadata: {
                marker: {
                    kind: "interrupt",
                    intent: "abort",
                    origin: "parent",
                },
            },
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("hasNewerRealUserMessage excludes ignored-only rows so they cannot end the assistant tool wait", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "status notification" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "## Claude Routing Status",
            ignored: true,
        });

        expect(hasNewerRealUserMessage(db, "session-1", 100)).toBe(false);
        expectAssistantAwaitingTools(db, "session-1", true);
    });

    it("keeps the assistant tool wait active for message marker parts after a stale tool-calls tail", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" }, 100);
        insertUser(db, "session-1", "user-1", { content: "peer message" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "peer message",
            metadata: {
                marker: {
                    kind: "message",
                    peer: "subagent",
                    expectReply: false,
                },
            },
        });

        expectAssistantAwaitingTools(db, "session-1", true);
    });
});

describe("shouldHoldIgnoredNotificationFromOpenCodeDb", () => {
    it("holds when a newer real user message exists even though assistantAwaitingTools is false", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" }, 100);
        insertUser(db, "session-1", "user-1", { content: "do the thing" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "do the thing",
        });

        expectAssistantAwaitingTools(db, "session-1", false);
        expectNoticeHold(db, "session-1", true);
    });

    it("holds while the latest assistant has no finish (generation in flight)", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", {}, 100);

        expectNoticeHold(db, "session-1", true);
    });

    it("does not hold after a finished assistant with no newer real user", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" }, 100);
        insertPart(db, "session-1", "assistant-1", "part-1", { type: "text", text: "done" });

        expectNoticeHold(db, "session-1", false);
    });

    it("does not treat an ignored-only notice as an unanswered real user", () => {
        const db = createTurnStateDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" }, 100);
        insertUser(db, "session-1", "user-1", { content: "status" }, 200);
        insertPart(db, "session-1", "user-1", "part-1", {
            type: "text",
            text: "status",
            ignored: true,
        });

        expect(hasNewerRealUserMessage(db, "session-1", 100)).toBe(false);
        expectNoticeHold(db, "session-1", false);
    });
});

describe("tracked out-of-pass turn state", () => {
    it("keeps answering after the selected DB disappears and logs the missing path once", () => {
        useTempDataHome("read-session-db-tracked-disappears-");
        const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
        mkdirSync(dirname(dbPath), { recursive: true });
        writeFileSync(dbPath, "sqlite fixture");
        observeOpenCodeTurnEvent("message.updated", {
            info: {
                id: "assistant-live",
                sessionID: "session-live",
                role: "assistant",
                finish: "tool-calls",
                time: { created: 100 },
            },
        });
        rmSync(dbPath);
        const logs: string[] = [];
        __openCodeTurnStateTest.setLogObserver((message) => logs.push(message));

        expect(assistantAwaitingTools(undefined, "session-live")).toBe(true);
        expect(shouldHoldIgnoredNotification("session-live")).toBe(true);
        expect(assistantAwaitingTools(undefined, "session-live")).toBe(true);
        expect(logs).toEqual([
            `[magic-context] OpenCode DB probe failed: path=${dbPath} source=default cause=opencode_db_missing`,
        ]);
    });

    it("tracks real and ignored user parts without reading the store", () => {
        useTempDataHome("read-session-db-tracked-parts-");
        observeOpenCodeTurnEvent("message.updated", {
            info: {
                id: "assistant-live",
                sessionID: "session-live",
                role: "assistant",
                finish: "tool-calls",
                time: { created: 100 },
            },
        });
        observeOpenCodeTurnEvent("message.part.updated", {
            part: {
                id: "ignored-part",
                messageID: "ignored-user",
                sessionID: "session-live",
                type: "text",
                ignored: true,
            },
        });
        observeOpenCodeTurnEvent("message.updated", {
            info: {
                id: "ignored-user",
                sessionID: "session-live",
                role: "user",
                time: { created: 200 },
            },
        });
        expect(assistantAwaitingTools(undefined, "session-live")).toBe(true);

        observeOpenCodeTurnEvent("message.part.updated", {
            part: {
                id: "real-part",
                messageID: "real-user",
                sessionID: "session-live",
                type: "text",
                text: "continue",
            },
        });
        observeOpenCodeTurnEvent("message.updated", {
            info: {
                id: "real-user",
                sessionID: "session-live",
                role: "user",
                time: { created: 300 },
            },
        });
        expect(assistantAwaitingTools(undefined, "session-live")).toBe(false);
        expect(shouldHoldIgnoredNotification("session-live")).toBe(true);
    });
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

interface MessageRow {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    providerID?: string;
    modelID?: string;
    agent?: string;
    timeCreated: number;
    data?: Record<string, unknown>;
}

function createOpenCodeDb(rows: MessageRow[]): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        const insert = db.prepare(
            `INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES (?, ?, ?, ?, ?)`,
        );
        for (const row of rows) {
            const data: Record<string, unknown> = { ...row.data, role: row.role };
            if (row.providerID !== undefined) data.providerID = row.providerID;
            if (row.modelID !== undefined) data.modelID = row.modelID;
            if (row.agent !== undefined) data.agent = row.agent;
            insert.run(
                row.id,
                row.sessionId,
                row.timeCreated,
                row.timeCreated,
                JSON.stringify(data),
            );
        }
    } finally {
        closeQuietly(db);
    }
}

function insertV2SessionMessages(
    rows: Array<{
        id: string;
        sessionId: string;
        type: "user" | "assistant" | "compaction";
        seq: number;
        model?: { providerID?: string; id?: string };
        agent?: string;
    }>,
    options: { v2Marker?: boolean } = {},
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            -- A migrated store keeps the v1 tables beside the v2 schema; the
            -- read-only session DB guard classifies message+part as v1.
            CREATE TABLE IF NOT EXISTS part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_v2 (
                id TEXT PRIMARY KEY
            );
        `);
        if (options.v2Marker === false) db.exec("DROP TABLE IF EXISTS session_v2");
        const insert = db.prepare(
            `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = Date.now();
        for (const row of rows) {
            const data: Record<string, unknown> = {};
            if (row.model !== undefined) data.model = row.model;
            if (row.agent !== undefined) data.agent = row.agent;
            insert.run(row.id, row.sessionId, row.type, row.seq, now, now, JSON.stringify(data));
        }
    } finally {
        closeQuietly(db);
    }
}

describe("latestPersistedMessageForRecovery", () => {
    it("reports when the latest assistant child has completed", () => {
        useTempDataHome("read-session-db-recovery-completed-");
        createOpenCodeDb([
            {
                id: "msg_assistant",
                sessionId: "ses_recovery",
                role: "assistant",
                timeCreated: 1000,
                data: {
                    parentID: "msg_user",
                    time: { created: 1000, completed: 1200 },
                    error: { name: "ExampleError" },
                },
            },
        ]);

        expect(latestPersistedMessageForRecovery("ses_recovery")).toEqual({
            id: "msg_assistant",
            role: "assistant",
            parentID: "msg_user",
            completedAt: 1200,
            error: { name: "ExampleError" },
        });
    });
});

describe("findLastAssistantModelFromOpenCodeDb", () => {
    it("prefers the v2 session_message table on a migrated store", () => {
        useTempDataHome("read-session-db-v2-preference-");
        createOpenCodeDb([
            {
                id: "msg_stale",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4.5",
                timeCreated: 1000,
            },
        ]);
        insertV2SessionMessages([
            { id: "sms_user", sessionId: "ses_A", type: "user", seq: 1 },
            {
                id: "sms_asst",
                sessionId: "ses_A",
                type: "assistant",
                seq: 2,
                model: { providerID: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
                agent: "build",
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "commandcode",
            modelID: "deepseek/deepseek-v4.1-flash",
            agent: "build",
        });
    });

    it("falls back to the v1 table when the v2 table has no assistant rows", () => {
        useTempDataHome("read-session-db-v2-fallback-");
        createOpenCodeDb([
            {
                id: "msg_legacy",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                timeCreated: 1000,
            },
        ]);
        insertV2SessionMessages([{ id: "sms_user", sessionId: "ses_A", type: "user", seq: 1 }]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
    });

    it("does not consult the v2 table on a 1.18 store that also ships session_message", () => {
        useTempDataHome("read-session-db-v1-session-message-");
        createOpenCodeDb([
            {
                id: "msg_live",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                timeCreated: 2000,
            },
        ]);
        // 1.18 stores ship session_message but no session_v2 marker; a stale
        // v2-shaped row must not win over the live v1 row.
        insertV2SessionMessages(
            [
                {
                    id: "sms_stale",
                    sessionId: "ses_A",
                    type: "assistant",
                    seq: 9,
                    model: { providerID: "stale", id: "stale-model" },
                },
            ],
            { v2Marker: false },
        );
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
    });

    it("returns null for a session with no assistant messages", () => {
        useTempDataHome("read-session-db-no-assistant-");
        createOpenCodeDb([
            {
                id: "msg_user1",
                sessionId: "ses_A",
                role: "user",
                timeCreated: 1000,
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toBeNull();
    });

    it("returns the most recent assistant's providerID/modelID", () => {
        useTempDataHome("read-session-db-latest-assistant-");
        createOpenCodeDb([
            {
                id: "msg_old",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4.5",
                timeCreated: 1000,
            },
            {
                id: "msg_new",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                timeCreated: 2000,
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
    });

    it("ignores user messages even when they are newer", () => {
        useTempDataHome("read-session-db-ignore-user-");
        createOpenCodeDb([
            {
                id: "msg_asst",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "github-copilot",
                modelID: "claude-sonnet-4.5",
                timeCreated: 1000,
            },
            {
                id: "msg_user_newer",
                sessionId: "ses_A",
                role: "user",
                timeCreated: 2000,
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "github-copilot",
            modelID: "claude-sonnet-4.5",
        });
    });

    it("ignores assistants without providerID or modelID", () => {
        useTempDataHome("read-session-db-incomplete-assistant-");
        createOpenCodeDb([
            {
                id: "msg_full",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                timeCreated: 1000,
            },
            {
                id: "msg_missing_model",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                // modelID missing
                timeCreated: 2000,
            },
        ]);
        // Returns the fully-populated earlier assistant rather than the newer partial row.
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
    });

    it("scopes by session ID and does not leak across sessions", () => {
        useTempDataHome("read-session-db-session-scope-");
        createOpenCodeDb([
            {
                id: "msg_A1",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                timeCreated: 1000,
            },
            {
                id: "msg_B1",
                sessionId: "ses_B",
                role: "assistant",
                providerID: "github-copilot",
                modelID: "gpt-5.4",
                timeCreated: 2000,
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
        expect(findLastAssistantModelFromOpenCodeDb("ses_B")).toEqual({
            providerID: "github-copilot",
            modelID: "gpt-5.4",
        });
    });

    it("returns null gracefully when the DB is missing entirely", () => {
        useTempDataHome("read-session-db-missing-db-");
        // Do NOT create the DB. The helper should log and return null instead of throwing.
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toBeNull();
    });

    it("includes agent name when present on the assistant message", () => {
        useTempDataHome("read-session-db-agent-");
        createOpenCodeDb([
            {
                id: "msg_agentic",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                agent: "Alfonso - CTO",
                timeCreated: 1000,
            },
        ]);
        expect(findLastAssistantModelFromOpenCodeDb("ses_A")).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
            agent: "Alfonso - CTO",
        });
    });

    it("omits agent when missing or empty on the assistant message", () => {
        useTempDataHome("read-session-db-no-agent-");
        createOpenCodeDb([
            {
                id: "msg_default",
                sessionId: "ses_A",
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-opus-4-7",
                // no agent
                timeCreated: 1000,
            },
        ]);
        const result = findLastAssistantModelFromOpenCodeDb("ses_A");
        expect(result).toEqual({
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
        });
        // Important: must not have an `agent` property at all (RPC handler
        // checks `if (recovered.agent)` so undefined is fine, but presence
        // of an empty string would break the agentBySession lookup).
        expect((result as { agent?: string }).agent).toBeUndefined();
    });
});
