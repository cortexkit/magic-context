import { expect, mock, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    rememberResolvedProjectIdentity,
    resolveProjectIdentityForSession,
} from "./project-identity";
import {
    projectIdentityPinGeneration,
    readRememberedProjectIdentity,
} from "./project-identity-cache";
import { __setProjectPinWriterForTests, ProjectPinWriter } from "./project-pin-writer";

test("a parent pin publication invalidates a warm linked-worktree answer before disk I/O", async () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-identity-merge-"));
    const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    const originalDataHome = process.env.XDG_DATA_HOME;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
    process.env.XDG_DATA_HOME = root;
    __resetProjectIdentityForTests();
    const write = mock(async () => {});
    await __setProjectPinWriterForTests(new ProjectPinWriter(write));
    const main = join(root, "main");
    const worktree = join(root, "worktree");
    const gitDir = join(main, ".git", "worktrees", "linked");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(join(gitDir, "commondir"), "../..\n");
    __setProjectIdentityTestHooks({
        execFileSync: (() => "abcdef123\n") as unknown as typeof execFileSync,
    });
    const read = spyOn(fs, "readFileSync");
    const scan = spyOn(fs, "readdirSync");
    try {
        expect(resolveProjectIdentityForSession(main)).toBe("git:abcdef123");
        expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
        expect(resolveProjectIdentityForSession(worktree)).toBe("git:abcdef123");
        const generation = projectIdentityPinGeneration();
        rememberResolvedProjectIdentity(worktree, {
            projectId: "pj-LINKED",
            via: "worktree",
            canonicalRoot: main,
        });
        expect(projectIdentityPinGeneration()).toBe(generation);
        expect(readRememberedProjectIdentity(worktree)?.identity).not.toBe("pj-LINKED");
        rememberResolvedProjectIdentity(main, {
            projectId: "pj-PARENT",
            via: "root",
            canonicalRoot: main,
        });
        expect(projectIdentityPinGeneration()).toBe(generation + 1);
        expect(write).not.toHaveBeenCalled();
        expect(resolveProjectIdentityForSession(worktree)).toBe("pj-PARENT");
        expect(resolveProjectIdentityForSession(main)).toBe("pj-PARENT");
        expect(readRememberedProjectIdentity(worktree)?.identity).not.toBe("pj-PARENT");
        expect(write).not.toHaveBeenCalled();
        read.mockClear();
        scan.mockClear();
        for (let i = 0; i < 100; i++)
            expect(resolveProjectIdentityForSession(worktree)).toBe("pj-PARENT");
        expect(read).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
    } finally {
        read.mockRestore();
        scan.mockRestore();
        await __setProjectPinWriterForTests();
        __resetProjectIdentityForTests();
        if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
