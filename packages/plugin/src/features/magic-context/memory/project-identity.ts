/**
 * Resolve a stable project identity from the working directory.
 *
 * Strategy:
 *   1. Exact-directory registered project pin → pinned pj- identity without probing git
 *   2. Linked worktree with a registered checkout pin → borrow that pj- identity
 *      Otherwise, Git repo with commits → root commit hash (same across clones and forks)
 *   3. Git repo with an unborn HEAD → directory hash until the first commit
 *   4. Transient git failure → reuse durable identity or defer
 *   5. No git repo → fallback to directory hash via resolveProjectIdentity()
 *
 * The root commit hash is immutable and survives remote renames, host
 * migrations, and SSH/HTTPS URL changes. It is the same across all
 * worktrees and clones of the same repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "../../../shared/logger";
import {
    invalidateGitCheckoutMetadata,
    readCachedGitCheckoutMetadata,
    readGitCheckoutMetadata,
} from "./git-common-dir";
import {
    __resetProjectIdentitySidecarCachesForTests,
    isPinnedProjectIdentity,
    projectDirectoryKey,
    projectIdentityPinGeneration,
    readBorrowedProjectIdentity,
    readRememberedGitIdentity,
    readRememberedProjectIdentity,
    rememberGitIdentity,
    rememberPinnedProjectIdentity,
    removeStaleWorktreeIdentity,
} from "./project-identity-cache";
import { isUnbornHeadOnDisk } from "./unborn-head";

// execFileSync is intentional here (audit #19): this runs once per unique directory per process
// lifetime when git is healthy, and successful git identities are cached in identityCache. The
// ~10-50ms block on first call is acceptable vs threading async through all callers of
// resolveProjectIdentity. Transient git failures are cooled down below so a slow/broken git probe
// cannot stall every transform pass.
const GIT_TIMEOUT_MS = 5_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const identityCache = new Map<string, string>();
const linkedGitWorktreeCache = new Map<string, boolean>();
const linkedIdentityDirectories = new Set<string>();
const lastKnownGitIdentityCache = new Map<string, string>();
// Cached `dir:` fallbacks for directories that have NO `.git` entry in their
// ancestor chain. We only cache the no-`.git` case: once a `.git` appears we
// must re-resolve every call so the identity flips to the stable `git:<root>`
// the moment git becomes available (otherwise project memories/state split
// across the first-commit boundary). Real git repos never reach this cache —
// they hit `identityCache` or the transient cooldown.
const directoryFallbackCache = new Map<string, string>();
// Cool down git-backed directories whose git probe failed transiently. During
// the window we reuse the last successful `git:` identity when this process has
// one; cold-start failures consult durable storage or defer memory features.
// After the cooldown expires, the next call re-probes so the cache refreshes
// when the user fixes git or the slow disk recovers.
const transientFailureCooldown = new Map<string, number>();
const dubiousOwnershipFallbackDirectories = new Set<string>();
const dubiousOwnershipLoggedDirectories = new Set<string>();
const dubiousOwnershipWarnedDirectories = new Set<string>();
const transientGitIdentityReuseLoggedDirectories = new Set<string>();
interface SessionIdentityCacheEntry {
    identity: string | undefined;
    revalidateAt: number | null;
    pinGeneration: number;
}
const sessionIdentityCache = new Map<string, SessionIdentityCacheEntry>();
// Boot policy applies to identity lookups made outside the session path (historian, RPC, tools).
let homeProjectPermission = false;
let homeProjectSkipLogged = false;
const pausedIdentityReasons = new Map<string, string>();
const pausedIdentityLogged = new Set<string>();

export function setHomeProjectPermission(allowed: boolean): void {
    homeProjectPermission = allowed;
}

/** Skip memory work on a disallowed home project without generating repeated failures. */
export function shouldSkipHomeProjectMemory(directory: string): boolean {
    try {
        assertProjectAllowed(directory, homeProjectPermission);
        return false;
    } catch (error) {
        if (
            !(error instanceof ProjectIdentityError) ||
            error.errorClass !== "home_project_disabled"
        )
            throw error;
        if (!homeProjectSkipLogged) {
            homeProjectSkipLogged = true;
            log("[magic-context] home project memory disabled; skipping memory features");
        }
        return true;
    }
}
let execFileSyncForIdentity: typeof execFileSync = execFileSync;
let gitTimeoutMs = GIT_TIMEOUT_MS;
let userHomeDirectoryForIdentity = (): string => homedir();
let nowMs = (): number => Date.now();
let filesystemProbeObserverForTests: (() => void) | undefined;

