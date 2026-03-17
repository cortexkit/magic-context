/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { buildMemoryInjectionBlock } from "./injection";
import { insertMemory, updateMemoryStatus } from "./storage-memory";

let db: Database;

function makeMemoryDatabase(): Database {
    const database = Database.open(":memory:");
    database.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      UNIQUE(project_path, category, normalized_hash)
    );
  `);
    return database;
}

function insertTestMemory(input: Parameters<typeof insertMemory>[1]): void {
    insertMemory(db, input);
}

afterEach(() => {
    if (db) {
        db.close(false);
    }
});

describe("buildMemoryInjectionBlock", () => {
    describe("#given no memories", () => {
        it("returns null when no memories exist", () => {
            //#given
            db = makeMemoryDatabase();

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 100);

            //#then
            expect(result).toBeNull();
        });
    });

    describe("#given memories within budget", () => {
        it("formats memories as XML with category sections", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Always use Bun",
            });
            insertTestMemory({
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "No as any",
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 500);

            //#then
            expect(result).toBe(
                [
                    "<project-memory>",
                    "<USER_DIRECTIVES>",
                    "- Always use Bun",
                    "</USER_DIRECTIVES>",
                    "<CONSTRAINTS>",
                    "- No as any",
                    "</CONSTRAINTS>",
                    "</project-memory>",
                ].join("\n"),
            );
        });

        it("orders categories by priority", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "Known issue",
            });
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Directive",
            });
            insertTestMemory({
                projectPath: "/repo/project",
                category: "NAMING",
                content: "Use createX",
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 500);

            //#then
            expect(result?.indexOf("<USER_DIRECTIVES>")).toBeLessThan(
                result?.indexOf("<NAMING>") ?? Infinity,
            );
            expect(result?.indexOf("<NAMING>")).toBeLessThan(
                result?.indexOf("<KNOWN_ISSUES>") ?? Infinity,
            );
        });

        it("includes both project and global memories", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "CONSTRAINTS",
                content: "Project rule",
            });
            insertTestMemory({
                projectPath: "__global__",
                category: "USER_DIRECTIVES",
                content: "Global rule",
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 500);

            //#then
            expect(result).toContain("- Project rule");
            expect(result).toContain("- Global rule");
        });
    });

    describe("#given memories exceeding budget", () => {
        it("truncates from lowest-priority categories first", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Keep Bun",
            });
            insertTestMemory({
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "x".repeat(200),
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 30);

            //#then
            expect(result).toContain("<USER_DIRECTIVES>");
            expect(result).not.toContain("<KNOWN_ISSUES>");
        });

        it("always includes USER_DIRECTIVES when they exist", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Primary directive",
            });
            insertTestMemory({
                projectPath: "/repo/project",
                category: "WORKFLOW_RULES",
                content: "y".repeat(300),
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 20);

            //#then
            expect(result).toContain("<USER_DIRECTIVES>");
            expect(result).toContain("- Primary directive");
        });

        it("respects the budget token limit", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Short rule",
            });
            const archived = insertMemory(db, {
                projectPath: "/repo/project",
                category: "KNOWN_ISSUES",
                content: "z".repeat(500),
            });
            updateMemoryStatus(db, archived.id, "archived");

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 25);

            //#then
            expect(result).not.toBeNull();
            expect(Math.ceil((result ?? "").length / 3.5)).toBeLessThanOrEqual(25);
        });
    });

    describe("#given special characters", () => {
        it("XML-escapes memory content with special characters", () => {
            //#given
            db = makeMemoryDatabase();
            insertTestMemory({
                projectPath: "/repo/project",
                category: "USER_DIRECTIVES",
                content: "Use <Bun> & keep > npm",
            });

            //#when
            const result = buildMemoryInjectionBlock(db, "/repo/project", 500);

            //#then
            expect(result).toContain("- Use &lt;Bun&gt; &amp; keep &gt; npm");
        });
    });
});
