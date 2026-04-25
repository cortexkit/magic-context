import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";

export interface DreamRunTaskSummary {
    name: string;
    durationMs: number;
    resultChars: number;
    error?: string;
}

export interface DreamRunMemoryChanges {
    written: number;
    deleted: number;
    archived: number;
    merged: number;
}

export interface DreamRunRow {
    id: number;
    project_path: string;
    started_at: number;
    finished_at: number;
    holder_id: string;
    tasks_json: string;
    tasks_succeeded: number;
    tasks_failed: number;
    smart_notes_surfaced: number;
    smart_notes_pending: number;
    memory_changes_json: string | null;
}

export interface DreamRunInput {
    projectPath: string;
    startedAt: number;
    finishedAt: number;
    holderId: string;
    tasks: DreamRunTaskSummary[];
    tasksSucceeded: number;
    tasksFailed: number;
    smartNotesSurfaced: number;
    smartNotesPending: number;
    memoryChanges?: DreamRunMemoryChanges | null;
}

const insertDreamRunStatements = new WeakMap<Database, PreparedStatement>();
const getDreamRunsByProjectStatements = new Map<number, WeakMap<Database, PreparedStatement>>();

function getInsertDreamRunStatement(db: Database): PreparedStatement {
    let stmt = insertDreamRunStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertDreamRunStatements.set(db, stmt);
    }
    return stmt;
}

function getDreamRunsByProjectStatement(db: Database, limit: number): PreparedStatement {
    let statements = getDreamRunsByProjectStatements.get(limit);
    if (!statements) {
        statements = new WeakMap<Database, PreparedStatement>();
        getDreamRunsByProjectStatements.set(limit, statements);
    }

    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT id, project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json FROM dream_runs WHERE project_path = ? ORDER BY finished_at DESC LIMIT ${limit}`,
        );
        statements.set(db, stmt);
    }

    return stmt;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isDreamRunRow(row: unknown): row is DreamRunRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.project_path === "string" &&
        typeof candidate.started_at === "number" &&
        typeof candidate.finished_at === "number" &&
        typeof candidate.holder_id === "string" &&
        typeof candidate.tasks_json === "string" &&
        typeof candidate.tasks_succeeded === "number" &&
        typeof candidate.tasks_failed === "number" &&
        typeof candidate.smart_notes_surfaced === "number" &&
        typeof candidate.smart_notes_pending === "number" &&
        isNullableString(candidate.memory_changes_json)
    );
}

export function insertDreamRun(db: Database, run: DreamRunInput): void {
    getInsertDreamRunStatement(db).run(
        run.projectPath,
        run.startedAt,
        run.finishedAt,
        run.holderId,
        JSON.stringify(run.tasks),
        run.tasksSucceeded,
        run.tasksFailed,
        run.smartNotesSurfaced,
        run.smartNotesPending,
        run.memoryChanges ? JSON.stringify(run.memoryChanges) : null,
    );
}

export function getDreamRuns(db: Database, projectPath: string, limit = 20): DreamRunRow[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
    return getDreamRunsByProjectStatement(db, normalizedLimit)
        .all(projectPath)
        .filter(isDreamRunRow)
        .map((row) => ({ ...row }));
}