/** Git failures retain their classification; confirmed unborn repositories may use directory-based identity keys. */
export type ProjectIdentityErrorClass =
    | "home_project_disabled"
    | "git_identity_unavailable"
    | "not_git_repo"
    | "no_commits"
    | "git_missing"
    | "git_timeout"
    | "dubious_ownership"
    | "permission_denied"
    | "unknown";

/**
 * Strict project identity resolution error with stable machine-readable classification.
 */
export class ProjectIdentityError extends Error {
    readonly errorClass: ProjectIdentityErrorClass;
    readonly rawDirectory: string;

    constructor(
        errorClass: ProjectIdentityErrorClass,
        rawDirectory: string,
        message: string,
        cause?: Error,
    ) {
        super(message);
        this.name = "ProjectIdentityError";
        this.errorClass = errorClass;
        this.rawDirectory = rawDirectory;
        if (cause) {
            this.cause = cause;
        }
    }
}

function asError(error: unknown): Error | undefined {
    return error instanceof Error ? error : undefined;
}

function getErrorCode(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function getErrorSignal(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("signal" in error)) {
        return undefined;
    }
    const signal = (error as { signal?: unknown }).signal;
    return typeof signal === "string" ? signal : undefined;
}

function getErrorKilled(error: unknown): boolean {
    if (error === null || typeof error !== "object" || !("killed" in error)) {
        return false;
    }
    return (error as { killed?: unknown }).killed === true;
}

function getErrorStderr(error: unknown): string {
    if (error === null || typeof error !== "object" || !("stderr" in error)) {
        return "";
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
        return stderr;
    }
    if (Buffer.isBuffer(stderr)) {
        return stderr.toString("utf8");
    }
    return "";
}

function directoryFallback(directory: string): string {
    // Use a hash of the full canonical path to avoid collisions between
    // directories with the same basename (e.g. /tmp/api vs /work/api).
    // Switched from Bun.hash to MD5 prefix when the storage layer moved off
    // bun:sqlite — see commit d03e148. This is a one-time prefix change for
    // non-git project memories: existing `dir:<wyhash>` rows become orphaned
    // and any new memories use `dir:<md5-prefix>`. Most users are git-backed
    // (unaffected). Doctor can be extended to re-key if needed.
    const canonical = path.resolve(directory);
    const hash = createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
    return `dir:${hash}`;
}

/**
 * Identity for a directory that has no git metadata (or no longer exists).
 *
 * A directory this plugin once resolved to `git:<root>` keeps that identity after its
 * git metadata disappears, as happens when a linked worktree is removed but its folder
 * is left behind. Computing a fresh `dir:` hash there would start a new, empty project
 * pool and split the repository's memory. Only the sidecar for this exact path counts:
 * borrowing an ancestor's sidecar could pull an unrelated folder under a home-directory
 * repository into that repository's pool.
 */
function rememberedIdentityOrDirectoryFallback(canonical: string): string {
    return readRememberedGitIdentity(canonical) ?? directoryFallback(canonical);
}

function assertDirectoryUsable(canonicalDirectory: string, rawDirectory: string): void {
    try {
        const stat = statSync(canonicalDirectory);
        if (!stat.isDirectory()) {
            throw new ProjectIdentityError(
                "unknown",
                rawDirectory,
                `Project path is not a directory: ${canonicalDirectory}`,
            );
        }
    } catch (error) {
        if (error instanceof ProjectIdentityError) {
            throw error;
        }

        const code = getErrorCode(error);
        if (code === "EACCES" || code === "EPERM") {
            throw new ProjectIdentityError(
                "permission_denied",
                rawDirectory,
                `Permission denied while accessing project directory: ${canonicalDirectory}`,
                asError(error),
            );
        }

        throw new ProjectIdentityError(
            "unknown",
            rawDirectory,
            `Unable to access project directory: ${canonicalDirectory}`,
            asError(error),
        );
    }
}

function isGitTimeoutError(error: unknown): boolean {
    const code = getErrorCode(error);
    const signal = getErrorSignal(error);
    return (
        code === "ETIMEDOUT" ||
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        getErrorKilled(error)
    );
}

function hasUnbornHead(directory: string): boolean {
    const options = {
        cwd: directory,
        encoding: "utf8" as const,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        timeout: gitTimeoutMs,
        windowsHide: true,
    };
    try {
        execFileSyncForIdentity("git", ["rev-parse", "--git-dir"], options);
        // --quiet distinguishes a missing HEAD (exit 1, no stderr) from access/runtime failures.
        try {
            execFileSyncForIdentity("git", ["rev-parse", "--verify", "--quiet", "HEAD"], options);
            return false;
        } catch (error) {
            return (
                !isGitTimeoutError(error) &&
                typeof error === "object" &&
                error !== null &&
                "status" in error &&
                error.status === 1 &&
                getErrorStderr(error) === ""
            );
        }
    } catch {
        return false;
    }
}

