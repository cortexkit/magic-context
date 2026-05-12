import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { closeDatabase, initializeDatabase, openDatabase } from "./storage-db";

const tempDirs: string[] = [];

function useTempDataHome(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = undefined;
});

describe("migration v12 — FK cascades and orphan cleanup", () => {
    test("fresh database enables foreign keys and cascades memory_embeddings", () => {
        useTempDataHome("v12-fresh-");
        const db = openDatabase();

        const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
        expect(foreignKeys.foreign_keys).toBe(1);

        db.prepare(
            `INSERT INTO memories (
                id, project_path, category, content, normalized_hash,
                first_seen_at, created_at, updated_at, last_seen_at
             ) VALUES (1, '/repo', 'ENVIRONMENT', 'content', 'hash', 1, 1, 1, 1)`,
        ).run();
        db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (1, ?, 'model')",
        ).run(Buffer.from([1, 2, 3]));

        db.prepare("DELETE FROM memories WHERE id = 1").run();

        expect(count(db, "memory_embeddings")).toBe(0);
    });

    test("v12 cleans historical orphan rows from v11 databases idempotently", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec("PRAGMA foreign_keys=OFF");
            runMigrations(db);
            db.prepare("DELETE FROM schema_migrations WHERE version = 12").run();

            db.prepare(
                "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (999, ?, 'model')",
            ).run(Buffer.from([1]));
            db.prepare(
                "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) VALUES ('missing-sha', ?, 'model', 1)",
            ).run(Buffer.from([2]));

            expect(count(db, "memory_embeddings")).toBe(1);
            expect(count(db, "git_commit_embeddings")).toBe(1);

            db.exec("PRAGMA foreign_keys=ON");
            runMigrations(db);

            expect(count(db, "memory_embeddings")).toBe(0);
            expect(count(db, "git_commit_embeddings")).toBe(0);

            db.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
            runMigrations(db);

            expect(count(db, "memory_embeddings")).toBe(0);
            expect(count(db, "git_commit_embeddings")).toBe(0);
        } finally {
            db.close();
        }
    });
});
