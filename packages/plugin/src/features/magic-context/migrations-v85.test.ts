/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    LATEST_MIGRATION_VERSION,
    runMigrations,
    V85_OPENCODE2_RELABEL_TABLES,
    V85_OPTIONAL_OPENCODE2_RELABEL_TABLES,
} from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

const tempDirs: string[] = [];
const originalOpenCodeDb = process.env.OPENCODE_DB;

afterEach(() => {
    if (originalOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = originalOpenCodeDb;
    resetOpenCodeDbPathStateForTesting();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

/**
 * Point the harness-evidence lookup at a path with no store, so the only thing
 * these tests can observe is what the migrations themselves do to the rows. With
 * evidence absent, v87 changes nothing — so any row that moves moved in v85.
 */
function useAbsentHostStore(): void {
    const dir = mkdtempSync(join(tmpdir(), "mc-v85-"));
    tempDirs.push(dir);
    process.env.OPENCODE_DB = join(dir, "opencode.db");
    resetOpenCodeDbPathStateForTesting();
}

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function harnessTablesFromDdl(db: Database): string[] {
    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
    return tables
        .filter((table) => columnNames(db, table.name).includes("harness"))
        .map((table) => table.name)
        .sort();
}

describe("migration v85: inert since v87 decides labels from host-store evidence", () => {
    test("fresh databases keep the v84 schema and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("protected_tokens_effective");
            expect(columnNames(db, "session_meta")).toContain("harness");
            expect(LATEST_SUPPORTED_VERSION).toBe(93);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM session_meta WHERE harness = 'opencode2'",
                    )
                    .get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("the relabel set still names every table whose DDL has a harness column", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const fromDdl = harnessTablesFromDdl(db);
            expect(fromDdl).toEqual([...V85_OPENCODE2_RELABEL_TABLES].sort());
            for (const optional of V85_OPTIONAL_OPENCODE2_RELABEL_TABLES) {
                expect(V85_OPENCODE2_RELABEL_TABLES).not.toContain(optional);
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("a v84 upgrade keeps its opencode2 rows: v85 no longer rewrites them, twins and all", () => {
        const db = new Database(":memory:");
        try {
            useAbsentHostStore();
            initializeDatabase(db);
            seedAppliedVersion(db, 84);

            db.exec(`
                INSERT INTO session_meta (session_id, harness, counter, is_subagent)
                VALUES
                    ('ses-only-o2', 'opencode2', 4, 1),
                    ('ses-primary', 'opencode', 9, 0);

                INSERT INTO tags (session_id, message_id, type, tag_number, harness)
                VALUES
                    ('ses-only-o2', 'm1', 'message', 1, 'opencode2'),
                    ('ses-primary', 'm2', 'message', 1, 'opencode');

                INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                VALUES
                    ('ses-twin', 'opencode', '/old', 100),
                    ('ses-twin', 'opencode2', '/new', 200),
                    ('ses-o2-only', 'opencode2', '/solo', 50);

                INSERT INTO message_history_orphan_sweep (harness, cursor_session_id, last_swept_at)
                VALUES
                    ('opencode', '', 500),
                    ('opencode2', 'ses-cursor', NULL);
            `);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT harness, counter FROM session_meta WHERE session_id = 'ses-only-o2'",
                    )
                    .get(),
            ).toEqual({ harness: "opencode2", counter: 4 });
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM tags WHERE harness = 'opencode2'").get(),
            ).toEqual({ count: 1 });
            // Both twin rows survive: v85 no longer picks a winner, and without
            // host-store evidence v87 does not either.
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path FROM session_projects WHERE session_id = 'ses-twin' ORDER BY harness",
                    )
                    .all(),
            ).toEqual([
                { harness: "opencode", project_path: "/old" },
                { harness: "opencode2", project_path: "/new" },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT harness, project_path FROM session_projects WHERE session_id = 'ses-o2-only'",
                    )
                    .get(),
            ).toEqual({ harness: "opencode2", project_path: "/solo" });
            expect(
                db
                    .prepare(
                        "SELECT harness, last_swept_at FROM message_history_orphan_sweep ORDER BY harness",
                    )
                    .all(),
            ).toEqual([
                { harness: "opencode", last_swept_at: 500 },
                { harness: "opencode2", last_swept_at: null },
            ]);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("the per-harness backfill cursor is left where it is, in both directions", () => {
        const db = new Database(":memory:");
        try {
            useAbsentHostStore();
            initializeDatabase(db);
            seedAppliedVersion(db, 84);
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_project_backfill_state (
                    harness TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
                    started_at INTEGER,
                    lease_expires_at INTEGER,
                    completed_at INTEGER,
                    holder_id TEXT
                );
                INSERT INTO session_project_backfill_state
                    (harness, status, started_at, completed_at)
                VALUES
                    ('opencode', 'completed', 100, 110),
                    ('opencode2', 'running', 900, NULL);
            `);

            runMigrations(db);

            // A cursor is keyed by harness alone, so no session's evidence speaks
            // for it: each lane keeps its own row instead of one being merged away.
            expect(
                db
                    .prepare(
                        "SELECT harness, status, started_at FROM session_project_backfill_state ORDER BY harness",
                    )
                    .all(),
            ).toEqual([
                { harness: "opencode", status: "completed", started_at: 100 },
                { harness: "opencode2", status: "running", started_at: 900 },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
