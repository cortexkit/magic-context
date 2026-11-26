import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedTestGitEnv } from "../../../shared/test-git-env";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    docsBaseHashes,
    docsChangeSet,
    hasCurrentDocsProposal,
    listPendingDocsProposals,
    parseDocsProposalOutput,
    validateDocsProposal,
    writeDocsProposal,
} from "./docs-proposals";
import { buildMaintainDocsPrompt } from "./task-prompts";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-proposal-test-"));
    dirs.push(dir);
    writeFileSync(
        join(dir, "ARCHITECTURE.md"),
        "# Architecture\n\n## Core\nOld sentence.\n\n## Guard\n<!-- mc:protected START -->\nHand authored\n<!-- mc:protected END -->\n",
    );
    writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\n## Layout\nOld layout.\n");
    return dir;
}
const replacement = JSON.stringify([
    {
        file: "ARCHITECTURE.md",
        action: "replace",
        heading: "## Core",
        text: "## Core\nCurrent sentence.",
        reason: "Source contradicts the old sentence",
    },
]);

function liveFixture(
    architecture = "# Architecture\n\n## Live\n\n### A\nOld text.\n\n### B\nOther text.\n",
) {
    const dir = fixture();
    writeFileSync(join(dir, "ARCHITECTURE.md"), architecture);
    return dir;
}

function liveChange(heading: string, text: string, action = "replace") {
    return { file: "ARCHITECTURE.md", action, heading, text, reason: "update A" };
}

function validateLive(dir: string, ...changes: unknown[]) {
    return validateDocsProposal(dir, JSON.stringify(changes), 12000, docsBaseHashes(dir));
}

