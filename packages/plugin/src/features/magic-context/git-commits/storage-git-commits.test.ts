import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import type { GitCommit } from "./git-log-reader";
import {
    enforceProjectCap,
    getCommitCount,
    getLatestIndexedCommitTimeMs,
    upsertCommits,
} from "./storage-git-commits";

function makeCommit(
    sha: string,
    committedAtMs: number,
    message = `commit ${sha.slice(0, 7)}`,
): GitCommit {
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message,
        author: "dev@example.com",
        committedAtMs,
    };
}

function openTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("storage-git-commits", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("inserts new commits and tracks count per project", () => {
        const result = upsertCommits(db, "git:proj", [
            makeCommit("a".repeat(40), 1700000000_000),
            makeCommit("b".repeat(40), 1700000100_000),
        ]);
        expect(result.inserted).toBe(2);
        expect(result.updated).toBe(0);
        expect(getCommitCount(db, "git:proj")).toBe(2);
    });

    it("updates when message changes, skips unchanged", () => {
        const commit = makeCommit("c".repeat(40), 1700000000_000, "original");
        upsertCommits(db, "git:proj", [commit]);

        const result = upsertCommits(db, "git:proj", [commit]);
        expect(result.inserted).toBe(0);
        expect(result.updated).toBe(0);

        const updated = upsertCommits(db, "git:proj", [{ ...commit, message: "amended" }]);
        expect(updated.updated).toBe(1);
    });

    it("reports latest indexed commit time", () => {
        upsertCommits(db, "git:proj", [
            makeCommit("a".repeat(40), 1000),
            makeCommit("b".repeat(40), 3000),
            makeCommit("c".repeat(40), 2000),
        ]);
        expect(getLatestIndexedCommitTimeMs(db, "git:proj")).toBe(3000);
    });

    it("evicts oldest commits when project cap exceeded", () => {
        const commits: GitCommit[] = [];
        for (let i = 0; i < 5; i += 1) {
            commits.push(makeCommit(String(i).padEnd(40, "0"), i * 1000));
        }
        upsertCommits(db, "git:proj", commits);
        expect(getCommitCount(db, "git:proj")).toBe(5);

        const evicted = enforceProjectCap(db, "git:proj", 3);
        expect(evicted).toBe(2);
        expect(getCommitCount(db, "git:proj")).toBe(3);

        // oldest two (timestamps 0, 1000) evicted, newest three (2000, 3000, 4000) kept
        expect(getLatestIndexedCommitTimeMs(db, "git:proj")).toBe(4000);
    });

    it("does not touch other projects when evicting", () => {
        upsertCommits(db, "git:a", [makeCommit("a".repeat(40), 1000)]);
        upsertCommits(db, "git:b", [
            makeCommit("b".repeat(40), 1000),
            makeCommit("c".repeat(40), 2000),
        ]);

        const evicted = enforceProjectCap(db, "git:b", 1);
        expect(evicted).toBe(1);
        expect(getCommitCount(db, "git:a")).toBe(1);
        expect(getCommitCount(db, "git:b")).toBe(1);
    });

    it("is a no-op when count is at or below cap", () => {
        upsertCommits(db, "git:proj", [
            makeCommit("a".repeat(40), 1000),
            makeCommit("b".repeat(40), 2000),
        ]);
        expect(enforceProjectCap(db, "git:proj", 2)).toBe(0);
        expect(enforceProjectCap(db, "git:proj", 5)).toBe(0);
    });
});
