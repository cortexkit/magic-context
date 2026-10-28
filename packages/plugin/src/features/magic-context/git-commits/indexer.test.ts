import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../../config";
import { isCommitRetentionPaused } from "../../../config/commit-retention-recovery";
import { sweepGitCommits } from "../../../plugin/dream-timer";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { readGitCommitsResult } from "./git-log-reader";
import { indexCommitsForProject } from "./indexer";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("indexCommitsForProject against a real repository", () => {
    let db: Database;
    let dir: string;

    const git = (args: string[], dateMs?: number) => {
        // Run git hermetically: a caller's GIT_CONFIG_* overrides (an editor or agent
        // can inject core.hooksPath this way) and the user's global or system config
        // could add hooks that rewrite the commit messages these tests compare.
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (!key.startsWith("GIT_")) env[key] = value;
        }
        env.GIT_CONFIG_GLOBAL = "/dev/null";
        env.GIT_CONFIG_NOSYSTEM = "1";
        if (dateMs !== undefined) {
            const stamp = `@${Math.floor(dateMs / 1000)} +0000`;
            env.GIT_AUTHOR_DATE = stamp;
            env.GIT_COMMITTER_DATE = stamp;
        }
        return execFileSync("git", args, { cwd: dir, env, encoding: "utf8", windowsHide: true });
    };
    const commit = (file: string, message: string, dateMs: number) => {
        writeFileSync(join(dir, file), `${message}\n`);
        git(["add", file]);
        git(["-c", "commit.gpgsign=false", "commit", "-qm", message], dateMs);
    };
    const indexedMessages = () =>
        (
            db
                .prepare("SELECT message FROM git_commits WHERE project_path = ? ORDER BY message")
                .all("git:repo") as { message: string }[]
        ).map((row) => row.message);
    const sweep = () =>
        indexCommitsForProject(db, "git:repo", dir, {
            sinceDays: 30,
            maxCommits: 100,
            skipEmbed: true,
        });

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        dir = createTestTempDirFromPath(join(tmpdir(), "mc-git-indexer-test-"));
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
    });

    afterEach(() => {
        closeQuietly(db);
        rmSync(dir, { recursive: true, force: true });
    });

    it("indexes merged branch commits whose committer date predates the indexed tip", async () => {
        const now = Date.now();
        commit("base.txt", "base commit", now - 5 * DAY_MS);
        git(["checkout", "-q", "-b", "feature"]);
        commit("feature.txt", "feature work from two days ago", now - 2 * DAY_MS);
        git(["checkout", "-q", "main"]);
        commit("main.txt", "main tip commit", now - 60 * 60 * 1000);

        await sweep();
        expect(indexedMessages()).toEqual(["base commit", "main tip commit"]);

        git(
            ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "feature"],
            now,
        );
        await sweep();

        expect(indexedMessages()).toEqual([
            "base commit",
            "feature work from two days ago",
            "main tip commit",
        ]);
    });

    it("retains overflow and vectors for a recovered cap but evicts for a valid cap", async () => {
        db.exec("PRAGMA foreign_keys = ON");
        const userConfig = createTestTempDirFromPath(join(tmpdir(), "mc-git-cap-config-"));
        const oldXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = userConfig;
        mkdirSync(join(userConfig, "cortexkit"), { recursive: true });
        const configPath = join(userConfig, "cortexkit", "magic-context.jsonc");
        try {
            writeFileSync(
                configPath,
                JSON.stringify({
                    memory: { git_commit_indexing: { enabled: true, max_commits: 0 } },
                }),
            );
            const recovered = loadPluginConfigDetailed(dir, false).config.memory
                .git_commit_indexing;
            expect(recovered.max_commits).toBe(2000);
            const insert =
                db.prepare(`INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
                VALUES (?, 'git:repo', ?, 'stored commit', NULL, ?, ?)`);
            const vector = db.prepare(
                "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) VALUES (?, ?, 'fixture', 0)",
            );
            db.transaction(() => {
                for (let i = 0; i < 2001; i++) {
                    const sha = i.toString(16).padStart(40, "0");
                    insert.run(sha, sha.slice(0, 7), i, i);
                    vector.run(sha, new Uint8Array(4));
                }
            })();
            commit("tip.txt", "new tip still indexed", Date.now());
            const options = {
                sinceDays: recovered.since_days,
                maxCommits: recovered.max_commits,
                skipRetention: isCommitRetentionPaused(recovered),
                skipEmbed: true,
            };
            const first = await indexCommitsForProject(db, "git:repo", dir, options);
            expect(first.inserted).toBe(1);
            expect(first.evicted).toBe(0);
            const repeated = await indexCommitsForProject(db, "git:repo", dir, options);
            expect(repeated.scanned).toBe(0);
            expect(repeated.evicted).toBe(0);
            await sweepGitCommits({
                directory: dir,
                projectIdentity: "git:repo",
                db,
                gitCommitIndexing: recovered,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM git_commits").get()).toEqual({ n: 2002 });
            expect(db.prepare("SELECT COUNT(*) AS n FROM git_commit_embeddings").get()).toEqual({
                n: 2001,
            });

            writeFileSync(
                configPath,
                JSON.stringify({
                    memory: { git_commit_indexing: { enabled: true, max_commits: 100 } },
                }),
            );
            const valid = loadPluginConfigDetailed(dir, false).config.memory.git_commit_indexing;
            const capped = await indexCommitsForProject(db, "git:repo", dir, {
                sinceDays: valid.since_days,
                maxCommits: valid.max_commits,
                skipRetention: isCommitRetentionPaused(valid),
                skipEmbed: true,
            });
            expect(capped.evicted).toBe(1902);
            expect(db.prepare("SELECT COUNT(*) AS n FROM git_commits").get()).toEqual({ n: 100 });
            expect(db.prepare("SELECT COUNT(*) AS n FROM git_commit_embeddings").get()).toEqual({
                n: 99,
            });
        } finally {
            if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = oldXdg;
            rmSync(userConfig, { recursive: true, force: true });
        }
    });

    it("falls back to the full window when the latest indexed commit no longer exists", async () => {
        const now = Date.now();
        commit("a.txt", "first commit", now - 3 * DAY_MS);
        commit("b.txt", "second commit", now - 2 * DAY_MS);
        // The latest indexed commit was rewritten away and garbage-collected.
        db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES (?, 'git:repo', 'aaaaaaa', 'rewritten away', NULL, ?, ?)`,
        ).run("a".repeat(40), now - DAY_MS, now - DAY_MS);

        const result = await sweep();

        expect(result.nonIndexable).toBe(false);
        expect(indexedMessages()).toEqual(["first commit", "rewritten away", "second commit"]);
    });

    it("reads history when a worktree file is named HEAD", async () => {
        commit("HEAD", "commit adding a file named HEAD", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.failure).toBeNull();
        expect(read.commits.map((entry) => entry.message)).toEqual([
            "commit adding a file named HEAD",
        ]);
    });

    it("reads a SHA-256 repository", async () => {
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        git(["init", "-q", "--object-format=sha256", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        commit("a.txt", "sha256 commit", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.commits.map((entry) => [entry.message, entry.sha.length])).toEqual([
            ["sha256 commit", 64],
        ]);
    });
});
