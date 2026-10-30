import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import parity from "../../../../../../test-vectors/project-identity-parity.json";
import resolveVectors from "../../../../../../test-vectors/project-resolve-v1/resolve.json";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    borrowedProjectIdentity,
    describeUnresolvedProjectIdentity,
    isLinkedGitWorktree,
    type LiveProjectIdentityAnswer,
    rememberResolvedProjectIdentity,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
    resolveProjectIdentityStrict,
} from "./project-identity";
import {
    projectDirectoryKey,
    readRememberedProjectIdentity,
    rememberGitIdentity,
    rememberPinnedProjectIdentity,
} from "./project-identity-cache";
import { __setProjectPinWriterForTests, flushProjectPinWrites } from "./project-pin-writer";
import {
    __resetSessionIdentityDecisionsForTests,
    awaitSessionIdentityDecision,
} from "./session-identity-decision";

function tempDir(): string {
    return createTestTempDirFromPath(join(tmpdir(), "mc-identity-"));
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    return (() => `${rootCommit}\n`) as unknown as typeof execFileSync;
}

const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
let storageDir: string;
let testRoot: string;

beforeEach(() => {
    testRoot = tempDir();
    storageDir = join(testRoot, "cortexkit", "magic-context");
    mkdirSync(storageDir, { recursive: true });
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testRoot;
    process.env.XDG_DATA_HOME = testRoot;
});

afterEach(async () => {
    await __setProjectPinWriterForTests();
    __resetProjectIdentityForTests();
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    rmSync(testRoot, { recursive: true, force: true });
});

describe("linked Git worktree detection", () => {
    test("reads gitdir and commondir files without running git, including from a subfolder", () => {
        const primary = join(storageDir, "primary");
        const linked = join(storageDir, "linked");
        const gitDir = join(primary, ".git", "worktrees", "linked");
        mkdirSync(gitDir, { recursive: true });
        mkdirSync(join(linked, "sub"), { recursive: true });
        writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
        writeFileSync(join(gitDir, "commondir"), "../..\n");
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return `${gitDir}\n${join(primary, ".git")}\n`;
            }) as unknown as typeof execFileSync,
        });

        expect(isLinkedGitWorktree(primary)).toBe(false);
        expect(isLinkedGitWorktree(linked)).toBe(true);
        expect(isLinkedGitWorktree(join(linked, "sub"))).toBe(true);
        rmSync(join(gitDir, "commondir"));
        expect(isLinkedGitWorktree(linked)).toBe(true);
        expect(gitCalls).toBe(0);
    });

    test.each([
        "unreadable .git file",
        "malformed .git file",
        "missing gitdir target",
        "unreadable gitdir target",
        "unreadable commondir file",
    ])("fails closed for %s without running git", (shape) => {
        const checkout = join(storageDir, "checkout");
        const dotGit = join(checkout, ".git");
        const gitDir = join(storageDir, "metadata");
        const commonFile = join(gitDir, "commondir");
        mkdirSync(checkout);
        writeFileSync(dotGit, `gitdir: ${gitDir}\n`);
        if (shape !== "missing gitdir target") mkdirSync(gitDir);
        if (shape === "malformed .git file") writeFileSync(dotGit, "not a gitdir pointer\n");
        if (shape === "unreadable commondir file") writeFileSync(commonFile, ".\n");
        const permissionDenied = (): NodeJS.ErrnoException =>
            Object.assign(new Error("permission denied"), { code: "EACCES" });
        const originalRead = fs.readFileSync;
        const originalStat = fs.lstatSync;
        let deniedReads = 0;
        const read = spyOn(fs, "readFileSync").mockImplementation(((...args) => {
            if (
                (shape === "unreadable .git file" && args[0] === dotGit) ||
                (shape === "unreadable commondir file" && args[0] === commonFile)
            ) {
                deniedReads++;
                throw permissionDenied();
            }
            return Reflect.apply(originalRead, fs, args);
        }) as typeof fs.readFileSync);
        const stat = spyOn(fs, "lstatSync").mockImplementation(((...args) => {
            if (shape === "unreadable gitdir target" && args[0] === commonFile) {
                deniedReads++;
                throw permissionDenied();
            }
            return Reflect.apply(originalStat, fs, args);
        }) as typeof fs.lstatSync);
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return `${gitDir}\n${gitDir}\n`;
            }) as unknown as typeof execFileSync,
        });
        try {
            expect(isLinkedGitWorktree(checkout)).toBe(true);
            expect(gitCalls).toBe(0);
            if (shape.startsWith("unreadable")) expect(deniedReads).toBe(1);
        } finally {
            read.mockRestore();
            stat.mockRestore();
        }
    });

    test("a folder without git metadata is not treated as linked", () => {
        expect(isLinkedGitWorktree(storageDir)).toBe(false);
    });
});

