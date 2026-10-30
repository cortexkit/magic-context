/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runCompartmentAgent } from "./compartment-runner";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDirectory(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeHostDb(dataHome: string, parentSessionId: string, projectDir: string): Database {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            directory TEXT NOT NULL,
            time_created INTEGER NOT NULL
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    db.prepare("INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)").run(
        parentSessionId,
        "parent",
        projectDir,
        Date.now(),
    );

    const messages = [
        { id: "source-1", role: "user", text: "eligible one" },
        { id: "source-2", role: "assistant", text: "eligible two" },
        { id: "source-3", role: "user", text: "protected one" },
        { id: "source-4", role: "user", text: "protected two" },
        { id: "source-5", role: "user", text: "protected three" },
        { id: "source-6", role: "user", text: "protected four" },
        { id: "source-7", role: "user", text: "protected five" },
    ];
    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    messages.forEach((message, index) => {
        const timestamp = index + 1;
        insertMessage.run(
            message.id,
            parentSessionId,
            timestamp,
            timestamp,
            JSON.stringify({ id: message.id, role: message.role, sessionID: parentSessionId }),
        );
        insertPart.run(
            `part-${message.id}`,
            message.id,
            parentSessionId,
            timestamp,
            timestamp,
            JSON.stringify({ type: "text", text: message.text }),
        );
    });
    return db;
}

describe("historian child session cleanup", () => {
    test("deletes the historian child after its prompt resolves and the compartment publishes", async () => {
        const dataHome = useTempDirectory("magic-context-child-cleanup-data-");
        const projectDir = useTempDirectory("magic-context-child-cleanup-project-");
        process.env.XDG_DATA_HOME = dataHome;

        const contextDb = openDatabase();
        expect(contextDb).toBeTruthy();
        const parentSessionId = "ses-parent";
        const childSessionId = "ses-historian-child";
        const childMessageId = "msg-historian-child";
        const hostDb = makeHostDb(dataHome, parentSessionId, projectDir);

        const deleteSession = mock(async ({ path }: { path: { id: string } }) => {
            hostDb.prepare("DELETE FROM session WHERE id = ?").run(path.id);
            return {};
        });
        const sessionStatus = mock(async () => ({ data: { type: "idle" } }));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: projectDir } })),
                create: mock(async () => {
                    const now = Date.now();
                    hostDb
                        .prepare(
                            "INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)",
                        )
                        .run(childSessionId, "magic-context-compartment", projectDir, now);
                    hostDb
                        .prepare(
                            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                        )
                        .run(
                            childMessageId,
                            childSessionId,
                            now,
                            now,
                            JSON.stringify({
                                id: childMessageId,
                                role: "assistant",
                                sessionID: childSessionId,
                            }),
                        );
                    return { data: { id: childSessionId } };
                }),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: Date.now() } },
                            parts: [
                                {
                                    type: "text",
                                    text: '<compartment start="1" end="2" title="History"><p1>Summary</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                status: sessionStatus,
                delete: deleteSession,
            },
        } as unknown as PluginContext["client"];
        const promptSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(
            undefined,
        );

        try {
            const holderId = "late-part-regression-holder";
            expect(acquireCompartmentLease(contextDb!, parentSessionId, holderId)).not.toBeNull();
            try {
                await runCompartmentAgent({
                    historianTurnTwo: "off",
                    client,
                    db: contextDb!,
                    sessionId: parentSessionId,
                    historianChunkTokens: 10_000,
                    directory: projectDir,
                    forceKeepLastCompartment: true,
                    compartmentLeaseHolderId: holderId,
                    boundarySnapshot: {
                        sessionId: parentSessionId,
                        mode: "incremental-runner",
                        offset: 1,
                        offsetMessageId: "source-1",
                        protectedTailStart: 3,
                        protectedTailStartMessageId: "source-3",
                        eligibleEndOrdinal: 3,
                        eligibleEndMessageId: "source-2",
                        rawMessageCountAtTrigger: 7,
                        rawLastMessageIdAtTrigger: "source-7",
                        N: 0,
                        usagePercentage: 0,
                        usageInputTokens: 0,
                        usageSource: "provisional-zero",
                        contextLimit: 128_000,
                        executeThresholdPercentage: 65,
                        triggerBudget: 10_000,
                        priorBoundaryOrdinal: 3,
                        migrationFloorActive: false,
                        providerShapeVersion: "opencode-v1",
                        cacheNamespace: `test:${parentSessionId}`,
                        createdAt: Date.now(),
                        rawRangeFingerprint: "",
                        trueRawEligibleTokens: 1_000,
                        oversizeAtomicUnit: false,
                        boundaryReason: "test",
                    },
                });
            } finally {
                releaseCompartmentLease(contextDb!, parentSessionId, holderId);
            }
            expect(getCompartments(contextDb!, parentSessionId)).toHaveLength(1);

            expect(sessionStatus).not.toHaveBeenCalled();
            expect(deleteSession).toHaveBeenCalledWith({
                path: { id: childSessionId },
                query: { directory: projectDir },
            });
            expect(
                hostDb.prepare("SELECT id FROM session WHERE id = ?").get(childSessionId),
            ).toBeNull();
        } finally {
            promptSpy.mockRestore();
            closeQuietly(hostDb);
        }
    });
});
