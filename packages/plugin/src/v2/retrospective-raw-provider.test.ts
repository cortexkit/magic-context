import { expect, test } from "bun:test";
import { join } from "node:path";
import {
    RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
    readRetrospectiveScanWindow,
} from "../features/magic-context/dreamer/retrospective-raw-provider";
import { Database } from "../shared/sqlite";
import { createTestTempDir } from "../shared/test-temp-dir";
import { V2RetrospectiveRawProvider } from "./retrospective-raw-provider";
import { V2StoreReader } from "./store-reader";

test("OC2 retrospective reads native oldest-first bounded user history, not stale legacy or private rows", async () => {
    const { dir: root, cleanup } = createTestTempDir("oc2-retrospective-");
    const path = join(root, "opencode2.db");
    const host = new Database(path);
    const context = new Database(":memory:");
    host.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, metadata TEXT);
        CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
        CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO session_v2 VALUES ('root', NULL, '{}'), ('child', 'root', '{}'), ('foreign', NULL, '{}'), ('hidden', NULL, '{"magic_context":"hidden-run"}'), ('holder', NULL, '{"magic_context":"background-holder"}');
        INSERT INTO session_message VALUES ('holder-prompt', 'holder', 'user', 0, 400, '{"text":"PRIVATE_HOLDER_PROMPT"}');
        INSERT INTO message VALUES ('old', 'root', 99999, '{"role":"user"}');
        INSERT INTO part VALUES ('old', 'old', 'root', 99999, '{"type":"text","text":"STALE_LEGACY"}');`);
    context.exec(`CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT);
        CREATE TABLE session_meta(session_id TEXT, is_subagent INTEGER);
        CREATE TABLE schema_migrations_meta(key TEXT, value TEXT);
        INSERT INTO session_projects VALUES ('root', 'opencode2', 'project'), ('child', 'opencode2', 'project'), ('foreign', 'opencode2', 'other'), ('legacy', 'opencode', 'project'), ('hidden', 'opencode2', 'project'), ('holder', 'opencode2', 'project');
        INSERT INTO schema_migrations_meta VALUES ('retrospective_activity:root', '1000'), ('retrospective_activity:child', '1000'), ('retrospective_activity:foreign', '1000'), ('retrospective_activity:legacy', '1000'), ('retrospective_activity:hidden', '1000');`);
    const insert = host.prepare("INSERT INTO session_message VALUES (?, 'root', ?, ?, ?, ?)");
    insert.run("z", "user", 4, 100, JSON.stringify({ text: "first real user" }));
    insert.run(
        "a",
        "assistant",
        5,
        101,
        JSON.stringify({
            content: [
                { type: "text", text: "PRIVATE_ASSISTANT" },
                {
                    type: "tool",
                    name: "read",
                    state: { content: [{ type: "text", text: "SECRET_OUTPUT" }] },
                },
            ],
        }),
    );
    insert.run("b", "synthetic", 6, 102, JSON.stringify({ text: "PRIVATE_SYNTHETIC" }));
    insert.run(
        "c",
        "user",
        10,
        200,
        JSON.stringify({
            content: [
                { type: "text", text: "second real user" },
                { type: "text", synthetic: true, text: "SYNTHETIC_PART" },
                { type: "text", ignored: true, text: "IGNORED_PART" },
            ],
        }),
    );
    insert.run("d", "user", 15, 300, JSON.stringify({ text: `head${"x".repeat(100000)}tail` }));
    const provider = new V2RetrospectiveRawProvider(context, () => new V2StoreReader(path));
    try {
        const reader = new V2StoreReader(path);
        try {
            // SQLite treats a zero negative offset as the complete string. A
            // marker-only budget must therefore be rejected, not leak raw text.
            expect(() =>
                reader.retrospectiveUserPage("root", {
                    boundaryMs: 0,
                    limit: 1,
                    maxChars: 3,
                    truncationMarker: "...",
                }),
            ).toThrow("Invalid text limit");
        } finally {
            reader.close();
        }
        expect(provider.listProjectSessions("project")).toEqual([
            { sessionId: "root", updatedAt: 300 },
        ]);
        context.exec("DELETE FROM schema_migrations_meta");
        expect(provider.listProjectSessions("project")).toEqual([
            { sessionId: "root", updatedAt: 300 },
        ]);
        const page = provider.readUserMessagesSince("root", 0, 2);
        expect(page.truncated).toBe(true);
        expect(
            page.messages.map((row) => [
                row.ts,
                row.ordinal,
                row.text,
                row.followsAssistantReply === true,
            ]),
        ).toEqual([
            [100, 4, "first real user", false],
            [200, 10, "second real user", true],
        ]);
        expect(provider.readOldestMessageTimesSince(["root"], 100).get("root")).toBe(200);
        expect(provider.readUserMessagesBefore("root", 200, 2).map((row) => row.ts)).toEqual([
            100, 200,
        ]);
        const tail = provider.readUserMessagesSince("root", 200, 1);
        expect(tail.truncated).toBe(false);
        expect(tail.messages[0]?.text.length).toBeLessThanOrEqual(
            RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
        );
        expect(tail.messages[0]?.text).toStartWith("head");
        expect(tail.messages[0]?.text).toEndWith("tail");
        const window = await readRetrospectiveScanWindow(provider, "project", 0, 0, {
            capPerSession: 2,
        });
        expect(window.maxScannedTs).toBe(199);
        expect(JSON.stringify(window)).not.toMatch(
            /PRIVATE|SECRET|STALE|SYNTHETIC_PART|IGNORED_PART/,
        );
    } finally {
        provider.dispose();
        host.close();
        context.close();
        cleanup();
    }
});
