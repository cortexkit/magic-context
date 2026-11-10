import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCortexKitArtifactGitignore } from "../../../shared/data-path";

const FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const proposalDir = (projectDir: string) =>
    join(projectDir, ".cortexkit/magic-context/docs-update-proposals");

export function docsBaseHashes(projectDir: string): Record<string, string> {
    return Object.fromEntries(
        FILES.map((name) => [
            name,
            hash(
                existsSync(join(projectDir, name))
                    ? readFileSync(join(projectDir, name), "utf8")
                    : "",
            ),
        ]),
    );
}

export function listPendingDocsProposals(projectDir: string): string[] {
    const dir = proposalDir(projectDir);
    return existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith(".md"))
              .sort()
              .map((name) => join(dir, name))
        : [];
}

export function hasCurrentDocsProposal(projectDir: string): boolean {
    const hashes = docsBaseHashes(projectDir);
    return listPendingDocsProposals(projectDir).some((path) =>
        Object.entries(hashes).every(([name, value]) =>
            readFileSync(path, "utf8").includes(`Base SHA-256 ${name}: ${value}`),
        ),
    );
}

function git(projectDir: string, args: string[]): string {
    return execFileSync("git", args, {
        windowsHide: true,
        cwd: projectDir,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 2_000_000,
    }).trim();
}

/**
 * Like git(), but returns the output read so far when it outgrows the buffer.
 * Callers keep only a bounded prefix of these outputs, so a truncated read is
 * enough; throwing instead would make maintain-docs fail on the same diff every
 * run while its anchor stays put and the diff keeps growing.
 */
function gitOutputPrefix(projectDir: string, args: string[]): string {
    try {
        return git(projectDir, args);
    } catch (error) {
        const { code, stdout } = error as { code?: unknown; stdout?: unknown };
        if (code !== "ENOBUFS") throw error;
        if (typeof stdout === "string") return stdout.trim();
        if (Buffer.isBuffer(stdout)) return stdout.toString("utf8").trim();
        throw error;
    }
}

/**
 * Pathspec bytes allowed on one git command line. macOS caps arguments plus
 * environment at 1 MiB and Linux usually at 2 MiB; beyond this the changed-file
 * list is summarised instead of passed to git, which would fail with E2BIG.
 */
const MAX_PATHSPEC_BYTES = 256_000;

