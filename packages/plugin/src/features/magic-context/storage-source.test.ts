/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getSourceContents, replaceSourceContent, saveSourceContent } from "./storage-source";

let db: Database;

function createDb(): Database {
    const database = new Database(":memory:");
    database.exec(`
    CREATE TABLE source_contents (
      tag_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY (session_id, tag_id)
    );
  `);
    return database;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-source", () => {
    it("saves and reads source contents by tag IDs", () => {
        db = createDb();

        saveSourceContent(db, "ses-1", 1, "first");
        saveSourceContent(db, "ses-1", 2, "second");

        const sources = getSourceContents(db, "ses-1", [2, 1, 999]);
        expect(sources.get(1)).toBe("first");
        expect(sources.get(2)).toBe("second");
        expect(sources.has(999)).toBe(false);
    });

    it("does not overwrite existing source content", () => {
        db = createDb();

        saveSourceContent(db, "ses-1", 1, "original");
        saveSourceContent(db, "ses-1", 1, "updated");

        const sources = getSourceContents(db, "ses-1", [1]);
        expect(sources.get(1)).toBe("original");
    });

    it("replaces existing source content when a heuristic cleanup persists stripped text", () => {
        db = createDb();

        saveSourceContent(db, "ses-1", 1, "original");
        replaceSourceContent(db, "ses-1", 1, "cleaned");

        const sources = getSourceContents(db, "ses-1", [1]);
        expect(sources.get(1)).toBe("cleaned");
    });
});
