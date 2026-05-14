/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    closeReadOnlySessionDb,
    findLastAssistantModelFromOpenCodeDb,
    isMidTurnFromOpenCodeDb,
} from "./read-session-db";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    // Close any cached OpenCode read-only DB handle so the new XDG_DATA_HOME
    // points to a fresh DB on the next test case.
    closeReadOnlySessionDb();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function createMidTurnDb(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function insertAssistant(
    db: Database,
    sessionId: string,
    id: string,
    data: Record<string, unknown>,
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, Date.now(), Date.now(), JSON.stringify({ role: "assistant", ...data }));
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

describe("isMidTurnFromOpenCodeDb", () => {
    it("is mid-turn when the latest assistant finished with tool-calls", () => {
        const db = createMidTurnDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "tool-calls" });

        expect(isMidTurnFromOpenCodeDb(db, "session-1")).toBe(true);
    });

    it("is mid-turn when the latest assistant has a non-provider-executed tool part", () => {
        const db = createMidTurnDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" });
        insertPart(db, "session-1", "assistant-1", "part-1", {
            type: "tool",
            providerExecuted: false,
        });

        expect(isMidTurnFromOpenCodeDb(db, "session-1")).toBe(true);
    });

    it("is not mid-turn for provider-executed tool parts", () => {
        const db = createMidTurnDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" });
        insertPart(db, "session-1", "assistant-1", "part-1", {
            type: "tool",
            providerExecuted: true,
        });

        expect(isMidTurnFromOpenCodeDb(db, "session-1")).toBe(false);
    });

    it("is not mid-turn when the latest assistant has no tool parts", () => {
        const db = createMidTurnDb();
        insertAssistant(db, "session-1", "assistant-1", { finish: "stop" });
        insertPart(db, "session-1", "assistant-1", "part-1", { type: "text", text: "done" });

        expect(isMidTurnFromOpenCodeDb(db, "session-1")).toBe(false);
    });

    it("is not mid-turn when there is no assistant message", () => {
        const db = createMidTurnDb();

        expect(isMidTurnFromOpenCodeDb(db, "session-1")).toBe(false);
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
            const data: Record<string, unknown> = { role: row.role };
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

describe("findLastAssistantModelFromOpenCodeDb", () => {
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
