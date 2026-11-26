import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentityStrict } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    projectDirectoryKey,
    readRememberedGitIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { countIdentityRows } from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { Database } from "@magic-context/core/shared/sqlite";
import { isolatedTestGitEnv } from "@magic-context/core/shared/test-git-env";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { diagnoseIdentitySplits, formatIdentitySplits } from "./doctor-identity-splits";
import { runMergeIdentityCli } from "./doctor-merge-identity";

// Every path here lives under one throwaway root; no live store, config, or cache is read.
const root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-merge-safety-")));
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED_ENV = {
    MAGIC_CONTEXT_STORAGE_DIR: join(root, "env-storage"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
};
let templatePath = "";
let fixtureCounter = 0;
const noHolderDeps = {
    inspectHolders: () => ({ safe: true, blockers: [] }),
    probe: () => ({ status: "free" as const }),
};

beforeAll(() => {
    for (const [key, value] of Object.entries(ISOLATED_ENV)) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }
    // Replaying the migration chain is slow, so build the schema once and copy it.
    templatePath = join(root, "template.db");
    const db = new Database(templatePath);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
}, 60_000);

afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

let logSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
    logSpy?.mockRestore();
    logSpy = undefined;
});

function md5Identity(directory: string): string {
    return `dir:${createHash("md5").update(directory, "utf8").digest("hex").slice(0, 12)}`;
}

function gitIdentity(seed: string): string {
    return `git:${createHash("sha1").update(seed).digest("hex")}`;
}

function fileHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Store {
    storageDir: string;
    dbPath: string;
    db: Database;
    host: Database;
}

function newStore(): Store {
    const storageDir = join(root, `store-${++fixtureCounter}`);
    mkdirSync(storageDir, { recursive: true });
    const dbPath = join(storageDir, "context.db");
    copyFileSync(templatePath, dbPath);
    const host = new Database(join(storageDir, "host.db"));
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    return { storageDir, dbPath, db: new Database(dbPath), host };
}

function closeStore(store: Store): void {
    store.db.close();
    store.host.close();
}

