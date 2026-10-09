/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import { closeQuietly } from "../src/shared/sqlite-helpers";
import {
    parseReplayDocument,
    serializeReplayDocument,
} from "../src/features/magic-context/storage-replay-document";
import { cloneSession, deleteClonedSession } from "./clone-session";

const temporaryDirectories: string[] = [];

function makeFixture(
    options: { includeReplayDocument?: boolean } = {},
): { opencodePath: string; contextPath: string; sourceSessionId: string } {
    const root = mkdtempSync(join(tmpdir(), "clone-session-fixture-"));
    const replayDocumentColumn =
        options.includeReplayDocument === false ? "" : "trailing_blank_decisions TEXT DEFAULT '',";
    temporaryDirectories.push(root);
    const opencodePath = join(root, "opencode.db");
    const contextPath = join(root, "context.db");
    const sourceSessionId = "ses_source";

    const opencode = new Database(opencodePath);
    opencode.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES project(id),
            parent_id TEXT,
            slug TEXT NOT NULL,
            directory TEXT NOT NULL,
            title TEXT NOT NULL,
            version TEXT NOT NULL,
            share_url TEXT,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_compacting INTEGER,
            time_archived INTEGER,
            summary_additions INTEGER,
            summary_deletions INTEGER,
            summary_files INTEGER,
            summary_diffs TEXT,
            revert TEXT,
            permission TEXT,
            agent TEXT,
            model TEXT,
            cost REAL NOT NULL DEFAULT 0,
            tokens_input INTEGER NOT NULL DEFAULT 0,
            tokens_output INTEGER NOT NULL DEFAULT 0,
            tokens_reasoning INTEGER NOT NULL DEFAULT 0,
            tokens_cache_read INTEGER NOT NULL DEFAULT 0,
            tokens_cache_write INTEGER NOT NULL DEFAULT 0,
            metadata TEXT
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
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE session_input (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            prompt TEXT NOT NULL,
            delivery TEXT NOT NULL,
            admitted_seq INTEGER NOT NULL,
            promoted_seq INTEGER,
            time_created INTEGER NOT NULL
        );
        CREATE TABLE todo (
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            position INTEGER NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            PRIMARY KEY (session_id, position)
        );
        CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
        CREATE TABLE event (
            id TEXT PRIMARY KEY,
            aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL
        );
    `);
    opencode.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("project_1", "/tmp/drive-project");
    opencode
        .prepare(
            "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
            sourceSessionId,
            "project_1",
            null,
            "source-slug",
            "/tmp/drive-project",
            "Synthetic source",
            "1.2.3",
            10,
            20,
            JSON.stringify({ sourceSessionId }),
        );
    opencode.prepare(
        "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("input_source_1", sourceSessionId, "input", "admitted", 1, 15);
    const insertMessage = opencode.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    insertMessage.run(
        "msg_source_1",
        sourceSessionId,
        100,
        100,
        JSON.stringify({
            role: "user",
            id: "msg_source_1",
            compaction: { tail_start_id: "msg_source_1", summary_refs: ["msg_source_1"] },
        }),
    );
    insertMessage.run(
        "msg_source_2",
        sourceSessionId,
        200,
        200,
        JSON.stringify({
            role: "assistant",
            id: "msg_source_2",
            parentID: "msg_source_1",
            finish: "stop",
            compaction: { tail_start_id: "msg_source_1", summary_refs: ["msg_source_1"] },
        }),
    );
    opencode
        .prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
            "prt_source_1",
            "msg_source_1",
            sourceSessionId,
            101,
            101,
            JSON.stringify({
                id: "prt_source_1",
                messageID: "msg_source_1",
                sessionID: sourceSessionId,
                type: "text",
                text: "hello",
            }),
        );
    opencode
        .prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
            "prt_source_2",
            "msg_source_2",
            sourceSessionId,
            201,
            201,
            JSON.stringify({
                id: "prt_source_2",
                messageID: "msg_source_2",
                sessionID: sourceSessionId,
                type: "tool",
                callID: "tool_source_1",
                providerExecuted: true,
            }),
        );
    opencode
        .prepare(
            "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sourceSessionId, "drive todo", "pending", "high", 0, 10, 10);
    opencode
        .prepare("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)")
        .run(sourceSessionId, 1, "");
    opencode
        .prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)")
        .run(
            "evt_source_1",
            sourceSessionId,
            0,
            "message.updated.1",
            JSON.stringify({ sessionID: sourceSessionId, info: { id: "msg_source_1" } }),
        );
    closeQuietly(opencode);

    const context = new Database(contextPath);
    context.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE compartments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            start_message INTEGER NOT NULL,
            end_message INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            start_message_id TEXT DEFAULT '',
            end_message_id TEXT DEFAULT '',
            harness TEXT NOT NULL DEFAULT 'opencode',
            importance INTEGER NOT NULL DEFAULT 50,
            episode_type TEXT,
            p1 TEXT,
            p2 TEXT,
            p3 TEXT,
            p4 TEXT,
            legacy INTEGER NOT NULL DEFAULT 0,
            UNIQUE(session_id, sequence)
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            message_id TEXT,
            type TEXT,
            status TEXT DEFAULT 'active',
            byte_size INTEGER,
            tag_number INTEGER,
            reasoning_byte_size INTEGER DEFAULT 0,
            drop_mode TEXT DEFAULT 'full',
            tool_name TEXT,
            input_byte_size INTEGER DEFAULT 0,
            caveman_depth INTEGER DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode',
            tool_owner_message_id TEXT DEFAULT NULL,
            entry_fingerprint TEXT,
            token_count INTEGER,
            input_token_count INTEGER,
            reasoning_token_count INTEGER,
            UNIQUE(session_id, tag_number)
        );
        CREATE TABLE source_contents (tag_id INTEGER, session_id TEXT, content TEXT, created_at INTEGER, harness TEXT NOT NULL DEFAULT 'opencode', PRIMARY KEY(session_id, tag_id));
        CREATE TABLE pending_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tag_id INTEGER, operation TEXT, queued_at INTEGER, harness TEXT NOT NULL DEFAULT 'opencode');
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            harness TEXT NOT NULL DEFAULT 'opencode',
            counter INTEGER DEFAULT 0,
            cleared_reasoning_through_tag INTEGER DEFAULT 0,
            tool_reclaim_watermark INTEGER DEFAULT 0,
            pi_stable_id_scheme INTEGER,
            stripped_placeholder_ids TEXT,
            stale_reduce_stripped_ids TEXT,
            processed_image_stripped_ids TEXT,
            merged_reasoning_stripped_ids TEXT,
            pending_pi_compaction_marker_state TEXT,
            last_todo_state TEXT,
            todo_synthetic_call_id TEXT,
            todo_synthetic_anchor_message_id TEXT,
            todo_synthetic_state_json TEXT,
            ${replayDocumentColumn}
            compaction_marker_state TEXT,
            channel2_nudge_state TEXT DEFAULT '',
            channel2_nudge_claimed_at INTEGER DEFAULT 0,
            channel2_nudge_claim_token TEXT DEFAULT '',
            emergency_drain_active INTEGER DEFAULT 0,
            cached_m0_bytes BLOB,
            cached_m1_bytes BLOB,
            served_prefix TEXT,
            held_release TEXT,
            nudge_anchor_message_id TEXT,
            prior_boundary_ordinal INTEGER DEFAULT 1
        );
        CREATE TABLE session_projects (session_id TEXT NOT NULL, harness TEXT NOT NULL, project_path TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, harness));
        CREATE TABLE compression_depth (session_id TEXT NOT NULL, message_ordinal INTEGER NOT NULL, depth INTEGER NOT NULL, harness TEXT NOT NULL, PRIMARY KEY(session_id, message_ordinal));
        CREATE TABLE session_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, harness TEXT NOT NULL);
        CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL, session_id TEXT, project_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, anchor_block_id TEXT);
        CREATE TABLE transform_decisions (session_id TEXT NOT NULL, harness TEXT NOT NULL, message_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, decision TEXT NOT NULL, PRIMARY KEY(session_id, harness, message_id));
    `);
    context
        .prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at, start_message_id, end_message_id, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sourceSessionId, 0, 1, 2, "one", "summary", 10, "msg_source_1", "msg_source_2", "opencode");
    const insertFixtureTag = context.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // A prior session makes the source tag's global id differ from its per-session tag number.
    insertFixtureTag.run("ses_other", "msg_other:p0", "message", "active", 1, 99, "opencode", null);
    const sourceTag = insertFixtureTag.run(
        sourceSessionId,
        "msg_source_1:p0",
        "message",
        "active",
        5,
        1,
        "opencode",
        null,
    );
    context
        .prepare(
            "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sourceSessionId, "tool_source_1", "tool", "active", 5, 2, "opencode", "msg_source_2");
    context
        .prepare("INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)")
        .run(Number(sourceTag.lastInsertRowid), sourceSessionId, "source text", 10, "opencode");
    // Queued drops name their tag by per-session tag number, never by row id.
    context
        .prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)")
        .run(sourceSessionId, 2, "drop", 11, "opencode");
    context
        .prepare(
            "INSERT INTO session_meta (session_id, harness, counter, cleared_reasoning_through_tag, tool_reclaim_watermark, stripped_placeholder_ids, compaction_marker_state, channel2_nudge_state, emergency_drain_active, cached_m0_bytes, cached_m1_bytes, nudge_anchor_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
            sourceSessionId,
            "opencode",
            2,
            1,
            2,
            JSON.stringify(["msg_source_1"]),
            JSON.stringify({ boundaryMessageId: "msg_source_1", compactionPartId: "prt_source_1" }),
            "claimed",
            1,
            Buffer.from("warm"),
            Buffer.from("warm"),
            "msg_source_2",
        );
    context.prepare("UPDATE session_meta SET served_prefix = ?, held_release = ? WHERE session_id = ?").run(
        JSON.stringify({ first_kept: { id: "msg_source_1", digest: "source-prefix" } }),
        JSON.stringify({ reason: "flush", obligations: ["flush"] }),
        sourceSessionId,
    );
    context
        .prepare("INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)")
        .run(sourceSessionId, "opencode", "/tmp/drive-project", 10);
    context
        .prepare("INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, ?, ?, ?)")
        .run(sourceSessionId, 1, 2, "opencode");
    context
        .prepare("INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sourceSessionId, "fact", "durable", 10, 10, "opencode");
    context
        .prepare(
            "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, anchor_block_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("session", "active", "note", sourceSessionId, 10, 10, "msg_source_1#0");
    context
        .prepare("INSERT INTO transform_decisions (session_id, harness, message_id, ts_ms, decision) VALUES (?, ?, ?, ?, ?)")
        .run(sourceSessionId, "opencode", "msg_source_2", 10, "defer");
    closeQuietly(context);

    return { opencodePath, contextPath, sourceSessionId };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("clone-session", () => {
    it("clones OpenCode and Magic Context state with independent remapped ids", () => {
        const fixture = makeFixture();
        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
            suffix: "test",
        });
        const destinationSessionId = result.plan.destinationSessionId;
        expect(result.dryRun).toBe(false);

        const opencode = new Database(fixture.opencodePath, { readonly: true });
        const sourceMessage = opencode
            .prepare("SELECT id, data FROM message WHERE session_id = ? AND id = ?")
            .get(fixture.sourceSessionId, "msg_source_1") as { id: string; data: string };
        const clonedMessages = opencode
            .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created")
            .all(destinationSessionId) as Array<{ id: string; data: string }>;
        expect(clonedMessages).toHaveLength(2);
        expect(clonedMessages.every((message) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(message.id))).toBe(true);
        expect(clonedMessages[0].id < clonedMessages[1].id).toBe(true);
        expect(clonedMessages[0].id).not.toBe("msg_source_1");
        const clonedUserData = JSON.parse(clonedMessages[0].data);
        expect(clonedUserData.id).toBe(clonedMessages[0].id);
        expect(clonedUserData.compaction.tail_start_id).toBe(clonedMessages[0].id);
        const clonedAssistantData = JSON.parse(clonedMessages[1].data);
        expect(clonedAssistantData.id).toBe(clonedMessages[1].id);
        expect(clonedAssistantData.parentID).toBe(clonedMessages[0].id);
        expect(clonedAssistantData.compaction.tail_start_id).toBe(clonedMessages[0].id);
        expect(clonedAssistantData.compaction.summary_refs).toEqual([clonedMessages[0].id]);
        expect(JSON.parse(sourceMessage.data).id).toBe("msg_source_1");
        const clonedParts = opencode
            .prepare("SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created")
            .all(destinationSessionId) as Array<{ id: string; data: string }>;
        expect(clonedParts.map((part) => part.id)).not.toEqual(["prt_source_1", "prt_source_2"]);
        expect(clonedParts.every((part) => /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(part.id))).toBe(true);
        expect(clonedParts[0].id < clonedParts[1].id).toBe(true);
        const clonedToolData = JSON.parse(clonedParts[1].data);
        expect(clonedToolData.id).toBe(clonedParts[1].id);
        expect(clonedToolData.messageID).toBe(clonedMessages[1].id);
        expect(clonedToolData.sessionID).toBe(destinationSessionId);
        const maxUserId = clonedMessages.filter((message) => JSON.parse(message.data).role === "user").map((message) => message.id).sort().at(-1);
        const maxAssistantId = clonedMessages.filter((message) => JSON.parse(message.data).role === "assistant").map((message) => message.id).sort().at(-1);
        expect(maxUserId! < maxAssistantId!).toBe(true);
        const clonedEvent = opencode
            .prepare("SELECT id, data FROM event WHERE aggregate_id = ?")
            .get(destinationSessionId) as { id: string; data: string };
        expect(clonedEvent.id).not.toBe("evt_source_1");
        expect(JSON.parse(clonedEvent.data).sessionID).toBe(destinationSessionId);
        expect(JSON.parse(clonedEvent.data).info.id).toBe(clonedMessages[0].id);
        const clonedSession = opencode
            .prepare("SELECT parent_id, time_created, time_updated, cost, tokens_input, share_url, summary_additions, revert, metadata FROM session WHERE id = ?")
            .get(destinationSessionId) as {
            parent_id: string | null;
            time_created: number;
            time_updated: number;
            cost: number;
            tokens_input: number;
            share_url: string | null;
            summary_additions: number | null;
            revert: string | null;
            metadata: string;
        };
        expect(clonedSession.parent_id).toBeNull();
        expect(clonedSession.time_created).toBe(clonedSession.time_updated);
        expect(clonedSession.cost).toBe(0);
        expect(clonedSession.tokens_input).toBe(0);
        expect(clonedSession.share_url).toBeNull();
        expect(clonedSession.summary_additions).toBeNull();
        expect(clonedSession.revert).toBeNull();
        expect(JSON.parse(clonedSession.metadata).cortexkitClone.version).toBe(1);
        expect((opencode.prepare("SELECT COUNT(*) AS count FROM session_input WHERE session_id = ?").get(destinationSessionId) as { count: number }).count).toBe(0);
        opencode.close();

        const context = new Database(fixture.contextPath, { readonly: true });
        const clonedTags = context
            .prepare("SELECT id, message_id, type, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number")
            .all(destinationSessionId) as Array<{
            id: number;
            message_id: string;
            type: string;
            tool_owner_message_id: string | null;
        }>;
        expect(clonedTags).toHaveLength(2);
        expect(clonedTags[0].message_id).toBe(`${clonedMessages[0].id}:p0`);
        expect(clonedTags[1].tool_owner_message_id).toBe(clonedMessages[1].id);
        const clonedContent = context
            .prepare("SELECT tag_id FROM source_contents WHERE session_id = ?")
            .get(destinationSessionId) as { tag_id: number };
        expect(clonedContent.tag_id).toBe(clonedTags[0].id);
        const clonedPending = context
            .prepare("SELECT tag_id FROM pending_ops WHERE session_id = ?")
            .get(destinationSessionId) as { tag_id: number };
        expect(clonedPending.tag_id).toBe(2);
        const clonedCompartment = context
            .prepare("SELECT start_message_id, end_message_id, start_message, end_message FROM compartments WHERE session_id = ?")
            .get(destinationSessionId) as {
            start_message_id: string;
            end_message_id: string;
            start_message: number;
            end_message: number;
        };
        expect(clonedCompartment.start_message_id).toBe(clonedMessages[0].id);
        expect(clonedCompartment.end_message_id).toBe(clonedMessages[1].id);
        expect([clonedCompartment.start_message, clonedCompartment.end_message]).toEqual([1, 2]);
        const meta = context
            .prepare("SELECT compaction_marker_state, channel2_nudge_state, emergency_drain_active, cached_m0_bytes, cached_m1_bytes, served_prefix, held_release FROM session_meta WHERE session_id = ?")
            .get(destinationSessionId) as {
            compaction_marker_state: string;
            channel2_nudge_state: string;
            emergency_drain_active: number;
            cached_m0_bytes: Buffer | null;
            cached_m1_bytes: Buffer | null;
            served_prefix: string | null;
            held_release: string | null;
        };
        expect(JSON.parse(meta.compaction_marker_state).boundaryMessageId).toBe(clonedMessages[0].id);
        expect(JSON.parse(meta.compaction_marker_state).compactionPartId).toBe(clonedParts[0].id);
        expect(meta.channel2_nudge_state).toBe("");
        expect(meta.emergency_drain_active).toBe(0);
        expect(meta.cached_m0_bytes).toBeNull();
        expect(meta.cached_m1_bytes).toBeNull();
        expect(meta.served_prefix).toBeNull();
        expect(meta.held_release).toBeNull();
        expect(
            (context.prepare("SELECT COUNT(*) AS count FROM session_projects WHERE session_id = ?").get(destinationSessionId) as { count: number }).count,
        ).toBe(1);
        const clonedNote = context
            .prepare("SELECT anchor_block_id FROM notes WHERE session_id = ?")
            .get(destinationSessionId) as { anchor_block_id: string };
        expect(clonedNote.anchor_block_id).toBe(`${clonedMessages[0].id}#0`);
        context.close();

        const mutable = new Database(fixture.opencodePath);
        mutable.prepare("UPDATE message SET data = ? WHERE session_id = ? AND id = ?").run("changed", destinationSessionId, clonedMessages[0].id);
        expect(
            (mutable.prepare("SELECT data FROM message WHERE id = ?").get("msg_source_1") as { data: string }).data,
        ).toContain("msg_source_1");
        mutable.close();
    });

    it("clones a legacy context database without adding a replay document column", () => {
        const fixture = makeFixture({ includeReplayDocument: false });
        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        const context = new Database(fixture.contextPath, { readonly: true });
        const metaColumnRows = context
            .prepare("PRAGMA table_info(session_meta)")
            .all() as Array<{ name: string }>;
        const metaColumns = metaColumnRows.map((column) => column.name);
        expect(metaColumns).not.toContain("trailing_blank_decisions");
        const clonedMeta = context
            .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id = ?")
            .get(result.plan.destinationSessionId) as { count: number };
        expect(clonedMeta.count).toBe(1);
        context.close();
    });

    it("keeps the filtered replay document after the generic metadata copy", () => {
        const fixture = makeFixture();
        const frozenInput = '{"path":"msg_source_1","dropped":"marker"}';
        const sourceReplayDocument = serializeReplayDocument({
            version: 2,
            trailingBlank: {
                "msg_source_2": "strip",
                "outside-assistant": "keep:2",
            },
            piNative: {
                toolInputs: {
                    tool_source_1: frozenInput,
                    outside_call: '{"dropped":"outside"}',
                },
                reasoningIds: ["msg_source_2", "outside_assistant"],
                nativeSibling: { preserved: true },
            },
            siblingNamespace: { preserved: ["without", "remapping"] },
        });
        const source = new Database(fixture.contextPath);
        try {
            source
                .prepare(
                    "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
                )
                .run(sourceReplayDocument, fixture.sourceSessionId);
        } finally {
            source.close();
        }
        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        const clone = new Database(fixture.contextPath, { readonly: true });
        try {
            const tool = clone.prepare(
                "SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool'",
            ).get(result.plan.destinationSessionId) as { message_id: string; tool_owner_message_id: string };
            const state = clone.prepare(
                "SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?",
            ).get(result.plan.destinationSessionId) as { trailing_blank_decisions: string };
            const replayDocument = parseReplayDocument(state.trailing_blank_decisions);
            expect(replayDocument.version).toBe(2);
            expect(Object.entries(replayDocument.trailingBlank)).toEqual([
                [tool.tool_owner_message_id, "strip"],
            ]);
            expect(replayDocument.piNative).toEqual({
                toolInputs: { [tool.message_id]: frozenInput },
                reasoningIds: [tool.tool_owner_message_id],
                nativeSibling: { preserved: true },
            });
            expect(replayDocument.siblingNamespace).toEqual({
                preserved: ["without", "remapping"],
            });
        } finally {
            clone.close();
        }
    });

    it("clones notes before project authority is attached and leaves the guard active", () => {
        const fixture = makeFixture();
        const context = new Database(fixture.contextPath);
        context.exec(`
            CREATE TABLE authority_managed (project_path TEXT PRIMARY KEY);
            INSERT INTO authority_managed(project_path) VALUES ('/tmp/drive-project');
            CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN EXISTS (
                SELECT 1 FROM session_projects sp
                JOIN authority_managed am ON am.project_path = sp.project_path
                WHERE sp.session_id = NEW.session_id
            )
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        `);
        context.close();

        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        const destination = result.plan.destinationSessionId;
        const cloned = new Database(fixture.contextPath);
        expect(
            cloned.prepare("SELECT content FROM notes WHERE session_id = ?").get(destination),
        ).toMatchObject({ content: "note" });
        expect(() =>
            cloned
                .prepare(
                    "INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES ('session', 'active', 'bare', ?, 1, 1)",
                )
                .run(destination),
        ).toThrow("context.db note writes are managed by the Rust module");
        cloned.close();
    });

    it("trims an unfinished trailing assistant before reminting", () => {
        const fixture = makeFixture();
        const opencode = new Database(fixture.opencodePath);
        opencode
            .prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
            .run(
                "msg_source_3",
                fixture.sourceSessionId,
                300,
                300,
                JSON.stringify({ role: "assistant", id: "msg_source_3", finish: "tool-calls" }),
            );
        opencode
            .prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
            .run(
                "prt_source_3",
                "msg_source_3",
                fixture.sourceSessionId,
                301,
                301,
                JSON.stringify({ type: "tool", callID: "tool_source_3" }),
            );
        opencode.close();

        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        expect(result.plan.trimmedMessageIds).toEqual(["msg_source_3"]);
        const cloned = new Database(fixture.opencodePath, { readonly: true });
        expect((cloned.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(result.plan.destinationSessionId) as { count: number }).count).toBe(2);
        expect((cloned.prepare("SELECT COUNT(*) AS count FROM part WHERE session_id = ?").get(result.plan.destinationSessionId) as { count: number }).count).toBe(2);
        cloned.close();
    });

    it("deletes only marked clones and clears their Magic Context state", () => {
        const fixture = makeFixture();
        expect(() =>
            deleteClonedSession({
                sessionId: fixture.sourceSessionId,
                opencodeDbPath: fixture.opencodePath,
                contextDbPath: fixture.contextPath,
            }),
        ).toThrow("not marked as a clone");
        const clone = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        deleteClonedSession({
            sessionId: clone.plan.destinationSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
        });
        const opencode = new Database(fixture.opencodePath, { readonly: true });
        const context = new Database(fixture.contextPath, { readonly: true });
        expect((opencode.prepare("SELECT COUNT(*) AS count FROM session WHERE id = ?").get(clone.plan.destinationSessionId) as { count: number }).count).toBe(0);
        expect((opencode.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(clone.plan.destinationSessionId) as { count: number }).count).toBe(0);
        expect((context.prepare("SELECT COUNT(*) AS count FROM tags WHERE session_id = ?").get(clone.plan.destinationSessionId) as { count: number }).count).toBe(0);
        expect((context.prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?").get(clone.plan.destinationSessionId) as { count: number }).count).toBe(0);
        opencode.close();
        context.close();
    });

    it("plans without writing either database", () => {
        const fixture = makeFixture();
        const before = new Database(fixture.opencodePath, { readonly: true });
        const sourceCount = (before.prepare("SELECT COUNT(*) AS count FROM session").get() as { count: number }).count;
        before.close();
        const result = cloneSession({
            sessionId: fixture.sourceSessionId,
            opencodeDbPath: fixture.opencodePath,
            contextDbPath: fixture.contextPath,
            dryRun: true,
        });
        expect(result.dryRun).toBe(true);
        const after = new Database(fixture.opencodePath, { readonly: true });
        expect((after.prepare("SELECT COUNT(*) AS count FROM session").get() as { count: number }).count).toBe(sourceCount);
        expect((after.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(fixture.sourceSessionId) as { count: number }).count).toBe(2);
        after.close();
    });
});
