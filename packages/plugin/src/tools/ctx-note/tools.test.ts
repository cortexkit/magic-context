import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { createCtxNoteTools } from "./tools";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
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
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

const toolContext = (sessionID = "ses-note") => ({ sessionID }) as never;

describe("createCtxNoteTools", () => {
    let db: Database;
    let tools: ReturnType<typeof createCtxNoteTools>;

    beforeEach(() => {
        db = createTestDb();
        tools = createCtxNoteTools({ db });
    });

    it("writes and reads session notes", async () => {
        const writeResult = await tools.ctx_note.execute(
            { action: "write", content: "Remember the user prefers build on integrate." },
            toolContext(),
        );
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(writeResult).toContain("Saved session note #1");
        expect(readResult).toContain("## Session Notes");
        expect(readResult).toContain("#1");
        expect(readResult).toContain("Remember the user prefers build on integrate.");
    });

    it("requires content for writes", async () => {
        const result = await tools.ctx_note.execute({ action: "write" }, toolContext());

        expect(result).toContain("Error");
        expect(result).toContain("'content' is required");
    });

    it("dismisses session notes and can still inspect them with filter='all'", async () => {
        await tools.ctx_note.execute({ action: "write", content: "First note" }, toolContext());
        const dismissResult = await tools.ctx_note.execute(
            { action: "dismiss", note_id: 1 },
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

    it("updates smart notes", async () => {
        tools = createCtxNoteTools({
            db,
            dreamerEnabled: true,
            projectIdentity: "git:test-project",
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
                note_id: 1,
                content: "Implement the cleanup after the schema settles.",
                surface_condition: "When PR #108 is merged",
            },
            toolContext(),
        );
        const readAllResult = await tools.ctx_note.execute(
            { action: "read", filter: "all" },
            toolContext(),
        );

        expect(updateResult).toContain("Updated note #1");
        expect(readAllResult).toContain("Implement the cleanup after the schema settles.");
        expect(readAllResult).toContain("When PR #108 is merged");
    });
});