export function docsChangeSet(
    projectDir: string,
    storedAnchor?: string,
): { head: string; text: string; unchanged: boolean; relevant: boolean } | null {
    try {
        if (
            realpathSync(git(projectDir, ["rev-parse", "--show-toplevel"])) !==
            realpathSync(projectDir)
        )
            return null;
        const head = git(projectDir, ["rev-parse", "HEAD"]);
        const recorded = Boolean(storedAnchor);
        let anchor = storedAnchor;
        if (
            anchor &&
            (!/^[a-f0-9]{40}$/.test(anchor) ||
                git(projectDir, ["cat-file", "-t", anchor]) !== "commit")
        )
            throw new Error("maintain-docs checkpoint is not a git commit");
        if (!anchor) anchor = git(projectDir, ["log", "-1", "--format=%H", "--", ...FILES]);
        if (!anchor) return null;
        if (recorded && anchor === head)
            return { head, text: "", unchanged: true, relevant: false };
        if (recorded) {
            const changed = git(projectDir, [
                "diff",
                "-M",
                "--name-status",
                `${anchor}..HEAD`,
                "--",
                ".",
            ])
                .split("\n")
                .filter(Boolean)
                .map((line) => line.split("\t").slice(1));
            const files = [
                ...new Set(
                    changed
                        .flat()
                        .filter(
                            (file) =>
                                file !== "ARCHITECTURE.md" &&
                                file !== "STRUCTURE.md" &&
                                !/(?:^|[./-])(test|spec)(?:[./-]|$)/.test(file) &&
                                !file.endsWith(".lock"),
                        ),
                ),
            ];
            const docs = FILES.map((file) =>
                existsSync(join(projectDir, file))
                    ? readFileSync(join(projectDir, file), "utf8")
                    : "",
            ).join("\n");
            const relevant = files.some((file) => {
                const directory = file.split("/").slice(0, -1).join("/");
                return docs.includes(file) || (directory.length > 2 && docs.includes(directory));
            });
            if (!relevant) return { head, text: "", unchanged: false, relevant: false };
            const budget = 32000;
            const pathspecBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file) + 1, 0);
            if (pathspecBytes > MAX_PATHSPEC_BYTES) {
                return {
                    head,
                    unchanged: false,
                    relevant: true,
                    text: `Changed files (too many to include a diff):\n${files.join("\n").slice(0, budget)}`,
                };
            }
            const stat = git(projectDir, [
                "diff",
                "-M",
                "--stat",
                `${anchor}..HEAD`,
                "--",
                ...files,
            ]);
            const patch = gitOutputPrefix(projectDir, [
                "diff",
                "-M",
                "--unified=3",
                `${anchor}..HEAD`,
                "--",
                ...files,
            ]);
            const text = `Changed files:\n${files.join("\n")}\n\nStat:\n${stat}\n\nHunks:\n${patch}`;
            if (text.length <= budget) return { head, text, unchanged: false, relevant: true };
            const ranges = [...patch.matchAll(/^\+\+\+ b\/(.+)$|^@@ .* \+(\d+)(?:,(\d+))? @@/gm)];
            return {
                head,
                unchanged: false,
                relevant: true,
                text: `Changed files and ranges (diff exceeds prompt budget):\n${files.join("\n")}\n${ranges
                    .map((match) =>
                        match[1] ? `file: ${match[1]}` : `line: ${match[2]} +${match[3] ?? 1}`,
                    )
                    .join("\n")
                    .slice(0, budget)}\n\nStat:\n${stat}`,
            };
        }
        const excluded = [
            "ARCHITECTURE.md",
            "STRUCTURE.md",
            ".cortexkit",
            "*.lock",
            "*lock.json",
            "*test*",
            "*spec*",
            "dist",
            "*generated*",
        ];
        const raw = gitOutputPrefix(projectDir, [
            "log",
            "--format=commit %h %s",
            "--stat",
            "--no-renames",
            "-n",
            "201",
            `${anchor}..HEAD`,
            "--",
            ".",
            ...excluded.map((path) => `:(exclude)${path}`),
        ]);
        if (!raw) return null;
        const commits = raw.split(/^commit /m);
        const text = raw.slice(0, 24000);
        return {
            head,
            unchanged: false,
            relevant: true,
            text: `${text}${raw.length > text.length ? `\n[cut ${raw.length - text.length} bytes]` : ""}${commits.length > 201 ? "\n[cut commits beyond newest 200]" : ""}`,
        };
    } catch (error) {
        if (storedAnchor) throw error;
        return null;
    }
}

export interface DocsSectionChange {
    file: (typeof FILES)[number];
    action: "replace" | "add" | "remove";
    heading: string;
    text: string;
    reason: string;
}

function sections(text: string): { heading: string; text: string; start: number; end: number }[] {
    const lines = text.split("\n");
    const result: { heading: string; text: string; start: number; end: number }[] = [];
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
        if (!fenced && /^#{1,6} \S/.test(lines[i])) {
            if (result.length) result[result.length - 1].end = i;
            result.push({ heading: lines[i], text: "", start: i, end: lines.length });
        }
    }
    for (const section of result) section.text = lines.slice(section.start, section.end).join("\n");
    return result;
}

function protectedBytes(text: string): string[] {
    return [
        ...text.matchAll(/<!-- mc:protected START[^\n]*-->[\s\S]*?<!-- mc:protected END -->/g),
    ].map((match) => match[0]);
}