/** A directory with content, so it is a live (non-leftover) project folder. */
function liveDirectory(name: string): string {
    const directory = join(root, `${name}-${++fixtureCounter}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "README.md"), "fixture\n");
    return directory;
}

/** The project-identities sidecar the plugin writes after resolving a path to git. */
function persistIdentity(store: Store, directory: string, identity: string): void {
    const sidecars = join(store.storageDir, "project-identities");
    mkdirSync(sidecars, { recursive: true });
    const key = projectDirectoryKey(directory);
    writeFileSync(
        join(sidecars, `${createHash("sha256").update(key).digest("hex")}.json`),
        JSON.stringify({ directory: key, identity }),
    );
}

/** Record a host session in `directory` bound to `identity`. */
function bindSession(store: Store, sessionId: string, directory: string, identity: string): void {
    store.host.prepare("INSERT INTO session VALUES (?, ?)").run(sessionId, directory);
    store.db
        .prepare("INSERT INTO session_projects VALUES (?, 'opencode', ?, 1)")
        .run(sessionId, identity);
}

function seedRows(
    store: Store,
    identity: string,
    counts: { memories?: number; sessions?: number; dreamRuns?: number; tasks?: number },
): void {
    const { db } = store;
    db.prepare("INSERT OR IGNORE INTO project_state(project_path) VALUES (?)").run(identity);
    for (let i = 0; i < (counts.memories ?? 0); i++)
        db.prepare(
            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'fact', ?, ?, 1, 1, 1, 1)",
        ).run(identity, `${identity} memory ${i}`, `${identity}-${i}`);
    for (let i = 0; i < (counts.sessions ?? 0); i++)
        db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(
            `${identity}-pi-${i}`,
            identity,
        );
    for (let i = 0; i < (counts.dreamRuns ?? 0); i++)
        db.prepare(
            "INSERT INTO dream_runs(project_path, started_at, finished_at, holder_id, tasks_json) VALUES (?, 1, 2, 'h', '[]')",
        ).run(identity);
    for (let i = 0; i < (counts.tasks ?? 0); i++)
        db.prepare("INSERT INTO task_schedule_state(project_path, task) VALUES (?, ?)").run(
            identity,
            `task-${i}`,
        );
}

function captureLog(): () => string {
    logSpy?.mockRestore();
    const lines: string[] = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    });
    return () => lines.join("\n");
}

function proposalLines(output: string): string[] {
    return output.split("\n").filter((line) => line.includes("→"));
}

function git(directory: string, ...args: string[]): string {
    return execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: isolatedTestGitEnv({ GIT_CONFIG_GLOBAL: join(root, "empty-git-config") }),
    }).trim();
}

function newRepository(name: string): { directory: string; identity: string } {
    const directory = liveDirectory(name);
    git(directory, "init", "-q");
    git(
        directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        name,
    );
    return { directory, identity: `git:${git(directory, "rev-parse", "HEAD")}` };
}

function sidecarPath(store: Store, directory: string): string {
    return join(
        store.storageDir,
        "project-identities",
        `${createHash("sha256").update(projectDirectoryKey(directory)).digest("hex")}.json`,
    );
}

function seedGitMerge(
    store: Store,
    source: ReturnType<typeof newRepository>,
    target: ReturnType<typeof newRepository>,
): void {
    persistIdentity(store, source.directory, source.identity);
    persistIdentity(store, target.directory, target.identity);
    seedRows(store, source.identity, { memories: 2, sessions: 2, dreamRuns: 1, tasks: 2 });
    seedRows(store, target.identity, { memories: 1, sessions: 1, dreamRuns: 1, tasks: 1 });
    bindSession(store, "old-root-session", source.directory, source.identity);
    bindSession(store, "new-root-session", target.directory, target.identity);
}

function assertGitMergeRows(store: Store, from: string, to: string, hostSessions = 2): void {
    const db = new Database(store.dbPath);
    try {
        expect(countIdentityRows(db, from)).toBe(0);
        for (const [table, count] of [
            ["memories", 3],
            ["session_projects", 3 + hostSessions],
            ["dream_runs", 2],
            ["task_schedule_state", 2],
            ["project_state", 1],
        ] as const)
            expect(
                db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_path = ?`).get(to),
            ).toEqual({ n: count });
        expect(
            db
                .prepare(
                    "SELECT new_project_path FROM v22_identity_rekey_map WHERE old_project_path = ?",
                )
                .get(from),
        ).toEqual({ new_project_path: to });
        expect(db.prepare("SELECT content FROM memories ORDER BY content").all()).toEqual(
            [`${from} memory 0`, `${from} memory 1`, `${to} memory 0`]
                .sort()
                .map((content) => ({ content })),
        );
    } finally {
        db.close();
    }
}

function reclonedMergeFixture(): {
    store: Store;
    source: ReturnType<typeof newRepository>;
    target: ReturnType<typeof newRepository>;
} {
    const store = newStore();
    const source = newRepository("old-public-history");
    const target = newRepository("new-public-history");
    seedGitMerge(store, source, target);
    // Warm the plugin's cache with the old root; preview and apply must still probe the new checkout.
    expect(resolveProjectIdentityStrict(source.directory)).toBe(source.identity);
    rmSync(source.directory, { recursive: true });
    git(root, "clone", "-q", target.directory, source.directory);
    return { store, source, target };
}

function deletedSessionMergeFixture(count = 48): {
    store: Store;
    source: ReturnType<typeof newRepository>;
    target: ReturnType<typeof newRepository>;
    directories: string[];
} {
    const store = newStore();
    const source = newRepository("deleted-session-source");
    const target = newRepository("deleted-session-target");
    const directories = Array.from({ length: count }, (_, index) =>
        join(root, `deleted-worker-${++fixtureCounter}-${index}`),
    );
    seedGitMerge(store, { ...source, directory: directories[0] }, target);
    rmSync(sidecarPath(store, directories[0]));
    for (const [index, directory] of directories.entries()) {
        mkdirSync(directory);
        rmSync(directory, { recursive: true });
        if (index > 0)
            bindSession(store, `deleted-worker-session-${index}`, directory, source.identity);
    }
    return { store, source, target, directories };
}

