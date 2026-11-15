import { expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import {
    PI_IDENTITY_FOLD_GUARD_LIMIT,
    piIdentityFoldGuardKey,
    readPiIdentityFoldGuards,
    writePiIdentityFoldGuards,
} from "./pi-identity-fold-guards";
import { getOrCreateSessionMeta } from "./storage";
import { initializeDatabase } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

it("fold guards round-trip and refuse to grow past their limit", () => {
    const db = openDb();
    try {
        expect(readPiIdentityFoldGuards(db, "session").size).toBe(0);
        writePiIdentityFoldGuards(db, "session", new Set(["a", "b"]));
        writePiIdentityFoldGuards(db, "session", new Set(["a", "b", "c"]));
        expect([...readPiIdentityFoldGuards(db, "session")]).toEqual(["a", "b", "c"]);
        const tooMany = new Set(
            Array.from({ length: PI_IDENTITY_FOLD_GUARD_LIMIT + 1 }, (_, n) => `k${n}`),
        );
        expect(() => writePiIdentityFoldGuards(db, "session", tooMany)).toThrow();
        db.prepare("UPDATE schema_migrations_meta SET value = ? WHERE key = ?").run(
            "[17]",
            piIdentityFoldGuardKey("session"),
        );
        expect(() => readPiIdentityFoldGuards(db, "session")).toThrow();
    } finally {
        db.close();
    }
});

it("deleting a session removes its fold guards and keeps other sessions' guards", () => {
    const db = openDb();
    try {
        for (const id of ["removed-session", "kept-session"]) {
            getOrCreateSessionMeta(db, id);
            writePiIdentityFoldGuards(db, id, new Set([`["tool",1,"${id}"]`]));
        }
        deleteSessionScopedRows(db, ["removed-session"]);
        const remaining = db
            .prepare(
                "SELECT key FROM schema_migrations_meta WHERE key LIKE 'pi_identity_fold_guards:%' ORDER BY key",
            )
            .all() as { key: string }[];
        expect(remaining.map((row) => row.key)).toEqual([piIdentityFoldGuardKey("kept-session")]);
        expect(readPiIdentityFoldGuards(db, "removed-session").size).toBe(0);
    } finally {
        db.close();
    }
});
