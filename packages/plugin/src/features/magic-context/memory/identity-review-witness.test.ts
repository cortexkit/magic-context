import { afterEach, beforeEach, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { setHarness } from "../../../shared/harness";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { createCtxMemoryTools } from "../../../tools/ctx-memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { updateSessionMeta } from "../storage-meta-session";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    borrowedProjectIdentity,
    rememberResolvedProjectIdentity,
    resolveProjectIdentityForSession,
} from "./project-identity";
import { projectDirectoryKey } from "./project-identity-cache";
import { __setProjectPinWriterForTests, flushProjectPinWrites } from "./project-pin-writer";
import {
    __resetSessionIdentityDecisionsForTests,
    resolveSessionProjectIdentity,
} from "./session-identity-decision";
import { getMemoryById, insertMemory } from "./storage-memory";

let temp: ReturnType<typeof createTestTempDir>;
let db: Database;
let storage: string;
let previousCwd: string;
const originalDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    setHarness("opencode");
    previousCwd = process.cwd();
    temp = createTestTempDir("mc-identity-review-");
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = temp.dir;
    process.env.XDG_DATA_HOME = temp.dir;
    storage = join(getMagicContextStorageDir(), "project-identities");
    mkdirSync(storage, { recursive: true });
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    __setProjectIdentityTestHooks({
        execFileSync: (() => "abcdef123\n") as unknown as typeof execFileSync,
    });
});

afterEach(async () => {
    process.chdir(previousCwd);
    await __setProjectPinWriterForTests();
    __resetProjectIdentityForTests();
    __resetSessionIdentityDecisionsForTests();
    db.close();
    if (originalDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalDataDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    temp.cleanup();
});

function sidecar(directory: string, identity: string, atomic = false) {
    const key = projectDirectoryKey(directory);
    const file = join(storage, `${createHash("sha256").update(key).digest("hex")}.json`);
    const destination = atomic ? `${file}.replacement` : file;
    writeFileSync(destination, JSON.stringify({ directory: key, identity }));
    if (atomic) renameSync(destination, file);
    return file;
}

function linked(primaryName: string, worktree = join(temp.dir, "worktree")) {
    const main = join(temp.dir, primaryName);
    const gitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    return { main, worktree };
}

async function writeProject(directory: string, sessionID: string): Promise<string> {
    const tool = createCtxMemoryTools({
        db,
        resolveProjectPath: (folder, session) =>
            resolveSessionProjectIdentity(session, folder, {
                db,
                connectionFile: join(temp.dir, "absent-connection.json"),
            }),
        memoryEnabled: true,
        embeddingEnabled: false,
    }).ctx_memory!;
    const result = await tool.execute(
        { action: "write", category: "USER_DIRECTIVES", content: `Review witness ${sessionID}` },
        {
            sessionID,
            messageID: "user-1",
            directory,
            worktree: directory,
            agent: "build",
            abort: new AbortController().signal,
            metadata: () => {},
        } as never,
    );
    const row = db
        .prepare("SELECT project_path FROM memories WHERE content = ?")
        .get(`Review witness ${sessionID}`) as { project_path: string } | null;
    expect(row, result).not.toBeNull();
    return row!.project_path;
}

test.each([
    "update",
    "archive",
] as const)("OpenCode 1 ctx_memory %s logs the served pj- owner", async (action) => {
    const projectPath = "pj-served-owner";
    const sessionID = `ses-served-${action}`;
    // Make accidental path resolution observable instead of a caught missing-path error.
    mkdirSync(join(temp.dir, projectPath));
    process.chdir(temp.dir);
    db.exec(`
        INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'served-owner', 1, 1);
        INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
        VALUES (1, 'pj-served-owner', 'Served', '/served', 1), (1, 'pj-other-owner', 'Other', '/other', 1);
    `);
    updateSessionMeta(db, sessionID, {
        cachedM0Bytes: Buffer.from("<project-memory>Served memory block</project-memory>"),
        cachedM0ProjectIdentity: projectPath,
        cachedM0MaterializedAt: 1,
    });
    expect(await resolveSessionProjectIdentity(sessionID, temp.dir, { db })).toBe(projectPath);
    const memory = insertMemory(db, {
        projectPath,
        category: "USER_DIRECTIVES",
        content: "Original served memory.",
    });
    const tool = createCtxMemoryTools({
        db,
        resolveProjectPath: (folder, session) =>
            resolveSessionProjectIdentity(session, folder, { db }),
        memoryEnabled: true,
        embeddingEnabled: false,
    }).ctx_memory!;
    const result = await tool.execute(
        {
            action,
            ids: [memory.id],
            ...(action === "update" ? { content: "Updated served memory." } : {}),
        },
        { sessionID, directory: temp.dir, agent: "build" } as never,
    );
    expect(result).not.toStartWith("Error:");
    expect(getMemoryById(db, memory.id)?.projectPath).toBe(projectPath);
    if (action === "update")
        expect(getMemoryById(db, memory.id)?.content).toBe("Updated served memory.");
    expect(getMemoryById(db, memory.id)?.status).toBe(action === "archive" ? "archived" : "active");
    expect(
        db
            .prepare(
                "SELECT project_path, mutation_type, target_memory_id FROM memory_mutation_log",
            )
            .all(),
    ).toEqual([{ project_path: projectPath, mutation_type: action, target_memory_id: memory.id }]);
});

test("review: a persisted local publication must not shadow another process's replacement for new writes", async () => {
    const { main, worktree } = linked("main");
    rememberResolvedProjectIdentity(main, {
        projectId: "pj-OLD",
        canonicalRoot: main,
        via: "root",
    });
    expect(await flushProjectPinWrites(2_000)).toBe(true);
    expect(borrowedProjectIdentity(worktree)).toBe("pj-OLD");
    sidecar(main, "pj-NEW", true);
    expect(await writeProject(worktree, "external-replacement")).toBe("pj-NEW");
});

test("review: an in-place legacy-to-pj pin upgrade must invalidate a cached borrow miss before a write", async () => {
    const { main, worktree } = linked("main");
    sidecar(main, "git:abcdef123");
    expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
    expect(borrowedProjectIdentity(worktree)).toBeUndefined();
    sidecar(main, "pj-NEW");
    expect(await writeProject(worktree, "in-place-upgrade")).toBe("pj-NEW");
});

test("review: recreating a worktree folder for another checkout must invalidate cached topology before a write", async () => {
    const { main, worktree } = linked("first-main");
    sidecar(main, "pj-FIRST");
    expect(borrowedProjectIdentity(worktree)).toBe("pj-FIRST");
    rmSync(worktree, { recursive: true });
    const second = linked("second-main", worktree);
    sidecar(second.main, "pj-SECOND");
    expect(await writeProject(worktree, "recreated-folder")).toBe("pj-SECOND");
});

test("review: a linked worktree's old exact pj pin must not redirect writes away from the parent checkout", async () => {
    const { main, worktree } = linked("main");
    sidecar(main, "pj-PARENT");
    sidecar(worktree, "pj-WORKTREE");
    expect(await writeProject(worktree, "own-worktree-pin")).toBe("pj-PARENT");
});
