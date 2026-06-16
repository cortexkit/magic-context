/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function tableNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

describe("migration v38 — transform decisions", () => {
    test("fresh DB schema includes transform_decisions", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);

            runMigrations(db);

            expect(tableNames(db)).toContain("transform_decisions");
            expect(indexNames(db)).toContain("idx_transform_decisions_session_harness");
            expect(columnNames(db, "transform_decisions")).toEqual([
                "session_id",
                "harness",
                "message_id",
                "ts_ms",
                "decision",
                "materialized",
                "materialize_reason",
                "emergency",
                "dropped_tokens",
                "dropped_count",
                "input_tokens",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrade creates transform_decisions idempotently", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (37, 'pre-v38 fixture', 1);
            `);

            runMigrations(db);
            runMigrations(db);

            expect(tableNames(db)).toContain("transform_decisions");
            expect(indexNames(db)).toContain("idx_transform_decisions_session_harness");
            db.prepare(
                `INSERT OR REPLACE INTO transform_decisions (
                    session_id, harness, message_id, ts_ms, decision, materialized,
                    materialize_reason, emergency, dropped_tokens, dropped_count, input_tokens
                ) VALUES ('ses', 'opencode', 'msg', 1, 'execute', 1, 'ttl_idle', 0, 0, 0, 123)`,
            ).run();
            const row = db
                .prepare(
                    "SELECT session_id, harness, message_id, materialize_reason, input_tokens FROM transform_decisions",
                )
                .get();
            expect(row).toEqual({
                session_id: "ses",
                harness: "opencode",
                message_id: "msg",
                materialize_reason: "ttl_idle",
                input_tokens: 123,
            });
        } finally {
            closeQuietly(db);
        }
    });
});
