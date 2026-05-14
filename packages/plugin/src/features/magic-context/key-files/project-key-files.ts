import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";

export type KeyFileStaleReason = "missing" | "content_drift";

export interface ProjectKeyFileRow {
    projectPath: string;
    path: string;
    content: string;
    contentHash: string;
    localTokenEstimate: number;
    generatedAt: number;
    generatedByModel: string | null;
    generationConfigHash: string;
    staleReason: KeyFileStaleReason | null;
}

export interface ReplacementKeyFile {
    path: string;
    content: string;
    localTokenEstimate: number;
    generatedByModel?: string | null;
    generationConfigHash: string;
}

export interface CommitKeyFile {
    path: string;
    content: string;
    localTokenEstimate: number;
}

export interface ResolvedCommitKeyFile extends CommitKeyFile {
    contentHash: string;
    staleReason: KeyFileStaleReason | null;
}

const MISSING_CONTENT_HASH = "<missing>";
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function sha256(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex");
}

export function resolveProjectPath(directory: string | undefined): string | null {
    if (!directory?.trim()) return null;
    try {
        return realpathSync(directory);
    } catch {
        return resolve(directory);
    }
}

function rowToProjectKeyFile(row: Record<string, unknown>): ProjectKeyFileRow {
    return {
        projectPath: String(row.project_path),
        path: String(row.path),
        content: String(row.content),
        contentHash: String(row.content_hash),
        localTokenEstimate: Number(row.local_token_estimate),
        generatedAt: Number(row.generated_at),
        generatedByModel: row.generated_by_model == null ? null : String(row.generated_by_model),
        generationConfigHash: String(row.generation_config_hash),
        staleReason:
            row.stale_reason == null ? null : (String(row.stale_reason) as KeyFileStaleReason),
    };
}

export function readCurrentKeyFiles(db: Database, projectPath: string): ProjectKeyFileRow[] {
    const resolvedProjectPath = resolveProjectPath(projectPath) ?? projectPath;
    const rows = db
        .prepare(
            `SELECT project_path, path, content, content_hash, local_token_estimate,
                    generated_at, generated_by_model, generation_config_hash, stale_reason
               FROM project_key_files
              WHERE project_path = ?
              ORDER BY generated_at DESC, path ASC`,
        )
        .all(resolvedProjectPath) as Record<string, unknown>[];
    return rows.map(rowToProjectKeyFile);
}

export function getKeyFilesVersion(db: Database, projectPath: string): number {
    const resolvedProjectPath = resolveProjectPath(projectPath) ?? projectPath;
    const row = db
        .prepare("SELECT version FROM project_key_files_version WHERE project_path = ?")
        .get(resolvedProjectPath) as { version?: number } | undefined;
    return Number(row?.version ?? 0);
}

export function bumpKeyFilesVersion(db: Database, projectPath: string): number {
    const resolvedProjectPath = resolveProjectPath(projectPath) ?? projectPath;
    db.prepare(
        `INSERT INTO project_key_files_version (project_path, version)
         VALUES (?, 1)
         ON CONFLICT(project_path) DO UPDATE SET version = version + 1`,
    ).run(resolvedProjectPath);
    return getKeyFilesVersion(db, resolvedProjectPath);
}

export function resolveCommitFiles(
    projectPath: string,
    files: CommitKeyFile[],
): ResolvedCommitKeyFile[] {
    return files.map((file) => {
        try {
            const disk = readFileSync(join(projectPath, file.path));
            return {
                ...file,
                contentHash: sha256(disk),
                staleReason: null,
            };
        } catch {
            return {
                ...file,
                contentHash: MISSING_CONTENT_HASH,
                staleReason: "missing",
            };
        }
    });
}

export function replaceProjectKeyFiles(
    db: Database,
    projectPath: string,
    files: ReplacementKeyFile[],
    generatedAt = Date.now(),
): number {
    const resolvedProjectPath = resolveProjectPath(projectPath) ?? projectPath;
    const resolved = resolveCommitFiles(
        resolvedProjectPath,
        files.map((file) => ({
            path: file.path,
            content: file.content,
            localTokenEstimate: file.localTokenEstimate,
        })),
    );
    const generatedByModel = files[0]?.generatedByModel ?? null;
    const configHash = files[0]?.generationConfigHash ?? sha256("{}");

    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        db.prepare("DELETE FROM project_key_files WHERE project_path = ?").run(resolvedProjectPath);
        insertResolvedKeyFiles(
            db,
            resolvedProjectPath,
            resolved,
            generatedAt,
            generatedByModel,
            configHash,
        );
        const version = bumpKeyFilesVersion(db, resolvedProjectPath);
        db.exec("COMMIT");
        committed = true;
        return version;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // no active transaction
            }
        }
    }
}

export function insertResolvedKeyFiles(
    db: Database,
    projectPath: string,
    files: ResolvedCommitKeyFile[],
    generatedAt: number,
    generatedByModel: string | null,
    generationConfigHash: string,
): void {
    const insert = db.prepare(
        `INSERT INTO project_key_files
           (project_path, path, content, content_hash, local_token_estimate,
            generated_at, generated_by_model, generation_config_hash, stale_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const file of files) {
        insert.run(
            projectPath,
            file.path,
            file.content,
            file.contentHash,
            file.localTokenEstimate,
            generatedAt,
            generatedByModel,
            generationConfigHash,
            file.staleReason,
        );
    }
}

export function deleteOrphanProjectKeyFiles(db: Database, now = Date.now()): number {
    const cutoff = now - ORPHAN_GRACE_MS;
    const rows = db
        .prepare(
            `SELECT project_path AS projectPath, MAX(generated_at) AS lastGen
               FROM project_key_files
              GROUP BY project_path
             HAVING lastGen < ?`,
        )
        .all(cutoff) as Array<{ projectPath: string; lastGen: number }>;

    let deletedProjects = 0;
    for (const row of rows) {
        if (existsSync(row.projectPath)) continue;
        try {
            db.prepare("DELETE FROM project_key_files WHERE project_path = ?").run(row.projectPath);
            db.prepare("DELETE FROM project_key_files_version WHERE project_path = ?").run(
                row.projectPath,
            );
            deletedProjects++;
        } catch (error) {
            log(`[key-files] orphan GC failed for ${row.projectPath}:`, error);
        }
    }
    return deletedProjects;
}

export function isRelativeProjectFile(projectPath: string, relativePath: string): boolean {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) return false;
    try {
        const root = realpathSync(projectPath);
        const absPath = resolve(projectPath, relativePath);
        const real = realpathSync(absPath);
        return real.startsWith(root + sep) || real === root;
    } catch {
        return false;
    }
}

export { MISSING_CONTENT_HASH };
