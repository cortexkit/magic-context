import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { isUserHomeDirectory } from "./memory/project-identity";

const SESSION_CHUNK_REPAIR_BATCH_SIZE = 100;

const upsertSessionProjectStatements = new WeakMap<Database, PreparedStatement>();
const repairSessionChunkProjectStatements = new WeakMap<Database, PreparedStatement>();
const misScopedProjectChunkStatements = new WeakMap<Database, PreparedStatement>();

// Each branch starts at a project index instead of scanning every chunk.
export const MIS_SCOPED_PROJECT_CHUNK_IDS_SQL = `
    SELECT e.id FROM compartment_chunk_embeddings e
    JOIN session_projects sp ON sp.session_id = e.session_id AND sp.harness = e.harness
    WHERE e.project_path = ? AND sp.project_path <> e.project_path
    UNION ALL
    SELECT e.id FROM session_projects sp
    JOIN compartment_chunk_embeddings e ON e.session_id = sp.session_id
    WHERE sp.project_path = ? AND e.harness = sp.harness AND e.project_path <> sp.project_path`;

export function hasMisScopedCompartmentChunkEmbeddingsForProject(
    db: Database,
    projectPath: string,
): boolean {
    let stmt = misScopedProjectChunkStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(`SELECT 1 FROM (${MIS_SCOPED_PROJECT_CHUNK_IDS_SQL}) LIMIT 1`);
        misScopedProjectChunkStatements.set(db, stmt);
    }
    return !!stmt.get(projectPath, projectPath);
}

function getUpsertSessionProjectStatement(db: Database): PreparedStatement {
    let stmt = upsertSessionProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, harness) DO UPDATE SET
                 project_path = excluded.project_path,
                 updated_at = excluded.updated_at
             WHERE session_projects.project_path <> excluded.project_path`,
        );
        upsertSessionProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getRepairSessionChunkProjectStatement(db: Database): PreparedStatement {
    let stmt = repairSessionChunkProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE compartment_chunk_embeddings
             SET project_path = ?
             WHERE id IN (
                 SELECT id
                 FROM compartment_chunk_embeddings
                 WHERE session_id = ?
                   AND harness = ?
                   AND project_path <> ?
                 LIMIT ?
             )`,
        );
        repairSessionChunkProjectStatements.set(db, stmt);
    }
    return stmt;
}

export function findMisScopedCompartmentChunkEmbeddingIdsForProject(
    db: Database,
    projectPath: string,
): number[] {
    return (
        db
            .prepare(`SELECT id FROM (${MIS_SCOPED_PROJECT_CHUNK_IDS_SQL}) LIMIT 25`)
            .all(projectPath, projectPath) as Array<{ id: number }>
    ).map(({ id }) => id);
}

export interface SessionProjectIdentityChange {
    previousProjectPath: string | undefined;
    projectPath: string;
}

/**
 * Persist the host session's current project binding. A host session can move
 * between projects, so a later observation deliberately replaces its earlier
 * project path.
 * Chunk backfills use this mapping as the project-scope authority: without it, a
 * project-wide drain cannot safely distinguish same-process sessions from other
 * projects and must not stamp arbitrary compartments with its own identity.
 */
export function recordSessionProjectIdentity(
    db: Database,
    sessionId: string,
    projectPath: string | undefined,
): SessionProjectIdentityChange | undefined {
    if (!sessionId || !projectPath) return undefined;
    // A session started exactly at the user's home directory is not a project.
    // The guard is repeated here because background backfills can call this
    // function without passing through the transform resolver.
    if (
        !projectPath.startsWith("git:") &&
        !projectPath.startsWith("dir:") &&
        isUserHomeDirectory(projectPath)
    )
        return;
    const harness = getHarness();
    const now = Date.now();
    let previousProjectPath: string | undefined;
    db.transaction(() => {
        const existing = db
            .prepare(
                "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?",
            )
            .get(sessionId, harness) as { project_path: string } | null;
        previousProjectPath = existing?.project_path;
        getUpsertSessionProjectStatement(db).run(sessionId, harness, projectPath, now);
        // Repair a bounded slice of chunks stamped with a project other than the
        // session's recorded owner. Repeated observations resume the repair
        // without making transform wait on an unbounded update.
        getRepairSessionChunkProjectStatement(db).run(
            projectPath,
            sessionId,
            harness,
            projectPath,
            SESSION_CHUNK_REPAIR_BATCH_SIZE,
        );
    }).immediate();
    return previousProjectPath === projectPath ? undefined : { previousProjectPath, projectPath };
}

/**
 * Whether a project binding has been stored for this session. Bindings are
 * stored only from a directory the host returned for the session. A session
 * without one has only ever been rendered with the directory OpenCode was
 * launched from, which the transform falls back to when the host gives none.
 */
export function hasRecordedSessionProjectIdentity(db: Database, sessionId: string): boolean {
    const row = db
        .prepare("SELECT 1 AS found FROM session_projects WHERE session_id = ? AND harness = ?")
        .get(sessionId, getHarness()) as { found: number } | null;
    return row?.found === 1;
}

/**
 * Heal historical chunk rows whose stored project differs from their session owner
 * when either the stored or the correct project is this project. Both
 * partitions use indexes, and the precheck avoids a write on the common miss.
 * Repair one slice per observation; later registrations resume the remaining rows.
 */
export function repairMisScopedCompartmentChunkEmbeddingsForProject(
    db: Database,
    projectPath: string,
    ids = findMisScopedCompartmentChunkEmbeddingIdsForProject(db, projectPath),
): number {
    if (!projectPath || ids.length === 0) return 0;
    return db
        .prepare(`UPDATE compartment_chunk_embeddings
        SET project_path = (SELECT sp.project_path FROM session_projects sp
            WHERE sp.session_id = compartment_chunk_embeddings.session_id
              AND sp.harness = compartment_chunk_embeddings.harness)
        WHERE id IN (${ids.map(() => "?").join(",")}) AND EXISTS (
            SELECT 1 FROM session_projects sp
            WHERE sp.session_id = compartment_chunk_embeddings.session_id
              AND sp.harness = compartment_chunk_embeddings.harness
              AND sp.project_path <> compartment_chunk_embeddings.project_path
              AND (sp.project_path = ? OR compartment_chunk_embeddings.project_path = ?)
        )`)
        .run(...ids, projectPath, projectPath).changes;
}