describe("docs proposals", () => {
    test("replaces the Live section with both nested subsections", () => {
        const dir = liveFixture();
        const change = liveChange("## Live", "## Live\n\n### A\nNew text.\n\n### B\nOther text.\n");
        const result = validateLive(dir, change);
        expect(result.changes).toEqual([change]);
        expect(result.diffs).toContain("-Old text.");
        expect(result.diffs).toContain("+New text.");
        expect(result.diffs).not.toContain("-### B");
    });

    test("replaces a nested subsection without replacing the next subsection", () => {
        const dir = liveFixture();
        const change = liveChange("### A", "### A\nNew text.\n");
        const result = validateLive(dir, change);
        expect(result.changes).toEqual([change]);
        expect(result.diffs).toContain("-Old text.");
        expect(result.diffs).toContain("+New text.");
        expect(result.diffs).not.toContain("-### B");
        expect(result.diffs).not.toContain("-Other text.");
    });

    test("removes the Live heading and its subsections but not the next section", () => {
        const dir = liveFixture(
            "# Architecture\n\n## Live\n\n### A\nOne.\n\n### B\nTwo.\n\n## Next\nKeep me.\n",
        );
        const change = liveChange("## Live", "", "remove");
        const result = validateLive(dir, change);
        expect(result.changes).toEqual([change]);
        expect(result.diffs).toContain("-### A\n-One.");
        expect(result.diffs).toContain("-### B\n-Two.");
        expect(result.diffs).not.toContain("-## Next");
    });

    test.each([
        "## Not part of Live",
        "# Higher level",
        "  ##  Also a heading",
    ])("drops a replacement containing a second top-level section: %s", (heading) => {
        const dir = liveFixture();
        const change = liveChange("## Live", `## Live\nNew.\n\n${heading}\nExtra.\n`);
        const result = validateLive(dir, change);
        expect(result.changes).toEqual([]);
        expect(result.diffs).toBe("");
        expect(result.dropped).toEqual([{ index: 0, reason: "invalid replacement ## Live" }]);
    });

    test("headings inside code fences do not split a section", () => {
        const dir = liveFixture(
            "# Architecture\n\n## Live\n````markdown\n```\n## Sample\n```\n````\n\n## Next\nKeep me.\n",
        );
        const change = liveChange("## Live", "## Live\n~~~markdown\n```\n## Example\n```\n~~~\n");
        const result = validateDocsProposal(
            dir,
            `\`\`\`json\n${JSON.stringify([change])}\n\`\`\``,
            12000,
            docsBaseHashes(dir),
        );
        expect(result.changes).toEqual([change]);
        expect(result.diffs).toContain("-## Sample");
        expect(result.diffs).toContain("+## Example");
        expect(result.diffs).not.toContain("-## Next");
    });

    test("keeps nested protected bytes unchanged and rejects removing their parent", () => {
        const protectedText =
            "<!-- mc:protected START -->\nHand authored\n<!-- mc:protected END -->";
        const dir = liveFixture(`# Architecture\n\n## Live\nOld.\n\n### A\n${protectedText}\n`);
        const removal = liveChange("## Live", "", "remove");
        const dropped = validateLive(dir, removal);
        expect(dropped.changes).toEqual([]);
        expect(dropped.dropped).toEqual([
            { index: 0, reason: "protected region changed in ARCHITECTURE.md" },
        ]);

        const rewrite = liveChange("## Live", `## Live\nNew.\n\n### A\n${protectedText}\n`);
        const kept = validateLive(dir, rewrite);
        expect(kept.changes).toEqual([rewrite]);
        expect(kept.diffs).toContain("+New.");
        expect(kept.diffs).not.toContain("-Hand authored");
    });

    test("applies ordered changes to an added section and its subsection", () => {
        const dir = liveFixture();
        const add = liveChange("## New", "## New\n\n### C\nDraft.\n", "add");
        const replace = liveChange("### C", "### C\nFinal.");
        const result = validateLive(dir, add, replace);
        expect(result.changes).toEqual([add, replace]);
        expect(result.dropped).toEqual([]);
        expect(result.diffs).toContain("+## New\n+\n+### C\n+Final.");
        expect(result.diffs).not.toContain("Draft.");
    });

    test("drops later growth first and revalidates changes that depended on it", () => {
        const dir = liveFixture();
        const hashes = docsBaseHashes(dir);
        const first = liveChange("### A", "### A\nSmall clarification.");
        const second = liveChange(
            "## New",
            `## New\n${"Long ".repeat(40)}\n\n### C\nDraft.`,
            "add",
        );
        const third = liveChange("### C", "", "remove");
        const budget = validateLive(dir, first).tokens;
        const result = validateDocsProposal(
            dir,
            JSON.stringify([first, second, third]),
            budget,
            hashes,
        );
        expect(result.changes).toEqual([first]);
        expect(result.tokens).toBe(budget);
        expect(result.dropped).toEqual([
            { index: 1, reason: expect.stringContaining("over budget") },
            { index: 2, reason: "missing section ### C" },
        ]);
        expect(result.diffs).not.toContain("+## New");
    });

    test("keeps non-growing corrections when the docs still exceed the budget", () => {
        const dir = liveFixture(
            `# Architecture\n\n## Live\n\n### A\n${"A".repeat(200)}\n\n### B\nOther text.\n`,
        );
        const shrink = liveChange("### A", `### A\n${"B".repeat(160)}\n\n`);
        const equal = liveChange("### B", "### B\nFixed text.\n");
        const grow = liveChange("## New", "## New\nNew section.", "add");
        const hashes = docsBaseHashes(dir);
        const budget = 30;
        const before = validateDocsProposal(dir, "[]", budget, hashes).tokens;
        const result = validateDocsProposal(
            dir,
            JSON.stringify([shrink, equal, grow]),
            budget,
            hashes,
        );
        expect(result.changes).toEqual([shrink, equal]);
        expect(result.dropped).toEqual([
            { index: 2, reason: expect.stringContaining("over budget") },
        ]);
        expect(result.tokens).toBeGreaterThan(budget);
        expect(result.tokens).toBeLessThan(before);
        expect(result.diffs).toContain("+Fixed text.");
        expect(result.diffs).not.toContain("+## New");
    });

    test("keeps multiple reductions that bring oversized docs back under budget", () => {
        const dir = liveFixture(
            `# Architecture\n\n## Live\n\n### A\n${"A".repeat(200)}\n\n### B\n${"B".repeat(200)}\n`,
        );
        const hashes = docsBaseHashes(dir);
        const first = liveChange("### A", "### A\nShort A.");
        const second = liveChange("### B", "### B\nShort B.");
        const partial = validateDocsProposal(dir, JSON.stringify([first]), 50, hashes);
        expect(partial.changes).toEqual([first]);
        expect(partial.tokens).toBeGreaterThan(50);
        const result = validateDocsProposal(dir, JSON.stringify([first, second]), 50, hashes);
        expect(result.changes).toEqual([first, second]);
        expect(result.dropped).toEqual([]);
        expect(result.tokens).toBeLessThanOrEqual(50);
    });

    test.each([
        "not JSON",
        "{}",
    ])("rejects an unusable proposal envelope %j without reading docs", (output) => {
        expect(() => parseDocsProposalOutput(output)).toThrow();
    });

    test.each([
        [null, "expected an object"],
        [{ file: "README.md" }, "unknown proposal file"],
        [{ ...JSON.parse(replacement)[0], action: "edit" }, "invalid action"],
        [{ ...JSON.parse(replacement)[0], heading: "no heading" }, "invalid section heading"],
        [{ ...JSON.parse(replacement)[0], text: null }, "section text must be a string"],
        [{ ...JSON.parse(replacement)[0], reason: "\n" }, "expected a one-line reason"],
        [JSON.parse(replacement)[0], "duplicate section change ## Core"],
    ])("drops malformed or duplicate entry %j without losing the valid entry", (entry, reason) => {
        const dir = fixture();
        const valid = JSON.parse(replacement)[0];
        const result = validateLive(dir, valid, entry);
        expect(result.changes).toEqual([valid]);
        expect(result.dropped).toEqual([{ index: 1, reason }]);
    });

    test("parses fenced changes and permits the same heading in different files", () => {
        const changes = [
            ...JSON.parse(replacement),
            { ...JSON.parse(replacement)[0], file: "STRUCTURE.md" },
        ];
        expect(
            parseDocsProposalOutput(`Proposed:\n\`\`\`json\n${JSON.stringify(changes)}\n\`\`\``),
        ).toEqual(changes);
    });

    test("drops protected changes or budget overflow and fails on base drift without writing docs", () => {
        const dir = fixture();
        const before = readFileSync(join(dir, "ARCHITECTURE.md"));
        const hashes = docsBaseHashes(dir);
        const protectedChange = JSON.stringify([
            {
                file: "ARCHITECTURE.md",
                action: "replace",
                heading: "## Guard",
                text: "## Guard\nRemoved hand authored text",
                reason: "wrong",
            },
        ]);
        expect(writeDocsProposal(dir, protectedChange, 12000, hashes, "head")).toEqual({
            path: null,
            dropped: [{ index: 0, reason: "protected region changed in ARCHITECTURE.md" }],
        });
        expect(writeDocsProposal(dir, replacement, 1, hashes, "head")).toEqual({
            path: null,
            dropped: [{ index: 0, reason: expect.stringContaining("over budget") }],
        });
        writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\n## Layout\nDrifted.\n");
        expect(() => writeDocsProposal(dir, replacement, 12000, hashes, "head")).toThrow(
            "base drifted",
        );
        expect(readFileSync(join(dir, "ARCHITECTURE.md"))).toEqual(before);
        expect(listPendingDocsProposals(dir)).toEqual([]);
    });

    test("supersedes the old pending proposal and cadence skips matching bases", () => {
        const dir = fixture();
        const hashes = docsBaseHashes(dir);
        const first = writeDocsProposal(dir, replacement, 12000, hashes, "head");
        expect(hasCurrentDocsProposal(dir)).toBe(true);
        const second = writeDocsProposal(dir, replacement, 12000, hashes, "head");
        expect(listPendingDocsProposals(dir)).toEqual([second.path]);
        expect(
            readFileSync(
                join(
                    dir,
                    ".cortexkit/magic-context/docs-update-proposals/superseded",
                    first.path!.split("/").at(-1)!,
                ),
                "utf8",
            ),
        ).toContain("Base SHA-256");
    });

    test("a docs proposal before any historian run stays invisible to git while config stays trackable", () => {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, {
                cwd: dir,
                encoding: "utf8",
                env: isolatedTestGitEnv(),
                windowsHide: true,
            });
        git("init", "-q");
        git("add", "ARCHITECTURE.md", "STRUCTURE.md");
        mkdirSync(join(dir, ".cortexkit"));
        writeFileSync(join(dir, ".cortexkit/magic-context.jsonc"), "{}\n");
        const proposal = writeDocsProposal(dir, replacement, 12000, docsBaseHashes(dir), "head");
        expect(readFileSync(proposal.path!, "utf8")).toContain("# Docs update proposal");
        expect(readFileSync(join(dir, ".cortexkit/magic-context/.gitignore"), "utf8")).toBe("*\n");
        expect(existsSync(join(dir, ".cortexkit/.gitignore"))).toBe(false);
        expect(git("status", "--porcelain", "--untracked-files=all", "--", ".cortexkit")).toBe(
            "?? .cortexkit/magic-context.jsonc\n",
        );
    });

    test("a gitignore failure does not prevent writing a docs proposal", () => {
        const dir = fixture();
        mkdirSync(join(dir, ".cortexkit/magic-context/.gitignore"), { recursive: true });
        const proposal = writeDocsProposal(dir, replacement, 12000, docsBaseHashes(dir), "head");
        expect(readFileSync(proposal.path!, "utf8")).toContain("# Docs update proposal");
    });

    test("host changeset omits docs, tests and lockfiles and prompt never requests bash", () => {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, {
                windowsHide: true,
                cwd: dir,
                encoding: "utf8",
                env: isolatedTestGitEnv(),
            }).trim();
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        git("add", ".");
        git("commit", "-qm", "base docs");
        const anchor = git("rev-parse", "HEAD");
        writeFileSync(join(dir, "src.ts"), "export const value = 1;\n");
        writeFileSync(join(dir, "foo.test.ts"), "test\n");
        git("add", ".");
        git("commit", "-qm", "update code");
        const changes = docsChangeSet(dir, anchor);
        expect(changes?.relevant).toBe(false);
        // After a completed run records its commit, only diffs touching documented paths need investigation.
        writeFileSync(
            join(dir, "ARCHITECTURE.md"),
            "# Architecture\n\n## Core\nsrc.ts implements the core.\n",
        );
        const scoped = docsChangeSet(dir, anchor);
        expect(scoped?.text).toContain("src.ts");
        expect(scoped?.text).toContain("@@");
        expect(scoped?.text).toContain("Stat:");
        expect(scoped?.text).not.toContain("foo.test.ts");
        const prompt = buildMaintainDocsPrompt(
            dir,
            scoped?.text ?? "",
            { architecture: true, structure: true },
            12000,
            500,
        );
        expect(prompt).toContain("12000");
        expect(prompt).toContain("500");
        expect(prompt).toContain("src.ts");
        expect(prompt).toContain("Current ARCHITECTURE.md");
        expect(prompt).toContain(
            "the next heading of the same or a higher level outside code fences",
        );
        expect(docsChangeSet(dir, git("rev-parse", "HEAD"))?.unchanged).toBe(true);
        expect(prompt).not.toContain("git log");
        expect(prompt).not.toContain("find .");
        expect(
            validateDocsProposal(dir, replacement, 12000, docsBaseHashes(dir)).tokens,
        ).toBeGreaterThan(0);
    });

    test("rename diff names both paths and captures hunks", () => {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, {
                cwd: dir,
                encoding: "utf8",
                env: isolatedTestGitEnv(),
                windowsHide: true,
            }).trim();
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        writeFileSync(
            join(dir, "old.ts"),
            "export const rule = 1;\nexport const stable = 'unchanged';\nexport const other = 'unchanged';\n",
        );
        git("add", ".");
        git("commit", "-qm", "base");
        const anchor = git("rev-parse", "HEAD");
        writeFileSync(
            join(dir, "ARCHITECTURE.md"),
            "# Architecture\n\n## Core\nold.ts implements the rule.\n",
        );
        git("mv", "old.ts", "new.ts");
        writeFileSync(
            join(dir, "new.ts"),
            "export const rule = 2;\nexport const stable = 'unchanged';\nexport const other = 'unchanged';\n",
        );
        git("add", ".");
        git("commit", "-qm", "rename");
        const changes = docsChangeSet(dir, anchor);
        expect(changes?.relevant).toBe(true);
        expect(changes?.text).toContain("rename from old.ts");
        expect(changes?.text).toContain("rename to new.ts");
    });

    function anchoredRepo(architecture: string) {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, {
                cwd: dir,
                encoding: "utf8",
                env: isolatedTestGitEnv(),
                windowsHide: true,
            }).trim();
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        writeFileSync(join(dir, "ARCHITECTURE.md"), architecture);
        git("add", ".");
        git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
        const anchor = git("rev-parse", "HEAD");
        const commitAll = () => {
            git("add", ".");
            git("-c", "commit.gpgsign=false", "commit", "-qm", "change");
        };
        return { dir, anchor, commitAll };
    }

    test("summarises a patch larger than the git output buffer instead of throwing", () => {
        const { dir, anchor, commitAll } = anchoredRepo("# Architecture\n\n## Core\nsrc/big.txt\n");
        mkdirSync(join(dir, "src"));
        // About 3.3 MB of added lines: past the 2 MB buffer the diff is read into.
        writeFileSync(
            join(dir, "src/big.txt"),
            "a line long enough to fill the patch\n".repeat(90_000),
        );
        commitAll();

        const changes = docsChangeSet(dir, anchor);

        expect(changes?.relevant).toBe(true);
        expect(changes?.text).toStartWith("Changed files and ranges (diff exceeds prompt budget):");
        expect(changes?.text).toContain("src/big.txt");
    });

    test("lists changed files without passing thousands of pathspecs to git", () => {
        const deep = `src/${"nested-directory-name-".repeat(7)}`;
        const { dir, anchor, commitAll } = anchoredRepo(`# Architecture\n\n## Core\n${deep}\n`);
        mkdirSync(join(dir, deep), { recursive: true });
        // About 1,400 paths of roughly 200 bytes: over the pathspec byte cap.
        for (let index = 0; index < 1_400; index++) {
            writeFileSync(join(dir, deep, `file-${index}-${"x".repeat(25)}.txt`), `${index}\n`);
        }
        commitAll();

        const changes = docsChangeSet(dir, anchor);

        expect(changes?.relevant).toBe(true);
        expect(changes?.text).toStartWith("Changed files (too many to include a diff):");
        expect(changes?.text).toContain(`${deep}/file-0-`);
    }, 60_000);
});