function classifyGitError(error: unknown, rawDirectory: string): ProjectIdentityError {
    if (isGitTimeoutError(error)) {
        return new ProjectIdentityError(
            "git_timeout",
            rawDirectory,
            `git rev-list timed out after ${gitTimeoutMs}ms`,
            asError(error),
        );
    }

    const code = getErrorCode(error);
    if (code === "ENOENT") {
        return new ProjectIdentityError(
            "git_missing",
            rawDirectory,
            "git binary is not available in PATH",
            asError(error),
        );
    }
    if (code === "EACCES" || code === "EPERM") {
        return new ProjectIdentityError(
            "permission_denied",
            rawDirectory,
            "Permission denied while spawning git",
            asError(error),
        );
    }

    const stderr = getErrorStderr(error).toLowerCase();
    if (stderr.includes("detected dubious ownership")) {
        return new ProjectIdentityError(
            "dubious_ownership",
            rawDirectory,
            "git refused to read the repository because it detected dubious ownership",
            asError(error),
        );
    }
    if (
        stderr.includes("not a git repository") ||
        stderr.includes("does not have any commits yet") ||
        stderr.includes("ambiguous argument 'head'") ||
        stderr.includes("unknown revision or path")
    ) {
        return new ProjectIdentityError(
            "not_git_repo",
            rawDirectory,
            "Directory has no git root commit; caller may use directory fallback",
            asError(error),
        );
    }

    return new ProjectIdentityError(
        "unknown",
        rawDirectory,
        "git rev-list failed while resolving project identity",
        asError(error),
    );
}

/**
 * Strictly resolve the project identity for a filesystem directory.
 *
 * Returns an exact-directory or inherited worktree `pj-` pin, or `git:<root-commit-sha>`.
 * Failures are thrown as `ProjectIdentityError` with a stable `errorClass` so callers can
 * distinguish deterministic non-git directories from transient git/runtime failures.
 *
 * The cache is process-local, keyed by `path.resolve(directory)`, and stores only successful git
 * identities. Transient failures are never cached.
 * Exact-directory `pj-` pins retain precedence. For an unpinned directory, set `cache: false`
 * to bypass the git-identity cache and return a fresh result without updating caches or
 * durable identity records (including stale-sidecar cleanup).
 */
export function resolveProjectIdentityStrict(
    directory: string,
    allowHomeProject = homeProjectPermission,
    options: { cache?: boolean } = {},
): string {
    assertProjectAllowed(directory, allowHomeProject);
    const canonical = path.resolve(directory);
    const pinned = pinForUsableDirectory(canonical, directory, options.cache !== false);
    if (pinned !== undefined) return pinned;
    const cached = options.cache === false ? undefined : identityCache.get(canonical);
    if (cached !== undefined) {
        return cached;
    }

    assertDirectoryUsable(canonical, directory);

    if (!hasGitDir(canonical)) {
        throw new ProjectIdentityError(
            "not_git_repo",
            directory,
            "Directory has no git metadata; caller may use directory fallback",
        );
    }

    // A repository with no commits yet is recognized from its files before any git process
    // starts. Asking git first made the answer depend on git returning within the timeout:
    // on Windows the call ran into the timeout right after `git init`, and a timeout pauses
    // memory features instead of using the directory identity. Unusual layouts still go to git.
    if (isUnbornHeadOnDisk(canonical)) {
        throw new ProjectIdentityError(
            "no_commits",
            directory,
            "Git repository has no commits yet",
        );
    }

    let output: string;
    try {
        output = execFileSyncForIdentity("git", ["rev-list", "--max-parents=0", "HEAD"], {
            cwd: canonical,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: gitTimeoutMs,
            windowsHide: true,
        }) as string;
    } catch (error) {
        const classified = classifyGitError(error, directory);
        if (classified.errorClass === "not_git_repo" && hasUnbornHead(canonical)) {
            throw new ProjectIdentityError(
                "no_commits",
                directory,
                "Git repository has no commits yet",
            );
        }
        throw classified;
    }

    // Repos with grafted histories (merged with --allow-unrelated-histories) have
    // MULTIPLE root commits, and git's enumeration order varies by traversal. Taking
    // whichever line comes first samples nondeterministically from that set, flapping
    // the project identity between sessions and splitting the memory pool. Pin the
    // derivation to the lexicographic minimum so it is a pure function of the set.
    const rootCommit = output
        .split("\n")
        .map((line) => line.trim().slice(0, 64))
        .filter((line) => /^[0-9a-f]{7,64}$/.test(line))
        .sort()[0];
    if (!rootCommit) {
        throw new ProjectIdentityError(
            "unknown",
            directory,
            "git rev-list returned no valid root commit hash",
        );
    }

    const identity = `git:${rootCommit}`;
    if (options.cache === false) return identity;
    identityCache.set(canonical, identity);
    lastKnownGitIdentityCache.set(canonical, identity);
    rememberGitIdentity(canonical, identity);
    const root = gitRootDirectory(canonical);
    if (root && root !== canonical) rememberGitIdentity(root, identity);
    transientFailureCooldown.delete(canonical);
    dubiousOwnershipFallbackDirectories.delete(canonical);
    transientGitIdentityReuseLoggedDirectories.delete(canonical);
    return identity;
}

