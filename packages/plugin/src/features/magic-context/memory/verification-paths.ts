import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

interface VerificationPathsExecOptions {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    encoding: BufferEncoding;
    windowsHide: true;
}

type VerificationPathsExecResult = {
    stdout: string | Buffer;
    stderr: string | Buffer;
};

type VerificationPathsExecFile = (
    file: string,
    args: readonly string[],
    options: VerificationPathsExecOptions,
) => Promise<VerificationPathsExecResult>;

const defaultExecFileForVerificationPaths: VerificationPathsExecFile = async (
    file,
    args,
    options,
) =>
    (await execFileAsync(file, [...args], {
        ...options,
        windowsHide: true,
    })) as VerificationPathsExecResult;

let execFileForVerificationPaths = defaultExecFileForVerificationPaths;

export interface NormalizedVerificationFiles {
    files: string[];
    warnings: string[];
    gitRoot: string | null;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
        const result = await execFileForVerificationPaths("git", args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            encoding: "utf8",
            windowsHide: true,
        });
        return String(result.stdout);
    } catch (error) {
        if (
            (error as { killed?: boolean }).killed ||
            (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ) {
            throw new Error(
                `Git verification command git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`,
                {
                    cause: error,
                },
            );
        }
        return null;
    }
}

function toPosixPath(value: string): string {
    return value.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeRealpath(value: string): string | null {
    try {
        return realpathSync.native(value);
    } catch {
        return null;
    }
}

export async function resolveGitTopLevel(cwd: string): Promise<string | null> {
    const stdout = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = stdout?.trim();
    return root ? (safeRealpath(root) ?? path.resolve(root)) : null;
}

export async function readGitHead(cwd: string): Promise<string | null> {
    const stdout = await runGit(cwd, ["rev-parse", "HEAD"]);
    const head = stdout?.trim();
    return head && /^[0-9a-f]{40}$/i.test(head) ? head : null;
}

export async function readGitChangedFilesSince(
    cwd: string,
    revision: string,
    knownGitRoot?: string,
): Promise<Set<string> | null> {
    if (!/^[0-9a-f]{7,40}$/i.test(revision)) return null;
    const gitRoot = knownGitRoot ?? (await resolveGitTopLevel(cwd));
    if (!gitRoot) return null;
    const stdout = await runGit(gitRoot, ["diff", "--name-only", "-z", revision]);
    if (stdout === null) return null;
    return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * Map each repo file changed at/after `sinceMs` to its LATEST commit time (ms).
 * Drives the per-memory verify gate: a memory needs re-verification if any of
 * its mapped files has a change time newer than that memory's `verified_at`.
 *
 * Returns null on any git failure → caller falls back to full verification
 * (safe direction: re-check rather than skip). Output excludes the working tree;
 * a file edited but uncommitted is caught separately by `verificationFileExists`
 * (deletion) — verify reads the live file regardless, so uncommitted edits are
 * surfaced when the file is opened. The committed-history map is what lets the
 * gate cheaply SKIP unchanged memories.
 */
export async function readGitFileChangeTimesSince(
    cwd: string,
    sinceMs: number,
    knownGitRoot?: string,
): Promise<Map<string, number> | null> {
    const gitRoot = knownGitRoot ?? (await resolveGitTopLevel(cwd));
    if (!gitRoot) return null;
    const sinceSec = Math.max(0, Math.floor(sinceMs / 1000));
    // Block format: "<unix-seconds>\n<file>\n<file>\n...\n\n". %ct = committer
    // time. --name-only lists each commit's files. We walk newest→oldest (git log
    // default), keeping the FIRST (= latest) time seen per file.
    const stdout = await runGit(gitRoot, [
        "log",
        `--since=@${sinceSec}`,
        "--name-only",
        "--format=%ct",
    ]);
    if (stdout === null) return null;
    const times = new Map<string, number>();
    let currentMs = 0;
    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "") continue;
        if (/^\d+$/.test(line)) {
            currentMs = Number.parseInt(line, 10) * 1000;
            continue;
        }
        // A file path under the current commit. Keep the newest time per file.
        if (currentMs > 0 && !times.has(line)) {
            times.set(line, currentMs);
        }
    }
    return times;
}

/**
 * Every tracked file, with the files of checked-out submodules listed under their
 * superproject paths (`app/src/thing.ts`, not just the gitlink `app`). Without
 * the recursion a memory about submodule code could never be mapped (#973).
 * `--recurse-submodules` cannot be combined with `--error-unmatch`, so the
 * per-path query below stays as it was and falls back to this listing.
 */
const TRACKED_FILES_ARGS = ["ls-files", "--recurse-submodules", "-z", "--full-name"] as const;

