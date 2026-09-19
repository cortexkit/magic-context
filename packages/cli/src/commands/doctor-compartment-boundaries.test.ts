import { describe, expect, it } from "bun:test";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    formatDanglingCompartmentBoundary,
    listDanglingCompartmentBoundaries,
} from "./doctor-compartment-boundaries";

function contextDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO session_meta (session_id, harness) VALUES ('ses-live', 'opencode'), ('ses-pi', 'pi')",
    ).run();
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id,
             end_message_id, title, content, created_at)
         VALUES
            ('ses-live', 0, 1, 2, 'm1', 'm2', 'ok', 'ok', 1),
            ('ses-live', 1, 3, 4, 'missing-start', 'm4', 'bad start', 'bad', 1),
            ('ses-live', 2, 5, 6, 'm5', 'missing-end', 'bad end', 'bad', 1),
            ('ses-pi', 0, 1, 1, 'pi-entry', 'pi-entry', 'pi', 'pi', 1)`,
    ).run();
    return db;
}

function v1Store(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);",
    );
    const insert = db.prepare("INSERT INTO message (id, session_id) VALUES (?, 'ses-live')");
    for (const id of ["m1", "m2", "m4", "m5"]) insert.run(id);
    return db;
}

function v2Store(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    const insert = db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, 'ses-live', 'user', ?, '{}')",
    );
    for (const [index, id] of ["m1", "m2", "m4", "m5"].entries()) insert.run(id, index);
    return db;
}

// A 1.18.x store that OpenCode 2 migrated: the v1 `message` table is kept but frozen at the
// migration point (here holding only m1), while session_message holds every id the host serves.
function migratedV2Store(): Database {
    const db = v2Store();
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL); CREATE TABLE session_v2 (id TEXT PRIMARY KEY);",
    );
    db.prepare("INSERT INTO message (id, session_id) VALUES ('m1', 'ses-live')").run();
    return db;
}

// The reverse: OpenCode 2 touched this store (session_v2 exists, session_message frozen at m1),
// then an OpenCode 1.x host kept writing to `message`.
function downgradedV1Store(): Database {
    const db = v1Store();
    db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE session_v2 (id TEXT PRIMARY KEY);",
    );
    db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m1', 'ses-live', 'user', 0, '{}')",
    ).run();
    return db;
}

describe("doctor dangling compartment boundary check", () => {
    for (const [name, makeStore, hostGeneration] of [
        ["v1", v1Store, undefined],
        ["v2", v2Store, undefined],
        // Stores carrying both generations are read by the running host, not by detection.
        ["migrated v2", migratedV2Store, "v2"],
        ["downgraded v1", downgradedV1Store, "v1"],
    ] as const) {
        it(`lists missing start and end ids from the resolved ${name} store`, () => {
            const context = contextDatabase();
            const store = makeStore();
            try {
                const dangling = listDanglingCompartmentBoundaries(context, store, hostGeneration);
                expect(dangling).toEqual([
                    {
                        sessionId: "ses-live",
                        sequence: 1,
                        missingStartMessageId: "missing-start",
                        missingEndMessageId: null,
                    },
                    {
                        sessionId: "ses-live",
                        sequence: 2,
                        missingStartMessageId: null,
                        missingEndMessageId: "missing-end",
                    },
                ]);
                expect(formatDanglingCompartmentBoundary(dangling[0]!)).toBe(
                    "session=ses-live sequence=1 missing start_message_id=missing-start",
                );
            } finally {
                context.close();
                store.close();
            }
        });
    }
});
