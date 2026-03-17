/**
 * Resolve a stable project identity from the working directory.
 *
 * Strategy:
 *   1. Git repo with commits → root commit hash (same across worktrees, clones, forks)
 *   2. Git repo with no commits → fallback to directory basename
 *   3. No git repo → fallback to directory basename
 *
 * The root commit hash is immutable and survives remote renames, host
 * migrations, and SSH/HTTPS URL changes. It is the same across all
 * worktrees and clones of the same repository.
 */

import { execSync } from "node:child_process";
import path from "node:path";

const GIT_TIMEOUT_MS = 5_000;
const resolvedCache = new Map<string, string>();

function getRootCommitHash(directory: string): string | undefined {
    try {
        const hash = execSync("git rev-list --max-parents=0 HEAD", {
            cwd: directory,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: GIT_TIMEOUT_MS,
        }).trim();

        // Multiple root commits possible (orphan branches); take the first
        const firstLine = hash.split("\n")[0]?.trim();
        return firstLine && firstLine.length >= 7 ? firstLine : undefined;
    } catch {
        return undefined;
    }
}

function directoryFallback(directory: string): string {
    return `dir:${path.basename(path.resolve(directory))}`;
}

/**
 * Resolve the project identity for the given directory.
 *
 * Returns a stable string suitable for use as a database key:
 *   - `"git:<sha>"` for git repositories with at least one commit
 *   - `"dir:<basename>"` for non-git directories or empty repos
 *
 * Results are cached per directory path for the lifetime of the process.
 */
export function resolveProjectIdentity(directory: string): string {
    const resolved = path.resolve(directory);
    const cached = resolvedCache.get(resolved);
    if (cached !== undefined) {
        return cached;
    }

    const rootHash = getRootCommitHash(resolved);
    const identity = rootHash ? `git:${rootHash}` : directoryFallback(resolved);

    resolvedCache.set(resolved, identity);
    return identity;
}
