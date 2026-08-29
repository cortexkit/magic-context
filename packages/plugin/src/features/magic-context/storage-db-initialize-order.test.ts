/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    FORK_MIGRATION_VERSION_FLOOR,
    LATEST_MIGRATION_VERSION,
    MIGRATIONS,
    runMigrations,
} from "./migrations";
import { closeDatabase, initializeDatabase, openDatabase, openDatabaseAsync } from "./storage-db";

interface InitializerIndexAudit {
    index: string;
    table: "message_history_index" | "tags";
    column: string;
    firstVersionWithColumn: number;
}

// These are the only initializer indexes whose columns were absent from an
// earlier persisted shape. Most initializer indexes use columns present in the
// original table definition. The message-history harness column was introduced
// by the v7 startup healer; the two tag columns were introduced by v10 and v27.
const INITIALIZER_INDEX_AUDIT: readonly InitializerIndexAudit[] = [
    {
        index: "idx_message_history_index_orphan_sweep",
        table: "message_history_index",
        column: "harness",
        firstVersionWithColumn: 7,
    },
    {
        index: "idx_tags_pi_fallback_tool_owner",
        table: "tags",
        column: "tool_owner_message_id",
        firstVersionWithColumn: 10,
    },
    {
        index: "idx_tags_pi_adopt",
        table: "tags",
        column: "entry_fingerprint",
        firstVersionWithColumn: 27,
    },
];

function seedMigrationLedger(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    for (const migration of MIGRATIONS) {
        if (migration.version > version) break;
        db.prepare(
            "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, 0)",
        ).run(migration.version, migration.description);
    }
}