function diff(name: string, before: string, after: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-doc-diff-"));
    try {
        writeFileSync(join(dir, "before"), before);
        writeFileSync(join(dir, "after"), after);
        try {
            return execFileSync(
                "git",
                ["diff", "--no-index", "--", join(dir, "before"), join(dir, "after")],
                { windowsHide: true, encoding: "utf8" },
            );
        } catch (error) {
            return (
                (error as { stdout?: string }).stdout
                    ?.replaceAll(join(dir, "before"), `a/${name}`)
                    .replaceAll(join(dir, "after"), `b/${name}`) ?? ""
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Validate only the model's output here so malformed proposals can use a fallback.
// Applying changes and checking the current docs remain host-side responsibilities.
export function parseDocsProposalOutput(output: string): DocsSectionChange[] {
    const match = output.match(/```json\s*([\s\S]*?)```/);
    const parsed: unknown = JSON.parse(match?.[1] ?? output);
    if (!Array.isArray(parsed)) throw new Error("proposal must be a JSON array");
    const changes = parsed as DocsSectionChange[];
    if (changes.some((item) => !item || !FILES.includes(item.file)))
        throw new Error("unknown proposal file");
    const seen = new Set<string>();
    for (const change of changes) {
        const key = `${change.file}:${change.heading}`;
        if (
            !(["replace", "add", "remove"] as unknown[]).includes(change.action) ||
            typeof change.heading !== "string" ||
            !/^#{1,6} [^\r\n]+$/.test(change.heading) ||
            typeof change.text !== "string" ||
            typeof change.reason !== "string" ||
            !change.reason.trim() ||
            /[\r\n]/.test(change.reason) ||
            seen.has(key)
        )
            throw new Error(`invalid section change in ${change.file}`);
        seen.add(key);
    }
    return changes;
}

export function validateDocsProposal(
    projectDir: string,
    output: string,
    budget: number,
    expected: Record<string, string>,
): { changes: DocsSectionChange[]; tokens: number; diffs: string } {
    if (
        Object.entries(expected).some(([name, value]) => docsBaseHashes(projectDir)[name] !== value)
    )
        throw new Error("base drifted");
    const changes = parseDocsProposalOutput(output);
    if (!changes.length) throw new Error("empty proposal");
    let tokens = 0;
    let diffs = "";
    for (const file of FILES) {
        const before = existsSync(join(projectDir, file))
            ? readFileSync(join(projectDir, file), "utf8")
            : "";
        let after = before;
        for (const change of changes.filter((item) => item.file === file)) {
            const section = sections(after).find((item) => item.heading === change.heading);
            if (change.action === "add") {
                if (section || !change.text.startsWith(`${change.heading}\n`))
                    throw new Error(`invalid addition ${change.heading}`);
                after += `${after.endsWith("\n") ? "" : "\n"}\n${change.text.trimEnd()}\n`;
            } else {
                if (!section) throw new Error(`missing section ${change.heading}`);
                if (
                    change.action === "replace" &&
                    (!change.text.startsWith(`${change.heading}\n`) ||
                        sections(change.text).length !== 1)
                )
                    throw new Error(`invalid replacement ${change.heading}`);
                const lines = after.split("\n");
                lines.splice(
                    section.start,
                    section.end - section.start,
                    ...(change.action === "remove" ? [] : change.text.trimEnd().split("\n")),
                );
                after = lines.join("\n");
            }
        }
        if (JSON.stringify(protectedBytes(before)) !== JSON.stringify(protectedBytes(after)))
            throw new Error(`protected region changed in ${file}`);
        const originalHeadings = sections(before).map((item) => item.heading);
        const expectedHeadings = originalHeadings
            .filter(
                (heading) =>
                    !changes.some(
                        (item) =>
                            item.file === file &&
                            item.action === "remove" &&
                            item.heading === heading,
                    ),
            )
            .concat(
                changes
                    .filter((item) => item.file === file && item.action === "add")
                    .map((item) => item.heading),
            );
        if (
            JSON.stringify(sections(after).map((item) => item.heading)) !==
            JSON.stringify(expectedHeadings)
        )
            throw new Error(`markdown structure changed in ${file}`);
        tokens += Math.ceil(after.length / 3.5);
        if (after !== before) diffs += diff(file, before, after);
    }
    if (tokens > budget) throw new Error(`over budget: ${tokens} > ${budget}`);
    if (!diffs) throw new Error("no doc changes proposed");
    return { changes, tokens, diffs };
}

export function writeDocsProposal(
    projectDir: string,
    output: string,
    budget: number,
    expected: Record<string, string>,
    head: string,
): string {
    const result = validateDocsProposal(projectDir, output, budget, expected);
    const dir = proposalDir(projectDir);
    mkdirSync(join(dir, "superseded"), { recursive: true });
    ensureCortexKitArtifactGitignore(projectDir);
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const path = join(dir, `${stamp}.md`);
    const body = `# Docs update proposal\n\nBase commit: ${head}\n${FILES.map((name) => `Base SHA-256 ${name}: ${expected[name]}`).join("\n")}\nResulting tokens: ${result.tokens} / ${budget}\n\n## Proposed sections\n\n${result.changes.map((item) => `### ${item.action} ${item.file}: ${item.heading}\nReason: ${item.reason}\n\n\`\`\`markdown\n${item.text}\n\`\`\``).join("\n\n")}\n\n## Unified diff\n\n\`\`\`diff\n${result.diffs}\n\`\`\`\n`;
    writeFileSync(path, body, { flag: "wx" });
    for (const old of listPendingDocsProposals(projectDir))
        if (old !== path)
            renameSync(old, join(dir, "superseded", old.split("/").at(-1) ?? "proposal.md"));
    return path;
}
