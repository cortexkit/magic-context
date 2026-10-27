import { beforeEach, describe, expect, it } from "bun:test";
import { tool } from "@opencode-ai/plugin";

import {
    __wakePlaneTest,
    WAKE_PLANE_CAPABILITY,
} from "../../features/magic-context/smart-notes/wake-plane";
import { Database } from "../../shared/sqlite";
import { createCtxNoteTools } from "./tools";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE authority_managed (
      project_path TEXT PRIMARY KEY,
      context_store_uuid TEXT NOT NULL,
      marked_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'active',
      content TEXT NOT NULL,
      session_id TEXT,
      project_path TEXT,
      surface_condition TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      ready_at INTEGER,
      ready_reason TEXT,
      compiled_provider TEXT,
      compiled_config TEXT,
      compiled_at INTEGER,
      compile_status TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode',
      anchor_ordinal INTEGER
    );
    CREATE TABLE message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

const toolContext = (sessionID = "ses-note", directory = "/workspace/project-a") =>
    ({ sessionID, directory }) as never;

describe("createCtxNoteTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxNoteTools>;

    beforeEach(() => {
        __wakePlaneTest.reset();
        db = createTestDb();
        tools = createCtxNoteTools({
            db,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });
    });

    it("refuses unmigrated note writes with MC-C14 and otherwise writes the shared store", async () => {
        const localTools = createCtxNoteTools({
            db,
            resolveProjectPath: () => "git:project-a",
        });
        db.prepare("INSERT INTO authority_managed VALUES (?, 'old-store', 1)").run("git:project-a");
        const reply = await localTools.ctx_note.execute(
            { action: "write", content: "blocked" },
            toolContext(),
        );
        expect(reply).toBe(
            "Magic Context needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)",
        );
        expect(db.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
        db.exec("DELETE FROM authority_managed");
        expect(
            await localTools.ctx_note.execute(
                { action: "write", content: "shared" },
                toolContext(),
            ),
        ).toContain("Saved session note");
        expect(db.prepare("SELECT content FROM notes").get()).toEqual({ content: "shared" });
    });

    it("writes and reads session notes", async () => {
        const writeResult = await tools.ctx_note.execute(
            { action: "write", content: "Remember the user prefers build on integrate." },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(writeResult).toContain("Saved session note #1");
        expect(readResult).toContain("## Notes");
        expect(readResult).toContain("#1");
        expect(readResult).toContain("Remember the user prefers build on integrate.");
    });

    it("refuses a condition on a session note and heals a previously parked row", async () => {
        await tools.ctx_note.execute({ action: "write", content: "session" }, toolContext());
        const reply = await tools.ctx_note.execute(
            { action: "update", note_ids: [1], surface_condition: "tomorrow" },
            toolContext(),
        );
        expect(reply).toContain("Only a note created with a condition can have one");
        expect(
            db.prepare("SELECT status, surface_condition FROM notes WHERE id = 1").get(),
        ).toEqual({ status: "active", surface_condition: null });
        db.prepare(
            "UPDATE notes SET status = 'pending', surface_condition = 'orphan' WHERE id = 1",
        ).run();
        const read = await tools.ctx_note.execute({ action: "read" }, toolContext());
        expect(read).toContain("session");
        expect(
            db.prepare("SELECT status, surface_condition FROM notes WHERE id = 1").get(),
        ).toEqual({ status: "active", surface_condition: null });
    });

    it("stores compiled, plain, and refused smart notes with the required reply shapes", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:project-a",
        });

        const plain = await tools.ctx_note.execute(
            {
                action: "write",
                content: "Follow up on the pull request.",
                surface_condition: "When PR #42 is merged",
            },
            toolContext(),
        );
        const compiled = await tools.ctx_note.execute(
            {
                action: "write",
                content: "Read the generated artifact.",
                surface_condition: "when path /tmp/ctx-note-future-artifact exists",
            },
            toolContext(),
        );
        const refused = await tools.ctx_note.execute(
            {
                action: "write",
                content: "Never inspect key material.",
                surface_condition: "when path /tmp/project-binding-key exists",
            },
            toolContext(),
        );

        expect(plain).toBe(
            "Created smart note #1. Dreamer will evaluate the condition during nightly runs:\n- Content: Follow up on the pull request.\n- Condition: When PR #42 is merged",
        );
        expect(compiled).toContain("- Retina provider: local-fs");
        expect(refused).toContain("- Retina compile refused: fenced path");
        expect(
            db
                .prepare(
                    "SELECT compile_status, compiled_provider, compiled_config FROM notes ORDER BY id",
                )
                .all(),
        ).toEqual([
            { compile_status: "plain", compiled_provider: null, compiled_config: null },
            {
                compile_status: "compiled",
                compiled_provider: "local-fs",
                compiled_config: expect.stringContaining('"kind":"path_exists"'),
            },
            { compile_status: "refused", compiled_provider: null, compiled_config: null },
        ]);
    });

    it("stores surface_condition as a regular note only when the wake plane is present", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:project-a",
        });
        for (const status of ["present", "absent", "unknown"] as const) {
            __wakePlaneTest.reset();
            __wakePlaneTest.setCatalogProbe(async () => {
                if (status === "unknown") throw new Error("daemon unavailable");
                return status === "present"
                    ? [
                          {
                              module_id: "scheduled-wakes",
                              roles: [],
                              control_ops: [WAKE_PLANE_CAPABILITY],
                          },
                      ]
                    : [{ module_id: "other-module", roles: [], control_ops: [] }];
            });
            const result = await tools.ctx_note.execute(
                {
                    action: "write",
                    content: `Wake-plane ${status}`,
                    surface_condition: "When the scheduled operation completes",
                },
                toolContext(),
            );

            if (status === "present") {
                expect(result).toContain(
                    "wake plane active — create a scheduled wake instead; stored as a plain note.",
                );
                expect(
                    db
                        .prepare("SELECT type FROM notes WHERE content = ?")
                        .get(`Wake-plane ${status}`),
                ).toEqual({ type: "session" });
            } else {
                expect(result).toContain("Created smart note");
                expect(
                    db
                        .prepare("SELECT type FROM notes WHERE content = ?")
                        .get(`Wake-plane ${status}`),
                ).toEqual({ type: "smart" });
            }
        }
    });

    it("defaults to read (not write) when content is an empty string and no action is given", async () => {
        // GPT-family models fill every optional param, so a read arrives as
        // { content: "", surface_condition: "" } with no action. That must
        // default to read, not infer write and reject the empty content.
        await tools.ctx_note.execute(
            { action: "write", content: "An existing note" },
            toolContext(),
        );
        const result = await tools.ctx_note.execute(
            { content: "", surface_condition: "" },
            toolContext(),
        );

        expect(result).not.toContain("'content' is required");
        expect(result).toContain("## Notes");
        expect(result).toContain("An existing note");
    });

    it("anchors a note to the live message-tail ordinal and renders it with an expand hint", async () => {
        db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, updated_at) VALUES (?, ?, ?)",
        ).run("ses-note", 512, 1);

        await tools.ctx_note.execute(
            { action: "write", content: "Anchored decision" },
            toolContext(),
        );
        // The anchor belongs to the full body, so read the note by id.
        const readResult = await tools.ctx_note.execute(
            { action: "read", note_ids: [1] },
            toolContext(),
        );

        expect(readResult).toContain("↳ @msg 512");
        expect(readResult).toContain("ctx_expand(start=N-x, end=N)");
    });

    it("omits the anchor (and hint) when the session has no indexed tail yet", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Unanchored decision" },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute(
            { action: "read", note_ids: [1] },
            toolContext(),
        );

        expect(readResult).not.toContain("↳ @msg");
        expect(readResult).not.toContain("ctx_expand(start=N-x");
    });

    it("requires content for writes", async () => {
        const result = await tools.ctx_note.execute({ action: "write" }, toolContext());

        expect(result).toContain("Error");
        expect(result).toContain("'content' is required");
    });

    it("reports the active tray on the write reply", async () => {
        const first = await tools.ctx_note.execute(
            { action: "write", content: "first tray item" },
            toolContext(),
        );
        const second = await tools.ctx_note.execute(
            { action: "write", content: "second tray item" },
            toolContext(),
        );

        expect(first).toBe("Saved session note #1. 1 active, oldest 0m.");
        expect(second).toBe("Saved session note #2. 2 active, oldest 0m.");
    });

    it("dismisses session notes and can still inspect them with filter='all'", async () => {
        await tools.ctx_note.execute({ action: "write", content: "First note" }, toolContext());
        const dismissResult = await tools.ctx_note.execute(
            { action: "dismiss", note_ids: [1] },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());
        const readAllResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext(),
        );

        expect(dismissResult).toContain("Note #1 dismissed");
        expect(readResult).toContain("No session notes or smart notes");
        expect(readAllResult).toContain("dismissed");
        expect(readAllResult).toContain("First note");
    });

    it("dismisses note_ids in one transaction and reports each outcome", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Owned note one" },
            toolContext("ses-a"),
        );
        await tools.ctx_note.execute(
            { action: "write", content: "Foreign note" },
            toolContext("ses-b"),
        );
        await tools.ctx_note.execute(
            { action: "write", content: "Owned note two" },
            toolContext("ses-a"),
        );
        await tools.ctx_note.execute({ action: "dismiss", note_ids: [3] }, toolContext("ses-a"));

        const result = await tools.ctx_note.execute(
            { action: "dismiss", note_ids: [1, 2, 3, 999] },
            toolContext("ses-a"),
        );

        expect(result).toBe(
            "Dismissed 1 of 4 notes.\n" +
                "- Note #1: dismissed\n" +
                "- Note #2: not_found\n" +
                "- Note #3: already_dismissed\n" +
                "- Note #999: not_found",
        );
        expect(db.prepare("SELECT id, status FROM notes ORDER BY id").all()).toEqual([
            { id: 1, status: "dismissed" },
            { id: 2, status: "active" },
            { id: 3, status: "dismissed" },
        ]);
    });

    it("ignores note_ids on write, reads owned ids, and hides foreign ids as missing", async () => {
        // Required-all tool surfaces make the model fill every declared
        // property on write; read uses IDs intentionally and must not disclose
        // whether an inaccessible ID exists.
        const writeWithFiller = await tools.ctx_note.execute(
            { action: "write", content: "Filler-tolerant note", note_ids: [1] },
            toolContext(),
        );
        await tools.ctx_note.execute(
            { action: "write", content: "Foreign note body" },
            toolContext("ses-foreign"),
        );
        const targetedRead = await tools.ctx_note.execute(
            { action: "read", note_ids: [1, 2, 999] },
            toolContext(),
        );
        const updateTwo = await tools.ctx_note.execute(
            { action: "update", note_ids: [1, 2], content: "two ids" },
            toolContext(),
        );
        const updateNone = await tools.ctx_note.execute(
            { action: "update", content: "no ids" },
            toolContext(),
        );
        const dismissNone = await tools.ctx_note.execute({ action: "dismiss" }, toolContext());

        expect(writeWithFiller).toContain("Saved session note #1");
        expect(targetedRead).toContain("Filler-tolerant note");
        expect(targetedRead).toContain("- Note #2: not_found");
        expect(targetedRead).toContain("- Note #999: not_found");
        expect(targetedRead).not.toContain("Foreign note body");
        expect(updateTwo).toContain("exactly one positive integer id when action is 'update'");
        expect(updateNone).toContain("exactly one positive integer id when action is 'update'");
        expect(dismissNone).toContain("1 to 50 positive integer ids when action is 'dismiss'");
    });

    it("rejects dismissing another session's session note", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Other session note" },
            toolContext("ses-b"),
        );

        const dismissResult = await tools.ctx_note.execute(
            { action: "dismiss", note_ids: [1] },
            toolContext("ses-a"),
        );
        const readOtherResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-b"),
        );

        expect(dismissResult).toContain("not found in your session/project");
        expect(readOtherResult).toContain("Other session note");
        expect(readOtherResult).not.toContain("dismissed");
    });

    it("updates own session notes but rejects another session's session note", async () => {
        await tools.ctx_note.execute(
            { action: "write", content: "Original session note" },
            toolContext("ses-a"),
        );

        const ownUpdate = await tools.ctx_note.execute(
            { action: "update", note_ids: [1], content: "Updated session note" },
            toolContext("ses-a"),
        );
        const otherUpdate = await tools.ctx_note.execute(
            { action: "update", note_ids: [1], content: "Hijacked session note" },
            toolContext("ses-b"),
        );
        const readResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-a"),
        );

        expect(ownUpdate).toContain("Updated note #1");
        expect(otherUpdate).toContain("not found in your session/project");
        expect(readResult).toContain("Updated session note");
        expect(readResult).not.toContain("Hijacked session note");
    });

    it("dismisses own project smart notes but rejects another project's smart note", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Project B smart note",
                surface_condition: "When project B is ready",
            },
            toolContext("ses-b", "/workspace/project-b"),
        );

        const wrongProjectDismiss = await tools.ctx_note.execute(
            { action: "dismiss", note_ids: [1] },
            toolContext("ses-a", "/workspace/project-a"),
        );
        const ownProjectDismiss = await tools.ctx_note.execute(
            { action: "dismiss", note_ids: [1] },
            toolContext("ses-a", "/workspace/project-b"),
        );

        expect(wrongProjectDismiss).toContain("not found in your session/project");
        expect(ownProjectDismiss).toContain("Note #1 dismissed");
    });

    it("rejects updating another project's smart note", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: (directory) =>
                directory.includes("project-b") ? "git:project-b" : "git:project-a",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Project B smart note",
                surface_condition: "When project B is ready",
            },
            toolContext("ses-b", "/workspace/project-b"),
        );

        const wrongProjectUpdate = await tools.ctx_note.execute(
            { action: "update", note_ids: [1], content: "Project A hijack" },
            toolContext("ses-a", "/workspace/project-a"),
        );
        const readProjectB = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext("ses-b", "/workspace/project-b"),
        );

        expect(wrongProjectUpdate).toContain("not found in your session/project");
        expect(readProjectB).toContain("Project B smart note");
        expect(readProjectB).not.toContain("Project A hijack");
    });

    it("updates smart notes", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:test-project",
        });

        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Implement the cleanup after the API settles.",
                surface_condition: "When PR #42 is merged",
            },
            toolContext(),
        );

        const updateResult = await tools.ctx_note.execute(
            {
                action: "update",
                note_ids: [1],
                content: "Implement the cleanup after the schema settles.",
                surface_condition: "When PR #108 is merged",
            },
            toolContext(),
        );
        // The condition lives on the full body, so read the note by id.
        const readAllResult = await tools.ctx_note.execute(
            { action: "read", note_ids: [1] },
            toolContext(),
        );

        expect(updateResult).toContain("Updated note #1");
        expect(readAllResult).toContain("Implement the cleanup after the schema settles.");
        expect(readAllResult).toContain("When PR #108 is merged");
    });

    it("lists parked smart notes in the default view and drops them under filter='active'", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => "git:project-a",
        });
        await tools.ctx_note.execute(
            {
                action: "write",
                content: "Parked smart note",
                surface_condition: "When the release lands",
            },
            toolContext(),
        );
        await tools.ctx_note.execute(
            { action: "write", content: "Plain session note" },
            toolContext(),
        );

        const defaultView = await tools.ctx_note.execute({ action: "read" }, toolContext());
        const activeOnly = await tools.ctx_note.execute(
            { action: "read", filter: "active" },
            toolContext(),
        );

        expect(defaultView).toContain("Parked smart note · pending");
        expect(defaultView).toContain("Plain session note");
        expect(activeOnly).toContain("Plain session note");
        expect(activeOnly).not.toContain("Parked smart note");
    });

    it("pages the glance with limit/offset and a continuation footer", async () => {
        for (let i = 1; i <= 30; i += 1) {
            await tools.ctx_note.execute(
                { action: "write", content: `note number ${i}` },
                toolContext(),
            );
        }

        // Default read: newest 25, footer pointing at the 5 older ones.
        const firstPage = await tools.ctx_note.execute({ action: "read" }, toolContext());
        expect(firstPage).toContain("note number 30"); // newest present
        expect(firstPage).toContain("note number 6"); // 25th newest present
        expect(firstPage).not.toContain("note number 5\n"); // older than page 1
        expect(firstPage).toContain(
            'Showing 25 of 30 — 5 older: ctx_note(action="read", offset=25)',
        );

        // Older page via offset.
        const secondPage = await tools.ctx_note.execute(
            { action: "read", offset: 25 },
            toolContext(),
        );
        expect(secondPage).toContain("note number 5");
        expect(secondPage).toContain("note number 1");
        expect(secondPage).not.toContain("note number 30");
        expect(secondPage).not.toContain("older: ctx_note"); // no further pages

        // Custom limit caps the page.
        const small = await tools.ctx_note.execute({ action: "read", limit: 3 }, toolContext());
        expect(small).toContain("note number 30");
        expect(small).toContain("note number 28");
        expect(small).not.toContain("note number 27\n");
        expect(small).toContain("Showing 3 of 30");
    });

    it("pages ready smart notes with the same default offset contract", async () => {
        const insert = db.prepare(
            "INSERT INTO notes(type, status, content, project_path, surface_condition, created_at, updated_at, ready_at) VALUES ('smart', 'ready', ?, 'git:project-a', 'condition', ?, ?, ?)",
        );
        for (let i = 1; i <= 105; i += 1) {
            insert.run(`ready note ${i}`, i, i, i);
        }

        const page = await tools.ctx_note.execute(
            { action: "read", limit: 5, offset: 100 },
            toolContext(),
        );
        expect(page).toContain("## Notes");
        expect(page).toContain("ready note 5");
        expect(page).toContain("ready note 1");
        expect(page).not.toContain("ready note 6\n");
        expect(page).not.toContain("older: ctx_note");
    });

    describe("issue 793 required provider schema", () => {
        it("advertises action, content and note_ids as required", () => {
            // Argument-dropping providers (InferenceNet via OpenRouter) only
            // emit required properties, so the key arguments must be required
            // for the calls to arrive complete. `filter` stays optional: a
            // read without it still renders the default mixed view.
            const jsonSchema = tool.schema.toJSONSchema(
                tool.schema.object(tools.ctx_note.args ?? {}),
            ) as { required?: string[] };
            expect(jsonSchema.required?.sort()).toEqual(["action", "content", "note_ids"]);
        });

        it("accepts an empty note_ids list at the provider-schema level", () => {
            // Without this, a model that correctly sends note_ids: [] on write
            // is rejected by host schema validation before the handler runs.
            const hostSchema = tool.schema.object(tools.ctx_note.args ?? {});
            expect(
                hostSchema.safeParse({ action: "write", content: "x", note_ids: [] }).success,
            ).toBe(true);
        });

        it("write succeeds with an empty note_ids list", async () => {
            const result = await tools.ctx_note.execute(
                { action: "write", content: "Empty ids note", note_ids: [] },
                toolContext(),
            );
            expect(result).toContain("Saved session note #1");
        });

        it("plain read with an empty note_ids list validates and lists notes", async () => {
            await tools.ctx_note.execute(
                { action: "write", content: "Listed plain-read note" },
                toolContext(),
            );
            const params: { action: "read"; content: string; note_ids: number[] } = {
                action: "read",
                content: "",
                note_ids: [],
            };
            const hostSchema = tool.schema.object(tools.ctx_note.args ?? {});
            expect(hostSchema.safeParse(params).success).toBe(true);
            const result = await tools.ctx_note.execute(params, toolContext());
            expect(result).toContain("Listed plain-read note");
        });

        it("read with a note id validates and returns the full body", async () => {
            await tools.ctx_note.execute(
                { action: "write", content: "Targeted full-body note" },
                toolContext(),
            );
            const params: { action: "read"; content: string; note_ids: number[] } = {
                action: "read",
                content: "",
                note_ids: [1],
            };
            const hostSchema = tool.schema.object(tools.ctx_note.args ?? {});
            expect(hostSchema.safeParse(params).success).toBe(true);
            const result = await tools.ctx_note.execute(params, toolContext());
            expect(result).toContain("Targeted full-body note");
        });

        it("read and dismiss succeed with empty content filler", async () => {
            await tools.ctx_note.execute(
                { action: "write", content: "Dismissable note" },
                toolContext(),
            );
            const readResult = await tools.ctx_note.execute(
                { action: "read", content: "" },
                toolContext(),
            );
            expect(readResult).toContain("Dismissable note");
            const dismissResult = await tools.ctx_note.execute(
                { action: "dismiss", note_ids: [1], content: "" },
                toolContext(),
            );
            expect(dismissResult).toContain("Note #1 dismissed.");
        });

        it("update accepts empty content when a surface condition is given", async () => {
            tools = createCtxNoteTools({
                db,
                dreamerEnabled: true,
                resolveProjectPath: () => "git:project-a",
            });
            await tools.ctx_note.execute(
                {
                    action: "write",
                    content: "Condition-only update target",
                    surface_condition: "When the release lands",
                },
                toolContext(),
            );
            const result = await tools.ctx_note.execute(
                {
                    action: "update",
                    note_ids: [1],
                    content: "",
                    surface_condition: "When the hotfix lands",
                },
                toolContext(),
            );
            expect(result).toContain("Updated note #1");
            expect(result).toContain("When the hotfix lands");
        });

        it("still rejects content missing where the action needs it", async () => {
            const writeResult = await tools.ctx_note.execute(
                { action: "write", content: "", note_ids: [] },
                toolContext(),
            );
            expect(writeResult).toContain("'content' is required when action is 'write'.");
            const dismissResult = await tools.ctx_note.execute(
                { action: "dismiss", note_ids: [] },
                toolContext(),
            );
            expect(dismissResult).toContain(
                "'note_ids' must contain 1 to 50 positive integer ids when action is 'dismiss'.",
            );
        });
    });
});
