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

describe("migration v74: detected context-limit provenance", () => {
    test("fresh databases include provenance and keep the schema fence aligned", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(columnNames(db, "session_meta")).toContain("detected_context_limit_provenance");
            expect(LATEST_SUPPORTED_VERSION).toBe(82);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades legacy rows conservatively and remains idempotent", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    detected_context_limit INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO session_meta (session_id, detected_context_limit)
                VALUES ('ses-legacy', 167000);
            `);
            seedAppliedVersion(db, 73);

            runMigrations(db);
            runMigrations(db);

            const row = db
                .prepare(
                    "SELECT detected_context_limit, detected_context_limit_provenance FROM session_meta WHERE session_id = ?",
                )
                .get("ses-legacy") as {
                detected_context_limit: number;
                detected_context_limit_provenance: string;
            };
            expect(row).toEqual({
                detected_context_limit: 167_000,
                detected_context_limit_provenance: "unknown",
            });
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 74")
                    .get() as {
                    count: number;
                },
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("tolerates a sparse pre-v74 database without session metadata", () => {
        const db = new Database(":memory:");
        try {
            seedAppliedVersion(db, 73);
            expect(() => runMigrations(db)).not.toThrow();
            expect(
                db.prepare("SELECT version FROM schema_migrations WHERE version = 74").get(),
            ).toEqual({ version: 74 });
        } finally {
            closeQuietly(db);
        }
    });
});
