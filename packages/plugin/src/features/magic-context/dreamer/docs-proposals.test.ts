import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("docs proposals", () => {
    test.each([
        "not JSON",
        "{}",
        "[null]",
        JSON.stringify([{ file: "README.md" }]),
        JSON.stringify([{ ...JSON.parse(replacement)[0], action: "edit" }]),
        JSON.stringify([{ ...JSON.parse(replacement)[0], heading: "no heading" }]),
        JSON.stringify([{ ...JSON.parse(replacement)[0], text: null }]),
        JSON.stringify([{ ...JSON.parse(replacement)[0], reason: "\n" }]),
        JSON.stringify([...JSON.parse(replacement), ...JSON.parse(replacement)]),
    ])("rejects malformed proposal output %j without reading docs", (output) => {
        expect(() => parseDocsProposalOutput(output)).toThrow();
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

    test("rejects protected changes, budget overflow and base drift without writing docs", () => {
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
        expect(() => writeDocsProposal(dir, protectedChange, 12000, hashes, "head")).toThrow(
            "protected region",
        );
        expect(() => writeDocsProposal(dir, replacement, 1, hashes, "head")).toThrow("over budget");
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
        expect(listPendingDocsProposals(dir)).toEqual([second]);
        expect(
            readFileSync(
                join(
                    dir,
                    ".cortexkit/magic-context/docs-update-proposals/superseded",
                    first.split("/").at(-1)!,
                ),
                "utf8",
            ),
        ).toContain("Base SHA-256");
    });

    test("a docs proposal before any historian run stays invisible to git while config stays trackable", () => {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
        git("init", "-q");
        git("add", "ARCHITECTURE.md", "STRUCTURE.md");
        mkdirSync(join(dir, ".cortexkit"));
        writeFileSync(join(dir, ".cortexkit/magic-context.jsonc"), "{}\n");
        const proposal = writeDocsProposal(dir, replacement, 12000, docsBaseHashes(dir), "head");
        expect(readFileSync(proposal, "utf8")).toContain("# Docs update proposal");
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
        expect(readFileSync(proposal, "utf8")).toContain("# Docs update proposal");
    });

    test("host changeset omits docs, tests and lockfiles and prompt never requests bash", () => {
        const dir = fixture();
        const git = (...args: string[]) =>
            execFileSync("git", args, { windowsHide: true, cwd: dir, encoding: "utf8" }).trim();
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
            execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
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
            execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
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
