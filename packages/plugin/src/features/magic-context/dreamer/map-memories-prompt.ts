import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
    assertNoDuplicateManifestIds,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

/**
 * map-memories prompt + host-side helpers.
 *
 * map-memories is a ONE-TIME backfill: it locates the repo file(s) that back
 * each project memory (or marks it file-independent), recording the mapping so
 * the verify task can run incrementally from the start (verify reads "which
 * files changed since this memory's verification" — without a mapping, the first
 * verify would have to check the whole pool and time out, the cold-start trap).
 *
 * The agent only LOCATES backing files; the host parses its single XML manifest
 * and writes the mappings via recordMemoryMapping (mapped, not yet content-
 * verified). The prompt was calibrated in the shadow harness on real memory
 * pools (DeepSeek-v4-Flash); see .alfonso/plans/dreamer-v2-rework.md.
 */

export const MAP_MEMORIES_SYSTEM_PROMPT = `You are a memory mapper for the magic-context system. You map project memories to the repository files that back them.

A memory's BACKING FILES are the file(s) whose code the memory makes a claim about — the files you would open to check whether the memory is accurate. You do NOT judge accuracy, rewrite, or remove anything. You only LOCATE backing files.

Tools (read-only): read, grep, glob. Use at most 3 tool calls per memory, including searches and reads. Never read the same file twice in a batch; reuse what you already learned. Never repeat an identical search or use broad searches such as "fn " or ".*". Request one useful line range, not repeated slices. Each memory may come with "Likely files" from paths it names or a literal identifier search, confirmed to exist — confirm those FIRST (cheap) instead of searching. Use search/grep to FIND code only when no likely files are given. Do not guess — confirm a file exists and genuinely backs the memory before listing it. You are locating code, not exhaustively verifying the claim. If the call budget runs out before you can decide, leave that id unmapped and move on; uncertainty is not evidence of file-independence.

For each memory decide ONE of:
- Backing files found → the specific repo-relative paths whose code the memory is about; do not chase every caller or related implementation.
- File-independent → the memory describes EXTERNAL behavior (a provider / API / platform / protocol limit, e.g. "Anthropic returns 400 on empty content"), or a pure process / workflow / philosophy rule, with NO specific local file that backs it. A BEHAVIORAL claim (when to act, how to work, who decides, or tool-usage discipline) is file-independent even when it cites file paths or commands as examples: a named file is not the file backing the rule.

Output ONE XML manifest and NOTHING else — no narration, no per-memory commentary, no reasoning. Open <mappings> before investigating. Emit each <memory> element as soon as you decide its mapping, before investigating the next memory, so an interruption cannot lose completed work. Close </mappings> when finished:
<mappings>
<memory id="N" files="path/a.ts,path/b.ts"/>
<memory id="M" independent="true"/>
</mappings>

Rules:
- Every decided input memory id MUST appear exactly once. Omit uncertain ids rather than inventing backing files or declaring them independent.
- files: repo-relative, comma-separated, no spaces inside a path. Only files that actually exist and genuinely back the memory.
- A BACKING FILE is CODE that implements or handles the claim — not a file that merely mentions it. A path named inside a process directive is an action target or example, not evidence that the file backs the directive. A markdown doc (.md), a PARITY/notes file, or a test that only DESCRIBES an external fact is NOT a backing file. If the only place a memory's fact appears is prose/docs/a test (no code implements or handles it), mark it independent="true".
- Many CONSTRAINTS are HYBRID: "external system does X, and OUR code handles it here." Map those to the HANDLING code (you can verify the handling, even though you can't verify the external behavior). Only mark independent when there is NO local code that implements or handles the fact.
- Prefer the most specific file(s); do not pad with tangential files. Most memories map to one file; some to a few.
- Mark independent="true" only for the file-independent cases above; an investigation that runs out of calls stays unmapped.`;

// CONTEXT GUARD: seed at most this many candidate PATHS per memory (path strings
// only — never file contents, which is what blows up context). The agent
// confirms these instead of blind-searching to find them. ~half the pool names a
// path; the seed is a free assist for that half, not load-bearing.
export const MAX_SEED_PATHS_PER_MEMORY = 3;

// Repo-relative path-like tokens with a source/code extension. Deliberately
// narrow: a multi-segment path (a/b/c.ts), optionally wrapped in backticks. We
// only SEED what the memory already names; the agent still confirms (paths can
// be stale/renamed → the host validates existence before seeding).
// NOTE: built FRESH per call via matchAll — a shared /g regex carries lastIndex
// across calls and silently skips matches at the start of later inputs.
const PATH_PATTERN =
    "`?((?:[\\w.-]+\\/)+[\\w.-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|json|jsonc|sql|toml|sh))`?";

