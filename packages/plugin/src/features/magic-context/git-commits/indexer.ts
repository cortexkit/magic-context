/**
 * Commit indexer — bridges `git log` output into the plugin's storage.
 *
 * Public entry points:
 *   - indexCommitsForProject() — sweep HEAD, upsert, evict to cap, embed backlog
 *   - embedUnembeddedCommits() — drain embedding backlog only (called from dream timer)
 *
 * Concurrency: both functions are guarded by a singleton in-progress flag
 * scoped to (projectPath, operation) so the dream timer can't spawn parallel
 * sweeps of the same project.
 */

import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import {
    contentSha256,
    embedItemsForProject,
    enqueueShadowEmbeddingItems,
    getProjectEmbeddingSnapshot,
} from "../memory/embedding";
import { readGitCommitsResult } from "./git-log-reader";
import {
    countEmbeddedCommits,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./storage-git-commit-embeddings";
import { enforceProjectCap, getLatestIndexedCommitSha, upsertCommits } from "./storage-git-commits";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EMBED_BATCH_SIZE = 16;
/** Max commits embedded per sweep invocation — bounds wall-clock cost. */
const EMBED_MAX_PER_SWEEP = 500;
/** Max seconds one embedding sweep can run. */
const EMBED_SWEEP_MAX_WALL_CLOCK_MS = 5 * 60 * 1000;

const indexInProgress = new Set<string>();
const embedInProgress = new Set<string>();

export interface IndexCommitsOptions {
    sinceDays: number;
    maxCommits: number;
    /** A recovered retention cap may bound reads, but must not delete stored commits. */
    skipRetention?: boolean;
    /** If true, skip the embed step after indexing. Useful when the caller
     *  plans to embed in a separate scheduled pass. Default false. */
    skipEmbed?: boolean;
}

export interface IndexCommitsResult {
    scanned: number;
    inserted: number;
    updated: number;
    evicted: number;
    embedded: number;
    /**
     * Set when `git log` failed structurally (directory is not a repo, or the
     * repo has no commits yet). The sweep uses this to park the project on a
     * long re-probe cooldown instead of retrying every tick.
     */
    nonIndexable: boolean;
}

/**
 * Sweep commits from `directory` (must be a git repo), upsert them for
 * `projectPath`, enforce max-commits cap, and optionally embed the backlog.
 *
 * Safe to call repeatedly — existing commits whose message hasn't changed
 * are skipped cheaply (SQLite WHERE clause in the UPSERT).
 */
export async function indexCommitsForProject(
    db: Database,
    projectPath: string,
    directory: string,
    options: IndexCommitsOptions,
): Promise<IndexCommitsResult> {
    const result: IndexCommitsResult = {
        scanned: 0,
        inserted: 0,
        updated: 0,
        evicted: 0,
        embedded: 0,
        nonIndexable: false,
    };
    if (projectPath.startsWith("dir:")) {
        result.nonIndexable = true;
        return result;
    }

    if (indexInProgress.has(projectPath)) {
        log(`[git-commits] index already in progress for ${projectPath}, skipping`);
        return result;
    }
    indexInProgress.add(projectPath);

    try {
        // Incremental: skip history reachable from the latest indexed commit.
        // A date cutoff (`--since` the latest indexed time) cannot do this: a
        // merged branch brings in commits dated before that time, and they
        // would never be read. since_days still bounds the window.
        const latestIndexed = getLatestIndexedCommitSha(db, projectPath);
        const sinceMs = Date.now() - options.sinceDays * MS_PER_DAY;

        const read = await readGitCommitsResult(directory, {
            sinceMs,
            maxCommits: options.maxCommits,
            projectIdentity: projectPath,
            excludeReachableFrom: latestIndexed ?? undefined,
        });
        const commits = read.commits;
        result.scanned = commits.length;

        if (read.failure === "not_a_repo" || read.failure === "no_head") {
            result.nonIndexable = true;
            return result;
        }

        if (commits.length === 0) {
            // No new commits. Still enforce the cap in case prior runs overflowed.
            if (!options.skipRetention) {
                result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);
            }
            log(
                `[git-commits] no new commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed?.slice(0, 7) ?? "none"} evicted=${result.evicted})`,
            );
            return result;
        }

        log(
            `[git-commits] read ${commits.length} commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed?.slice(0, 7) ?? "none"})`,
        );

        const upsert = upsertCommits(db, projectPath, commits);
        result.inserted = upsert.inserted;
        result.updated = upsert.updated;
        if (!options.skipRetention) {
            result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);
        }

        const snapshot = getProjectEmbeddingSnapshot(projectPath);
        if (options.skipEmbed || !snapshot?.gitCommitEnabled) {
            log(
                `[git-commits] indexed ${projectPath}: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=0 (embedding skipped: skipEmbed=${options.skipEmbed === true} gitCommitEnabled=${snapshot?.gitCommitEnabled === true})`,
            );
            return result;
        }

        result.embedded = await embedUnembeddedCommits(db, projectPath);
        log(
            `[git-commits] indexed ${projectPath}: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=${result.embedded}`,
        );
        return result;
    } finally {
        indexInProgress.delete(projectPath);
    }
}

