import { afterEach, describe, expect, it, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { isolatedTestGitEnv } from "../../shared/test-git-env";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { readRememberedGitIdentity } from "./memory/project-identity-cache";
import {
    __clearProjectIdentityResolutionCacheForTests,
    __clearProjectIdentityTransientCooldownForTests,
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    isUserHomeDirectory,
    normalizeStoredProjectPath,
    ProjectIdentityError,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
    resolveProjectIdentityOrFallback,
    resolveProjectIdentityStrict,
    setHomeProjectPermission,
    shouldSkipHomeProjectMemory,
    storedPathBelongsToIdentity,
    takeDubiousOwnershipProjectIdentityWarning,
} from "./project-identity";

const tempDirs: string[] = [];
const FIRST_ROOT_COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
const SECOND_ROOT_COMMIT = "1234567890abcdef1234567890abcdef12345678";

afterEach(() => {
    __resetProjectIdentityForTests();
    for (const dir of tempDirs) {
        try {
            chmodSync(dir, 0o755);
        } catch {
            // Ignore cleanup permission restoration failures.
        }
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeRepoWithGitMetadata(prefix: string): string {
    const dir = makeTempDir(prefix);
    mkdirSync(join(dir, ".git"));
    return dir;
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    // Keep the real `.git` walk on disk, but route git output through the test
    // seam. Under heavy machine load, launching git can stall while the
    // operating system assesses the binary, which makes direct calls flaky.
    return (() => `${rootCommit}\n`) as typeof execFileSync;
}

function expectedDirIdentity(directory: string): string {
    return `dir:${createHash("md5")
        .update(path.resolve(directory), "utf8")
        .digest("hex")
        .slice(0, 12)}`;
}

function expectProjectIdentityError(fn: () => void): ProjectIdentityError {
    let caught: unknown;
    try {
        fn();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(ProjectIdentityError);
    if (!(caught instanceof ProjectIdentityError)) {
        throw new Error("Expected ProjectIdentityError");
    }
    return caught;
}

function makeGitFailure(fields: {
    stderr?: string;
    code?: string;
    signal?: string;
    killed?: boolean;
}) {
    const error = new Error("git failed") as Error & {
        stderr?: Buffer;
        code?: string;
        signal?: string;
        killed?: boolean;
    };
    if (fields.stderr !== undefined) error.stderr = Buffer.from(fields.stderr, "utf8");
    if (fields.code !== undefined) error.code = fields.code;
    if (fields.signal !== undefined) error.signal = fields.signal;
    if (fields.killed !== undefined) error.killed = fields.killed;
    return error;
}

describe("project identity", () => {
    it("unborn repo resolves to its existing dir identity and switches at the first commit", () => {
        const directory = makeTempDir("identity-unborn-");
        execFileSync("git", ["init", "-q", directory], {
            env: isolatedTestGitEnv(),
            windowsHide: true,
        });
        expect(
            expectProjectIdentityError(() => resolveProjectIdentityStrict(directory)).errorClass,
        ).toBe("no_commits");
        expect(resolveProjectIdentity(directory)).toBe(expectedDirIdentity(directory));
        expect(resolveProjectIdentityOrFallback(directory)).toBe(expectedDirIdentity(directory));
        expect(resolveProjectIdentityForSession(directory)).toBe(expectedDirIdentity(directory));
        expect(readRememberedGitIdentity(directory)).toBeUndefined();
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "first",
            ],
            { cwd: directory, env: isolatedTestGitEnv(), windowsHide: true },
        );
        const root = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: directory,
            env: isolatedTestGitEnv(),
            encoding: "utf8",
            windowsHide: true,
        }).trim();
        expect(resolveProjectIdentityForSession(directory)).toBe(`git:${root}`);
    });

    it("transient failure with commits and no recorded identity still pauses", () => {
        const directory = makeTempDir("identity-committed-cold-");
        execFileSync("git", ["init", "-q", directory], {
            env: isolatedTestGitEnv(),
            windowsHide: true,
        });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "first",
            ],
            { cwd: directory, env: isolatedTestGitEnv(), windowsHide: true },
        );
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                throw makeGitFailure({ code: "ETIMEDOUT" });
            }) as typeof execFileSync,
        });
        expect(resolveProjectIdentityForSession(directory)).toBeUndefined();
        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        expect(readRememberedGitIdentity(directory)).toBeUndefined();
    });
    it("applies the boot home permission to strict, fallback, and stored identities", () => {
        const home = makeTempDir("identity-home-policy-");
        __setProjectIdentityTestHooks({ homeDirectory: () => home });
        expect(shouldSkipHomeProjectMemory(home)).toBe(true);
        expect(resolveProjectIdentityForSession(home)).toBeUndefined();
        expect(expectProjectIdentityError(() => resolveProjectIdentity(home)).errorClass).toBe(
            "home_project_disabled",
        );
        expect(
            expectProjectIdentityError(() => resolveProjectIdentityStrict(home)).errorClass,
        ).toBe("home_project_disabled");
        expect(
            expectProjectIdentityError(() => resolveProjectIdentityOrFallback(home)).errorClass,
        ).toBe("home_project_disabled");
        expect(normalizeStoredProjectPath(home)).toBe(home);

        setHomeProjectPermission(true);
        expect(shouldSkipHomeProjectMemory(home)).toBe(false);
        const identity = resolveProjectIdentity(home);
        expect(identity).toBe(expectedDirIdentity(home));
        expect(resolveProjectIdentityOrFallback(home)).toBe(identity);
        expect(normalizeStoredProjectPath(home)).toBe(identity);
        expect(storedPathBelongsToIdentity(home, identity)).toBe(true);
        expectProjectIdentityError(() => resolveProjectIdentity(home, false));
        expectProjectIdentityError(() => resolveProjectIdentityStrict(home, false));
        setHomeProjectPermission(false);
        expect(shouldSkipHomeProjectMemory(home)).toBe(true);
        expectProjectIdentityError(() => resolveProjectIdentity(home));
    });
    it("resolveProjectIdentityStrict returns the git root commit identity", () => {
        const repo = makeRepoWithGitMetadata("project-identity-git-");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit(FIRST_ROOT_COMMIT) });

        const identity = resolveProjectIdentityStrict(repo);

        expect(identity).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(identity.slice("git:".length).length).toBeGreaterThanOrEqual(7);
    });

    it("resolveProjectIdentityStrict throws not_git_repo for non-git directories", () => {
        const directory = makeTempDir("project-identity-non-git-");

        const error = expectProjectIdentityError(() => resolveProjectIdentityStrict(directory));

        expect(error.errorClass).toBe("not_git_repo");
        expect(error.rawDirectory).toBe(directory);
    });

    it("resolveProjectIdentityStrict classifies missing directories without falling back", () => {
        const directory = makeTempDir("project-identity-missing-");
        rmSync(directory, { recursive: true, force: true });

        const error = expectProjectIdentityError(() => resolveProjectIdentityStrict(directory));

        expect(["permission_denied", "unknown"]).toContain(error.errorClass);
        expect(error.rawDirectory).toBe(directory);
    });

    it("resolveProjectIdentityStrict caches git identities across calls", () => {
        const repo = makeRepoWithGitMetadata("project-identity-cache-");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit(FIRST_ROOT_COMMIT) });
        const first = resolveProjectIdentityStrict(repo);

        chmodSync(repo, 0o000);
        try {
            expect(resolveProjectIdentityStrict(repo)).toBe(first);
        } finally {
            chmodSync(repo, 0o755);
        }
    });

    it("resolveProjectIdentity falls back to dir identity for non-git directories", () => {
        const directory = makeTempDir("project-identity-wrapper-");

        expect(resolveProjectIdentity(directory)).toBe(expectedDirIdentity(directory));
    });

    it("serves repeated session identity lookups before filesystem probes", () => {
        const repo = makeRepoWithGitMetadata("project-identity-session-cache-");
        let filesystemProbes = 0;
        __setProjectIdentityTestHooks({
            execFileSync: returningRootCommit(FIRST_ROOT_COMMIT),
            onFilesystemProbe: () => {
                filesystemProbes += 1;
            },
        });

        const first = resolveProjectIdentityForSession(repo);
        expect(first).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(filesystemProbes).toBeGreaterThan(0);
        filesystemProbes = 0;

        expect(resolveProjectIdentityForSession(repo)).toBe(first);
        expect(filesystemProbes).toBe(0);
    });

    it("invalidates a session directory fallback immediately when git metadata appears", () => {
        const directory = makeTempDir("project-identity-session-revalidate-");
        let now = 1_000;
        let filesystemProbes = 0;
        __setProjectIdentityTestHooks({
            execFileSync: returningRootCommit(FIRST_ROOT_COMMIT),
            nowMs: () => now,
            onFilesystemProbe: () => {
                filesystemProbes += 1;
            },
        });

        expect(resolveProjectIdentityForSession(directory)).toBe(expectedDirIdentity(directory));
        mkdirSync(join(directory, ".git"));
        filesystemProbes = 0;
        expect(resolveProjectIdentityForSession(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(filesystemProbes).toBeGreaterThan(0);

        now += 5 * 60 * 1000 + 1;
        expect(resolveProjectIdentityForSession(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(filesystemProbes).toBeGreaterThan(0);
    });

    it("uses the no-git fast path without invoking git", () => {
        const directory = makeTempDir("project-identity-no-git-fast-");
        const execMock = mock(() => {
            throw new Error("git should not be launched for a directory with no .git ancestor");
        });
        __setProjectIdentityTestHooks({ execFileSync: execMock as unknown as typeof execFileSync });

        expect(resolveProjectIdentity(directory)).toBe(expectedDirIdentity(directory));
        expect(execMock).not.toHaveBeenCalled();
    });

    it("detects git metadata in ancestors for subdirectory sessions", () => {
        const repo = makeRepoWithGitMetadata("project-identity-ancestor-");
        const subdir = join(repo, "nested", "session");
        mkdirSync(subdir, { recursive: true });
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit(FIRST_ROOT_COMMIT) });

        expect(resolveProjectIdentity(subdir)).toBe(`git:${FIRST_ROOT_COMMIT}`);
    });

    it("detects git metadata through symlinked checkout paths", () => {
        const repo = makeRepoWithGitMetadata("project-identity-symlink-repo-");
        const subdir = join(repo, "nested", "session");
        mkdirSync(subdir, { recursive: true });
        const linkParent = makeTempDir("project-identity-symlink-parent-");
        const link = join(linkParent, "checkout");
        try {
            symlinkSync(subdir, link, "dir");
        } catch (error) {
            if ((error as { code?: unknown }).code === "EPERM") return;
            throw error;
        }
        const execMock = mock(() => `${FIRST_ROOT_COMMIT}\n`);
        __setProjectIdentityTestHooks({ execFileSync: execMock as unknown as typeof execFileSync });

        expect(resolveProjectIdentity(link)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(execMock).toHaveBeenCalledTimes(1);
    });

    it("reuses the last successful git identity during transient failures and cooldown", () => {
        const directory = makeRepoWithGitMetadata("project-identity-last-known-");
        let now = 1_000;
        let mode: "first" | "timeout" | "second" = "first";
        const execMock = mock(() => {
            if (mode === "first") return `${FIRST_ROOT_COMMIT}\n`;
            if (mode === "second") return `${SECOND_ROOT_COMMIT}\n`;
            throw makeGitFailure({ code: "ETIMEDOUT" });
        });
        __setProjectIdentityTestHooks({
            execFileSync: execMock as unknown as typeof execFileSync,
            nowMs: () => now,
        });

        expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        __clearProjectIdentityResolutionCacheForTests(directory);
        mode = "timeout";

        expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(execMock).toHaveBeenCalledTimes(2);

        mode = "second";
        now += 5 * 60 * 1000 + 1;
        expect(resolveProjectIdentity(directory)).toBe(`git:${SECOND_ROOT_COMMIT}`);
        expect(execMock).toHaveBeenCalledTimes(3);
    });

    it("classifies dubious ownership and defers until the cooldown expires", () => {
        const directory = makeRepoWithGitMetadata("project-identity-dubious-");
        let now = 1_000;
        let recovered = false;
        const execMock = mock(() => {
            if (recovered) return `${FIRST_ROOT_COMMIT}\n`;
            throw makeGitFailure({
                stderr:
                    "fatal: detected dubious ownership in repository at '/repo'\n" +
                    "To add an exception for this directory, call:\n",
            });
        });
        __setProjectIdentityTestHooks({
            execFileSync: execMock as unknown as typeof execFileSync,
            nowMs: () => now,
        });

        const strictError = expectProjectIdentityError(() =>
            resolveProjectIdentityStrict(directory),
        );
        expect(strictError.errorClass).toBe("dubious_ownership");

        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        expect(takeDubiousOwnershipProjectIdentityWarning(directory)).toContain(
            "git config --global --add safe.directory",
        );
        expect(takeDubiousOwnershipProjectIdentityWarning(directory)).toBeNull();

        recovered = true;
        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        expect(execMock).toHaveBeenCalledTimes(2);

        now += 5 * 60 * 1000 + 1;
        expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(execMock).toHaveBeenCalledTimes(3);
    });

    it("cools down git timeouts so immediate retries do not rerun git", () => {
        const directory = makeRepoWithGitMetadata("project-identity-timeout-");
        const execMock = mock(() => {
            throw makeGitFailure({ code: "ETIMEDOUT" });
        });
        __setProjectIdentityTestHooks({ execFileSync: execMock as unknown as typeof execFileSync });

        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        expect(execMock).toHaveBeenCalledTimes(1);
    });

    it("re-probes after a transient cooldown is cleared", () => {
        const directory = makeRepoWithGitMetadata("project-identity-clear-cooldown-");
        let recovered = false;
        const execMock = mock(() => {
            if (recovered) return `${FIRST_ROOT_COMMIT}\n`;
            throw makeGitFailure({ code: "ETIMEDOUT" });
        });
        __setProjectIdentityTestHooks({ execFileSync: execMock as unknown as typeof execFileSync });

        expect(() => resolveProjectIdentity(directory)).toThrow(ProjectIdentityError);
        recovered = true;
        __clearProjectIdentityTransientCooldownForTests(directory);

        expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
        expect(execMock).toHaveBeenCalledTimes(2);
    });

    it("still propagates permission_denied git failures", () => {
        const directory = makeRepoWithGitMetadata("project-identity-permission-");
        __setProjectIdentityTestHooks({
            execFileSync: mock(() => {
                throw makeGitFailure({ code: "EACCES" });
            }) as unknown as typeof execFileSync,
        });

        const error = expectProjectIdentityError(() => resolveProjectIdentity(directory));

        expect(error.errorClass).toBe("permission_denied");
    });

    it("normalizeStoredProjectPath returns stored identities unchanged", () => {
        expect(normalizeStoredProjectPath("git:not-a-filesystem-path")).toBe(
            "git:not-a-filesystem-path",
        );
        expect(normalizeStoredProjectPath("dir:abcdef123456")).toBe("dir:abcdef123456");
    });

    it("normalizeStoredProjectPath resolves raw filesystem paths through the wrapper", () => {
        const directory = makeTempDir("project-identity-normalize-");

        expect(normalizeStoredProjectPath(directory)).toBe(expectedDirIdentity(directory));
    });

    it("storedPathBelongsToIdentity matches on exact identity and on normalized raw path", () => {
        // Exact stored-identity match.
        expect(storedPathBelongsToIdentity("git:abc123", "git:abc123")).toBe(true);
        expect(storedPathBelongsToIdentity("dir:deadbeef", "dir:deadbeef")).toBe(true);
        // Mismatched identity.
        expect(storedPathBelongsToIdentity("git:abc123", "git:other")).toBe(false);
        // Raw filesystem paths stored before normalization must still match the
        // identity they normalize to.
        const directory = makeTempDir("project-identity-belongs-");
        const identity = expectedDirIdentity(directory);
        expect(storedPathBelongsToIdentity(directory, identity)).toBe(true);
        expect(storedPathBelongsToIdentity(directory, "dir:not-this-one")).toBe(false);
    });

    it("ProjectIdentityError carries classification and raw directory fields", () => {
        const cause = new Error("inner");
        const error = new ProjectIdentityError("git_timeout", "/raw/path", "timed out", cause);

        expect(error.name).toBe("ProjectIdentityError");
        expect(error.errorClass).toBe("git_timeout");
        expect(error.rawDirectory).toBe("/raw/path");
        expect(error.cause).toBe(cause);
    });
});

it("recovers a durable git identity after restart despite dubious ownership", () => {
    const directory = makeRepoWithGitMetadata("identity-restart-");
    __setProjectIdentityTestHooks({ execFileSync: returningRootCommit(FIRST_ROOT_COMMIT) });
    expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
    __resetProjectIdentityForTests();
    __setProjectIdentityTestHooks({
        execFileSync: (() => {
            throw makeGitFailure({ stderr: "detected dubious ownership" });
        }) as typeof execFileSync,
    });
    expect(resolveProjectIdentity(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
    expect(resolveProjectIdentityForSession(directory)).toBe(`git:${FIRST_ROOT_COMMIT}`);
});

it("cold git failure refuses both fallback APIs and pauses session memory", () => {
    const directory = makeRepoWithGitMetadata("identity-cold-");
    __setProjectIdentityTestHooks({
        execFileSync: (() => {
            throw makeGitFailure({ code: "ETIMEDOUT" });
        }) as typeof execFileSync,
    });
    const nested = join(directory, "nested");
    mkdirSync(nested);
    const linked = makeTempDir("identity-linked-cold-");
    writeFileSync(
        join(linked, ".git"),
        `gitdir: ${join(directory, ".git", "worktrees", "linked")}\n`,
    );
    for (const candidate of [directory, nested, linked]) {
        expect(() => resolveProjectIdentity(candidate)).toThrow(ProjectIdentityError);
        expect(() => resolveProjectIdentityOrFallback(candidate)).toThrow(ProjectIdentityError);
        expect(resolveProjectIdentityForSession(candidate)).toBeUndefined();
    }
});

it("recognizes Windows home spellings without filesystem access", () => {
    __setProjectIdentityTestHooks({ homeDirectory: () => "C:\\Users\\Phoenix" });
    for (const directory of [
        "c:/Users/Phoenix",
        "C:\\Users\\Phoenix\\",
        "\\\\?\\C:\\Users\\Phoenix",
        "c:/users/phoenix/.",
    ]) {
        expect(isUserHomeDirectory(directory)).toBe(true);
        expect(() => resolveProjectIdentityStrict(directory)).toThrow(
            "Home project memory is disabled",
        );
        expect(resolveProjectIdentityForSession(directory)).toBeUndefined();
        expect(() => resolveProjectIdentityOrFallback(directory)).toThrow(
            "Home project memory is disabled",
        );
    }
    expect(isUserHomeDirectory("C:/Users/Phoenix/project")).toBe(false);
});
