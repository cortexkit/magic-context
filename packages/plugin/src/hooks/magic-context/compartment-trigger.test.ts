/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    closeDatabase,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import type { SessionMeta } from "../../features/magic-context/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { checkCompartmentTrigger } from "./compartment-trigger";

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

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text?: string }>,
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
            if (message.text) {
                insertPart.run(
                    message.id,
                    sessionId,
                    timestamp,
                    timestamp,
                    JSON.stringify({ type: "text", text: message.text }),
                );
            }
        });
    } finally {
        closeQuietly(db);
    }
}

function makeSessionMeta(sessionId: string, lastContextPercentage: number): SessionMeta {
    return {
        sessionId,
        counter: 0,
        cacheTtl: "5m",
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        isSubagent: false,
        lastContextPercentage,
        lastInputTokens: 0,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        lastTransformError: null,
        systemPromptHash: "",
        systemPromptTokens: 0,
        clearedReasoningThroughTag: 0,
    };
}

describe("checkCompartmentTrigger", () => {
    it("fires proactively near the execute threshold when pending drops are insufficient and the unsummarized tail is meaningful", () => {
        useTempDataHome("compartment-trigger-proactive-");
        createOpenCodeDb("ses-proactive", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(7000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(7000) },
            { id: "m-5", role: "user", text: "protected tail 1" },
            { id: "m-6", role: "user", text: "protected tail 2" },
            { id: "m-7", role: "user", text: "protected tail 3" },
            { id: "m-8", role: "user", text: "protected tail 4" },
            { id: "m-9", role: "user", text: "protected tail 5" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-proactive", "m-1", "message", 950, 1);
        insertTag(db, "ses-proactive", "m-2", "message", 50, 2);
        queuePendingOp(db, "ses-proactive", 2, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-proactive",
            makeSessionMeta("ses-proactive", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
        );

        expect(result).toEqual({ shouldFire: true, reason: "projected_headroom" });
    });

    it("does not fire proactively when pending drops already project usage below the post-drop target", () => {
        useTempDataHome("compartment-trigger-projected-");
        createOpenCodeDb("ses-projected", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(5000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(5000) },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-projected", "m-1", "message", 800, 1);
        insertTag(db, "ses-projected", "m-2", "message", 200, 2);
        queuePendingOp(db, "ses-projected", 1, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-projected",
            makeSessionMeta("ses-projected", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
        );

        expect(result).toEqual({ shouldFire: false });
    });

    it("does not fire proactively when auto-droppable tool reasoning brings projected usage below target", () => {
        useTempDataHome("compartment-trigger-tool-reasoning-");
        createOpenCodeDb("ses-tool-reasoning", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(7000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(7000) },
            { id: "m-5", role: "user", text: "protected tail 1" },
            { id: "m-6", role: "user", text: "protected tail 2" },
            { id: "m-7", role: "user", text: "protected tail 3" },
            { id: "m-8", role: "user", text: "protected tail 4" },
            { id: "m-9", role: "user", text: "protected tail 5" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-tool-reasoning", "call-1", "tool", 100, 1, 900);
        insertTag(db, "ses-tool-reasoning", "m-2", "message", 100, 2);

        const result = checkCompartmentTrigger(
            db,
            "ses-tool-reasoning",
            makeSessionMeta("ses-tool-reasoning", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            undefined,
            0,
            0,
        );

        expect(result).toEqual({ shouldFire: false });
    });

    it("accounts for truncated tool stubs when dropToolStructure is false", () => {
        useTempDataHome("compartment-trigger-truncated-tools-");
        createOpenCodeDb("ses-truncated-tools", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "a ".repeat(7000) },
            { id: "m-4", role: "assistant", text: "b ".repeat(7000) },
            { id: "m-5", role: "user", text: "protected tail 1" },
            { id: "m-6", role: "user", text: "protected tail 2" },
            { id: "m-7", role: "user", text: "protected tail 3" },
            { id: "m-8", role: "user", text: "protected tail 4" },
            { id: "m-9", role: "user", text: "protected tail 5" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-truncated-tools", "call-1", "tool", 250, 1, 0, "read", 700);
        insertTag(db, "ses-truncated-tools", "m-2", "message", 750, 2);

        const fullDropResult = checkCompartmentTrigger(
            db,
            "ses-truncated-tools",
            makeSessionMeta("ses-truncated-tools", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            undefined,
            0,
            0,
            undefined,
            true,
        );
        const truncatedResult = checkCompartmentTrigger(
            db,
            "ses-truncated-tools",
            makeSessionMeta("ses-truncated-tools", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
            undefined,
            0,
            0,
            undefined,
            false,
        );

        expect(fullDropResult).toEqual({ shouldFire: false });
        expect(truncatedResult).toEqual({ shouldFire: true, reason: "projected_headroom" });
    });

    it("does not force-fire at 80% when pending drops are enough to bring usage below target", () => {
        useTempDataHome("compartment-trigger-force-skip-");
        createOpenCodeDb("ses-force-skip", [
            { id: "m-1", role: "user", text: "setup" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "follow-up" },
        ]);
        const db = openDatabase();
        insertTag(db, "ses-force-skip", "m-1", "message", 800, 1);
        insertTag(db, "ses-force-skip", "m-2", "message", 200, 2);
        queuePendingOp(db, "ses-force-skip", 1, "drop", 1);

        const result = checkCompartmentTrigger(
            db,
            "ses-force-skip",
            makeSessionMeta("ses-force-skip", 79),
            { percentage: 82, inputTokens: 164_000 },
            79,
            65,
        );

        expect(result).toEqual({ shouldFire: false });
    });

    it("does not fire when only unsummarized history is inside the protected tail", () => {
        //#given: 3 messages, all 3 are user turns so protected tail covers all
        useTempDataHome("compartment-trigger-protected-only-");
        createOpenCodeDb("ses-protected-only", [
            { id: "m-1", role: "user", text: "a".repeat(200) },
            { id: "m-2", role: "user", text: "b".repeat(200) },
            { id: "m-3", role: "user", text: "c".repeat(200) },
        ]);
        const db = openDatabase();

        //#when
        const result = checkCompartmentTrigger(
            db,
            "ses-protected-only",
            makeSessionMeta("ses-protected-only", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
        );

        //#then: no eligible prefix — should not fire
        expect(result).toEqual({ shouldFire: false });
    });

    it("fires proactively when meaningful eligible history exists before protected tail", () => {
        //#given: 8 user turns with big content — last 5 are protected, first 3 are eligible
        useTempDataHome("compartment-trigger-eligible-prefix-");
        createOpenCodeDb("ses-eligible-prefix", [
            { id: "m-1", role: "user", text: "a ".repeat(3500) },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "b ".repeat(3500) },
            { id: "m-4", role: "assistant", text: "done" },
            { id: "m-5", role: "user", text: "c ".repeat(3500) },
            { id: "m-6", role: "assistant", text: "done" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        //#when: no pending drops, percentage above proactive threshold
        const result = checkCompartmentTrigger(
            db,
            "ses-eligible-prefix",
            makeSessionMeta("ses-eligible-prefix", 62),
            { percentage: 63, inputTokens: 126_000 },
            62,
            65,
        );

        //#then: fires because the eligible prefix (m-1 to m-6) is meaningful
        expect(result).toEqual({ shouldFire: true, reason: "projected_headroom" });
    });
});
