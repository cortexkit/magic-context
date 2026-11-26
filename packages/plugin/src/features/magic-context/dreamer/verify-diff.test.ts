import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedTestGitEnv } from "../../../shared/test-git-env";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

import { buildVerifyDiffEvidence, VERIFY_DIFF_BUDGET_TOKENS } from "./verify-diff";
import { buildVerifyPrompt, type VerifyPromptMemory } from "./verify-prompt";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: isolatedTestGitEnv(),
        windowsHide: true,
    }).trim();
function repo() {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "verify-diff-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "verify@example.invalid");
    git(dir, "config", "user.name", "Verify Test");
    return dir;
}
function memory(id: number, file: string, at: number, commit?: string): VerifyPromptMemory {
    return {
        id,
        category: "ARCHITECTURE",
        content: `claim ${id}`,
        mappedFiles: [file],
        verifiedAt: at,
        verifiedCommit: commit,
    };
}

describe("incremental verify evidence", () => {
    it("shared timestamp bases produce byte-identical ordered evidence to explicit commit bases", async () => {
        const dir = repo();
        for (const file of ["a.ts", "b.ts"]) writeFileSync(path.join(dir, file), "old\n");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "base");
        const base = git(dir, "rev-parse", "HEAD");
        const at = Number(git(dir, "show", "-s", "--format=%ct")) * 1000 + 1000;
        writeFileSync(path.join(dir, "a.ts"), "new\n");
        const memories = [memory(1, "b.ts", at), memory(2, "a.ts", at), memory(3, "b.ts", at)];
        expect(await buildVerifyDiffEvidence(dir, memories)).toEqual(
            await buildVerifyDiffEvidence(
                dir,
                memories.map((m) => ({ ...m, verifiedCommit: base })),
            ),
        );
    });
    it("captures changed hunks once per shared file, untouched hunks, rename, deletion and pending edits", async () => {
        const dir = repo();
        writeFileSync(path.join(dir, "a.ts"), "old\nkeep\n");
        writeFileSync(path.join(dir, "renamed.ts"), "rename me\nkeep\n");
        writeFileSync(path.join(dir, "deleted.ts"), "remove me\n");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "initial");
        const base = git(dir, "rev-parse", "HEAD");
        writeFileSync(path.join(dir, "a.ts"), "new\nkeep\n");
        git(dir, "mv", "renamed.ts", "moved.ts");
        git(dir, "rm", "-q", "deleted.ts");
        git(dir, "commit", "-qam", "change");
        writeFileSync(path.join(dir, "a.ts"), "new\nkeep\npending\n");
        const now = Date.now();
        const evidence = await buildVerifyDiffEvidence(dir, [
            memory(1, "a.ts", now, base),
            memory(2, "a.ts", now, base),
            memory(3, "renamed.ts", now, base),
            memory(4, "deleted.ts", now, base),
        ]);
        expect(evidence?.mode).toBe("diff");
        expect(evidence?.files).toHaveLength(3);
        expect(evidence?.files[0].memoryIds).toEqual([1, 2]);
        expect(evidence?.files[0].text).toContain("+new");
        expect(evidence?.files[0].text).not.toContain("+keep");
        expect(evidence?.files[0].text).toContain("+pending");
        expect(evidence?.files[1].text).toContain("RENAMED renamed.ts -> moved.ts");
        expect(evidence?.files[2].text).toContain("DELETED deleted.ts");
        expect(buildVerifyPrompt(dir, [memory(1, "a.ts", now, base)], evidence)).toContain(
            "diff below is the evidence",
        );
    });

    it("derives a base for old verified rows, but never-verified rows require full checks", async () => {
        const dir = repo();
        writeFileSync(path.join(dir, "a.ts"), "old\n");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "initial");
        const base = git(dir, "rev-parse", "HEAD");
        const timestamp = Number(git(dir, "show", "-s", "--format=%ct", base)) * 1000 + 1000;
        writeFileSync(path.join(dir, "a.ts"), "new\n");
        execFileSync("git", ["commit", "-qam", "change"], {
            cwd: dir,
            windowsHide: true,
            env: isolatedTestGitEnv({
                GIT_COMMITTER_DATE: new Date(timestamp + 60_000).toISOString(),
                GIT_AUTHOR_DATE: new Date(timestamp + 60_000).toISOString(),
            }),
        });
        const evidence = await buildVerifyDiffEvidence(dir, [memory(1, "a.ts", timestamp)]);
        expect(evidence?.files[0].text).toContain("+new");
        expect(await buildVerifyDiffEvidence(dir, [memory(2, "a.ts", 0)])).toBeNull();
    });

    it("switches to changed ranges rather than full diffs past the token budget", async () => {
        const dir = repo();
        writeFileSync(path.join(dir, "a.ts"), "old\n");
        git(dir, "add", ".");
        git(dir, "commit", "-qm", "initial");
        const base = git(dir, "rev-parse", "HEAD");
        writeFileSync(path.join(dir, "a.ts"), `${"x".repeat(VERIFY_DIFF_BUDGET_TOKENS * 4)}\n`);
        const evidence = await buildVerifyDiffEvidence(dir, [memory(1, "a.ts", Date.now(), base)]);
        expect(evidence?.mode).toBe("ranges");
        expect(evidence?.files[0].text).toContain("@@");
        expect(evidence?.files[0].text).not.toContain("x".repeat(100));
    });
});

it("measures a thirty-memory ten-file small-commit verify prompt", async () => {
    const dir = repo();
    for (let i = 0; i < 10; i++)
        writeFileSync(path.join(dir, `file${i}.ts`), `export const value = ${i};\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "initial");
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(path.join(dir, "file0.ts"), "export const value = 11;\n");
    git(dir, "commit", "-qam", "small change");
    const memories = Array.from({ length: 30 }, (_, i) =>
        memory(i + 1, `file${Math.floor(i / 3)}.ts`, Date.now(), base),
    );
    const batch = memories.filter((m) => m.mappedFiles[0] === "file0.ts");
    const evidence = await buildVerifyDiffEvidence(dir, batch);
    const before = buildVerifyPrompt(dir, batch);
    const after = buildVerifyPrompt(dir, batch, evidence);
    expect(evidence?.files).toHaveLength(1);
    console.log(
        `verify prompt measurement (30 memories / 10 files, 3 selected): before=${before.length} chars after=${after.length} chars; expected file reads: 1 -> 0 if claim unaffected, at most 1 if affected`,
    );
});
