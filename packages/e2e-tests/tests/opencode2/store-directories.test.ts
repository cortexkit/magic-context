import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateStoreDirectories } from "../../src/opencode2-runner/store-directories";

test("copied store paths are relocated in all host and MC directory columns", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-store-directories-"));
    const oc = join(root, "opencode.db"), mc = join(root, "context.db");
    const repo = "/some/real/repo";
    const host = new Database(oc);
    host.exec("CREATE TABLE session (directory TEXT); CREATE TABLE project (worktree TEXT, directory TEXT)");
    host.query("INSERT INTO session VALUES (?)").run(repo);
    host.query("INSERT INTO project VALUES (?, ?)").run(repo, repo);
    host.query("INSERT INTO project VALUES (?, ?)").run("/", "/");
    host.close();
    const context = openTestDb(mc);
    context.exec("CREATE TABLE session_projects (project_path TEXT)");
    context.query("INSERT INTO session_projects VALUES (?)").run(repo);
    context.query("INSERT INTO session_projects VALUES (?)").run("dir:synthetic-project");
    context.close();
    expect(isolateStoreDirectories(root, oc, mc)).toEqual([repo]);
    for (const [path, table, column] of [[oc, "session", "directory"], [oc, "project", "worktree"], [oc, "project", "directory"], [mc, "session_projects", "project_path"]]) {
        const db = openTestDb(path!);
        expect((db.query(`SELECT ${column} AS path FROM ${table}`).get() as { path: string }).path).toStartWith(join(realpathSync(root), "replayed-projects"));
        db.close();
    }
    expect(isolateStoreDirectories(root, oc, mc)).toEqual([]);
    const identities = openTestDb(mc);
    expect((identities.query("SELECT project_path FROM session_projects WHERE project_path LIKE 'dir:%'").get() as { project_path: string }).project_path).toBe("dir:synthetic-project");
    identities.close();
});

test("copied store rejects unrecognized relative project directories", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-store-directories-"));
    const oc = join(root, "opencode.db");
    const db = new Database(oc);
    db.exec("CREATE TABLE session (directory TEXT); INSERT INTO session VALUES ('../escape')");
    db.close();
    expect(() => isolateStoreDirectories(root, oc, join(root, "missing.db"))).toThrow("E2E_STORE_DIRECTORY_OUTSIDE_ROOT");
});