function pin(directory: string, identity = "pj-A"): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    const file = join(storageDir, "project-identities", `${hash}.json`);
    mkdirSync(join(storageDir, "project-identities"), { recursive: true });
    writeFileSync(file, JSON.stringify({ directory: projectDirectoryKey(directory), identity }));
    return file;
}

function liveAnswer(overrides: Partial<LiveProjectIdentityAnswer> = {}): LiveProjectIdentityAnswer {
    const result = structuredClone(resolveVectors[0].reply.result);
    if (!result) throw new Error("Missing root resolve vector");
    return { ...result, ...overrides };
}

function replaceVectorStrings(value: unknown, replacements: Record<string, string>): unknown {
    if (typeof value === "string") return replacements[value] ?? value;
    if (Array.isArray(value)) return value.map((item) => replaceVectorStrings(item, replacements));
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                replaceVectorStrings(child, replacements),
            ]),
        );
    return value;
}

function sidecarBytes(): Map<string, string> {
    const dir = join(storageDir, "project-identities");
    if (!fs.existsSync(dir)) return new Map();
    return new Map(
        fs.readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]),
    );
}

function linkedIdentityFixture() {
    const main = join(testRoot, "main");
    const worktree = join(testRoot, "worktree");
    const gitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    return { main, worktree, gitDir };
}

test("warm linked-worktree identity with 500 sidecars performs no scans or file reads", async () => {
    const { main, worktree, gitDir } = linkedIdentityFixture();
    pin(main, "pj-ROOT");
    for (let i = 0; i < 499; i++) pin(join(testRoot, `unrelated-${i}`), `pj-other-${i}`);
    const read = spyOn(fs, "readFileSync");
    const scan = spyOn(fs, "readdirSync");
    try {
        expect(resolveProjectIdentityForSession(worktree)).toBe("pj-ROOT");
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(resolveProjectIdentityForSession(worktree)).toBe("pj-ROOT");
        expect(read.mock.calls.filter(([file]) => file === join(worktree, ".git"))).toHaveLength(1);
        expect(read.mock.calls.filter(([file]) => file === join(gitDir, "commondir"))).toHaveLength(
            1,
        );
        read.mockClear();
        scan.mockClear();
        const started = performance.now();
        let answer: string | undefined;
        for (let i = 0; i < 100; i++) answer = resolveProjectIdentityForSession(worktree);
        const elapsed = performance.now() - started;
        console.info(
            `WORKTREE_WARM_TS calls=100 sidecars=500 us_per_call=${elapsed * 10} reads=${read.mock.calls.length} scans=${scan.mock.calls.length}`,
        );
        expect(answer).toBe("pj-ROOT");
        expect(resolveProjectIdentity(worktree)).toBe("pj-ROOT");
        expect(resolveProjectIdentityStrict(worktree)).toBe("pj-ROOT");
        expect(borrowedProjectIdentity(worktree)).toBe("pj-ROOT");
        expect(scan).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    } finally {
        read.mockRestore();
        scan.mockRestore();
    }
});

test.each([
    "external",
    "pending",
])("a cached worktree git answer observes an %s checkout pin", async (source) => {
    const { main, worktree } = linkedIdentityFixture();
    __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abcdef123") });
    expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
    expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
    if (source === "external") pin(main, "pj-NEW");
    else {
        rememberPinnedProjectIdentity(main, "pj-NEW");
        const mainPin = join(
            storageDir,
            "project-identities",
            `${createHash("sha256").update(projectDirectoryKey(main)).digest("hex")}.json`,
        );
        expect(fs.existsSync(mainPin)).toBe(false);
    }
    expect(resolveProjectIdentityForSession(worktree)).toBe("pj-NEW");
    expect(await flushProjectPinWrites(2_000)).toBe(true);
});

