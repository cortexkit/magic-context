import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { createCtxNoteTools } from "./tools";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
    CREATE TABLE session_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
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

        expect(writeResult).toContain("Saved session note 1");
        expect(readResult).toContain("## Session Notes");
        expect(readResult).toContain("Remember the user prefers build on integrate.");
    });

    it("requires content for writes", async () => {
        const result = await tools.ctx_note.execute({ action: "write" }, toolContext());

        expect(result).toContain("Error");
        expect(result).toContain("'content' is required");
    });

    it("clears notes", async () => {
        await tools.ctx_note.execute({ action: "write", content: "First note" }, toolContext());
        const clearResult = await tools.ctx_note.execute({ action: "clear" }, toolContext());
        const readResult = await tools.ctx_note.execute({ action: "read" }, toolContext());

        expect(clearResult).toContain("Cleared 1 session note");
        expect(readResult).toContain("No session notes or smart notes");
    });
});
