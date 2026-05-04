/**
 * Read git commit history from a working directory using `git log`.
 *
 * Wraps a single `git log` invocation with controlled flags and parses the
 * delimited output. Runs synchronously with a timeout guard — indexing
 * happens on a plugin timer, not on the hot transform path, so blocking for
 * a few hundred milliseconds once per refresh is acceptable.
 *
 * Parsing contract:
 *   - We request `--format=%H%x1f%s%x1f%ae%x1f%ct%x1f%b%x1e`:
 *       %H = full 40-char SHA
 *       %s = subject (one line)
 *       %ae = author email
 *       %ct = committer time (seconds since epoch)
 *       %b = body (multi-line)
 *     Fields are separated by US (0x1f, ASCII Unit Separator), records by RS
 *     (0x1e, ASCII Record Separator). We deliberately AVOID NUL (0x00) here:
 *     Node's `child_process.execFile` validation rejects argv elements that
 *     contain embedded NUL bytes ("must be a string without null bytes"),
 *     even when the underlying program (git) would happily accept them via
 *     other entry points. Bun's execFile is more permissive, which masked
 *     this in unit tests until live OpenCode runtime exposed it. US/RS
 *     never appear naturally in commit subjects, emails, or bodies.
 *   - Subject + trimmed body combine into the searchable message.
 *   - We skip merge commits via `--no-merges` so merge "Merge branch 'x'"
 *     noise doesn't fill the index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../../../shared/logger";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** Hard cap on commits returned per invocation. Indexer loops with since-filter
 *  if it needs more history. */
const DEFAULT_MAX_COMMITS = 5000;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

export interface GitCommit {
    /** Full 40-char SHA. */
    sha: string;
    /** First 7 chars of SHA for display. */
    shortSha: string;
    /** Subject + body, joined with a blank line when body exists. */
    message: string;
    /** Author email, or null when unavailable. */
    author: string | null;
    /** Committer time in milliseconds since epoch. */
    committedAtMs: number;
}

export interface ReadGitCommitsOptions {
    /** Only include commits newer than this (milliseconds since epoch). */
    sinceMs?: number;
    /** Only include commits reachable from HEAD (the default). */
    branch?: string;
    /** Hard cap on returned commits. Default 5000. */
    maxCommits?: number;
}

/**
 * Read commits reachable from HEAD (or `branch` when provided) up to
 * `maxCommits`, optionally filtered by `sinceMs`. Returns an empty array
 * when git is unavailable or the directory is not a repo. Does NOT throw
 * on non-zero git exit — logs and returns empty so indexing failures
 * never crash the plugin.
 */
export async function readGitCommits(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<GitCommit[]> {
    const args = [
        "log",
        options.branch ?? "HEAD",
        "--no-merges",
        `--max-count=${options.maxCommits ?? DEFAULT_MAX_COMMITS}`,
        `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    ];
    if (options.sinceMs !== undefined && options.sinceMs > 0) {
        // git accepts ISO 8601 to --since
        const iso = new Date(options.sinceMs).toISOString();
        args.push(`--since=${iso}`);
    }

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            cwd: directory,
            timeout: GIT_TIMEOUT_MS,
            // Default buffer is 1MB; bump to 32MB for large repos. Commits are
            // small but history can be long.
            maxBuffer: 32 * 1024 * 1024,
            encoding: "utf8",
        });
        stdout = result.stdout;
    } catch (error) {
        // Intentional: git may not be installed, directory may not be a repo,
        // or the invocation may time out. All are "skip indexing this cycle"
        // conditions, not crashes. We return empty and the next sweep will
        // retry. We DO log the reason though — a silent empty-result masked a
        // real cwd / PATH / timeout bug during the v0.14 git-commits rollout.
        const message = error instanceof Error ? error.message : String(error);
        log(`[git-commits] readGitCommits failed at cwd=${directory}: ${message.slice(0, 500)}`);
        return [];
    }

    if (stdout.trim().length === 0) {
        log(
            `[git-commits] readGitCommits returned empty stdout at cwd=${directory} (sinceMs=${options.sinceMs ?? "none"} args=${args.slice(0, 4).join(" ")})`,
        );
    }

    return parseGitLogOutput(stdout);
}

export function parseGitLogOutput(stdout: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const records = stdout.split(RECORD_SEPARATOR);

    for (const rawRecord of records) {
        const record = rawRecord.replace(/^\s+/, "");
        if (!record) continue;

        // Split only on the first 4 FIELD_SEPARATOR occurrences so an embedded
        // \x1f inside the commit body doesn't truncate the body at the first
        // such byte. JavaScript's split(sep, limit) caps the output array
        // rather than capping the split count, so we split manually.
        const fields: string[] = [];
        let remaining = record;
        for (let i = 0; i < 4; i++) {
            const idx = remaining.indexOf(FIELD_SEPARATOR);
            if (idx < 0) break;
            fields.push(remaining.slice(0, idx));
            remaining = remaining.slice(idx + FIELD_SEPARATOR.length);
        }
        fields.push(remaining); // the body (may contain further \x1f bytes)
        if (fields.length < 5) continue;

        const sha = fields[0].trim();
        const subject = fields[1].trim();
        const author = fields[2].trim();
        const timeSec = Number.parseInt(fields[3].trim(), 10);
        const body = fields[4].trim();

        if (sha.length !== 40 || !Number.isFinite(timeSec) || timeSec <= 0) {
            continue;
        }

        const message = body.length > 0 ? `${subject}\n\n${body}` : subject;

        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            message,
            author: author.length > 0 ? author : null,
            committedAtMs: timeSec * 1000,
        });
    }

    return commits;
}