test("a borrowed answer notices an in-place pin replacement and a new exact worktree pin", () => {
    const { main, worktree } = linkedIdentityFixture();
    pin(main, "pj-FIRST");
    expect(resolveProjectIdentityForSession(worktree)).toBe("pj-FIRST");
    pin(main, "pj-OTHER");
    expect(resolveProjectIdentityForSession(worktree)).toBe("pj-OTHER");
    pin(worktree, "pj-EXACT");
    expect(resolveProjectIdentityForSession(worktree)).toBe("pj-EXACT");
});

test("worktree cleanup runs only once even if a legacy writer recreates its sidecar", async () => {
    const { main, worktree } = linkedIdentityFixture();
    pin(main, "pj-ROOT");
    const stale = pin(worktree, "git:abcdef123");
    expect(borrowedProjectIdentity(worktree)).toBe("pj-ROOT");
    expect(await flushProjectPinWrites(2_000)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    pin(worktree, "git:abcdef123");
    expect(borrowedProjectIdentity(worktree)).toBe("pj-ROOT");
    expect(await flushProjectPinWrites(2_000)).toBe(true);
    expect(fs.existsSync(stale)).toBe(true);
});

test("ordinary warm sessions perform no new filesystem probes", () => {
    const main = join(testRoot, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abcdef123") });
    expect(resolveProjectIdentityForSession(main)).toBe("git:abcdef123");
    const read = spyOn(fs, "readFileSync");
    const scan = spyOn(fs, "readdirSync");
    const stat = spyOn(fs, "lstatSync");
    try {
        for (let i = 0; i < 100; i++)
            expect(resolveProjectIdentityForSession(main)).toBe("git:abcdef123");
        expect(read).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
    } finally {
        read.mockRestore();
        scan.mockRestore();
        stat.mockRestore();
    }
});

test("session topology caching preserves fail-closed worktree detection for malformed metadata", () => {
    const { worktree } = linkedIdentityFixture();
    writeFileSync(join(worktree, ".git"), "not a gitdir pointer\n");
    __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abcdef123") });
    expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
    expect(isLinkedGitWorktree(worktree)).toBe(true);
});

describe("live project pin writes", () => {
    for (const row of parity.cases.filter((row) => row.name.startsWith("worktree-"))) {
        test(`parity worktree resolvers: ${row.name}`, async () => {
            const expand = (value: string) => value.replaceAll("<fixture>", testRoot);
            const fixture = parity.fixtures.linked;
            for (const repo of fixture.repositories) {
                mkdirSync(expand(repo.root), { recursive: true });
                mkdirSync(expand(repo.gitDir), { recursive: true });
                if (repo.kind === "worktree") {
                    writeFileSync(
                        join(expand(repo.root), ".git"),
                        `gitdir: ${expand(repo.gitDir)}\n`,
                    );
                    writeFileSync(
                        join(expand(repo.gitDir), "commondir"),
                        `${expand(repo.commonDir)}\n`,
                    );
                }
            }
            for (const record of row.sidecars) {
                const file = pin(expand(record.directory), record.identity);
                writeFileSync(
                    file,
                    JSON.stringify({
                        ...record,
                        directory: expand(record.directory),
                        ...("gitCommonDir" in record
                            ? { gitCommonDir: expand(record.gitCommonDir) }
                            : {}),
                    }),
                );
            }
            const before = sidecarBytes();
            let probes = 0;
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    probes++;
                    return parity.gitRootCommit;
                }) as unknown as typeof execFileSync,
            });
            const directory = expand(row.directory);
            const expected = row.expected.identity;
            if (row.name === "worktree-stale-git-sidecar-retired") {
                expect(resolveProjectIdentityStrict(directory, false, { cache: false })).toBe(
                    expected,
                );
                expect(await flushProjectPinWrites(2_000)).toBe(true);
                expect(sidecarBytes()).toEqual(before);
            }
            expect(resolveProjectIdentityStrict(directory)).toBe(expected);
            expect(resolveProjectIdentity(directory)).toBe(expected);
            expect(resolveProjectIdentityForSession(directory)).toBe(expected);
            __resetSessionIdentityDecisionsForTests();
            try {
                expect(
                    (
                        await awaitSessionIdentityDecision(row.name, directory, {
                            connectionFile: join(testRoot, "absent.json"),
                        })
                    ).identity,
                ).toBe(expected);
            } finally {
                __resetSessionIdentityDecisionsForTests();
            }
            expect(await flushProjectPinWrites(2_000)).toBe(true);
            const after = sidecarBytes();
            const removed = "sidecarRemovals" in row.expected ? row.expected.sidecarRemovals : [];
            for (const [file, bytes] of before) {
                if (removed?.some((folder) => expand(folder) === JSON.parse(bytes).directory))
                    expect(after.has(file)).toBe(false);
                else expect(after.get(file)).toBe(bytes);
            }
            expect([...after.keys()].filter((file) => !before.has(file))).toEqual([]);
            expect(probes).toBe(row.expected.gitProbeCalls);
            __setProjectIdentityTestHooks({ homeDirectory: () => directory });
            expect(resolveProjectIdentityForSession(directory, false)).toBeUndefined();
        });
    }

    const rowNames = [
        "registered-root",
        "registered-subfolder",
        "registered-linked-worktree",
        "unregistered-checkout",
        "nested-registration-without-parent-pin",
        "nested-registration-with-parent-pin",
        "gone-registered-root-is-accepted",
        "legacy-git-record-replaced-by-live-project-pin",
        "pj-pin-preserves-sidecar-bytes",
        "walk-subfolder-canonical-root-equals-checkout",
        "walk-subfolder-canonical-root-differs-from-checkout",
    ];
    for (const name of rowNames) {
        test(`parity writer: ${name}`, async () => {
            const row = parity.cases.find((candidate) => candidate.name === name);
            if (!row || typeof row.answer === "string")
                throw new Error(`Missing live row: ${name}`);
            const expand = (value: string): string => value.replaceAll("<fixture>", testRoot);
            const fixture = parity.fixtures[row.fixture as keyof typeof parity.fixtures];
            for (const repo of fixture.repositories) {
                mkdirSync(expand(repo.root), { recursive: true });
                mkdirSync(expand(repo.gitDir), { recursive: true });
                if (repo.kind !== "main")
                    writeFileSync(
                        join(expand(repo.root), ".git"),
                        `gitdir: ${expand(repo.gitDir)}\n`,
                    );
                if (repo.kind === "worktree")
                    writeFileSync(
                        join(expand(repo.gitDir), "commondir"),
                        `${expand(repo.commonDir)}\n`,
                    );
            }
            for (const directory of fixture.directories)
                mkdirSync(expand(directory), { recursive: true });
            for (const record of row.sidecars) {
                const file = pin(expand(record.directory), record.identity);
                writeFileSync(
                    file,
                    `${JSON.stringify(
                        replaceVectorStrings(
                            record,
                            Object.fromEntries(
                                Object.values(record)
                                    .filter((value): value is string => typeof value === "string")
                                    .map((value) => [value, expand(value)]),
                            ),
                        ),
                        null,
                        2,
                    )}\n`,
                );
            }
            const replacements = Object.fromEntries(
                Object.entries(row.answer.replaceStrings).map(([from, to]) => [from, expand(to)]),
            );
            const vector = replaceVectorStrings(
                resolveVectors[row.answer.caseIndex],
                replacements,
            ) as {
                reply: { result: LiveProjectIdentityAnswer };
            };
            if ("mutations" in row.answer) {
                for (const mutation of row.answer.mutations ?? []) {
                    let target = vector as unknown as Record<string, unknown>;
                    for (const key of mutation.path.slice(0, -1))
                        target = target[key] as Record<string, unknown>;
                    const key = mutation.path.at(-1);
                    if (!key) throw new Error("Mutation path must name a field");
                    target[key] =
                        typeof mutation.value === "string"
                            ? expand(mutation.value)
                            : mutation.value;
                }
            }
            const before = sidecarBytes();
            let gitCalls = 0;
            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    gitCalls++;
                    throw new Error("Pin writes must not run git");
                }) as unknown as typeof execFileSync,
            });
            rememberResolvedProjectIdentity(expand(row.directory), vector.reply.result);
            expect(await flushProjectPinWrites(2_000)).toBe(true);
            const after = sidecarBytes();
            const writes = [...after]
                .filter(([file, bytes]) => before.get(file) !== bytes)
                .map(([, bytes]) => JSON.parse(bytes));
            const expected = row.expected.sidecarWrites
                .filter((record) => record.identity.startsWith("pj-"))
                .map((record) => ({
                    ...record,
                    directory: expand(record.directory),
                    ...("gitCommonDir" in record
                        ? { gitCommonDir: expand(record.gitCommonDir) }
                        : {}),
                }));
            expect(writes.sort((a, b) => a.directory.localeCompare(b.directory))).toEqual(
                expected.sort((a, b) => a.directory.localeCompare(b.directory)),
            );
            for (const [file, bytes] of before) {
                if (
                    !writes.some(
                        (record) =>
                            projectDirectoryKey(record.directory) === JSON.parse(bytes).directory,
                    )
                )
                    expect(after.get(file)).toBe(bytes);
            }
            expect(gitCalls).toBe(0);
        });
    }

    test("rejects implicit and unknown vias even with a registered project id", async () => {
        const directory = join(testRoot, "plain");
        mkdirSync(directory);
        for (const via of ["implicit", "future-via"])
            rememberResolvedProjectIdentity(
                directory,
                liveAnswer({ via, canonicalRoot: directory }),
            );
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(sidecarBytes().size).toBe(0);
    });

    test("does not pin a linked subfolder after a cached main-checkout probe", async () => {
        const root = join(testRoot, "checkout");
        const sub = join(root, "sub");
        const gitDir = join(testRoot, "metadata");
        mkdirSync(sub, { recursive: true });
        mkdirSync(gitDir);
        expect(isLinkedGitWorktree(sub)).toBe(false);
        writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
        writeFileSync(join(gitDir, "commondir"), ".\n");
        rememberResolvedProjectIdentity(sub, liveAnswer({ canonicalRoot: root }));
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(sidecarBytes().size).toBe(0);
    });

    test("rejects an implicit id even when the via is accepted", async () => {
        const directory = join(testRoot, "plain");
        mkdirSync(directory);
        const implicit = resolveVectors[3].reply.result;
        if (!implicit) throw new Error("Missing implicit resolve vector");
        rememberResolvedProjectIdentity(directory, {
            ...implicit,
            via: "root",
            canonicalRoot: directory,
        });
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(sidecarBytes().size).toBe(0);
    });

    test("pins non-git folders for every accepted via without inventing a common dir", async () => {
        for (const via of ["root", "walk", "containment", "worktree"]) {
            const directory = join(testRoot, via);
            mkdirSync(directory);
            rememberResolvedProjectIdentity(directory, liveAnswer({ via, canonicalRoot: null }));
            expect(readRememberedProjectIdentity(directory)).toEqual({
                directory,
                identity: "pj-resolve-root",
            });
        }
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(sidecarBytes().size).toBe(4);
    });

    test("compares realpath and directory-key spellings before pinning a checkout root", () => {
        const root = join(testRoot, "repo");
        const sub = join(root, "sub");
        const alias = join(testRoot, "alias");
        mkdirSync(join(root, ".git"), { recursive: true });
        mkdirSync(sub);
        fs.symlinkSync(root, alias);
        rememberResolvedProjectIdentity(sub, liveAnswer({ canonicalRoot: `${alias}/` }));
        expect(readRememberedProjectIdentity(root)?.identity).toBe("pj-resolve-root");
        expect(readRememberedProjectIdentity(sub)?.identity).toBe("pj-resolve-root");
    });

    test("a missing canonical root does not prevent pinning the resolved folder", () => {
        const root = join(testRoot, "repo");
        const sub = join(root, "sub");
        mkdirSync(join(root, ".git"), { recursive: true });
        mkdirSync(sub);
        rememberResolvedProjectIdentity(
            sub,
            liveAnswer({ canonicalRoot: join(testRoot, "missing") }),
        );
        expect(readRememberedProjectIdentity(sub)?.identity).toBe("pj-resolve-root");
        expect(readRememberedProjectIdentity(root)).toBeUndefined();
    });

    test("home and missing folders cannot gain pins from live answers", async () => {
        const home = join(testRoot, "home");
        mkdirSync(join(home, ".git"), { recursive: true });
        mkdirSync(join(home, "sub"));
        __setProjectIdentityTestHooks({ homeDirectory: () => home });
        for (const directory of [home, join(home, "sub"), join(testRoot, "missing")])
            rememberResolvedProjectIdentity(directory, liveAnswer({ canonicalRoot: directory }));
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(sidecarBytes().size).toBe(0);
    });
});

