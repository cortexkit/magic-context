/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

/**
 * Phase 2a regression: every session-scoped table must carry a `harness`
 * column so OpenCode and Pi can share `~/.local/share/cortexkit/magic-context/`
 * without conflating their session state. Pre-v0.16 rows must transparently
 * become harness='opencode'.
 *
 * This test creates a fresh in-memory DB and verifies that all session-scoped
 * tables expose a harness column with the expected default — covering both
 * fresh installs (CREATE TABLE in initializeDatabase + migration v1 for notes)
 * and the upgrade path (ensureColumn for upgrades + migration v6 for notes).
 */

const SESSION_SCOPED_TABLES = [
    "session_meta",
    "compartments",
    "compression_depth",
    "session_facts",
    "tags",
    "source_contents",
    "pending_ops",
    "recomp_compartments",
    "recomp_facts",
    "message_history_index",
    "notes",
] as const;

describe("harness column", () => {
    it("every session-scoped table has a harness column", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        for (const table of SESSION_SCOPED_TABLES) {
            const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                name: string;
                dflt_value: string | null;
                notnull: number;
            }>;
            const harness = cols.find((c) => c.name === "harness");
            expect(harness, `${table} should have harness column`).toBeDefined();
            // Stored DEFAULT in sqlite_master includes literal quotes.
            expect(harness?.dflt_value).toBe("'opencode'");
            expect(harness?.notnull).toBe(1);
        }

        closeQuietly(db);
    });

    it("legacy notes rows get harness='opencode' via migration v6", () => {
        // Simulate a pre-v6 DB: create notes table without harness column,
        // insert a legacy row, then run init+migrations to verify backfill.
        const db = new Database(":memory:");

        // Pre-create v1 notes WITHOUT harness, mark migrations 1-5 already applied.
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
                ready_reason TEXT
            );
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );
        `);
        const now = Date.now();
        db.prepare("INSERT INTO notes (content, created_at, updated_at) VALUES (?, ?, ?)").run(
            "legacy note",
            now,
            now,
        );
        for (const v of [1, 2, 3, 4, 5]) {
            db.prepare(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
            ).run(v, "pre-existing", now);
        }

        // Now run init (idempotent) + migration v6.
        initializeDatabase(db);
        runMigrations(db);

        // Legacy row should now report harness='opencode' even though it was
        // inserted before the column existed (SQLite physically backfills
        // NOT NULL DEFAULT on existing rows during ALTER TABLE).
        const row = db.prepare("SELECT harness FROM notes WHERE content = 'legacy note'").get() as
            | { harness: string }
            | undefined;
        expect(row?.harness).toBe("opencode");

        closeQuietly(db);
    });
});
