/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { closeDatabase, isDatabasePersisted, openDatabase } from "./storage-db";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    // Plugin v0.16+ — shared cortexkit/magic-context path. See data-path.ts.
    return join(dataHome, "cortexkit", "magic-context", "context.db");
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

describe("storage-db", () => {
    describe("#given openDatabase", () => {
        it("#when called first time #then creates DB with WAL mode and busy_timeout", () => {
            const dataHome = useTempDataHome("storage-db-wal-");

            const db = openDatabase();

            const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
            expect(wal.journal_mode.toLowerCase()).toBe("wal");
            expect(Object.values(timeout)[0]).toBe(5000);
            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(isDatabasePersisted(db)).toBe(true);
        });

        it("#when called first time #then creates required tables", () => {
            useTempDataHome("storage-db-tables-");

            const db = openDatabase();

            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            const tableNames = tables.map((t) => t.name);
            expect(tableNames).toEqual(
                expect.arrayContaining([
                    "tags",
                    "pending_ops",
                    "source_contents",
                    "compression_depth",
                    "session_meta",
                ]),
            );
        });

        it("#when called first time #then creates required session-scoped indexes", () => {
            useTempDataHome("storage-db-indexes-");

            const db = openDatabase();
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all() as Array<{ name: string }>;
            const indexNames = indexes.map((item) => item.name);

            expect(indexNames).toEqual(
                expect.arrayContaining([
                    "idx_tags_session_tag_number",
                    "idx_pending_ops_session",
                    "idx_source_contents_session",
                    "idx_compartments_session",
                    "idx_compression_depth_session",
                    "idx_session_facts_session",
                    "idx_notes_session_status",
                    "idx_notes_project_status",
                    "idx_notes_type_status",
                ]),
            );
        });

        it("#when called a second time #then returns cached instance (singleton)", () => {
            useTempDataHome("storage-db-cached-");

            const db1 = openDatabase();
            const db2 = openDatabase();

            expect(db1).toBe(db2);
        });

        it("#when file path setup fails #then falls back to in-memory DB", () => {
            const dataHome = useTempDataHome("storage-db-fallback-");
            // Block mkdirSync by planting a file at the cortexkit segment of
            // the new shared path. See storage.test.ts for the same pattern.
            writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

            const db = openDatabase();

            expect(db).toBeInstanceOf(Database);
            expect(isDatabasePersisted(db)).toBe(false);
            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            expect(tables.map((t) => t.name)).toEqual(
                expect.arrayContaining(["tags", "pending_ops", "source_contents", "session_meta"]),
            );
        });

        it("#when an existing session_meta table lacks compartment_in_progress #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-compartment-flag-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE session_meta (
          session_id TEXT PRIMARY KEY,
          last_response_time INTEGER,
          cache_ttl TEXT,
          counter INTEGER DEFAULT 0,
          last_nudge_tokens INTEGER DEFAULT 0,
          last_nudge_band TEXT DEFAULT '',
          last_transform_error TEXT DEFAULT '',
          nudge_anchor_message_id TEXT DEFAULT '',
          nudge_anchor_text TEXT DEFAULT '',
          sticky_turn_reminder_text TEXT DEFAULT '',
          sticky_turn_reminder_message_id TEXT DEFAULT '',
          is_subagent INTEGER DEFAULT 0,
          last_context_percentage REAL DEFAULT 0,
          last_input_tokens INTEGER DEFAULT 0,
          times_execute_threshold_reached INTEGER DEFAULT 0,
          historian_failure_count INTEGER DEFAULT 0,
          historian_last_error TEXT DEFAULT NULL,
          historian_last_failure_at INTEGER DEFAULT NULL,
          cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toEqual(
                expect.arrayContaining([
                    "compartment_in_progress",
                    "historian_failure_count",
                    "historian_last_error",
                    "historian_last_failure_at",
                ]),
            );
        });

        it("#when an existing memory_embeddings table lacks model_id #then openDatabase adds the missing column", () => {
            const dataHome = useTempDataHome("storage-db-migrate-embedding-model-");
            const dbPath = resolveDbPath(dataHome);
            mkdirSync(join(dataHome, "cortexkit", "magic-context"), {
                recursive: true,
            });
            const legacyDb = new Database(dbPath);
            legacyDb.run(`
        CREATE TABLE memories (
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

        CREATE TABLE memory_embeddings (
          memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL
        );
      `);
            closeQuietly(legacyDb);

            const db = openDatabase();
            const columns = db.prepare("PRAGMA table_info(memory_embeddings)").all() as Array<{
                name?: string;
            }>;

            expect(columns.map((column) => column.name)).toContain("model_id");
        });
    });

    describe("#given closeDatabase", () => {
        it("#when called after openDatabase #then clears the cached instance", () => {
            useTempDataHome("storage-db-close-");

            const db1 = openDatabase();
            closeDatabase();
            const db2 = openDatabase();

            expect(db1).not.toBe(db2);
        });

        it("#when called multiple times #then does not throw", () => {
            useTempDataHome("storage-db-multi-close-");

            openDatabase();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
        });

        it("#when called without prior open #then does not throw", () => {
            expect(() => closeDatabase()).not.toThrow();
        });
    });
});