/** Directory fallback is allowed for non-repositories and confirmed unborn repositories. */
function shouldUseDirectoryFallback(error: ProjectIdentityError): boolean {
    return error.errorClass !== "home_project_disabled";
}

function getActiveCooldown(canonical: string): number | undefined {
    const until = transientFailureCooldown.get(canonical);
    if (until === undefined) return undefined;
    if (nowMs() < until) return until;
    transientFailureCooldown.delete(canonical);
    return undefined;
}

function lastKnownGitIdentity(canonical: string): string | undefined {
    return (
        lastKnownGitIdentityCache.get(canonical) ??
        identityCache.get(canonical) ??
        readRememberedGitIdentity(canonical)
    );
}

function nearestLastKnownGitIdentity(
    canonical: string,
): { identity: string; source: string } | undefined {
    const visited = new Set<string>();
    const walk = (start: string): { identity: string; source: string } | undefined => {
        let current = start;
        while (!visited.has(current)) {
            visited.add(current);
            const cached = lastKnownGitIdentity(current);
            if (cached !== undefined) return { identity: cached, source: current };
            // Never borrow an outer repository's identity for a nested repository.
            if (existsSync(path.join(current, ".git"))) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return undefined;
    };

    const exactOrAncestor = walk(canonical);
    if (exactOrAncestor) return exactOrAncestor;

    try {
        const realCanonical = realpathSync.native(canonical);
        if (realCanonical !== canonical) return walk(realCanonical);
    } catch {
        // If realpath fails, the path-based ancestor walk above is the only safe cache lookup.
    }
    return undefined;
}

function reuseLastKnownGitIdentity(canonical: string): string | undefined {
    const cached = nearestLastKnownGitIdentity(canonical);
    if (cached === undefined) return undefined;
    if (!transientGitIdentityReuseLoggedDirectories.has(canonical)) {
        transientGitIdentityReuseLoggedDirectories.add(canonical);
        const sourceNote = cached.source === canonical ? "" : ` from ancestor ${cached.source}`;
        log(
            `[magic-context] git identity resolution is temporarily unavailable for ${canonical}; reusing the last successful project identity${sourceNote} to avoid splitting project-scoped memory`,
        );
    }
    return cached.identity;
}

function formatDubiousOwnershipWarning(canonical: string): string {
    return `Magic Context: git refused to read ${canonical} (dubious ownership — the repo is owned by a different user). Memory features are paused unless a previous git identity is available. Fix: git config --global --add safe.directory ${canonical}`;
}

function recordDubiousOwnershipFallback(canonical: string): void {
    dubiousOwnershipFallbackDirectories.add(canonical);
    if (dubiousOwnershipLoggedDirectories.has(canonical)) return;
    dubiousOwnershipLoggedDirectories.add(canonical);
    log(`[magic-context] ${formatDubiousOwnershipWarning(canonical)}`);
}

export function takeDubiousOwnershipProjectIdentityWarning(directory: string): string | null {
    const canonical = path.resolve(directory);
    if (!dubiousOwnershipFallbackDirectories.has(canonical)) return null;
    if (dubiousOwnershipWarnedDirectories.has(canonical)) return null;
    dubiousOwnershipWarnedDirectories.add(canonical);
    return formatDubiousOwnershipWarning(canonical);
}

/**
 * Compare filesystem-canonical paths so a symlink spelling of $HOME cannot
 * accidentally create a second directory identity. The session resolver also
 * checks descendants whose nearest git root is the home directory.
 */
function canonicalUserHomeDirectory(): string {
    const homeDirectory = userHomeDirectoryForIdentity();
    try {
        return realpathSync.native(homeDirectory);
    } catch {
        // Sandboxed OpenCode processes may know $HOME but be denied access to its
        // metadata. Returning the original path lets later checks still recognize
        // projects under the user's home directory without aborting plugin startup.
        return homeDirectory;
    }
}

export function isUserHomeDirectory(directory: string): boolean {
    if (projectDirectoryKey(directory) === projectDirectoryKey(userHomeDirectoryForIdentity()))
        return true;
    try {
        return (
            projectDirectoryKey(realpathSync.native(path.resolve(directory))) ===
            projectDirectoryKey(canonicalUserHomeDirectory())
        );
    } catch {
        return false;
    }
}

function assertProjectAllowed(directory: string, allowHomeProject: boolean): void {
    const canonical = path.resolve(directory);
    if (
        !allowHomeProject &&
        (isUserHomeDirectory(directory) ||
            isUserHomeDirectory(gitRootDirectory(canonical) ?? canonical))
    ) {
        throw new ProjectIdentityError(
            "home_project_disabled",
            directory,
            "Home project memory is disabled; set allow_home_project to opt in",
        );
    }
}

function pinForUsableDirectory(
    canonical: string,
    directory: string,
    cleanup = true,
): string | undefined {
    try {
        assertDirectoryUsable(canonical, directory);
        accessSync(canonical, constants.R_OK | constants.X_OK);
    } catch {
        // Missing or inaccessible directories keep the legacy Git/path fallback;
        // a remembered pin must not bypass the directory usability check.
        return undefined;
    }
    const pinned = readRememberedProjectIdentity(canonical)?.identity;
    return isPinnedProjectIdentity(pinned)
        ? pinned
        : readCachedGitCheckoutMetadata(canonical)?.linkedWorktree
          ? borrowedProjectIdentity(canonical, cleanup)
          : undefined;
}

export function borrowedProjectIdentity(directory: string, cleanup = true): string | undefined {
    const metadata = readCachedGitCheckoutMetadata(directory);
    const pin = metadata?.gitCommonDir
        ? readBorrowedProjectIdentity(directory, metadata.gitCommonDir, metadata.linkedWorktree)
        : undefined;
    if (cleanup && pin && metadata?.linkedWorktree) {
        removeStaleWorktreeIdentity(directory);
        if (metadata.checkoutRoot !== directory) removeStaleWorktreeIdentity(metadata.checkoutRoot);
    }
    return pin;
}

export interface LiveProjectIdentityAnswer {
    projectId: string;
    via: string;
    canonicalRoot: string | null;
}

/** Call only for a live answer received before the session's resolution deadline, never for a cache match. */
export function rememberResolvedProjectIdentity(
    directory: string,
    answer: LiveProjectIdentityAnswer,
    allowHomeProject = homeProjectPermission,
): void {
    if (
        !["root", "walk", "containment", "worktree"].includes(answer.via) ||
        !isPinnedProjectIdentity(answer.projectId)
    )
        return;
    try {
        assertProjectAllowed(directory, allowHomeProject);
        const canonical = path.resolve(directory);
        assertDirectoryUsable(canonical, directory);
        const metadata = readGitCheckoutMetadata(canonical);
        // Use fresh topology: a cached non-worktree result must not authorize a pin after a checkout changes.
        const linked =
            metadata?.gitCommonDir === undefined ? hasGitDir(canonical) : metadata.linkedWorktree;
        if (linked) return;
        rememberPinnedProjectIdentity(canonical, answer.projectId, metadata?.gitCommonDir);
        if (metadata && answer.canonicalRoot !== null) {
            // A separately registered subfolder must not claim its containing checkout.
            const answerRoot = projectDirectoryKey(realpathSync.native(answer.canonicalRoot));
            const checkoutRoot = projectDirectoryKey(realpathSync.native(metadata.checkoutRoot));
            if (answerRoot === checkoutRoot && projectDirectoryKey(canonical) !== checkoutRoot)
                rememberPinnedProjectIdentity(
                    checkoutRoot,
                    answer.projectId,
                    metadata.gitCommonDir,
                );
        }
    } catch {
        // Missing folders or unverifiable roots cannot authorize additional pins.
    }
}

export function resolveProjectIdentity(
    directory: string,
    allowHomeProject = homeProjectPermission,
): string {
    assertProjectAllowed(directory, allowHomeProject);
    const canonical = path.resolve(directory);
    const pinned = pinForUsableDirectory(canonical, directory);
    if (pinned !== undefined) return pinned;
    const cachedFallback = directoryFallbackCache.get(canonical);
    if (cachedFallback !== undefined) {
        // Serve the cached `dir:` fallback only while the directory still has no
        // `.git` in itself or any ancestor. If a repo appeared above a nested
        // session since we cached, drop it and re-resolve so the identity can
        // flip to the stable `git:<root>`.
        if (!hasGitDir(canonical)) {
            return cachedFallback;
        }
        directoryFallbackCache.delete(canonical);
    }

    if (getActiveCooldown(canonical) !== undefined) {
        if (hasGitDir(canonical)) {
            const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
            if (cachedGitIdentity !== undefined) {
                return cachedGitIdentity;
            }
            throw new ProjectIdentityError(
                "git_identity_unavailable",
                directory,
                "Git identity unavailable; memory features paused until the retry cooldown expires",
            );
        }
        return rememberedIdentityOrDirectoryFallback(canonical);
    }

    try {
        return resolveProjectIdentityStrict(directory, allowHomeProject);
    } catch (error) {
        if (error instanceof ProjectIdentityError && shouldUseDirectoryFallback(error)) {
            // Do not cache unborn fallbacks: the first commit must switch the identity to git:.
            if (error.errorClass === "no_commits") return directoryFallback(canonical);
            if (!hasGitDir(canonical)) {
                if (error.errorClass === "permission_denied") throw error;
                const resolved = rememberedIdentityOrDirectoryFallback(canonical);
                directoryFallbackCache.set(canonical, resolved);
                transientFailureCooldown.delete(canonical);
                return resolved;
            }
            transientFailureCooldown.set(canonical, nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS);
            const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
            if (error.errorClass === "dubious_ownership") recordDubiousOwnershipFallback(canonical);
            if (cachedGitIdentity !== undefined) {
                return cachedGitIdentity;
            }
            throw error;
        }
        throw error;
    }
}

export function resolveProjectIdentityOrFallback(
    directory: string,
    allowHomeProject = homeProjectPermission,
): string {
    try {
        return resolveProjectIdentity(directory, allowHomeProject);
    } catch (error) {
        const canonical = path.resolve(directory);
        if (
            hasGitDir(canonical) ||
            (error instanceof ProjectIdentityError && error.errorClass === "home_project_disabled")
        )
            throw error;
        const fallback = rememberedIdentityOrDirectoryFallback(canonical);
        const message = error instanceof Error ? error.message : String(error);
        log(
            `[magic-context] project identity resolution failed for ${canonical}; using directory fallback ${fallback}: ${message}`,
        );
        return fallback;
    }
}

/** Cheap probe: does `<dir>/.git` or any ancestor `.git` exist (a repo may have
 *  appeared since we cached a `dir:` fallback)? A plain file counts for worktrees
 *  and submodules. Any filesystem miss just means "keep walking". */
function hasGitDir(canonical: string): boolean {
    if (hasGitDirInAncestorChain(canonical)) {
        return true;
    }

    try {
        const realCanonical = realpathSync.native(canonical);
        return realCanonical !== canonical && hasGitDirInAncestorChain(realCanonical);
    } catch {
        return false;
    }
}

function gitRootInAncestorChain(startDirectory: string): string | null {
    let current = startDirectory;
    while (true) {
        if (existsSync(path.join(current, ".git"))) {
            try {
                return realpathSync.native(current);
            } catch {
                return path.resolve(current);
            }
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function hasGitDirInAncestorChain(startDirectory: string): boolean {
    return gitRootInAncestorChain(startDirectory) !== null;
}

function gitRootDirectory(canonical: string): string | null {
    const direct = gitRootInAncestorChain(canonical);
    if (direct) return direct;
    try {
        const realCanonical = realpathSync.native(canonical);
        return realCanonical === canonical ? null : gitRootInAncestorChain(realCanonical);
    } catch {
        return null;
    }
}

/** Cheap metadata probe for user-facing commit-search availability. This avoids
 * running `git log` on every ctx_search call while still distinguishing a true
 * non-repository directory from a transient `dir:` identity fallback. */
export function directoryHasGitMetadata(directory: string): boolean {
    return gitRootDirectory(path.resolve(directory)) !== null;
}

/**
 * Explain to an agent (and the user reading its tool output) why a session has no
 * project identity. The tools only see `undefined` from the resolver; without this
 * they reported "Could not resolve project identity" and agents blamed the absence
 * of a git repository, which is not a cause — non-git directories resolve to a
 * `dir:` identity. The one deliberate refusal is a session running in the home
 * directory itself.
 */
export function describeUnresolvedProjectIdentity(directory: string): string {
    const resolvedDirectory = path.resolve(directory);
    const canonicalHome = canonicalUserHomeDirectory();
    const canonicalDirectory = (() => {
        try {
            return realpathSync.native(resolvedDirectory);
        } catch {
            return resolvedDirectory;
        }
    })();
    if (isUserHomeDirectory(directory) || gitRootDirectory(canonicalDirectory) === canonicalHome) {
        return (
            `this session runs in your home directory (${canonicalHome}), which Magic Context does not treat as a project. ` +
            "Start OpenCode inside a project folder, or set `allow_home_project: true` in the user-level " +
            "magic-context.jsonc (~/.config/cortexkit/) to give home sessions their own memory."
        );
    }
    if (hasGitDir(resolvedDirectory))
        return `git identity resolution for ${resolvedDirectory} is temporarily unavailable. Memory features are paused; retry after git access recovers.`;
    return `the session directory ${resolvedDirectory} could not be read as a project.`;
}

/**
 * Whether a resolved project identity can key project-scoped state (memories,
 * embeddings, dreamer schedules, session attribution). An unresolved directory
 * has no identity; callers that coerce that to "" must refuse the empty string
 * instead of using it as one more project.
 */
export function isUsableProjectIdentity(identity: string | null | undefined): identity is string {
    return typeof identity === "string" && identity.trim().length > 0;
}

export function resolveProjectIdentityForSession(
    directory: string,
    allowHomeProject = homeProjectPermission,
): string | undefined {
    const resolvedDirectory = path.resolve(directory);
    const cacheKey = `${allowHomeProject ? "1" : "0"}\0${resolvedDirectory}`;
    const cached = sessionIdentityCache.get(cacheKey);
    // Only known worktrees revalidate a borrow; ordinary warm sessions keep their no-I/O fast path.
    if (cached && linkedIdentityDirectories.has(resolvedDirectory)) {
        try {
            assertProjectAllowed(directory, allowHomeProject);
        } catch (error) {
            if (
                error instanceof ProjectIdentityError &&
                error.errorClass === "home_project_disabled"
            )
                return undefined;
            throw error;
        }
        const pinned = pinForUsableDirectory(resolvedDirectory, directory);
        if (pinned) return pinned;
    }
    if (
        cached &&
        cached.pinGeneration === projectIdentityPinGeneration() &&
        (cached.revalidateAt === null || nowMs() < cached.revalidateAt) &&
        !(cached.identity?.startsWith("dir:") && hasGitDir(resolvedDirectory))
    ) {
        return cached.identity;
    }
    sessionIdentityCache.delete(cacheKey);
    if (cached?.identity?.startsWith("dir:") && hasGitDir(resolvedDirectory))
        invalidateGitCheckoutMetadata(resolvedDirectory);

    filesystemProbeObserverForTests?.();
    const canonicalDirectory = (() => {
        try {
            filesystemProbeObserverForTests?.();
            return realpathSync.native(resolvedDirectory);
        } catch {
            return resolvedDirectory;
        }
    })();
    filesystemProbeObserverForTests?.();
    const homeRoot = gitRootDirectory(canonicalDirectory);
    const inheritsHomeRepository = homeRoot !== null && isUserHomeDirectory(homeRoot);
    let identity: string | undefined;
    if (!allowHomeProject && (isUserHomeDirectory(directory) || inheritsHomeRepository)) {
        identity = undefined;
    } else {
        try {
            identity = resolveProjectIdentityOrFallback(
                isUserHomeDirectory(directory) ? canonicalUserHomeDirectory() : directory,
                allowHomeProject,
            );
        } catch (error) {
            if (!(error instanceof ProjectIdentityError)) throw error;
            const reason =
                error.errorClass === "git_identity_unavailable"
                    ? (pausedIdentityReasons.get(resolvedDirectory) ?? error.errorClass)
                    : error.errorClass;
            pausedIdentityReasons.set(resolvedDirectory, reason);
            const logKey = `${resolvedDirectory}\0${reason}`;
            if (!pausedIdentityLogged.has(logKey)) {
                pausedIdentityLogged.add(logKey);
                log(`[magic-context] memory features paused for ${resolvedDirectory}: ${reason}`);
            }
            identity = undefined;
        }
    }
    if (identity !== undefined) pausedIdentityReasons.delete(resolvedDirectory);
    if (readCachedGitCheckoutMetadata(resolvedDirectory)?.linkedWorktree)
        linkedIdentityDirectories.add(resolvedDirectory);

    // A published pin invalidates even a successful git lookup. Directory/home fallbacks are
    // revalidated after the same cooldown used for recoverable git failures so a
    // newly initialized repository or recovered checkout is observed without
    // probing the filesystem on every context pass. A cwd change uses a new key.
    sessionIdentityCache.set(cacheKey, {
        identity,
        pinGeneration: projectIdentityPinGeneration(),
        revalidateAt:
            identity?.startsWith("git:") === true ? null : nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS,
    });
    return identity;
}

/**
 * Normalize a stored project path or legacy raw filesystem path.
 *
 * Already-resolved `git:` / `dir:` identities are returned byte-for-byte. Raw filesystem paths are
 * resolved through the production wrapper. Unresolved paths remain unchanged so a transient
 * git failure cannot manufacture a new project identity during an ownership check.
 */
export function normalizeStoredProjectPath(rawOrStored: string): string {
    if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) {
        return rawOrStored;
    }

    try {
        return resolveProjectIdentity(rawOrStored);
    } catch {
        // Preserve the raw key when resolution is deferred; never invent a second project.
        return rawOrStored;
    }
}

/**
 * Ownership check for a memory row against the current session's resolved
 * project identity. A memory's stored `project_path` may be a raw filesystem
 * path (legacy) OR an already-normalized `git:`/`dir:` identity; either must
 * match the current identity after normalization. Used by ctx_memory
 * delete/update/archive/merge so a session can still manage memories stored
 * under a legacy raw path that normalizes to the same project (shared by both
 * harnesses — Pi previously used raw `===`, diverging from OpenCode).
 */
export function storedPathBelongsToIdentity(
    storedProjectPath: string,
    projectIdentity: string,
): boolean {
    return (
        storedProjectPath === projectIdentity ||
        normalizeStoredProjectPath(storedProjectPath) === projectIdentity
    );
}

/**
 * Detect whether a directory belongs to a linked Git worktree. Linked worktrees
 * have a `.git` file whose gitdir target contains a `commondir` file.
 * The probe is cached because authority recovery can be considered every pass.
 */
export function isLinkedGitWorktree(directory: string): boolean {
    const resolvedDirectory = path.resolve(directory);
    const cached = linkedGitWorktreeCache.get(resolvedDirectory);
    if (cached !== undefined) return cached;

    const metadata = readCachedGitCheckoutMetadata(resolvedDirectory);
    const resolvedLinked =
        metadata?.gitCommonDir === undefined ? undefined : metadata.linkedWorktree;
    // If Git metadata exists but its topology cannot be resolved, fail closed:
    // the checkout may be linked and must not be allowed to drain shared authority.
    const linked = resolvedLinked ?? hasGitDir(resolvedDirectory);
    linkedGitWorktreeCache.set(resolvedDirectory, linked);
    return linked;
}

export function __setProjectIdentityTestHooks(hooks: {
    execFileSync?: typeof execFileSync;
    homeDirectory?: () => string;
    nowMs?: () => number;
    onFilesystemProbe?: () => void;
    gitTimeoutMs?: number;
}): void {
    execFileSyncForIdentity = hooks.execFileSync ?? execFileSync;
    gitTimeoutMs = hooks.gitTimeoutMs ?? GIT_TIMEOUT_MS;
    userHomeDirectoryForIdentity = hooks.homeDirectory ?? (() => homedir());
    nowMs = hooks.nowMs ?? (() => Date.now());
    filesystemProbeObserverForTests = hooks.onFilesystemProbe;
}

export function __clearProjectIdentityTransientCooldownForTests(directory?: string): void {
    if (directory === undefined) {
        transientFailureCooldown.clear();
        sessionIdentityCache.clear();
        return;
    }
    const resolvedDirectory = path.resolve(directory);
    transientFailureCooldown.delete(resolvedDirectory);
    for (const allowHome of ["0", "1"]) {
        sessionIdentityCache.delete(`${allowHome}\0${resolvedDirectory}`);
    }
}

export function __clearProjectIdentityResolutionCacheForTests(directory?: string): void {
    invalidateGitCheckoutMetadata(directory);
    if (directory === undefined) {
        linkedGitWorktreeCache.clear();
        linkedIdentityDirectories.clear();
        identityCache.clear();
        sessionIdentityCache.clear();
        return;
    }
    const resolvedDirectory = path.resolve(directory);
    linkedGitWorktreeCache.delete(resolvedDirectory);
    linkedIdentityDirectories.delete(resolvedDirectory);
    identityCache.delete(resolvedDirectory);
    for (const allowHome of ["0", "1"]) {
        sessionIdentityCache.delete(`${allowHome}\0${resolvedDirectory}`);
    }
}

export function __resetProjectIdentityForTests(): void {
    invalidateGitCheckoutMetadata();
    __resetProjectIdentitySidecarCachesForTests();
    homeProjectPermission = false;
    homeProjectSkipLogged = false;
    pausedIdentityReasons.clear();
    pausedIdentityLogged.clear();
    identityCache.clear();
    linkedGitWorktreeCache.clear();
    linkedIdentityDirectories.clear();
    lastKnownGitIdentityCache.clear();
    directoryFallbackCache.clear();
    transientFailureCooldown.clear();
    dubiousOwnershipFallbackDirectories.clear();
    dubiousOwnershipLoggedDirectories.clear();
    dubiousOwnershipWarnedDirectories.clear();
    transientGitIdentityReuseLoggedDirectories.clear();
    sessionIdentityCache.clear();
    execFileSyncForIdentity = execFileSync;
    gitTimeoutMs = GIT_TIMEOUT_MS;
    userHomeDirectoryForIdentity = (): string => homedir();
    nowMs = (): number => Date.now();
    filesystemProbeObserverForTests = undefined;
}
