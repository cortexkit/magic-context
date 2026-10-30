/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { FORK_MIGRATION_VERSION_FLOOR, LATEST_MIGRATION_VERSION, MIGRATIONS } from "./migrations";
import {
    formatSchemaFenceBootLog,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "./storage-db";

// Guards the #1 bug class the project already hit during v2 work: adding a
// migration but forgetting to bump LATEST_SUPPORTED_VERSION (the schema-fence
// ceiling). A stale ceiling makes the DB refuse to open after the new migration
// applies, silently disabling Magic Context. Keep the fence and the migration
// list in lockstep.
describe("schema version fence", () => {
    it("LATEST_SUPPORTED_VERSION equals the highest migration version", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        expect(LATEST_SUPPORTED_VERSION).toBe(96);
    });

    it("keeps every upstream migration below the downstream floor", () => {
        expect(LATEST_MIGRATION_VERSION).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
        for (const migration of MIGRATIONS) {
            expect(migration.version).toBeLessThan(FORK_MIGRATION_VERSION_FLOOR);
        }
    });

    it("logs the live upstream migration lane and supported fence at boot", () => {
        expect(formatSchemaFenceBootLog(71, 72)).toBe(
            "[magic-context] upstream migration lane at boot: database=v71, supported_fence=v72",
        );
    });
});

it("migration v96 adds a nullable request-definition marker without invalidating old cached bytes", () => {
    const db = new Database(":memory:");
    const fresh = new Database(":memory:");
    const sparse = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, cached_m0_bytes BLOB, cached_m1_bytes BLOB);
            INSERT INTO session_meta VALUES ('old', X'6162', X'6364');`);
        const migration = MIGRATIONS.find(({ version }) => version === 96);
        expect(migration).toBeDefined();
        migration!.up(db);
        migration!.up(db);
        migration!.up(sparse);
        expect(
            db
                .prepare(
                    "SELECT hex(cached_m0_bytes) AS m0, hex(cached_m1_bytes) AS m1, cached_m0_tool_definitions_hash AS hash FROM session_meta",
                )
                .get(),
        ).toEqual({
            m0: "6162",
            m1: "6364",
            hash: null,
        });
        initializeDatabase(fresh);
        expect(
            (fresh.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toContain("cached_m0_tool_definitions_hash");
    } finally {
        db.close();
        fresh.close();
        sparse.close();
    }
});