describe("project pin precedence", () => {
    test("pj pin wins over a live git root without a git probe", () => {
        const directory = join(storageDir, "repo");
        mkdirSync(join(directory, ".git"), { recursive: true });
        const file = pin(directory);
        const before = readFileSync(file, "utf8");
        let gitCalls = 0;
        __setProjectIdentityTestHooks({
            execFileSync: (() => {
                gitCalls++;
                return "abc1234\n";
            }) as unknown as typeof execFileSync,
        });
        expect(resolveProjectIdentity(directory)).toBe("pj-A");
        expect(resolveProjectIdentityStrict(directory)).toBe("pj-A");
        expect(resolveProjectIdentityStrict(directory, false, { cache: false })).toBe("pj-A");
        expect(resolveProjectIdentityForSession(directory)).toBe("pj-A");
        expect(gitCalls).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(before);
    });

    test("a pj pin wins over process-cached git and directory fallbacks", () => {
        const repo = join(storageDir, "repo");
        const plain = join(storageDir, "plain");
        mkdirSync(join(repo, ".git"), { recursive: true });
        mkdirSync(plain);
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(repo)).toBe("git:abc1234");
        expect(resolveProjectIdentity(plain)).toStartWith("dir:");
        pin(repo);
        pin(plain);
        expect(resolveProjectIdentity(repo)).toBe("pj-A");
        expect(resolveProjectIdentity(plain)).toBe("pj-A");
    });

    test("a legacy git sidecar still loses to a live git root", () => {
        const directory = join(storageDir, "repo");
        mkdirSync(join(directory, ".git"), { recursive: true });
        rememberGitIdentity(directory, "git:def5678");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(directory)).toBe("git:abc1234");
    });

    test("a subfolder's legacy git write cannot replace its checkout root's pin", () => {
        const root = join(storageDir, "repo");
        const sub = join(root, "sub");
        mkdirSync(join(root, ".git"), { recursive: true });
        mkdirSync(sub);
        const file = pin(root);
        const before = readFileSync(file, "utf8");
        __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
        expect(resolveProjectIdentity(sub)).toBe("git:abc1234");
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(readRememberedProjectIdentity(sub)?.identity).toBe("git:abc1234");
    });

    test("home and missing-directory eligibility run before a pin can be used", () => {
        const fakeHome = join(storageDir, "home");
        const missing = join(storageDir, "missing");
        mkdirSync(join(fakeHome, ".git"), { recursive: true });
        mkdirSync(join(fakeHome, "sub"));
        pin(fakeHome);
        pin(join(fakeHome, "sub"));
        pin(missing);
        __setProjectIdentityTestHooks({ homeDirectory: () => fakeHome });
        expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(fakeHome, "sub"))).toBeUndefined();
        expect(() => resolveProjectIdentityStrict(missing)).toThrow(
            "Unable to access project directory",
        );
        expect(resolveProjectIdentity(missing)).toStartWith("dir:");
        expect(resolveProjectIdentityForSession(missing)).not.toBe("pj-A");
    });
});

