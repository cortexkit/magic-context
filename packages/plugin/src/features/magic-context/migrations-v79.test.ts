/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

describe("migration v79: memory evidence", () => {
    it("creates the evidence identity and backfills known source sessions", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(`
                INSERT INTO memories (
                    project_path, category, content, normalized_hash,
                    source_session_id, source_type, first_seen_at,
                    created_at, updated_at, last_seen_at
                ) VALUES (
                    'git:project', 'CONSTRAINTS', 'Fact', 'hash',
                    'session-a', 'user', 11, 11, 11, 11
                );
            `);

            runMigrations(db);

            expect(
                db
                    .prepare(
                        `SELECT memory_id, content_hash, source_session_id, source_message_id, source_type, observed_at
                           FROM memory_evidence`,
                    )
                    .all(),
            ).toEqual([
                {
                    memory_id: 1,
                    content_hash: "hash",
                    source_session_id: "session-a",
                    source_message_id: null,
                    source_type: "user",
                    observed_at: 11,
                },
            ]);
            expect(LATEST_SUPPORTED_VERSION).toBe(79);
        } finally {
            closeQuietly(db);
        }
    });
});
