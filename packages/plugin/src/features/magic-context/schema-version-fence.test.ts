/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { FORK_MIGRATION_VERSION_FLOOR, LATEST_MIGRATION_VERSION, MIGRATIONS } from "./migrations";
import {
    formatSchemaFenceBootLog,
    LATEST_SUPPORTED_VERSION,
    SCHEMA_FENCE_SENTINEL,
} from "./storage-db";

// Guards the #1 bug class the project already hit during v2 work: adding a
// migration but forgetting to bump LATEST_SUPPORTED_VERSION (the schema-fence
// ceiling). A stale ceiling makes the DB refuse to open after the new migration
// applies, silently disabling Magic Context. Keep the fence and the migration
// list in lockstep.
describe("schema version fence", () => {
    it("LATEST_SUPPORTED_VERSION equals the highest migration version", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
    });

    it("the built-chunk sentinel names the highest migration version", () => {
        expect(SCHEMA_FENCE_SENTINEL).toBe(
            `magic-context-schema-fence=${LATEST_MIGRATION_VERSION}`,
        );
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
