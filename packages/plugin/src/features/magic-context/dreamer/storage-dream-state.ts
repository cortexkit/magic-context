import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";

const getDreamStateStatements = new WeakMap<Database, PreparedStatement>();
const setDreamStateStatements = new WeakMap<Database, PreparedStatement>();
const deleteDreamStateStatements = new WeakMap<Database, PreparedStatement>();

function getGetDreamStateStatement(db: Database): PreparedStatement {
    let stmt = getDreamStateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT value FROM dream_state WHERE key = ?");
        getDreamStateStatements.set(db, stmt);
    }
    return stmt;
}

function getSetDreamStateStatement(db: Database): PreparedStatement {
    let stmt = setDreamStateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO dream_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        setDreamStateStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteDreamStateStatement(db: Database): PreparedStatement {
    let stmt = deleteDreamStateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM dream_state WHERE key = ?");
        deleteDreamStateStatements.set(db, stmt);
    }
    return stmt;
}

export function getDreamState(db: Database, key: string): string | null {
    const row = getGetDreamStateStatement(db).get(key) as { value?: unknown } | null;
    return typeof row?.value === "string" ? row.value : null;
}

export function setDreamState(db: Database, key: string, value: string): void {
    getSetDreamStateStatement(db).run(key, value);
}

export function deleteDreamState(db: Database, key: string): void {
    getDeleteDreamStateStatement(db).run(key);
}
