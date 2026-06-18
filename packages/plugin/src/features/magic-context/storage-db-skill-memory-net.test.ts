import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function cols(db: Database, table: string): Set<string> {
    return new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (r) => r.name,
        ),
    );
}

function objExists(db: Database, name: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
}

describe("skill_memory init-time self-heal net", () => {
    test("initializeDatabase ALONE creates skill_memory with the full final column set + FTS vtable + triggers", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db); // NO runMigrations
            const c = cols(db, "skill_memory");
            for (const need of [
                "origin_project",
                "source_type",
                "delta_embedding",
                "recall_count",
                "skill_id",
                "tier",
                "project_identity",
                "normalized_hash",
                "intent_embedding",
            ]) {
                expect(c.has(need)).toBe(true);
            }
            expect(objExists(db, "skill_memory_fts")).toBe(true);
            expect(objExists(db, "skill_memory_ai")).toBe(true);
            expect(objExists(db, "skill_memory_ad")).toBe(true);
            expect(objExists(db, "skill_memory_au")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("init-only schema MATCHES fully-migrated schema (no fresh-vs-migrated divergence)", () => {
        const a = new Database(":memory:");
        const b = new Database(":memory:");
        try {
            initializeDatabase(a);
            initializeDatabase(b);
            runMigrations(b);
            expect([...cols(a, "skill_memory")].sort()).toEqual(
                [...cols(b, "skill_memory")].sort(),
            );
            expect(objExists(a, "skill_memory_fts")).toBe(objExists(b, "skill_memory_fts"));
        } finally {
            closeQuietly(a);
            closeQuietly(b);
        }
    });

    test("heals a renumber-skip: existing skill_memory missing origin_project/source_type gets them on init", () => {
        const db = new Database(":memory:");
        try {
            // Simulate a DB created at the v39/v40 shape (no origin_project/source_type),
            // as if v41 was skipped by a renumber collision.
            db.exec(`CREATE TABLE skill_memory (
              id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, resolved_path TEXT NOT NULL,
              tier TEXT NOT NULL, skill_source TEXT, project_identity TEXT NOT NULL, intent TEXT,
              intent_embedding BLOB, embedding_model_version TEXT, kind TEXT NOT NULL, delta TEXT NOT NULL,
              tags TEXT, hit_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
              normalized_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER,
              delta_embedding BLOB, recall_count INTEGER NOT NULL DEFAULT 0,
              UNIQUE(skill_id, tier, project_identity, normalized_hash)
            );`);
            expect(cols(db, "skill_memory").has("origin_project")).toBe(false);
            initializeDatabase(db); // the net must ADD the missing columns
            expect(cols(db, "skill_memory").has("origin_project")).toBe(true);
            expect(cols(db, "skill_memory").has("source_type")).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});
