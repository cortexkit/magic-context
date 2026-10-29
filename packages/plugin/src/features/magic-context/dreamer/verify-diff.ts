import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readGitHead, resolveGitTopLevel } from "../memory";
import type { VerifyPromptMemory } from "./verify-prompt";

const exec = promisify(execFile);
/** 12K diff tokens leaves room for 50 claims, the manifest, tools and reasoning in a 128K verify window. */
export const VERIFY_DIFF_BUDGET_TOKENS = 12_000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export interface VerifyDiffEvidence {
    head: string;
    mode: "diff" | "ranges";
    files: Array<{ path: string; text: string; memoryIds: number[] }>;
}

async function git(root: string, args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
        cwd: root,
        timeout: 10_000,
        maxBuffer: MAX_DIFF_BYTES,
        encoding: "utf8",
        windowsHide: true,
    });
    return stdout;
}

/** Without a usable git base or on git error, return null so verify reads source instead of trusting incomplete diff evidence. */
export async function buildVerifyDiffEvidence(
    directory: string,
    memories: readonly VerifyPromptMemory[],
): Promise<VerifyDiffEvidence | null> {
    const root = await resolveGitTopLevel(directory);
    const head = root && (await readGitHead(root));
    if (!root || !head || memories.some((m) => !m.verifiedAt)) return null;
    try {
        const bases = new Map<number, string>();
        const basesByTime = new Map<number, string>();
        for (const memory of memories) {
            const at = memory.verifiedAt;
            if (!at) return null;
            const base =
                memory.verifiedCommit ??
                basesByTime.get(at) ??
                (
                    await git(root, [
                        "rev-list",
                        "-1",
                        `--before=${new Date(at).toISOString()}`,
                        head,
                    ])
                ).trim();
            if (!/^[0-9a-f]{40}$/i.test(base)) return null;
            if (!memory.verifiedCommit) basesByTime.set(at, base);
            bases.set(memory.id, base);
        }
        // A shared file is presented once, from the oldest verification time.
        // This may include extra hunks but cannot hide a later memory's changes.
        const grouped = new Map<string, { base: string; time: number; ids: number[] }>();
        for (const memory of memories) {
            const at = memory.verifiedAt;
            const base = bases.get(memory.id);
            if (!at || !base) return null;
            for (const file of memory.mappedFiles) {
                if (!file || file.startsWith("/") || file.split("/").includes("..")) return null;
                const previous = grouped.get(file);
                if (!previous)
                    grouped.set(file, {
                        base,
                        time: at,
                        ids: [memory.id],
                    });
                else {
                    previous.ids.push(memory.id);
                    if (at < previous.time) {
                        previous.time = at;
                        previous.base = base;
                    }
                }
            }
        }
        const files: VerifyDiffEvidence["files"] = [];
        const namesByBase = new Map<string, string[][]>();
        for (const [file, group] of grouped) {
            // Git's rename detection needs both sides in its candidate set. Reuse
            // name-status across files sharing a base instead of scanning every
            // commit's files once per mapped file.
            let names = namesByBase.get(group.base);
            if (names === undefined) {
                names = (await git(root, ["diff", "-M", "--name-status", group.base, head]))
                    .split("\n")
                    .map((line) => line.split("\t"));
                namesByBase.set(group.base, names);
            }
            const rename = names.find((parts) => parts[0]?.startsWith("R") && parts[1] === file);
            const paths = rename ? [file, rename[2]] : [file];
            const [committed, pending] = await Promise.all([
                git(root, ["diff", "-M", "--no-ext-diff", group.base, head, "--", ...paths]),
                git(root, ["diff", "-M", "--no-ext-diff", head, "--", ...paths]),
            ]);
            const status = rename
                ? `RENAMED ${file} -> ${rename[2]}\n`
                : names.some((parts) => parts[0] === "D" && parts[1] === file && parts.length === 2)
                  ? `DELETED ${file}\n`
                  : "";
            files.push({
                path: file,
                memoryIds: group.ids,
                text:
                    `${status}${committed}${pending ? `\nUncommitted changes:\n${pending}` : ""}` ||
                    "No changed hunks in mapped file.",
            });
        }
        // UTF-8 bytes / 4 is a rough token estimate; use the more conservative
        // character count so non-ASCII or punctuation-heavy diffs don't overfill.
        const size = files.reduce((sum, file) => sum + file.text.length, 0);
        if (size <= VERIFY_DIFF_BUDGET_TOKENS * 3) return { head, mode: "diff", files };
        return {
            head,
            mode: "ranges",
            files: files.map((file) => {
                const headers = file.text
                    .split("\n")
                    .filter((line) =>
                        /^(?:@@|diff --git|rename |deleted file mode|new file mode|RENAMED|DELETED|Uncommitted changes:)/.test(
                            line,
                        ),
                    );
                const lines = file.text.split("\n");
                const added = lines.filter(
                    (line) => line.startsWith("+") && !line.startsWith("+++"),
                ).length;
                const removed = lines.filter(
                    (line) => line.startsWith("-") && !line.startsWith("---"),
                ).length;
                return {
                    ...file,
                    text: `Changed lines: +${added}/-${removed}.\n${headers.join("\n")}\nRead only these changed line ranges if they may affect the claim.`,
                };
            }),
        };
    } catch {
        return null;
    }
}