describe("doctor merge-identities stale source sidecars", () => {
    it("allows a re-cloned source with a new-root worktree and repins without changing merge semantics", () => {
        const { store, source, target } = reclonedMergeFixture();
        const worktree = join(root, `new-root-worktree-${++fixtureCounter}`);
        git(target.directory, "worktree", "add", "--detach", worktree);
        bindSession(store, "new-worktree-session", worktree, target.identity);
        closeStore(store);
        const beforeDb = fileHash(store.dbPath);
        const beforeSidecar = fileHash(sidecarPath(store, source.directory));
        const output = captureLog();
        const args = ["--db", store.dbPath, "--from", source.identity, "--to", target.identity];

        expect(runMergeIdentityCli(args, noHolderDeps)).toBe(0);
        expect(output()).toContain(
            `Sidecar for ${source.directory}: overwrite with ${target.identity} (live root now resolves to ${target.identity}; sidecar will be rewritten)`,
        );
        expect(fileHash(store.dbPath)).toBe(beforeDb);
        expect(fileHash(sidecarPath(store, source.directory))).toBe(beforeSidecar);
        expect(readRememberedGitIdentity(source.directory)).toBe(source.identity);
        expect(resolveProjectIdentityStrict(source.directory)).toBe(source.identity);
        expect(runMergeIdentityCli([...args, "--apply"], noHolderDeps)).toBe(0);
        for (const directory of [source.directory, target.directory, worktree])
            expect(JSON.parse(readFileSync(sidecarPath(store, directory), "utf8"))).toEqual({
                directory: projectDirectoryKey(directory),
                identity: target.identity,
            });
        assertGitMergeRows(store, source.identity, target.identity, 3);
    }, 30_000);

    it("allows different directory sets when every source-only directory has an allowance", () => {
        const { store, source, target } = reclonedMergeFixture();
        const orphan = join(root, `allowed-orphan-${++fixtureCounter}`);
        persistIdentity(store, orphan, source.identity);
        bindSession(store, "orphan-session", orphan, source.identity);
        closeStore(store);
        const output = captureLog();
        expect(
            runMergeIdentityCli(
                [
                    "--db",
                    store.dbPath,
                    "--from",
                    source.identity,
                    "--to",
                    target.identity,
                    "--apply",
                ],
                noHolderDeps,
            ),
        ).toBe(0);
        expect(output()).toContain(
            `Sidecar for ${source.directory}: overwrite with ${target.identity} (live root now resolves to ${target.identity}; sidecar will be rewritten)`,
        );
        expect(output()).toContain(
            `1 source-only folders no longer exist: allowed (1 orphaned sidecar(s) will be rewritten to ${target.identity})`,
        );
        for (const directory of [source.directory, orphan])
            expect(JSON.parse(readFileSync(sidecarPath(store, directory), "utf8"))).toEqual({
                directory: projectDirectoryKey(directory),
                identity: target.identity,
            });
        assertGitMergeRows(store, source.identity, target.identity, 3);
    }, 30_000);

    it("allows an orphaned worktree source sidecar and rewrites it to the target", () => {
        const store = newStore();
        const repository = newRepository("old-worktree-history");
        const target = newRepository("orphan-target-history");
        const directory = join(root, `removed-worktree-${++fixtureCounter}`);
        git(repository.directory, "worktree", "add", "--detach", directory);
        const source = { directory, identity: repository.identity };
        seedGitMerge(store, source, target);
        git(repository.directory, "worktree", "remove", "--force", directory);
        expect(existsSync(directory)).toBe(false);
        closeStore(store);
        const beforeDb = fileHash(store.dbPath);
        const beforeSidecar = fileHash(sidecarPath(store, directory));
        const output = captureLog();
        const args = ["--db", store.dbPath, "--from", source.identity, "--to", target.identity];

        expect(runMergeIdentityCli(args, noHolderDeps)).toBe(0);
        expect(output()).toContain(
            `1 source-only folders no longer exist: allowed (1 orphaned sidecar(s) will be rewritten to ${target.identity})`,
        );
        expect(output()).not.toContain(directory);
        expect(fileHash(store.dbPath)).toBe(beforeDb);
        expect(fileHash(sidecarPath(store, directory))).toBe(beforeSidecar);
        const verboseOutput = captureLog();
        expect(runMergeIdentityCli([...args, "--verbose"], noHolderDeps)).toBe(0);
        expect(verboseOutput()).toContain(
            `Sidecar for ${directory}: overwrite with ${target.identity} (orphaned; sidecar will be rewritten)`,
        );
        expect(runMergeIdentityCli([...args, "--apply"], noHolderDeps)).toBe(0);
        expect(JSON.parse(readFileSync(sidecarPath(store, directory), "utf8"))).toEqual({
            directory: projectDirectoryKey(directory),
            identity: target.identity,
        });
        expect(existsSync(directory)).toBe(false);
        assertGitMergeRows(store, source.identity, target.identity);
        expect(runMergeIdentityCli(["--db", store.dbPath], noHolderDeps)).toBe(0);
        expect(verboseOutput()).toContain("No detected identity splits.");
    }, 30_000);

    for (const resolution of ["source", "third", "failure"] as const)
        it(`refuses a persisted source when the live probe resolves to ${resolution}`, () => {
            const store = newStore();
            const source = newRepository(`refused-${resolution}-source`);
            const target = newRepository(`refused-${resolution}-target`);
            seedGitMerge(store, source, target);
            if (resolution === "third") {
                const third = newRepository("third-history");
                rmSync(source.directory, { recursive: true });
                git(root, "clone", "-q", third.directory, source.directory);
            } else if (resolution === "failure") {
                writeFileSync(join(source.directory, ".git", "HEAD"), "ref: refs/heads/missing\n");
            }
            closeStore(store);
            const beforeDb = fileHash(store.dbPath);
            const beforeSidecar = fileHash(sidecarPath(store, source.directory));
            for (const extra of [[], ["--apply", "--force"]])
                expect(() =>
                    runMergeIdentityCli(
                        [
                            "--db",
                            store.dbPath,
                            "--from",
                            source.identity,
                            "--to",
                            target.identity,
                            ...extra,
                        ],
                        noHolderDeps,
                    ),
                ).toThrow(`${source.identity} is the identity the plugin persisted for`);
            expect(fileHash(store.dbPath)).toBe(beforeDb);
            expect(fileHash(sidecarPath(store, source.directory))).toBe(beforeSidecar);
            expect(
                readdirSync(store.storageDir).filter((name) => name.startsWith("identity-merge")),
            ).toEqual([]);
        }, 30_000);

    it("refuses different directories when one source-only directory has no stale-sidecar allowance", () => {
        const { store, source, target } = reclonedMergeFixture();
        const unallowed = liveDirectory("unallowed-source");
        bindSession(store, "unallowed-session", unallowed, source.identity);
        closeStore(store);
        const before = fileHash(store.dbPath);
        expect(() =>
            runMergeIdentityCli(
                [
                    "--db",
                    store.dbPath,
                    "--from",
                    source.identity,
                    "--to",
                    target.identity,
                    "--apply",
                    "--force",
                ],
                noHolderDeps,
            ),
        ).toThrow("Refusing different directories");
        expect(fileHash(store.dbPath)).toBe(before);
    }, 30_000);

    it("allows many deleted session-only source folders and summarizes the preview", () => {
        const { store, source, target, directories } = deletedSessionMergeFixture();
        closeStore(store);
        const before = fileHash(store.dbPath);
        const args = ["--db", store.dbPath, "--from", source.identity, "--to", target.identity];
        const output = captureLog();
        expect(runMergeIdentityCli(args, noHolderDeps)).toBe(0);
        const summary = "48 source-only folders no longer exist: allowed";
        expect(output()).toContain(`${summary}. Use --verbose for the full list.`);
        expect(output().split(summary)).toHaveLength(2);
        expect(output()).toContain("Identity merge preview:");
        for (const directory of directories) {
            expect(output()).not.toContain(directory);
            expect(existsSync(sidecarPath(store, directory))).toBe(false);
        }
        expect(fileHash(store.dbPath)).toBe(before);

        const verboseOutput = captureLog();
        expect(runMergeIdentityCli([...args, "--verbose"], noHolderDeps)).toBe(0);
        for (const directory of directories)
            expect(verboseOutput()).toContain(`${directory} (orphaned; no persisted sidecar)`);
        expect(verboseOutput()).not.toContain("Use --verbose");
        expect(fileHash(store.dbPath)).toBe(before);
        expect(runMergeIdentityCli([...args, "--apply"], noHolderDeps)).toBe(0);
        assertGitMergeRows(store, source.identity, target.identity, directories.length + 1);
        for (const directory of directories) {
            expect(existsSync(directory)).toBe(false);
            expect(JSON.parse(readFileSync(sidecarPath(store, directory), "utf8"))).toEqual({
                directory: projectDirectoryKey(directory),
                identity: target.identity,
            });
        }
    }, 30_000);

    it("refuses deleted session-only source folders mixed with one existing unallowed folder", () => {
        const { store, source, target } = deletedSessionMergeFixture();
        const existing = liveDirectory("existing-unallowed-worker");
        bindSession(store, "existing-worker-session", existing, source.identity);
        closeStore(store);
        const before = fileHash(store.dbPath);
        captureLog();
        for (const extra of [[], ["--apply", "--force"]])
            expect(() =>
                runMergeIdentityCli(
                    [
                        "--db",
                        store.dbPath,
                        "--from",
                        source.identity,
                        "--to",
                        target.identity,
                        ...extra,
                    ],
                    noHolderDeps,
                ),
            ).toThrow("Refusing different directories");
        expect(fileHash(store.dbPath)).toBe(before);
        expect(existsSync(sidecarPath(store, existing))).toBe(false);
    }, 30_000);

    it("rechecks missing session-only source folders under the write handle", () => {
        const { store, source, target, directories } = deletedSessionMergeFixture(2);
        closeStore(store);
        const before = fileHash(store.dbPath);
        captureLog();
        expect(() =>
            runMergeIdentityCli(
                [
                    "--db",
                    store.dbPath,
                    "--from",
                    source.identity,
                    "--to",
                    target.identity,
                    "--apply",
                ],
                {
                    ...noHolderDeps,
                    inspectHolders: () => {
                        mkdirSync(directories[0]);
                        return { safe: true, blockers: [] };
                    },
                },
            ),
        ).toThrow("Refusing different directories");
        expect(fileHash(store.dbPath)).toBe(before);
        expect(existsSync(sidecarPath(store, directories[0]))).toBe(false);
    }, 30_000);

    it("rechecks the live root under the write handle instead of trusting the preview", () => {
        const { store, source, target } = reclonedMergeFixture();
        closeStore(store);
        const third = newRepository("root-changed-after-preview");
        const beforeDb = fileHash(store.dbPath);
        const beforeSidecar = fileHash(sidecarPath(store, source.directory));
        captureLog();
        expect(() =>
            runMergeIdentityCli(
                [
                    "--db",
                    store.dbPath,
                    "--from",
                    source.identity,
                    "--to",
                    target.identity,
                    "--apply",
                ],
                {
                    ...noHolderDeps,
                    inspectHolders: () => {
                        rmSync(source.directory, { recursive: true });
                        git(root, "clone", "-q", third.directory, source.directory);
                        return { safe: true, blockers: [] };
                    },
                },
            ),
        ).toThrow(`${source.identity} is the identity the plugin persisted for`);
        expect(fileHash(store.dbPath)).toBe(beforeDb);
        expect(fileHash(sidecarPath(store, source.directory))).toBe(beforeSidecar);
    }, 30_000);
});

