/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    FORK_MIGRATIONS,
    LATEST_FORK_MIGRATION_VERSION,
    runForkMigrations,
} from "./fork-migrations";
import { FORK_MIGRATION_VERSION_FLOOR, LATEST_MIGRATION_VERSION, MIGRATIONS } from "./migrations";
import {
    closeDatabase,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
} from "./storage-db";

/**
 * Guards the downstream migration lane. These assertions deliberately live here
 * rather than in schema-version-fence.test.ts so that upstream-owned file stays
 * byte-identical to upstream and never conflicts on rebase.
 */
describe("fork migration lane", () => {
    const tempDirs: string[] = [];
    const originalDataHome = process.env.XDG_DATA_HOME;

    afterEach(() => {
        closeDatabase();
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
        for (const dir of tempDirs.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort scratch cleanup
            }
        }
    });

    function useTempDataHome(prefix: string): string {
        const dataHome = mkdtempSync(join(tmpdir(), prefix));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        return dataHome;
    }

    test("every fork migration sits at or above the downstream floor", () => {
        expect(FORK_MIGRATIONS.length).toBeGreaterThan(0);
        for (const migration of FORK_MIGRATIONS) {
            expect(migration.version).toBeGreaterThanOrEqual(FORK_MIGRATION_VERSION_FLOOR);
        }
    });

    test("no fork migration leaks into the upstream MIGRATIONS array", () => {
        // The core invariant of B1b: upstream's array must remain pristine, or the
        // fence constant and a dozen upstream tests derived from it break.
        for (const migration of MIGRATIONS) {
            expect(migration.version).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
        }
    });

    test("versions are unique across both lanes", () => {
        // schema_migrations.version is a PRIMARY KEY, so a duplicate would surface at
        // runtime as a sibling-conflict rather than a clear authoring error.
        const versions = [...MIGRATIONS, ...FORK_MIGRATIONS].map((m) => m.version);
        expect([...new Set(versions)].length).toBe(versions.length);
    });

    test("LATEST_FORK_MIGRATION_VERSION tracks the fork lane maximum", () => {
        expect(LATEST_FORK_MIGRATION_VERSION).toBe(
            Math.max(...FORK_MIGRATIONS.map((m) => m.version)),
        );
    });

    test("the schema fence stays in the upstream lane and ignores fork versions", () => {
        // Fork rows are fence-invisible by design: getPersistedVersion() reads
        // MAX(version) WHERE version < floor, so a ceiling at or above the floor
        // could never be reached.
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        expect(LATEST_SUPPORTED_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
        expect(LATEST_FORK_MIGRATION_VERSION).toBeGreaterThanOrEqual(FORK_MIGRATION_VERSION_FLOOR);
    });

    test("runForkMigrations applies each fork migration exactly once", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                )
            `);

            runForkMigrations(db);
            runForkMigrations(db);
            runForkMigrations(db);

            const rows = db
                .prepare(
                    "SELECT version FROM schema_migrations WHERE version >= ? ORDER BY version",
                )
                .all(FORK_MIGRATION_VERSION_FLOOR) as Array<{ version: number }>;
            expect(rows.map((r) => r.version)).toEqual(
                [...FORK_MIGRATIONS].map((m) => m.version).sort((a, b) => a - b),
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("runForkMigrations refuses to run before the bookkeeping table exists", () => {
        // Ordering contract: the upstream pass creates schema_migrations, and a fork
        // migration's DDL may depend on upstream tables. Failing loudly beats
        // inserting bookkeeping for DDL that silently no-opped.
        const db = new Database(":memory:");
        try {
            expect(() => runForkMigrations(db)).toThrow(/requires the schema_migrations table/);
        } finally {
            closeQuietly(db);
        }
    });

    test("the real openDatabase path applies the fork lane", () => {
        // The load-bearing integration seam. Every other test here drives
        // runForkMigrations directly, so all of them still pass if the call is
        // missing from storage-db.ts's open path — verified by reverting the wiring
        // and watching 40 tests stay green. Without this test the feature is
        // dead-on-arrival in production and nothing notices.
        useTempDataHome("fork-lane-open-path-");

        const db = openDatabase();
        expect(db).not.toBeNull();

        const rows = db
            ?.prepare("SELECT version FROM schema_migrations WHERE version >= ? ORDER BY version")
            .all(FORK_MIGRATION_VERSION_FLOOR) as Array<{ version: number }>;
        expect(rows.map((r) => r.version)).toEqual(
            [...FORK_MIGRATIONS].map((m) => m.version).sort((a, b) => a - b),
        );

        // And the fork migrations' actual DDL landed, not just their bookkeeping rows.
        const columns = (
            db?.prepare("PRAGMA table_info(skill_memory)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns).toContain("normalized_hash"); // P1 (10000)
        expect(columns).toContain("delta_embedding"); // P2 (10001)
        expect(columns).toContain("source_type"); // P3a (10002)
    });

    test("fork rows do not advance the upstream watermark", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                )
            `);
            db.prepare(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
            ).run(LATEST_MIGRATION_VERSION, "upstream head", 0);

            runForkMigrations(db);

            const upstreamMax = db
                .prepare(
                    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
                )
                .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number };
            expect(upstreamMax.version).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });
});