/** Extract candidate backing-file paths a memory NAMES, keep only those that
 *  EXIST in the repo, dedupe, cap. Pure host-side seeding — no LLM, no contents. */
export function extractMemoryCandidatePaths(content: string, repoDir: string): string[] {
    const found = new Set<string>();
    const root = path.resolve(repoDir);
    for (const match of content.matchAll(new RegExp(PATH_PATTERN, "g"))) {
        const rel = match[1];
        if (rel.includes("..")) continue;
        const abs = path.resolve(repoDir, rel);
        if (!abs.startsWith(`${root}/`)) continue;
        try {
            if (existsSync(abs) && statSync(abs).isFile()) found.add(rel);
        } catch {
            /* unreadable → skip */
        }
        if (found.size >= MAX_SEED_PATHS_PER_MEMORY) break;
    }
    return [...found];
}

export interface MapMemoryInput {
    id: number;
    category: string;
    content: string;
    candidates: string[];
}

const execFileAsync = promisify(execFile);

/** One bounded literal source search per batch; only paths enter the model context.
 * An unavailable repository or oversized/slow search leaves path seeds intact. */
export async function seedIdentifierCandidates(
    memories: MapMemoryInput[],
    repoDir: string,
): Promise<MapMemoryInput[]> {
    const identifiers = new Map(
        memories
            .filter((memory) => memory.candidates.length === 0)
            .map((memory) => [
                memory.id,
                [
                    ...new Set(
                        memory.content.match(
                            /\b(?:[A-Z][A-Za-z0-9_]{3,}|[a-z][a-z0-9]*[A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*_[A-Za-z0-9_]{2,})\b/g,
                        ) ?? [],
                    ),
                ].slice(0, 3),
            ]),
    );
    const terms = [...new Set([...identifiers.values()].flat())];
    if (terms.length === 0) return memories;
    let stdout: string;
    try {
        const result = await execFileAsync(
            "git",
            [
                "-c",
                "core.quotePath=false",
                "grep",
                "--no-color",
                "-n",
                "-I",
                "-F",
                ...terms.flatMap((term) => ["-e", term]),
                "--",
                ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "sql", "sh"].map(
                    (extension) => `*.${extension}`,
                ),
            ],
            {
                cwd: repoDir,
                encoding: "utf8",
                timeout: 2_000,
                maxBuffer: 256 * 1024,
                windowsHide: true,
                // A timed-out or oversized lookup must terminate even if Git ignores SIGTERM.
                killSignal: "SIGKILL",
            },
        );
        stdout = result.stdout;
    } catch {
        return memories;
    }
    const matches = stdout.split("\n").flatMap((line) => {
        const match = line.match(/^([^:]+):\d+:(.*)$/);
        return match ? [{ file: match[1], text: match[2] }] : [];
    });
    return memories.map((memory) => {
        const names = identifiers.get(memory.id);
        if (!names?.length) return memory;
        const files = new Map<string, number>();
        for (const match of matches) {
            const score = names.filter((name) => match.text.includes(name)).length;
            if (score) files.set(match.file, Math.max(files.get(match.file) ?? 0, score));
        }
        const candidates = [...files]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, MAX_SEED_PATHS_PER_MEMORY)
            .map(([file]) => file);
        return candidates.length ? { ...memory, candidates } : memory;
    });
}

export function buildMapMemoriesPrompt(projectPath: string, memories: MapMemoryInput[]): string {
    const list = memories
        .map((m) => {
            const seed = m.candidates.length
                ? `\nLikely files (candidate paths, confirmed to exist): ${m.candidates.join(", ")}`
                : "";
            return `[${m.id}] ${m.category}\n${m.content}${seed}`;
        })
        .join("\n\n");
    return `## Map these memories to their backing files

Project: ${projectPath}

For each memory below, find the repo file(s) it makes a claim about, or mark it file-independent. Behavioral process/workflow directives stay file-independent even when they name files. When "Likely files" are listed, those paths either occur in the memory or match its identifiers in a bounded literal source search — START there only for code claims: confirm each actually backs the claim (a quick read/outline), drop any that don't, add others only if genuinely needed. Search from scratch only when no likely files are given. Use at most 3 tool calls per memory, reuse prior reads, and emit each decided mapping immediately in ONE <mappings> manifest. Leave uncertain ids unmapped and move on.

<memories>
${list}
</memories>`;
}

export interface ParsedMemoryMapping {
    id: number;
    files: string[];
    independent: boolean;
}