async function gitTrackedPath(gitRoot: string, repoRelativePath: string): Promise<string | null> {
    const stdout = await runGit(gitRoot, [
        "ls-files",
        "-z",
        "--full-name",
        "--error-unmatch",
        "--",
        repoRelativePath,
    ]);
    const fallbackStdout = stdout === null ? await runGit(gitRoot, TRACKED_FILES_ARGS) : null;
    if (stdout === null && fallbackStdout === null) return null;
    const matches = (stdout ?? fallbackStdout ?? "").split("\0").filter(Boolean);
    if (matches.length === 0) return null;
    return (
        matches.find((match) => match === repoRelativePath) ??
        matches.find((match) => match.toLowerCase() === repoRelativePath.toLowerCase()) ??
        (matches.length === 1 ? matches[0] : null)
    );
}

export function verificationFileExists(baseRoot: string, filePath: string): boolean {
    if (!filePath || filePath === ".") return false;
    const root = path.resolve(baseRoot);
    const candidate = path.resolve(root, filePath);
    return isWithin(root, candidate) && existsSync(candidate);
}

/**
 * Normalize agent-supplied verification paths into repo-root-relative Git paths.
 * Non-git projects fall back to cwd-relative existing files; their gate full-runs.
 */
export async function normalizeVerificationFiles(args: {
    cwd: string;
    files: readonly string[];
}): Promise<NormalizedVerificationFiles> {
    const cwd = path.resolve(args.cwd);
    const gitRoot = await resolveGitTopLevel(cwd);
    const root = gitRoot ?? cwd;
    const rootReal = safeRealpath(root) ?? root;
    const warnings: string[] = [];
    const normalized: string[] = [];
    // An exact tracked-path hit needs no per-file pathspec query. Unusual
    // pathspecs and missing paths retain Git's existing matching/fallback rules.
    let trackedPaths: Set<string> | undefined;

    for (const raw of args.files) {
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) {
            warnings.push("Skipped blank verification path.");
            continue;
        }
        if (value === ".") {
            warnings.push('Skipped verification path "." (repo/project root is not a file).');
            continue;
        }

        const candidate = path.resolve(cwd, value);
        const candidateReal = safeRealpath(candidate);
        if (candidateReal && !isWithin(rootReal, candidateReal)) {
            warnings.push(
                `Skipped verification path "${value}" because it resolves outside the project.`,
            );
            continue;
        }
        if (!candidateReal && !isWithin(path.resolve(root), candidate)) {
            warnings.push(`Skipped verification path "${value}" because it escapes the project.`);
            continue;
        }
        if (path.resolve(root) === candidate) {
            warnings.push(
                `Skipped verification path "${value}" because it is the repo/project root.`,
            );
            continue;
        }
        if (existsSync(candidate)) {
            try {
                if (statSync(candidate).isDirectory()) {
                    warnings.push(
                        `Skipped verification path "${value}" because it is a directory.`,
                    );
                    continue;
                }
            } catch {
                warnings.push(
                    `Skipped verification path "${value}" because it could not be inspected.`,
                );
                continue;
            }
        }

        if (gitRoot) {
            const repoRelative = toPosixPath(path.relative(gitRoot, candidateReal ?? candidate));
            if (!repoRelative || repoRelative === "." || repoRelative.startsWith("../")) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not inside the git repo.`,
                );
                continue;
            }
            if (!trackedPaths) {
                let trackedOutput: string | null = null;
                try {
                    trackedOutput = await runGit(gitRoot, TRACKED_FILES_ARGS);
                } catch {
                    // The bulk inventory is optional. A slow or oversized inventory
                    // must not prevent the original per-path lookup from succeeding.
                }
                trackedPaths = new Set(trackedOutput?.split("\0").filter(Boolean) ?? []);
            }
            const tracked = trackedPaths.has(repoRelative)
                ? repoRelative
                : await gitTrackedPath(gitRoot, repoRelative);
            if (!tracked) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not a tracked git file.`,
                );
                continue;
            }
            if (candidateReal && tracked !== repoRelative) {
                const realRelative = toPosixPath(path.relative(gitRoot, candidateReal));
                if (realRelative !== tracked) {
                    warnings.push(
                        `Skipped verification path "${value}" because it is not a tracked git file.`,
                    );
                    continue;
                }
            }
            normalized.push(tracked);
        } else {
            if (!existsSync(candidate)) {
                warnings.push(`Skipped verification path "${value}" because it does not exist.`);
                continue;
            }
            const projectRelative = toPosixPath(path.relative(cwd, candidate));
            if (!projectRelative || projectRelative === "." || projectRelative.startsWith("../")) {
                warnings.push(
                    `Skipped verification path "${value}" because it is not inside the project.`,
                );
                continue;
            }
            normalized.push(projectRelative);
        }
    }

    return {
        files: Array.from(new Set(normalized)).sort(),
        warnings,
        gitRoot,
    };
}

export function __setVerificationPathsTestHooks(hooks: {
    execFile?: VerificationPathsExecFile;
}): void {
    // Keep the real filesystem shape on disk, but let tests script git output.
    // Under heavy machine load, launching git can stall while the operating
    // system assesses the binary, so the seam keeps gate tests deterministic.
    execFileForVerificationPaths = hooks.execFile ?? defaultExecFileForVerificationPaths;
}

export function __resetVerificationPathsForTests(): void {
    execFileForVerificationPaths = defaultExecFileForVerificationPaths;
}
