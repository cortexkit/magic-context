import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { findIdentitySplits, formatIdentitySplits } from "./doctor-identity-splits";

test("identity inspections reuse path and count probes only within one request", () => {
    const directory = realpathSync(
        createTestTempDirFromPath(join(tmpdir(), "doctor-probe-reuse-")),
    );
    const db = new Database(":memory:");
    const host = new Database(":memory:");
    const canonicalProbe = spyOn(realpathSync, "native");
    const prepare = spyOn(db, "prepare");
    try {
        db.exec(
            "CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT); CREATE TABLE memories(project_path TEXT); CREATE TABLE notes(project_path TEXT)",
        );
        host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
        for (let i = 0; i < 3; i++) {
            host.prepare("INSERT INTO session VALUES (?, ?)").run(`s${i}`, directory);
            db.prepare("INSERT INTO session_projects VALUES (?, 'opencode', ?)").run(
                `s${i}`,
                i % 2 ? "git:aaa" : "dir:bbb",
            );
        }
        prepare.mockClear();
        const first = findIdentitySplits(db, host);
        expect(canonicalProbe).toHaveBeenCalledTimes(1);
        const countPreparations = prepare.mock.calls.filter(([sql]) =>
            String(sql).startsWith("SELECT COUNT(*) AS n"),
        );
        expect(countPreparations).toHaveLength(3);
        expect(first[0]?.identities.find((entry) => entry.identity === "git:aaa")?.memories).toBe(
            0,
        );
        db.prepare("INSERT INTO memories VALUES ('git:aaa')").run();
        const second = findIdentitySplits(db, host);
        expect(canonicalProbe).toHaveBeenCalledTimes(2);
        expect(second[0]?.identities.find((entry) => entry.identity === "git:aaa")?.memories).toBe(
            1,
        );
    } finally {
        canonicalProbe.mockRestore();
        prepare.mockRestore();
        host.close();
        db.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("reports dir/git and two-git splits from both host generations without changing rows", () => {
    const db = new Database(":memory:");
    const host = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT);
            CREATE TABLE memories(project_path TEXT); CREATE TABLE notes(project_path TEXT);
            CREATE TABLE task_schedule_state(project_path TEXT);
            INSERT INTO session_projects VALUES ('a','opencode','dir:aaa'), ('b','opencode2','git:bbb'), ('c','opencode','git:ccc'), ('d','opencode2','git:ddd'), ('a','pi','git:unrelated');
            INSERT INTO memories VALUES ('dir:aaa'), ('dir:aaa');
            INSERT INTO notes VALUES ('git:bbb');
            INSERT INTO task_schedule_state VALUES ('git:ccc');`);
        host.exec(`CREATE TABLE session(id TEXT, directory TEXT); CREATE TABLE session_v2(id TEXT, directory TEXT);
            INSERT INTO session VALUES ('a','G:/Phoenix/markt.de'), ('c','G:/Phoenix/Proteus');
            INSERT INTO session_v2 VALUES ('b','g:/phoenix/markt.de/'), ('d','g:/phoenix/Proteus');`);
        db.exec("PRAGMA query_only = ON");
        host.exec("PRAGMA query_only = ON");
        const before = db.prepare("SELECT total_changes() AS n").get();
        const splits = findIdentitySplits(db, host);
        expect(splits).toEqual([
            {
                directory: "g:/phoenix/markt.de",
                identities: [
                    { identity: "dir:aaa", sessions: 1, memories: 2, notes: 0, dreamer: 0 },
                    { identity: "git:bbb", sessions: 1, memories: 0, notes: 1, dreamer: 0 },
                ],
            },
            {
                directory: "g:/phoenix/proteus",
                identities: [
                    { identity: "git:ccc", sessions: 1, memories: 0, notes: 0, dreamer: 1 },
                    { identity: "git:ddd", sessions: 1, memories: 0, notes: 0, dreamer: 0 },
                ],
            },
        ]);
        expect(formatIdentitySplits(splits).join("\n")).toContain("read-only; no merge performed");
        expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally {
        host.close();
        db.close();
    }
});

test("reports directory data after the first commit before a git session binding exists", () => {
    const directory = realpathSync(
        createTestTempDirFromPath(join(tmpdir(), "doctor-first-commit-")),
    );
    const identity = `dir:${createHash("md5").update(directory).digest("hex").slice(0, 12)}`;
    const db = new Database(":memory:");
    const host = new Database(":memory:");
    try {
        execFileSync("git", ["init", "-q", directory], { windowsHide: true });
        db.exec(
            "CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT); CREATE TABLE memories(project_path TEXT)",
        );
        host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
        db.prepare("INSERT INTO session_projects VALUES ('a','opencode',?)").run(identity);
        db.prepare("INSERT INTO memories VALUES (?)").run(identity);
        host.prepare("INSERT INTO session VALUES ('a',?)").run(directory);
        db.exec("PRAGMA query_only = ON");
        host.exec("PRAGMA query_only = ON");
        const before = db.prepare("SELECT total_changes() AS n").get();
        expect(findIdentitySplits(db, host)).toEqual([]);
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
            { cwd: directory, windowsHide: true },
        );
        const root = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: directory,
            encoding: "utf8",
            windowsHide: true,
        }).trim();
        const splits = findIdentitySplits(db, host);
        expect(splits).toEqual([
            {
                directory,
                identities: [
                    { identity, sessions: 1, memories: 1, notes: 0, dreamer: 0 },
                    { identity: `git:${root}`, sessions: 0, memories: 0, notes: 0, dreamer: 0 },
                ],
            },
        ]);
        expect(formatIdentitySplits(splits).join("\n")).toContain("doctor merge-identities");
        expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally {
        host.close();
        db.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