// Built fresh per call — a shared /g regex carries lastIndex across inputs.
const MEMORY_ELEMENT_PATTERN = "<memory\\b([^<>]*)(?:\\/>|>([\\s\\S]*?)<\\/memory>)";
const NESTED_FILE_PATTERN = "<file\\b([^>]*)\\/?>";

function extractNestedFilePaths(inner: string): string[] {
    const files: string[] = [];
    for (const match of inner.matchAll(new RegExp(NESTED_FILE_PATTERN, "gi"))) {
        const pathMatch = match[1].match(/\bpath\s*=\s*"([^"]+)"/);
        if (pathMatch) files.push(pathMatch[1].trim());
    }
    return files.filter(Boolean);
}

function mappingsBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "mappings");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "mappings", "memory");
        // Wrong root / JSON is a format miss, not truncation. Keep the original
        // "closing root" error so a length-capped `<mappings>` still looks like
        // truncation rather than an unrecognized shape.
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/** Parse the agent's complete `<mappings>` manifest. A missing root close tag is
 *  treated as truncation and rejects the whole batch. `independent` is honored
 *  only for the explicit sentinel; a missing `files` attribute is never treated
 *  as file-independent (that silently excluded memories from verify). Nested
 *  `<file path="…"/>` children are accepted as an unambiguous alias. */
export function parseMapMemoriesManifest(text: string): ParsedMemoryMapping[] {
    const out: ParsedMemoryMapping[] = [];
    const body = mappingsBody(text);
    for (const m of body.matchAll(new RegExp(MEMORY_ELEMENT_PATTERN, "gi"))) {
        const attrs = m[1];
        const inner = m[2];
        const idMatch = attrs.match(/\bid\s*=\s*"(\d+)"/);
        if (!idMatch) throw new Error("mappings manifest entry missing numeric id");
        const id = Number.parseInt(idMatch[1], 10);
        if (!Number.isInteger(id)) throw new Error("mappings manifest entry missing numeric id");
        const independent = /\bindependent\s*=\s*"(?:true|1)"/i.test(attrs);
        const filesMatch = attrs.match(/\bfiles\s*=\s*"([^"]*)"/);
        const attrFiles = filesMatch
            ? filesMatch[1]
                  .split(",")
                  .map((f) => f.trim())
                  .filter(Boolean)
            : [];
        const nestedFiles = inner ? extractNestedFilePaths(inner) : [];
        const files = attrFiles.length > 0 ? attrFiles : nestedFiles;
        if (!independent && files.length === 0) {
            throw new Error(
                `mappings manifest entry ${id} has neither files nor independent="true"`,
            );
        }
        out.push({
            id,
            files: independent && files.length === 0 ? [] : files,
            independent: independent && files.length === 0,
        });
    }
    if (out.length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "mappings", "memory"));
    }
    return out;
}

/** Responses must contain a closed manifest with syntactically valid entries.
 *  A closed empty manifest is valid when no memory's mapping could be confirmed.
 *  The mapper commits valid expected ids; omissions follow its retry/backoff policy.
 *  Duplicate expected ids are rejected; duplicate unknown ids are ignored. */
export function validateMapMemoriesManifest(
    text: string,
    expectedIds: ReadonlySet<number>,
): ParsedMemoryMapping[] {
    const parsed = parseMapMemoriesManifest(text);
    assertNoDuplicateManifestIds(
        parsed.filter((entry) => expectedIds.has(entry.id)).map((entry) => entry.id),
        "mappings",
    );
    return parsed;
}

/** Recover only closed, individually valid decisions from an interrupted manifest.
 * Conflicting decisions for one id are left unmapped, never resolved by guessing. */
export function parsePartialMapMemoriesManifest(
    text: string,
    expectedIds: ReadonlySet<number>,
): ParsedMemoryMapping[] {
    const start = text.indexOf("<mappings>");
    if (start < 0) return [];
    const entries = new Map<number, ParsedMemoryMapping>();
    const conflicts = new Set<number>();
    for (const match of text.slice(start).matchAll(new RegExp(MEMORY_ELEMENT_PATTERN, "gi"))) {
        try {
            const entry = parseMapMemoriesManifest(`<mappings>${match[0]}</mappings>`)[0];
            if (!entry || !expectedIds.has(entry.id) || conflicts.has(entry.id)) continue;
            const previous = entries.get(entry.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
                entries.delete(entry.id);
                conflicts.add(entry.id);
            } else {
                entries.set(entry.id, entry);
            }
        } catch {
            // A malformed decision must not prevent banking other completed memories.
        }
    }
    return [...entries.values()];
}