describe("resolveProjectIdentity directory fallback", () => {
    test("refuses the exact canonical home directory unless the user opts in", () => {
        expect(resolveProjectIdentityForSession(homedir())).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(homedir(), "a-project"))).not.toBeUndefined();
    });

    // Agents read this text; it must name the home-directory rule and the opt-in,
    // not leave them to guess "no git repo" (which resolves fine).
    test("explains the home-directory refusal with the opt-in", () => {
        const reason = describeUnresolvedProjectIdentity(homedir());
        expect(reason).toContain("home directory");
        expect(reason).toContain("allow_home_project");
        expect(reason).not.toContain("git");
    });

    test("uses the canonical home directory's stable dir identity when opted in", () => {
        const canonicalHome = realpathSync.native(homedir());
        const expected = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

        expect(resolveProjectIdentityForSession(homedir(), true)).toBe(expected);
    });

    test("resolves a project identity when sandbox policy denies realpath for the home directory", () => {
        const project = tempDir();
        const deniedHome = tempDir();
        const originalNative = realpathSync.native;
        const permissionDenied = (): NodeJS.ErrnoException => {
            const error = new Error("sandbox denied realpath") as NodeJS.ErrnoException;
            error.code = "EPERM";
            return error;
        };
        __setProjectIdentityTestHooks({ homeDirectory: () => deniedHome });
        Object.defineProperty(realpathSync, "native", {
            configurable: true,
            value: (() => {
                throw permissionDenied();
            }) as typeof realpathSync.native,
        });

        try {
            const expected = `dir:${createHash("md5")
                .update(project, "utf8")
                .digest("hex")
                .slice(0, 12)}`;
            expect(resolveProjectIdentityForSession(project)).toBe(expected);
        } finally {
            Object.defineProperty(realpathSync, "native", {
                configurable: true,
                value: originalNative,
            });
            rmSync(project, { recursive: true, force: true });
            rmSync(deniedHome, { recursive: true, force: true });
        }
    });

    test("keeps a contained repository distinct from the home identity", () => {
        const contained = createTestTempDirFromPath(join(homedir(), "mc-home-identity-"));
        try {
            mkdirSync(join(contained, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
            const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
            const containedIdentity = resolveProjectIdentityForSession(contained, true);

            expect(homeIdentity).toBeDefined();
            expect(containedIdentity).toBe("git:abc1234");
            expect(containedIdentity).not.toBe(homeIdentity);
        } finally {
            rmSync(contained, { recursive: true, force: true });
        }
    });

    test("requires home opt-in when a child inherits the home git repository", () => {
        const fakeHome = tempDir();
        const child = join(fakeHome, "nested", "project");
        try {
            mkdirSync(join(fakeHome, ".git"));
            mkdirSync(child, { recursive: true });
            __setProjectIdentityTestHooks({
                execFileSync: returningRootCommit("def5678"),
                homeDirectory: () => fakeHome,
            });
            // Opt-in permits memory, not a second identity for the home repository.
            const expectedHomeIdentity = "git:def5678";

            expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
            expect(resolveProjectIdentityForSession(child)).toBeUndefined();
            expect(resolveProjectIdentityForSession(fakeHome, true)).toBe(expectedHomeIdentity);
            expect(resolveProjectIdentityForSession(child, true)).toBe(expectedHomeIdentity);
        } finally {
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });
    test("flips dir: fallback to git: once a repo gains its first commit (no stale cache)", () => {
        const dir = tempDir();
        try {
            const first = resolveProjectIdentity(dir);
            expect(first).toMatch(/^dir:[0-9a-f]{12}$/);
            expect(resolveProjectIdentity(dir)).toBe(first);

            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });

            const second = resolveProjectIdentity(dir);
            expect(second).toBe("git:abc1234");
            expect(second).not.toBe(first);
            expect(resolveProjectIdentity(dir)).toBe(second);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("keeps the remembered git identity for a leftover worktree folder with no git metadata", () => {
        const dir = tempDir();
        const neverResolved = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("fedcba9") });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");

            // A new process sees only the durable sidecar. Removing the worktree's git
            // metadata leaves an empty folder that git no longer recognizes.
            __resetProjectIdentityForTests();
            rmSync(join(dir, ".git"), { recursive: true, force: true });
            expect(resolveProjectIdentity(dir)).toBe("git:fedcba9");
            expect(resolveProjectIdentityForSession(dir)).toBe("git:fedcba9");

            // A plain folder the plugin never resolved to git keeps its directory identity.
            expect(resolveProjectIdentity(neverResolved)).toBe(
                `dir:${createHash("md5").update(neverResolved, "utf8").digest("hex").slice(0, 12)}`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(neverResolved, { recursive: true, force: true });
        }
    });

    test("derives a deterministic identity from grafted-history repos (multiple root commits)", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            // Repos merged with --allow-unrelated-histories keep several live root
            // commits, and git's enumeration order varies by traversal. The identity
            // must be the lexicographic minimum of the SET, not the first line.
            __setProjectIdentityTestHooks({
                execFileSync: (() =>
                    "7e96b9e\n1e394c2\n4058752\n") as unknown as typeof execFileSync,
            });
            expect(resolveProjectIdentity(dir)).toBe("git:1e394c2");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reuses a parent repository identity for subdirectory transient git failures", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("def5678") });
            const parentIdentity = resolveProjectIdentity(dir);
            const subdir = join(dir, "nested", "child");
            mkdirSync(subdir, { recursive: true });

            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw new Error("temporary git failure");
                }) as unknown as typeof execFileSync,
            });

            expect(resolveProjectIdentity(subdir)).toBe(parentIdentity);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
