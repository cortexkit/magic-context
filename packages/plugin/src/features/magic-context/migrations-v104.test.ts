import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { getMemoryById } from "./memory/storage-memory";
import { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } from "./migrations";
import { schemaSnapshot } from "./schema-fingerprint";
import { enforceSchemaFence, initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

const HEAD = 104;
const TABLES = ["memory_placement", "memory_ops", "memory_outbox", "memory_sync_state"];

// Run the placement upgrade cases only through HEAD, even after the registry grows.
// The contiguity test below still checks the full registry.
function runThroughHead(db: Database) {
    const index = MIGRATIONS.findIndex((migration) => migration.version > HEAD);
    const later = index < 0 ? [] : MIGRATIONS.splice(index);
    try {
        runMigrations(db);
    } finally {
        MIGRATIONS.push(...later);
    }
}

function current() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runThroughHead(db);
    return db;
}

function predecessor() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    // The initializer also supports fresh stores. Remove only the new sidecars
    // so their creation cannot conceal a missing upgrade body.
    for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
    const index = MIGRATIONS.findIndex((migration) => migration.version === HEAD);
    const later = MIGRATIONS.splice(index);
    try {
        runMigrations(db);
    } finally {
        MIGRATIONS.push(...later);
    }
    return db;
}

function insertMemory(db: Database) {
    db.exec(`INSERT INTO memories(id,project_path,category,content,normalized_hash,
        first_seen_at,created_at,updated_at,last_seen_at)
        VALUES (1,'/project','CONSTRAINTS','Keep exact bytes: 東京 🧠','hash',1,2,3,4)`);
}

describe("memory placement and sync schema", () => {
    test("the actual migration registry is contiguous with no adjacent-version gaps", () => {
        expect(MIGRATIONS[0].version).toBe(1);
        for (let index = 1; index < MIGRATIONS.length; index++) {
            expect(MIGRATIONS[index].version).toBe(MIGRATIONS[index - 1].version + 1);
        }
        expect(MIGRATIONS.at(-1)?.version).toBe(LATEST_MIGRATION_VERSION);
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
        expect(LATEST_SUPPORTED_VERSION).toBeGreaterThanOrEqual(HEAD);
        expect(MIGRATIONS.filter((migration) => migration.version === HEAD)).toHaveLength(1);
    });

    test("upgrades the populated predecessor without backfill and matches fresh maintenance", () => {
        const db = predecessor();
        const fresh = current();
        try {
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: HEAD - 1,
            });
            expect(enforceSchemaFence(db, ":predecessor:", HEAD - 1)).toBe(true);
            insertMemory(db);
            const before = db.prepare("SELECT * FROM memories").all();
            initializeDatabase(db);
            for (const table of TABLES) {
                expect(
                    db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table),
                ).toBeNull();
            }
            runThroughHead(db);
            expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
                v: HEAD,
            });
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
            expect(enforceSchemaFence(db, ":previous-host:", HEAD - 1)).toBe(false);
            expect(enforceSchemaFence(db, ":current-host:", HEAD)).toBe(true);
            for (const table of TABLES) {
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
                expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual([]);
            }
            expect(SESSION_SCOPED_TABLES).not.toContain("memory_placement");
            expect(schemaSnapshot(db)).toEqual(schemaSnapshot(fresh));
            MIGRATIONS.find((migration) => migration.version === HEAD)!.up(db);
            initializeDatabase(db);
            runThroughHead(db);
            expect(schemaSnapshot(db)).toEqual(schemaSnapshot(fresh));
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
        } finally {
            db.close();
            fresh.close();
        }
    });

    test("a memory without sidecars keeps its legacy project and source defaults", () => {
        const db = predecessor();
        try {
            insertMemory(db);
            const before = getMemoryById(db, 1);
            expect(before).toMatchObject({
                id: 1,
                projectPath: "/project",
                scope: "project",
                importance: 50,
                shareable: 0,
                sourceType: "historian",
                sourceSessionId: null,
            });
            runThroughHead(db);
            expect(getMemoryById(db, 1)).toEqual(before);
            for (const table of TABLES) {
                expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
            }
        } finally {
            db.close();
        }
    });

    test("foreign-keys-on memory deletion succeeds with a placement row", () => {
        for (const db of [predecessor(), new Database(":memory:")]) {
            try {
                // Exercise migration DDL and fresh DDL independently: a foreign key
                // added to either declaration must not be masked by the other.
                if (db.prepare("SELECT name FROM sqlite_master WHERE name='memories'").get()) {
                    runThroughHead(db);
                } else {
                    initializeDatabase(db);
                }
                db.exec("PRAGMA foreign_keys=ON");
                expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
                insertMemory(db);
                db.exec(`INSERT INTO memory_placement(memory_id,level,owner_kind,owner_id,written_at)
                    VALUES (1,'project','project','project-id',5)`);
                db.exec("DELETE FROM memories WHERE id=1");
                expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
                expect(db.prepare("SELECT memory_id FROM memory_placement").all()).toEqual([
                    { memory_id: 1 },
                ]);
            } finally {
                db.close();
            }
        }
    });
});
