import { afterEach, describe, expect, test } from "bun:test";
import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import parity from "../../../../../../testdata/unborn-head-parity.json";
import { isolatedTestGitEnv } from "../../../shared/test-git-env";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    ProjectIdentityError,
    resolveProjectIdentityForSession,
    resolveProjectIdentityStrict,
} from "./project-identity";
import { isUnbornHeadInLayout, isUnbornHeadOnDisk } from "./unborn-head";

type ParityCase = {
    name: string;
    entries: Record<string, string | null>;
    probe: string;
    unborn: boolean;
};

const tempDirs: string[] = [];
const savedPath = process.env.PATH;
let gitEnv: NodeJS.ProcessEnv | undefined;

afterEach(() => {
    process.env.PATH = savedPath;
    gitEnv = undefined;
    __resetProjectIdentityForTests();
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

/**
 * Create one case from `testdata/unborn-head-parity.json` (the layouts the Rust module's
 * check is tested on too) under `root`. Keys are `/`-separated on every platform; a key
 * ending in `/` is a directory, any other key a file with that text.
 */
function buildLayout(root: string, entries: Record<string, string | null>): void {
    for (const [key, text] of Object.entries(entries)) {
        const target = join(root, ...key.split("/").filter(Boolean));
        if (key.endsWith("/")) {
            mkdirSync(target, { recursive: true });
            continue;
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, (text ?? "").replaceAll("{root}", root));
    }
}

/** Git configuration isolated from the machine's, so a user default such as reftable storage cannot change the fixture. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
    if (gitEnv) return gitEnv;
    const config = join(makeTempDir("unborn-gitconfig-"), "config");
    writeFileSync(config, "");
    gitEnv = isolatedTestGitEnv({
        GIT_CONFIG_GLOBAL: config,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
    });
    return gitEnv;
}

function git(cwd: string, args: string[], env = isolatedGitEnv()): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
}

function freshRepository(prefix: string): string {
    const directory = makeTempDir(prefix);
    git(directory, ["init", "-q"]);
    return directory;
}

function committedRepository(prefix: string): { directory: string; root: string } {
    const directory = freshRepository(prefix);
    git(directory, ["commit", "--allow-empty", "-qm", "first"]);
    return { directory, root: git(directory, ["rev-parse", "HEAD"]).trim() };
}

function expectedDirIdentity(directory: string): string {
    const hash = createHash("md5").update(path.resolve(directory), "utf8").digest("hex");
    return `dir:${hash.slice(0, 12)}`;
}

/** Route identity git calls through the real `execFileSync`, counting them. */
function countGitSpawns(): { count: () => number } {
    let spawns = 0;
    __setProjectIdentityTestHooks({
        execFileSync: ((file: string, args: string[], options: ExecFileSyncOptions) => {
            spawns++;
            return execFileSync(file, args, { ...options, windowsHide: true });
        }) as typeof execFileSync,
    });
    return { count: () => spawns };
}

function errorClassOf(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (error) {
        if (error instanceof ProjectIdentityError) return error.errorClass;
        throw error;
    }
    return undefined;
}

/**
 * Put a `git` first on PATH that sleeps far past the identity probe's timeout, so every
 * git call ends in a real timeout, like a git call that stalls until it is killed (seen
 * on Windows). `exec` replaces the shell so the timeout's kill reaches the sleeping
 * process and its pipes close.
 */
function installSlowGit(): void {
    const bin = makeTempDir("slow-git-");
    const script = join(bin, "git");
    writeFileSync(script, "#!/bin/sh\nexec sleep 10\n");
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    __setProjectIdentityTestHooks({ gitTimeoutMs: 300 });
}

describe("unborn HEAD read from the filesystem", () => {
    for (const parityCase of (parity as { cases: ParityCase[] }).cases) {
        test(`parity: ${parityCase.name}`, () => {
            const root = realpathSync.native(makeTempDir("unborn-parity-"));
            buildLayout(root, parityCase.entries);
            const probe = join(root, ...parityCase.probe.split("/"));
            expect(isUnbornHeadInLayout(probe)).toBe(parityCase.unborn);
            expect(isUnbornHeadOnDisk(probe, {})).toBe(parityCase.unborn);
        });
    }

    test("defers to git when the environment moves the repository", () => {
        const root = makeTempDir("unborn-env-");
        buildLayout(root, (parity as { cases: ParityCase[] }).cases[0]?.entries ?? {});
        const repo = join(root, "repo");
        expect(isUnbornHeadOnDisk(repo, {})).toBe(true);
        for (const name of [
            "GIT_DIR",
            "GIT_COMMON_DIR",
            "GIT_WORK_TREE",
            "GIT_CEILING_DIRECTORIES",
        ])
            expect(isUnbornHeadOnDisk(repo, { [name]: root })).toBe(false);
    });

    test("a fresh git init resolves to its dir identity without starting git", () => {
        const directory = freshRepository("unborn-fresh-");
        const spawns = countGitSpawns();
        expect(errorClassOf(() => resolveProjectIdentityStrict(directory))).toBe("no_commits");
        expect(resolveProjectIdentityForSession(directory)).toBe(expectedDirIdentity(directory));
        expect(spawns.count()).toBe(0);
    });

    test("the first commit switches the identity to the root commit", () => {
        const directory = freshRepository("unborn-first-commit-");
        const spawns = countGitSpawns();
        expect(resolveProjectIdentityForSession(directory)).toBe(expectedDirIdentity(directory));
        expect(spawns.count()).toBe(0);
        git(directory, ["commit", "--allow-empty", "-qm", "first"]);
        const root = git(directory, ["rev-parse", "HEAD"]).trim();
        expect(resolveProjectIdentityForSession(directory)).toBe(`git:${root}`);
        expect(spawns.count()).toBeGreaterThan(0);
    });

    test("a linked worktree on a branch with no commits uses its dir identity without git", () => {
        const { directory } = committedRepository("unborn-worktree-main-");
        const worktree = join(makeTempDir("unborn-worktree-"), "wt");
        git(directory, ["worktree", "add", "-q", "--detach", worktree]);
        // What `git worktree add --orphan` leaves behind, which older git cannot create.
        const worktreeGitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]).trim();
        writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/fresh\n");
        // Git agrees the worktree's HEAD has no commit.
        expect(() => git(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"])).toThrow();

        const spawns = countGitSpawns();
        expect(resolveProjectIdentityForSession(worktree)).toBe(expectedDirIdentity(worktree));
        expect(spawns.count()).toBe(0);
    });

    test("a branch held only in packed-refs is born and is resolved by git", () => {
        const { directory, root } = committedRepository("unborn-packed-");
        git(directory, ["pack-refs", "--all"]);
        expect(isUnbornHeadOnDisk(directory, {})).toBe(false);
        const spawns = countGitSpawns();
        expect(resolveProjectIdentityForSession(directory)).toBe(`git:${root}`);
        expect(spawns.count()).toBeGreaterThan(0);
    });

    test("reftable or unknown ref storage is left to git", () => {
        for (const extra of [
            { "repo/.git/reftable/": null },
            { "repo/.git/config": "[extensions]\n\trefStorage = somethingNew\n" },
        ]) {
            __resetProjectIdentityForTests();
            const root = makeTempDir("unborn-reftable-");
            buildLayout(root, {
                "repo/.git/HEAD": "ref: refs/heads/main\n",
                "repo/.git/objects/": null,
                "repo/.git/refs/heads/": null,
                ...extra,
            });
            let spawns = 0;
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    spawns++;
                    return "abcdef1234567\n";
                }) as unknown as typeof execFileSync,
            });
            expect(resolveProjectIdentityStrict(join(root, "repo"))).toBe("git:abcdef1234567");
            expect(spawns).toBe(1);
        }
    });

    // The slow git is a shell script; Windows cannot run one as `git`. The zero-spawn
    // tests above prove the same property there.
    test.skipIf(process.platform === "win32")(
        "a git slower than the timeout still gives a fresh repository its dir identity",
        () => {
            const directory = freshRepository("unborn-slow-git-");
            installSlowGit();
            expect(resolveProjectIdentityForSession(directory)).toBe(
                expectedDirIdentity(directory),
            );
        },
    );

    test.skipIf(process.platform === "win32")(
        "a git slower than the timeout still pauses a repository with commits",
        () => {
            const { directory } = committedRepository("unborn-slow-git-born-");
            installSlowGit();
            expect(errorClassOf(() => resolveProjectIdentityStrict(directory))).toBe("git_timeout");
            __resetProjectIdentityForTests();
            installSlowGit();
            expect(resolveProjectIdentityForSession(directory)).toBeUndefined();
        },
    );
});
