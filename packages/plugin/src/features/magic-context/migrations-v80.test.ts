/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

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

describe("migration v80: observed tool-set comparison telemetry", () => {
    test("fresh databases include tool-set operands and align the schema fence", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "transform_decisions")).toEqual(
                expect.arrayContaining(["m0_tool_set_hash_prev", "m0_tool_set_hash_new"]),
            );
            const toolSetColumns = db
                .prepare("PRAGMA table_info(transform_decisions)")
                .all() as Array<{ name: string; notnull: number }>;
            expect(
                toolSetColumns
                    .filter(({ name }) =>
                        ["m0_tool_set_hash_prev", "m0_tool_set_hash_new"].includes(name),
                    )
                    .every(({ notnull }) => notnull === 0),
            ).toBe(true);
            expect(LATEST_SUPPORTED_VERSION).toBe(82);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades existing decisions without inventing a comparison and remains idempotent", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE transform_decisions (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    message_id TEXT NOT NULL,
                    ts_ms INTEGER NOT NULL,
                    decision TEXT NOT NULL,
                    materialized INTEGER NOT NULL DEFAULT 0,
                    materialize_reason TEXT,
                    system_hash_prev TEXT,
                    system_hash_new TEXT,
                    m0_model_key_prev TEXT,
                    m0_model_key_new TEXT,
                    emergency INTEGER NOT NULL DEFAULT 0,
                    dropped_tokens INTEGER NOT NULL DEFAULT 0,
                    dropped_count INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, harness, message_id)
                );
                INSERT INTO transform_decisions (
                    session_id, harness, message_id, ts_ms, decision, materialized
                ) VALUES ('ses-legacy', 'opencode', 'msg-legacy', 1, 'execute', 0);
            `);
            seedAppliedVersion(db, 79);

            runMigrations(db);
            runMigrations(db);

            expect(
                db
                    .prepare(
                        `SELECT m0_tool_set_hash_prev, m0_tool_set_hash_new
                         FROM transform_decisions WHERE session_id = 'ses-legacy'`,
                    )
                    .get(),
            ).toEqual({ m0_tool_set_hash_prev: null, m0_tool_set_hash_new: null });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 80")
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("tolerates a sparse pre-v80 database without transform decision telemetry", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 79);
            expect(() => runMigrations(db)).not.toThrow();
            expect(
                db.prepare("SELECT version FROM schema_migrations WHERE version = 80").get(),
            ).toEqual({ version: 80 });
        } finally {
            closeQuietly(db);
        }
    });
});
