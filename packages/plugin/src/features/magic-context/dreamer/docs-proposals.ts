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

interface Section {
    heading: string;
    level: number;
    start: number;
    end: number;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/;

function sections(lines: string[]): Section[] {
    const result: Section[] = [];
    const open: Section[] = [];
    let fence: string | undefined;
    for (let i = 0; i < lines.length; i++) {
        const heading = lines[i].replace(/\r$/, "");
        const marker = heading.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
            continue;
        }
        if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
            fence = marker[1];
            continue;
        }
        const match = heading.match(ATX_HEADING);
        if (!match) continue;
        const level = match[1].length;
        // Only siblings and ancestors end a section; deeper headings stay in its range.
        for (
            let previous = open.at(-1);
            previous && previous.level >= level;
            previous = open.at(-1)
        ) {
            previous.end = i;
            open.pop();
        }
        const section = { heading, level, start: i, end: lines.length };
        result.push(section);
        open.push(section);
    }
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

// Only a non-array reply triggers a model retry. Check each array entry later so a bad one does not discard valid changes.
export function parseDocsProposalOutput(output: string): unknown[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch (error) {
        const match =
            output.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```(?=\s|$)/) ??
            output.match(/```json\s*([\s\S]*?)```/);
        if (!match) throw error;
        parsed = JSON.parse(match[1]);
    }
    if (!Array.isArray(parsed)) throw new Error("proposal must be a JSON array");
    return parsed;
}

function readChange(item: unknown): DocsSectionChange | string {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "expected an object";
    const { file, action, heading, text, reason } = item as Record<string, unknown>;
    if (file !== "ARCHITECTURE.md" && file !== "STRUCTURE.md") return "unknown proposal file";
    if (action !== "replace" && action !== "add" && action !== "remove") return "invalid action";
    if (typeof heading !== "string" || /[\r\n]/.test(heading) || !ATX_HEADING.test(heading))
        return "invalid section heading";
    if (typeof text !== "string") return "section text must be a string";
    if (typeof reason !== "string" || !reason.trim() || /[\r\n]/.test(reason))
        return "expected a one-line reason";
    return { file, action, heading, text, reason };
}

function applyChange(before: string, change: DocsSectionChange): { after: string } | string {
    const lines = before.split("\n");
    const existing = sections(lines);
    const index = existing.findIndex((item) => item.heading === change.heading);
    const replacement = change.action === "remove" ? [] : change.text.trimEnd().split("\n");
    const inserted = sections(replacement);
    const wholeSection =
        inserted[0]?.heading === change.heading &&
        inserted[0].start === 0 &&
        inserted[0].end === replacement.length;
    const expectedHeadings = existing.map((item) => item.heading);
    const insertedHeadings = inserted.map((item) => item.heading);
    let after: string;
    if (change.action === "add") {
        if (index !== -1 || !wholeSection) return `invalid addition ${change.heading}`;
        after = `${before.endsWith("\n") ? before : `${before}\n`}\n${replacement.join("\n")}\n`;
        expectedHeadings.push(...insertedHeadings);
    } else {
        if (index === -1) return `missing section ${change.heading}`;
        if (change.action === "replace" && !wholeSection)
            return `invalid replacement ${change.heading}`;
        const section = existing[index];
        const affected = existing.filter(
            (item) => item.start >= section.start && item.start < section.end,
        );
        expectedHeadings.splice(index, affected.length, ...insertedHeadings);
        if (change.action === "replace" && section.end === lines.length && before.endsWith("\n"))
            replacement.push("");
        lines.splice(section.start, section.end - section.start, ...replacement);
        after = lines.join("\n");
    }
    if (JSON.stringify(protectedBytes(before)) !== JSON.stringify(protectedBytes(after)))
        return `protected region changed in ${change.file}`;
    if (
        JSON.stringify(sections(after.split("\n")).map((item) => item.heading)) !==
        JSON.stringify(expectedHeadings)
    )
        return `markdown structure changed in ${change.file}`;
    if (after === before) return "no doc changes proposed";
    return { after };
}

interface DroppedDocsChange {
    index: number;
    reason: string;
}

function applyChanges(
    items: unknown[],
    originals: Record<DocsSectionChange["file"], string>,
    overBudget: ReadonlyMap<number, string>,
) {
    const docs = { ...originals };
    const kept: { index: number; change: DocsSectionChange; grew: boolean }[] = [];
    const dropped: DroppedDocsChange[] = [];
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
        const change = overBudget.get(index) ?? readChange(item);
        if (typeof change === "string") {
            dropped.push({ index, reason: change });
            continue;
        }
        const key = `${change.file}:${change.heading}`;
        const before = docs[change.file];
        const result = seen.has(key)
            ? `duplicate section change ${change.heading}`
            : applyChange(before, change);
        if (typeof result === "string") {
            dropped.push({ index, reason: result });
            continue;
        }
        kept.push({ index, change, grew: result.after.length > before.length });
        docs[change.file] = result.after;
        seen.add(key);
    }
    const tokens = FILES.reduce((sum, file) => sum + Math.ceil(docs[file].length / 3.5), 0);
    return { docs, kept, dropped, tokens };
}

export function validateDocsProposal(
    projectDir: string,
    output: string,
    budget: number,
    expected: Record<string, string>,
): { changes: DocsSectionChange[]; dropped: DroppedDocsChange[]; tokens: number; diffs: string } {
    const readDoc = (file: DocsSectionChange["file"]) => {
        const path = join(projectDir, file);
        return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    const originals = {
        "ARCHITECTURE.md": readDoc("ARCHITECTURE.md"),
        "STRUCTURE.md": readDoc("STRUCTURE.md"),
    };
    if (
        Object.keys(expected).some(
            (name) =>
                !FILES.some((file) => file === name && hash(originals[file]) === expected[name]),
        )
    )
        throw new Error("base drifted");
    const items = parseDocsProposalOutput(output);
    const overBudget = new Map<number, string>();
    let result = applyChanges(items, originals, overBudget);
    while (result.tokens > budget && result.kept.length) {
        const reason = `over budget: ${result.tokens} > ${budget}`;
        const latestGrowth = [...result.kept].reverse().find((item) => item.grew);
        if (latestGrowth) overBudget.set(latestGrowth.index, reason);
        else for (const item of result.kept) overBudget.set(item.index, reason);
        // Replay in proposal order: later changes may target a section we just dropped.
        result = applyChanges(items, originals, overBudget);
    }
    const diffs = FILES.filter((file) => originals[file] !== result.docs[file])
        .map((file) => diff(file, originals[file], result.docs[file]))
        .join("");
    return {
        changes: result.kept.map((item) => item.change),
        dropped: result.dropped,
        tokens: result.tokens,
        diffs,
    };
}

export function writeDocsProposal(
    projectDir: string,
    output: string,
    budget: number,
    expected: Record<string, string>,
    head: string,
): { path: string | null; dropped: DroppedDocsChange[] } {
    const result = validateDocsProposal(projectDir, output, budget, expected);
    if (!result.diffs) return { path: null, dropped: result.dropped };
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
    return { path, dropped: result.dropped };
}