describe("doctor merge-identities on a removed worktree's leftover folder", () => {
    it("proposes nothing and refuses both pairs from the suggestion, even with --apply --force", () => {
        const store = newStore();
        // An empty folder with no .git, as a removed linked worktree leaves behind.
        const worktree = join(root, "worktree", `wt-${++fixtureCounter}`, "repo-variant");
        mkdirSync(worktree, { recursive: true });
        const repository = gitIdentity("issue-repo");
        // The plugin hashes the session's own spelling; on Windows that differs from the
        // normalized key doctor probes, which is why the source and target hashes differ.
        const smallSource = md5Identity(`${worktree}-original-spelling`);
        const liveTarget = md5Identity(projectDirectoryKey(worktree));
        persistIdentity(store, worktree, repository);
        seedRows(store, repository, { memories: 40, sessions: 30, dreamRuns: 12, tasks: 4 });
        bindSession(store, "wt-git", worktree, repository);
        seedRows(store, smallSource, { tasks: 3 });
        bindSession(store, "wt-dir", worktree, smallSource);
        closeStore(store);
        const before = fileHash(store.dbPath);

        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Orphaned project path: ${worktree}`);
        expect(output()).toContain(`Identity the plugin persisted for this path: ${repository}`);
        expect(proposalLines(output())).toEqual([]);

        for (const pair of [
            { from: repository, to: liveTarget, reason: "repository-wide identity" },
            { from: smallSource, to: liveTarget, reason: `target ${liveTarget} owns no rows` },
        ])
            for (const extra of [["--apply", "--force"], ["--force"], []])
                expect(() =>
                    runMergeIdentityCli(
                        ["--db", store.dbPath, "--from", pair.from, "--to", pair.to, ...extra],
                        noHolderDeps,
                    ),
                ).toThrow(pair.reason);
        expect(fileHash(store.dbPath)).toBe(before);
        expect(
            readdirSync(store.storageDir).filter((name) => name.startsWith("identity-merge")),
        ).toEqual([]);
    }, 30_000);
});

describe("doctor merge-identities safety rules", () => {
    it("doctor lists abandoned folder keys and only offers an exact destination from matching move history", () => {
        const store = newStore();
        try {
            const source = liveDirectory("before move");
            const target = newRepository("after-move");
            const unknown = md5Identity(liveDirectory("missing move history"));
            const stillBound = md5Identity(liveDirectory("still bound"));
            const from = md5Identity(source);
            seedRows(store, from, { memories: 1 });
            seedRows(store, unknown, { memories: 2 });
            seedRows(store, stillBound, { memories: 1, sessions: 1 });
            store.db
                .prepare("INSERT INTO session_projects VALUES ('moved', 'opencode2', ?, 10)")
                .run(target.identity);
            store.host.exec(`CREATE TABLE session_v2(id TEXT, directory TEXT);
                CREATE TABLE event(aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)`);
            store.host.prepare("INSERT INTO session_v2 VALUES ('moved', ?)").run(target.directory);
            const record = store.host.prepare("INSERT INTO event VALUES ('moved', ?, ?, ?)");
            record.run(
                0,
                "session.created.1",
                JSON.stringify({ sessionID: "moved", location: { directory: source } }),
            );
            record.run(
                3,
                "session.moved.1",
                JSON.stringify({ sessionID: "moved", location: { directory: target.directory } }),
            );

            const storageDir = getMagicContextStorageDir();
            const storagePath = join(storageDir, "context.db");
            const hostDirectory = join(ISOLATED_ENV.XDG_DATA_HOME, "opencode");
            const hostPath = join(hostDirectory, "opencode.db");
            mkdirSync(storageDir, { recursive: true });
            mkdirSync(hostDirectory, { recursive: true });
            store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            store.host.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            copyFileSync(store.dbPath, storagePath);
            copyFileSync(join(store.storageDir, "host.db"), hostPath);
            const before = fileHash(storagePath);
            const hostBefore = fileHash(hostPath);
            const lines = diagnoseIdentitySplits().join("\n");

            expect(lines).toContain(
                `folder key ${from}: 1 memory; last used 1970-01-01T00:00:00.001Z`,
            );
            const sourceArg = `'${source}'`;
            expect(lines).toContain(
                `npx @cortexkit/magic-context@latest doctor merge-identities --from ${sourceArg} --to ${target.identity}\n  It shows what would move. Add --apply to move them.`,
            );
            expect(lines).toContain(`folder key ${unknown}: 2 memories`);
            expect(lines).toContain("The destination can't be determined.");
            expect(lines).toContain(
                `npx @cortexkit/magic-context@latest doctor merge-identities --from ${unknown} --to "DESTINATION_IDENTITY"\n  It shows what would move. Add --apply to move them.`,
            );
            expect(lines).not.toContain(stillBound);
            expect(fileHash(storagePath)).toBe(before);
            expect(fileHash(hostPath)).toBe(hostBefore);

            // The recorded binding can lag the host's location until the session's next turn.
            const copied = new Database(storagePath);
            try {
                copied
                    .prepare(
                        "UPDATE session_projects SET project_path = ? WHERE session_id = 'moved'",
                    )
                    .run(gitIdentity("stale-binding"));
            } finally {
                copied.close();
            }
            const stale = diagnoseIdentitySplits().join("\n");
            expect(stale).toContain(
                `npx @cortexkit/magic-context@latest doctor merge-identities --from ${sourceArg} --to "DESTINATION_IDENTITY"\n  It shows what would move. Add --apply to move them.`,
            );
            expect(stale).not.toContain(`--to ${target.identity}`);
        } finally {
            closeStore(store);
        }
    });

    it("previews and explicitly merges memories using a folder path as the source", () => {
        const store = newStore();
        try {
            const source = liveDirectory("old folder");
            const target = newRepository("new-repo");
            const from = md5Identity(source);
            seedRows(store, from, { memories: 1 });
            bindSession(store, "moved-session", target.directory, target.identity);
            const args = ["--db", store.dbPath, "--from", source, "--to", target.identity];
            const output = captureLog();

            expect(runMergeIdentityCli(args, noHolderDeps)).toBe(0);
            expect(output()).toContain(`Identity merge preview: ${from} → ${target.identity}`);
            expect(countIdentityRows(store.db, from)).toBeGreaterThan(0);

            expect(runMergeIdentityCli([...args, "--apply"], noHolderDeps)).toBe(0);
            expect(store.db.prepare("SELECT project_path FROM memories").all()).toEqual([
                { project_path: target.identity },
            ]);
            expect(readRememberedGitIdentity(source, store.storageDir)).toBeUndefined();
        } finally {
            closeStore(store);
        }
    });

    it("never treats a repository-wide git identity as a source in an explicit merge", () => {
        const store = newStore();
        const repository = gitIdentity("rule-1-explicit");
        seedRows(store, repository, { memories: 2, sessions: 2 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        closeStore(store);
        expect(() =>
            runMergeIdentityCli([
                "--db",
                store.dbPath,
                "--from",
                repository,
                "--to",
                "dir:aaaaaaaaaaaa",
                "--force",
            ]),
        ).toThrow("repository-wide identity");
    }, 30_000);

    it("never lists a repository-wide git identity as a split source", () => {
        const store = newStore();
        const directory = liveDirectory("rule-1-listing");
        const repository = gitIdentity("rule-1-listing");
        const live = md5Identity(directory);
        seedRows(store, repository, { memories: 3 });
        seedRows(store, live, { memories: 1 });
        bindSession(store, "git-session", directory, repository);
        bindSession(store, "dir-session", directory, live);
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`${repository}: repository-wide identity`);
        expect(proposalLines(output())).toEqual([]);
    }, 30_000);

    it("refuses an explicit merge into a known target that owns no rows", () => {
        const store = newStore();
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
        // Known only from an earlier merge's history, it owns nothing now.
        store.db
            .prepare(
                "INSERT INTO v22_identity_rekey_map(old_project_path, new_project_path, rekeyed_at) VALUES ('dir:bbbbbbbbbbbb', 'dir:cccccccccccc', 1)",
            )
            .run();
        closeStore(store);
        expect(() =>
            runMergeIdentityCli([
                "--db",
                store.dbPath,
                "--from",
                "dir:aaaaaaaaaaaa",
                "--to",
                "dir:bbbbbbbbbbbb",
                "--force",
            ]),
        ).toThrow("target dir:bbbbbbbbbbbb owns no rows while dir:aaaaaaaaaaaa owns");
    }, 30_000);

    it("does not suggest a live target that owns no rows", () => {
        const store = newStore();
        const directory = liveDirectory("rule-2-listing");
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
        seedRows(store, "dir:bbbbbbbbbbbb", { tasks: 1 });
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        bindSession(store, "b", directory, "dir:bbbbbbbbbbbb");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Target ${md5Identity(directory)} owns no rows`);
        expect(proposalLines(output())).toEqual([]);
    }, 30_000);

    it("refuses an explicit merge that contradicts the identity persisted for the path", () => {
        const store = newStore();
        const directory = liveDirectory("rule-3-explicit");
        const persisted = gitIdentity("rule-3-explicit");
        const other = gitIdentity("rule-3-other");
        persistIdentity(store, directory, persisted);
        seedRows(store, persisted, { memories: 2 });
        seedRows(store, other, { memories: 1 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        seedRows(store, "dir:bbbbbbbbbbbb", { memories: 1 });
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        bindSession(store, "o", directory, other);
        closeStore(store);
        const merge = (from: string, to: string) => () =>
            runMergeIdentityCli(["--db", store.dbPath, "--from", from, "--to", to, "--force"]);
        expect(merge("dir:aaaaaaaaaaaa", "dir:bbbbbbbbbbbb")).toThrow(
            `the plugin persisted ${persisted} for ${projectDirectoryKey(directory)}`,
        );
        expect(merge(persisted, other)).toThrow(
            `${persisted} is the identity the plugin persisted for`,
        );
    }, 30_000);

    it("suggests the persisted identity over a disagreeing live resolution", () => {
        const store = newStore();
        const directory = liveDirectory("rule-3-listing");
        const persisted = gitIdentity("rule-3-listing");
        const live = md5Identity(directory);
        persistIdentity(store, directory, persisted);
        seedRows(store, persisted, { memories: 2 });
        seedRows(store, live, { memories: 1 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        bindSession(store, "live", directory, live);
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Live resolution ${live} disagrees`);
        expect(proposalLines(output()).sort()).toEqual(
            [`  dir:aaaaaaaaaaaa → ${persisted}`, `  ${live} → ${persisted}`].sort(),
        );
    }, 30_000);

    it("reports a missing or empty git-less folder as orphaned instead of a split", () => {
        const store = newStore();
        const empty = join(root, `empty-${++fixtureCounter}`);
        mkdirSync(empty);
        const missing = join(root, `missing-${++fixtureCounter}`);
        const repository = gitIdentity("rule-4");
        seedRows(store, md5Identity(empty), { memories: 2 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        seedRows(store, repository, { memories: 2 });
        seedRows(store, "dir:bbbbbbbbbbbb", { memories: 1 });
        bindSession(store, "e1", empty, md5Identity(empty));
        bindSession(store, "e2", empty, "dir:aaaaaaaaaaaa");
        bindSession(store, "m1", missing, repository);
        bindSession(store, "m2", missing, "dir:bbbbbbbbbbbb");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(
            `Orphaned project path: ${empty} (directory is empty and has no git metadata)`,
        );
        expect(output()).toContain(
            `Orphaned project path: ${missing} (directory no longer exists)`,
        );
        expect(proposalLines(output())).toEqual([]);
        expect(formatIdentitySplits([{ directory: missing, identities: [] }]).join("\n")).toContain(
            `Orphaned project path: ${missing}`,
        );
    }, 30_000);
});

it("still merges two real directory splits into the persisted git identity that owns rows", () => {
    const store = newStore();
    const directory = liveDirectory("legit");
    execFileSync("git", ["init", "-q", directory], {
        env: isolatedTestGitEnv(),
        stdio: "ignore",
        windowsHide: true,
    });
    execFileSync(
        "git",
        [
            "-C",
            directory,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
        { env: isolatedTestGitEnv(), stdio: "ignore", windowsHide: true },
    );
    const repository = `git:${execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8", env: isolatedTestGitEnv(), windowsHide: true }).trim()}`;
    persistIdentity(store, directory, repository);
    seedRows(store, repository, { memories: 3 });
    bindSession(store, "g", directory, repository);
    seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
    seedRows(store, "dir:bbbbbbbbbbbb", { tasks: 1 });
    bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
    bindSession(store, "b", directory, "dir:bbbbbbbbbbbb");
    closeStore(store);

    const output = captureLog();
    expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
    expect(proposalLines(output()).sort()).toEqual([
        `  dir:aaaaaaaaaaaa → ${repository}`,
        `  dir:bbbbbbbbbbbb → ${repository}`,
    ]);
    for (const source of ["dir:aaaaaaaaaaaa", "dir:bbbbbbbbbbbb"])
        expect(
            runMergeIdentityCli(
                ["--db", store.dbPath, "--from", source, "--to", repository, "--apply"],
                noHolderDeps,
            ),
        ).toBe(0);

    const db = new Database(store.dbPath);
    try {
        expect(
            db
                .prepare(
                    "SELECT DISTINCT project_path FROM session_projects WHERE harness = 'opencode'",
                )
                .all(),
        ).toEqual([{ project_path: repository }]);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_path = ?").get(repository),
        ).toEqual({ n: 5 });
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM task_schedule_state WHERE project_path = ?")
                .get(repository),
        ).toEqual({ n: 1 });
    } finally {
        db.close();
    }
}, 30_000);
