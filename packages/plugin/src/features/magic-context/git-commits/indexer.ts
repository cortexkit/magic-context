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

import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { embedBatch, getEmbeddingModelId, isEmbeddingEnabled } from "../memory/embedding";
import { readGitCommits } from "./git-log-reader";
import {
    countEmbeddedCommits,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./storage-git-commit-embeddings";
import {
    enforceProjectCap,
    getLatestIndexedCommitTimeMs,
    upsertCommits,
} from "./storage-git-commits";

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
    embeddingConfig: EmbeddingConfig,
    options: IndexCommitsOptions,
): Promise<IndexCommitsResult> {
    const result: IndexCommitsResult = {
        scanned: 0,
        inserted: 0,
        updated: 0,
        evicted: 0,
        embedded: 0,
    };

    if (indexInProgress.has(projectPath)) {
        log(`[git-commits] index already in progress for ${projectPath}, skipping`);
        return result;
    }
    indexInProgress.add(projectPath);

    try {
        // Incremental: if we've seen commits before, only fetch anything newer
        // than the latest indexed commit. Otherwise use since_days cutoff.
        const latestIndexed = getLatestIndexedCommitTimeMs(db, projectPath);
        const sinceMs =
            latestIndexed !== null
                ? // subtract 1 minute for clock skew across systems
                  Math.max(latestIndexed - 60_000, Date.now() - options.sinceDays * MS_PER_DAY)
                : Date.now() - options.sinceDays * MS_PER_DAY;

        const commits = await readGitCommits(directory, {
            sinceMs,
            maxCommits: options.maxCommits,
        });
        result.scanned = commits.length;

        if (commits.length === 0) {
            // No new commits. Still enforce the cap in case prior runs overflowed.
            result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);
            log(
                `[git-commits] no new commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed ?? "none"} evicted=${result.evicted})`,
            );
            return result;
        }

        log(
            `[git-commits] read ${commits.length} commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed ?? "none"})`,
        );

        const upsert = upsertCommits(db, projectPath, commits);
        result.inserted = upsert.inserted;
        result.updated = upsert.updated;
        result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);

        if (options.skipEmbed || !isEmbeddingEnabled()) {
            log(
                `[git-commits] indexed ${projectPath}: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=0 (embedding skipped: skipEmbed=${options.skipEmbed === true} embeddingEnabled=${isEmbeddingEnabled()})`,
            );
            return result;
        }

        result.embedded = await embedUnembeddedCommits(db, projectPath, embeddingConfig);
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
export async function embedUnembeddedCommits(
    db: Database,
    projectPath: string,
    _config: EmbeddingConfig,
): Promise<number> {
    if (embedInProgress.has(projectPath)) {
        return 0;
    }
    if (!isEmbeddingEnabled()) {
        return 0;
    }

    embedInProgress.add(projectPath);
    const startedAt = Date.now();
    const deadline = startedAt + EMBED_SWEEP_MAX_WALL_CLOCK_MS;
    let total = 0;

    try {
        while (Date.now() < deadline && total < EMBED_MAX_PER_SWEEP) {
            const rows = loadUnembeddedCommits(db, projectPath, EMBED_BATCH_SIZE);
            if (rows.length === 0) break;

            let embeddedThisBatch = 0;
            try {
                const embeddings = await embedBatch(rows.map((row) => row.message));
                const modelId = getEmbeddingModelId();
                if (modelId === "off") break;

                db.transaction(() => {
                    for (const [index, row] of rows.entries()) {
                        const embedding = embeddings[index];
                        if (!embedding) continue;
                        saveCommitEmbedding(db, row.sha, embedding, modelId);
                        embeddedThisBatch += 1;
                    }
                })();
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
            const totalEmbedded = countEmbeddedCommits(db, projectPath);
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