function seedHistoricalCoreTables(db: Database, version: number): void {
    const tagColumns = [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "session_id TEXT",
        "message_id TEXT",
        "type TEXT",
        "status TEXT DEFAULT 'active'",
        "byte_size INTEGER",
        "tag_number INTEGER",
    ];
    if (version >= 7) tagColumns.push("harness TEXT NOT NULL DEFAULT 'opencode'");
    if (version >= 10) tagColumns.push("tool_owner_message_id TEXT DEFAULT NULL");
    if (version >= 27) tagColumns.push("entry_fingerprint TEXT");

    const messageHistoryIndexColumns = [
        "session_id TEXT PRIMARY KEY",
        "last_indexed_ordinal INTEGER NOT NULL DEFAULT 0",
        "updated_at INTEGER NOT NULL",
    ];
    if (version >= 7) {
        messageHistoryIndexColumns.push("harness TEXT NOT NULL DEFAULT 'opencode'");
    }

    db.exec(`
        CREATE TABLE tags (${tagColumns.join(", ")});
        CREATE TABLE message_history_index (${messageHistoryIndexColumns.join(", ")});
    `);
    if (version >= 1) {
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
        `);
    }
}

function indexExists(db: Database, name: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
    );
}

function hasColumn(db: Database, table: InitializerIndexAudit["table"], column: string): boolean {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (entry) => entry.name === column,
    );
}

function buildHistoricalStore(version: number): Database {
    const db = new Database(":memory:");
    seedMigrationLedger(db, version);
    seedHistoricalCoreTables(db, version);
    return db;
}

function seedHistoricalStoreFile(version: number): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "magic-context-index-order-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        seedMigrationLedger(db, version);
        seedHistoricalCoreTables(db, version);
    } finally {
        closeQuietly(db);
    }
    return { dir, path };
}

function persistedVersion(db: Database): number {
    // Mirror getPersistedSchemaVersion: rows at or above the reserved fork lane are a
    // downstream namespace, not this binary's schema version. A bare MAX(version) reads
    // a fork's 10_000+ row as the store version, so this assertion fails for any fork
    // using the documented lane even though production resolves the version correctly.
    return (
        db
            .prepare(
                "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
            )
            .get(FORK_MIGRATION_VERSION_FLOOR) as {
            version: number;
        }
    ).version;
}

function legacyInitializerOrderingFailure(db: Database): string {
    try {
        // This is the former ordering: index creation ran before the initializer
        // healed message_history_index.harness and before migrations could run.
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
              ON message_history_index(harness, session_id, updated_at);
        `);
        initializeDatabase(db);
        runMigrations(db);
        throw new Error("legacy initializer ordering unexpectedly succeeded");
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

describe("initializeDatabase legacy index ordering", () => {
    afterEach(() => closeDatabase());
    test("documents the stable no-such-column wedge from the old ordering", () => {
        const db = buildHistoricalStore(6);
        try {
            const firstFailure = legacyInitializerOrderingFailure(db);
            const secondFailure = legacyInitializerOrderingFailure(db);

            expect(firstFailure).toBe("no such column: harness");
            expect(secondFailure).toBe(firstFailure);
            expect(persistedVersion(db)).toBe(6);
        } finally {
            closeQuietly(db);
        }
    });

    test("heals the legacy shape before creating every audited index", () => {
        for (const audit of INITIALIZER_INDEX_AUDIT) {
            const db = buildHistoricalStore(audit.firstVersionWithColumn - 1);
            try {
                expect(
                    hasColumn(db, audit.table, audit.column),
                    `${audit.index} fixture must stop before ${audit.column} exists`,
                ).toBe(false);

                expect(() => initializeDatabase(db), audit.index).not.toThrow();

                expect(hasColumn(db, audit.table, audit.column), audit.index).toBe(true);
                expect(indexExists(db, audit.index), audit.index).toBe(true);
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("opens the repaired legacy store through the shared OpenCode and Pi boot paths", async () => {
        const openCode = seedHistoricalStoreFile(6);
        const pi = seedHistoricalStoreFile(6);
        try {
            const openCodeDb = openDatabase(openCode.path);
            expect(openCodeDb).not.toBeNull();
            expect(persistedVersion(openCodeDb!)).toBe(LATEST_MIGRATION_VERSION);
            closeDatabase();

            // Pi imports openDatabaseAsync directly from the shared storage-db module.
            const piDb = await openDatabaseAsync(pi.path);
            expect(piDb).not.toBeNull();
            expect(persistedVersion(piDb!)).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeDatabase();
            rmSync(openCode.dir, { recursive: true, force: true });
            rmSync(pi.dir, { recursive: true, force: true });
        }
    });

    test("succeeds from every migration checkpoint represented by the step-through ledger", () => {
        for (const version of [0, ...MIGRATIONS.map((migration) => migration.version)]) {
            const db = buildHistoricalStore(version);
            try {
                expect(() => initializeDatabase(db), `legacy checkpoint v${version}`).not.toThrow();

                for (const audit of INITIALIZER_INDEX_AUDIT) {
                    expect(
                        hasColumn(db, audit.table, audit.column),
                        `v${version}: ${audit.index}`,
                    ).toBe(true);
                    expect(indexExists(db, audit.index), `v${version}: ${audit.index}`).toBe(true);
                }
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("resolves the store version from the upstream lane when a fork migration row is present", () => {
        const seeded = seedHistoricalStoreFile(6);
        try {
            const db = openDatabase(seeded.path);
            expect(db).not.toBeNull();
            // A downstream fork records its own migrations in the reserved >= 10_000 lane.
            db!
                .prepare(
                    // OR REPLACE so the fixture is idempotent on a real fork, whose own
                    // migration may already occupy this version.
                    "INSERT OR REPLACE INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                )
                .run(FORK_MIGRATION_VERSION_FLOOR + 100, "downstream fork migration", Date.now());
            // The store version is still this binary's latest upstream migration; the fork
            // row is a separate namespace and must never be read as the schema version.
            expect(persistedVersion(db!)).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeDatabase();
            rmSync(seeded.dir, { recursive: true, force: true });
        }
    });
});
