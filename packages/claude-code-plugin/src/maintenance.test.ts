import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { pruneVanishedTranscriptIndexes } from "./maintenance";
import { openRuntime, type Runtime } from "./runtime";
import { userRecord, writeTranscript } from "./test-fixtures";

let runtime: Runtime;

beforeAll(() => {
    const { dir } = createTestTempDir("mc-claude-code-maintenance-");
    runtime = openRuntime(dir);
});

afterAll(() => runtime.close());

const DAY = 24 * 60 * 60 * 1000;

function indexRow(sessionId: string, harness: string, updatedAt: number): void {
    runtime.db
        .prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at, harness) VALUES (?, 3, ?, ?)",
        )
        .run(sessionId, updatedAt, harness);
}

function hasRow(sessionId: string): boolean {
    return (
        runtime.db
            .prepare("SELECT 1 FROM message_history_index WHERE session_id = ?")
            .get(sessionId) != null
    );
}

test("drops the index of idle Claude Code sessions whose transcript is gone, and nothing else", () => {
    const { dir } = createTestTempDir("mc-claude-code-maintenance-config-");
    const configDir = join(dir, "claude");
    const now = Date.UTC(2026, 9, 1);
    writeTranscript(configDir, "/work/app", "cc-still-there", [userRecord("hi")]);

    indexRow("cc-vanished", "claude-code", now - 10 * DAY);
    indexRow("cc-still-there", "claude-code", now - 10 * DAY);
    indexRow("cc-recent-vanished", "claude-code", now - DAY);
    indexRow("oc-vanished", "opencode", now - 10 * DAY);

    const result = pruneVanishedTranscriptIndexes(runtime.db, { now, configDir });

    expect(result).toEqual({ checked: 2, pruned: 1 });
    expect(hasRow("cc-vanished")).toBe(false);
    expect(hasRow("cc-still-there")).toBe(true);
    expect(hasRow("cc-recent-vanished")).toBe(true);
    expect(hasRow("oc-vanished")).toBe(true);
});
