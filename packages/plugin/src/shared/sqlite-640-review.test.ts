import { expect, spyOn, test } from "bun:test";
import { openDatabase } from "../features/magic-context/storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage-meta";
import { recordToolDefinition } from "../features/magic-context/tool-definition-tokens";
import { captureLkgSlot } from "../hooks/magic-context/lkg-replay";
import { lkgReplayFits } from "../hooks/magic-context/lkg-replay-fit";
import { resetLkgSlotsForTest } from "../hooks/magic-context/lkg-slot";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { createMessagesTransformHandler } from "../plugin/messages-transform";
import { refreshModelLimitsFromApi } from "./models-dev-cache";
import { Database, SqliteAcquisitionBusyError, withAsyncPrivilegedWriter } from "./sqlite";

function fixture() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)");
    db.exec("CREATE TABLE writes(value INTEGER)");
    return db;
}

test("review: shared async admission rolls back callback busy without retrying side effects", async () => {
    const db = fixture();
    let callbacks = 0;
    let recoveries = 0;
    try {
        await expect(
            withAsyncPrivilegedWriter(
                db,
                () => {
                    callbacks++;
                    db.prepare("INSERT INTO writes VALUES (1)").run();
                    throw new SqliteAcquisitionBusyError(new Error("nested acquisition busy"));
                },
                {
                    beforeRetry: () => {
                        recoveries++;
                    },
                },
            ),
        ).rejects.toThrow("SQLite writer acquisition remained busy");
        expect(callbacks).toBe(1);
        expect(recoveries).toBe(0);
        expect(db.prepare("SELECT * FROM writes").all()).toEqual([]);
        expect(db.inTransaction).toBe(false);
    } finally {
        db.close();
    }
});

test("review: default OpenCode empty admission retries BEGIN only and preserves output bytes", async () => {
    const db = fixture();
    const exec = db.exec.bind(db);
    let attempts = 0;
    const spy = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && ++attempts === 1)
            throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        return exec(sql);
    });
    try {
        const output = [{ role: "user", content: "§1§ managed input" }];
        const before = JSON.stringify(output);
        await withAsyncPrivilegedWriter(db, () => undefined);
        expect(attempts).toBe(2);
        expect(JSON.stringify(output)).toBe(before);
        expect(db.inTransaction).toBe(false);
    } finally {
        spy.mockRestore();
        db.close();
    }
});

test("review: COMMIT busy after empty admission is surfaced once and transaction is released", async () => {
    const db = fixture();
    const exec = db.exec.bind(db);
    let callbacks = 0;
    let commits = 0;
    const spy = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "COMMIT") {
            commits++;
            throw Object.assign(new Error("reader holds rollback-journal lock"), {
                code: "SQLITE_BUSY",
            });
        }
        return exec(sql);
    });
    try {
        await expect(
            withAsyncPrivilegedWriter(db, () => {
                callbacks++;
            }),
        ).rejects.toThrow("reader holds rollback-journal lock");
        expect(callbacks).toBe(1);
        expect(commits).toBe(1);
        expect(db.inTransaction).toBe(false);
    } finally {
        spy.mockRestore();
        db.close();
    }
});

test("review: OpenCode tries a valid saved request before backed-off writer retry", async () => {
    resetLkgSlotsForTest();
    const db = openDatabase();
    if (!db) throw new Error("isolated test database unavailable");
    const sessionId = "review-opencode-order";
    const model = { providerID: "openai", modelID: "gpt-4.1" };
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: model.providerID,
                            models: {
                                [model.modelID]: { limit: { context: 1000000, output: 8192 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
    recordToolDefinition(model.providerID, model.modelID, undefined, "read", "read file", {
        type: "object",
    });
    const messages = [
        {
            info: { id: "u0", role: "user", sessionID: sessionId, model },
            parts: [{ type: "text", text: "old raw history" }],
        },
    ] as MessageLike[];
    const managed = structuredClone(messages);
    (managed[0].parts[0] as { text: string }).text = "saved managed prefix";
    expect(
        captureLkgSlot({
            sessionId,
            input: messages,
            output: managed,
            modelKey: "openai/gpt-4.1",
            providerKey: "openai",
        }),
    ).toBe(true);
    expect(
        lkgReplayFits({
            db,
            sessionId,
            messages: managed,
            model,
            modelKey: "openai/gpt-4.1",
            systemPromptTokens: 100,
        }).fits,
    ).toBe(true);
    const exec = db.exec.bind(db);
    let attempts = 0;
    let callbacks = 0;
    const spy = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && ++attempts === 1)
            throw Object.assign(new Error("writer busy"), { code: "SQLITE_BUSY" });
        return exec(sql);
    });
    try {
        const output = { messages: structuredClone(messages) };
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, result) => {
                    callbacks++;
                    (result.messages[0].parts[0] as { text: string }).text =
                        "recomputed after retry";
                },
            },
        });
        await handler({}, output as Parameters<typeof handler>[1]);
        expect({ callbacks, attempts, messages: output.messages }).toEqual({
            callbacks: 0,
            attempts: 1,
            messages: managed,
        });
    } finally {
        spy.mockRestore();
        resetLkgSlotsForTest();
    }
});