/**
 * Embed unembedded commits for a project, draining until exhausted or hitting
 * the wall-clock / per-sweep limits. Mirrors the memory embedding sweep
 * behavior so provider switches refresh the commit index as quickly as memories.
 */
export async function embedUnembeddedCommits(db: Database, projectPath: string): Promise<number> {
    if (embedInProgress.has(projectPath)) {
        return 0;
    }
    const snapshot = getProjectEmbeddingSnapshot(projectPath);
    if (!snapshot?.gitCommitEnabled) {
        return 0;
    }

    embedInProgress.add(projectPath);
    const startedAt = Date.now();
    const deadline = startedAt + EMBED_SWEEP_MAX_WALL_CLOCK_MS;
    const signal = AbortSignal.timeout(EMBED_SWEEP_MAX_WALL_CLOCK_MS);
    let total = 0;

    try {
        while (Date.now() < deadline && total < EMBED_MAX_PER_SWEEP) {
            const rows = loadUnembeddedCommits(db, projectPath, snapshot.modelId, EMBED_BATCH_SIZE);
            if (rows.length === 0) break;

            let embeddedThisBatch = 0;
            try {
                const result = await embedItemsForProject(
                    projectPath,
                    rows.map((row) => ({
                        id: `commit:${row.sha}`,
                        text: row.message,
                        contentSha256: contentSha256(row.message),
                    })),
                    signal,
                    db,
                    projectPath,
                );
                if (!result) break;

                db.transaction(() => {
                    for (const row of rows) {
                        const embedding = result.vectors.get(`commit:${row.sha}`);
                        if (!embedding) continue;
                        saveCommitEmbedding(db, row.sha, embedding, result.modelId);
                        embeddedThisBatch += 1;
                    }
                }).immediate();
                enqueueShadowEmbeddingItems(
                    projectPath,
                    "commit",
                    rows
                        .filter((row) => result.vectors.has(`commit:${row.sha}`))
                        .map((row) => row.sha),
                );
            } catch (error) {
                log(
                    `[git-commits] embed batch failed for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
                );
                break;
            }

            if (embeddedThisBatch === 0) break;
            total += embeddedThisBatch;
            if (embeddedThisBatch < rows.length) break; // partial success = drained
        }

        if (total > 0) {
            const totalEmbedded = countEmbeddedCommits(db, projectPath, snapshot.modelId);
            log(
                `[git-commits] embedded ${total} commits for ${projectPath} (total embedded: ${totalEmbedded})`,
            );
        }
        return total;
    } finally {
        embedInProgress.delete(projectPath);
    }
}

/** Test-only: reset in-progress guards. */
export function _resetIndexerGuards(): void {
    indexInProgress.clear();
    embedInProgress.clear();
}
