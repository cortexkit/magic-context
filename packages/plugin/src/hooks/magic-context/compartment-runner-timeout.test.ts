/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { executeContextRecomp, runCompartmentAgent } from "./compartment-runner";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("historian timeout wiring", () => {
    it("passes historianTimeoutMs to incremental historian runs", async () => {
        useTempDataHome("magic-context-incremental-timeout-");
        createOpenCodeDb("ses-incremental-timeout", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);

        const db = openDatabase();
        const client = createHistorianClient(
            "/tmp/incremental-timeout",
            `<compartment start="1" end="2" title="Eligible history">Summary</compartment>`,
        );
        const promptSyncSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(
            undefined,
        );

        try {
            await runCompartmentAgent({
                client,
                db,
                sessionId: "ses-incremental-timeout",
                historianChunkTokens: 10_000,
                historianTimeoutMs: 456_789,
                directory: "/tmp",
            });

            expect(promptSyncSpy).toHaveBeenCalledTimes(1);
            expect(promptSyncSpy.mock.calls[0]?.[2]).toEqual({ timeoutMs: 456_789 });
        } finally {
            promptSyncSpy.mockRestore();
        }
    });

    it("passes historianTimeoutMs to recomp historian runs", async () => {
        useTempDataHome("magic-context-recomp-timeout-");
        createOpenCodeDb("ses-recomp-timeout-wiring", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);

        const db = openDatabase();
        const client = createHistorianClient(
            "/tmp/recomp-timeout",
            `<compartment start="1" end="4" title="Recovered history">Summary</compartment>`,
        );
        const promptSyncSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(
            undefined,
        );

        try {
            await executeContextRecomp({
                client,
                db,
                sessionId: "ses-recomp-timeout-wiring",
                historianChunkTokens: 10_000,
                historianTimeoutMs: 456_789,
                directory: "/tmp",
            });

            expect(promptSyncSpy).toHaveBeenCalledTimes(1);
            expect(promptSyncSpy.mock.calls[0]?.[2]).toEqual({ timeoutMs: 456_789 });
        } finally {
            promptSyncSpy.mockRestore();
        }
    });
});

function createHistorianClient(directory: string, output: string): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory } })),
            create: mock(async () => ({ data: { id: "ses-historian-child" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: output }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
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
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );

        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            insertPart.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        closeQuietly(db);
    }
}
