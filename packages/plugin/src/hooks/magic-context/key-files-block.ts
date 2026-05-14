import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { isAftAvailable } from "../../features/magic-context/key-files/aft-availability";
import {
    getKeyFilesVersion,
    type KeyFileStaleReason,
    readCurrentKeyFiles,
    resolveProjectPath,
    sha256,
} from "../../features/magic-context/key-files/project-key-files";
import type { SessionMeta } from "../../features/magic-context/types";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

export interface KeyFilesConfigForRender {
    enabled: boolean;
    tokenBudget: number;
}

interface CacheEntry {
    value: string | null;
    version: number;
}

interface StaleUpdate {
    projectPath: string;
    path: string;
    generatedAtWitness: number;
    staleReason: KeyFileStaleReason;
}

export const cachedKeyFilesBySession = new Map<string, CacheEntry>();

const staleUpdates = new Map<string, StaleUpdate>();

function staleKey(update: StaleUpdate): string {
    return `${update.projectPath}\0${update.path}\0${update.generatedAtWitness}\0${update.staleReason}`;
}

export function queueStaleUpdate(
    projectPath: string,
    path: string,
    generatedAtWitness: number,
    staleReason: KeyFileStaleReason,
): void {
    const update = { projectPath, path, generatedAtWitness, staleReason };
    staleUpdates.set(staleKey(update), update);
}

export function flushStaleUpdates(db: Database): number {
    if (staleUpdates.size === 0) return 0;
    const updates = [...staleUpdates.values()];
    staleUpdates.clear();
    const stmt = db.prepare(
        `UPDATE project_key_files
            SET stale_reason = ?1
          WHERE project_path = ?2
            AND path = ?3
            AND generated_at = ?4
            AND (stale_reason IS NULL OR stale_reason != ?1)`,
    );
    let changed = 0;
    for (const update of updates) {
        try {
            changed += stmt.run(
                update.staleReason,
                update.projectPath,
                update.path,
                update.generatedAtWitness,
            ).changes;
        } catch (error) {
            log("[key-files] flushStaleUpdates failed:", error);
        }
    }
    return changed;
}

export function pendingStaleUpdateCount(): number {
    return staleUpdates.size;
}

export function clearKeyFilesCacheForSession(sessionId: string): void {
    cachedKeyFilesBySession.delete(sessionId);
}

function isUnderProject(projectPath: string, absPath: string): boolean {
    const root = realpathSync(projectPath);
    return absPath.startsWith(root + sep) || absPath === root;
}

export function buildKeyFilesBlock(
    db: Database,
    projectPath: string,
    config: KeyFilesConfigForRender = { enabled: true, tokenBudget: 10_000 },
): string | null {
    if (!config.enabled) return null;
    if (!isAftAvailable()) return null;

    const rows = readCurrentKeyFiles(db, projectPath);
    if (rows.length === 0) return null;

    for (const row of rows) {
        if (row.staleReason !== null) continue;

        let nextStale: KeyFileStaleReason | null = null;
        let observed = false;
        try {
            const absPath = join(projectPath, row.path);
            const real = realpathSync(absPath);
            if (!isUnderProject(projectPath, real)) {
                nextStale = "missing";
                observed = true;
            } else {
                const diskHash = sha256(readFileSync(real));
                if (diskHash !== row.contentHash) nextStale = "content_drift";
                observed = true;
            }
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === "ENOENT" || code === "ELOOP") {
                nextStale = "missing";
                observed = true;
            } else {
                log(
                    `[key-files] freshness check transient failure: ${row.path}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        if (observed && nextStale !== null) {
            queueStaleUpdate(row.projectPath, row.path, row.generatedAt, nextStale);
        }
    }

    const blocks: string[] = [];
    let used = 0;
    for (const row of rows) {
        if (used + row.localTokenEstimate > config.tokenBudget) break;
        blocks.push(
            `  <key-file path="${escapeXmlAttr(row.path)}">\n${escapeXmlContent(row.content)}\n  </key-file>`,
        );
        used += row.localTokenEstimate;
    }
    if (blocks.length === 0) return null;
    const rendered = `<key-files>\n${blocks.join("\n")}\n</key-files>`;
    flushStaleUpdates(db);
    return rendered;
}

export function readVersionedKeyFiles(args: {
    db: Database;
    sessionId: string | undefined;
    sessionMeta: SessionMeta;
    directory?: string;
    isCacheBusting: boolean;
    config?: KeyFilesConfigForRender;
}): string | null {
    const config = args.config ?? { enabled: true, tokenBudget: 10_000 };
    if (args.sessionMeta.isSubagent) return null;
    if (!config.enabled) return null;
    if (!isAftAvailable()) return null;

    const projectPath = resolveProjectPath(args.directory ?? args.sessionMeta.sessionId);
    if (!projectPath) return null;

    const currentVersion = getKeyFilesVersion(args.db, projectPath);
    if (args.sessionId) {
        const cached = cachedKeyFilesBySession.get(args.sessionId);
        if (cached && !args.isCacheBusting && cached.version === currentVersion) {
            return cached.value;
        }
    }

    const value = buildKeyFilesBlock(args.db, projectPath, config);
    if (args.sessionId) {
        cachedKeyFilesBySession.set(args.sessionId, { value, version: currentVersion });
        if (value)
            sessionLog(
                args.sessionId,
                `loaded key-files block (v${currentVersion}, ${value.length} chars)`,
            );
    }
    return value;
}
