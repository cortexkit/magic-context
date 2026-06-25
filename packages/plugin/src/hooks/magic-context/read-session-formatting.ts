import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMIT_VERB_PATTERN, createCommitHashExtractPattern } from "../../shared/commit-detection";
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker";
import { isSystemDirective, removeSystemReminders } from "../../shared/system-directive";

export interface SessionChunkLine {
    ordinal: number;
    messageId: string;
}

export interface ChunkBlock {
    role: string;
    startOrdinal: number;
    endOrdinal: number;
    parts: string[];
    meta: SessionChunkLine[];
    commitHashes: string[];
    /**
     * True when every part in this block came from tool-call summaries only
     * (no textual narrative from the user or assistant). Historian often skips
     * such blocks — that's safe as long as we know the skipped range is
     * tool-only, so we mark the block here and let validation absorb the gap.
     */
    isToolOnly: boolean;
}

const MAX_COMMITS_PER_BLOCK = 5;

export function hasMeaningfulUserText(parts: unknown[]): boolean {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const candidate = part as Record<string, unknown>;
        if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
        if (candidate.ignored === true) continue;

        const cleaned = removeSystemReminders(candidate.text)
            .replace(OMO_INTERNAL_INITIATOR_MARKER, "")
            .trim();

        if (!cleaned) continue;
        if (isSystemDirective(cleaned)) continue;
        return true;
    }

    return false;
}

export function extractTexts(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
            texts.push(p.text.trim());
        }
    }
    return texts;
}

/** Extract compact tool-call summaries from message parts.
 *  Returns lines like "TC: Fix lint errors" or "TC: read(src/index.ts)". */
export function extractToolCallSummaries(parts: unknown[]): string[] {
    const summaries: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type !== "tool" || typeof p.tool !== "string") continue;

        const state = p.state as Record<string, unknown> | null;
        if (!state || typeof state !== "object") continue;
        const input = state.input as Record<string, unknown> | null;
        const metadata = state.metadata as Record<string, unknown> | null;

        // Skill tool: surface the skill name (input.name) before the description
        // fallback, which would otherwise mask it if metadata.description exists.
        // The name is an IDENTITY key — the historian extracts the skill-id from
        // this marker and recall keys on the raw input.name, so the marker name
        // MUST equal the raw name (no truncation, no mutation) or the stored id
        // won't match recall. Emit it VERBATIM when marker-safe; if it contains a
        // marker-breaking char (CR/LF/tab/")") — which a real skill directory name
        // never does — drop the name (`TC: skill`) rather than emit a corrupted or
        // mutated identity.
        if (p.tool === "skill") {
            const rawName = input && typeof input.name === "string" ? input.name : "";
            // Only CR/LF/tab genuinely corrupt the single-line `TC: skill(<name>)`
            // marker; a ")" does NOT break the line and the historian reads the
            // marker as natural language (not a strict paren-matched parse), so a
            // ")"-containing name is preserved VERBATIM rather than dropped —
            // dropping the name loses historian attribution + recall keying, which
            // is worse than a cosmetically-ambiguous paren. (Real skill directory
            // names are slugs; this is defensive.)
            const markerSafe = rawName !== "" && !/[\r\n\t]/.test(rawName);
            summaries.push(markerSafe ? `TC: skill(${rawName})` : "TC: skill");
            continue;
        }

        // Prefer explicit description (bash tool always has one)
        const description =
            (input && typeof input.description === "string" && input.description) ||
            (metadata && typeof metadata.description === "string" && metadata.description);
        if (description) {
            summaries.push(`TC: ${description}`);
            continue;
        }

        // Fall back to tool_name(key_arg) for common tools
        const toolName = p.tool as string;
        const keyArg = extractKeyArg(toolName, input);
        summaries.push(keyArg ? `TC: ${toolName}(${keyArg})` : `TC: ${toolName}`);
    }
    return summaries;
}

function extractKeyArg(_toolName: string, input: Record<string, unknown> | null): string | null {
    if (!input) return null;
    // File-oriented tools: show the path
    if (typeof input.filePath === "string") return truncateArg(input.filePath);
    if (typeof input.path === "string") return truncateArg(input.path);
    // Search tools: show the pattern/query
    if (typeof input.pattern === "string") return truncateArg(input.pattern);
    if (typeof input.query === "string") return truncateArg(input.query);
    // Symbol tools
    if (typeof input.symbol === "string") return input.symbol;
    // Module tools
    if (typeof input.module === "string") return input.module;
    // Memory/note tools: show the action
    if (typeof input.action === "string") return input.action;
    return null;
}

function truncateArg(value: string, maxLen = 60): string {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}…`;
}

// Keep ai-tokenizer out of the eager module graph. Pi imports this module through
// its system-prompt path during cold start, while token estimates are not needed
// until the first real prompt is processed. Synchronous require preserves the
// estimateTokens API and defers both package loads until that first non-empty call.
type TokenizerLike = {
    encode: (text: string, allowedSpecial: string) => number[];
};
type TokenizerConstructor = new (encoding: unknown) => TokenizerLike;

const TOKENIZER_PACKAGE_DIRS = [
    ["@cortexkit", "opencode-magic-context"],
    ["@cortexkit", "pi-magic-context"],
] as const;
let tokenizer: TokenizerLike | undefined;
let tokenizerLoadAttempted = false;
let tokenizerLoadPromise: Promise<boolean> | undefined;
let tokenizerWarningSent = false;

function tokenizerPackageRoots(): string[] {
    const cwd = process.cwd();
    const openCodeCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode");
    const roots = [cwd, openCodeCache];
    const candidates: string[] = [];
    for (const root of roots) {
        for (const packageDir of TOKENIZER_PACKAGE_DIRS) {
            // Prefer a dependency nested under the plugin over a conflicting
            // version hoisted by the host application.
            candidates.push(
                join(root, "node_modules", ...packageDir, "node_modules", "ai-tokenizer"),
            );
        }
        candidates.push(join(root, "node_modules", "ai-tokenizer"));
    }

    let ancestor = process.argv[1] ? dirname(resolve(process.argv[1])) : cwd;
    while (true) {
        candidates.push(join(ancestor, "node_modules", "ai-tokenizer"));
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }
    return [...new Set(candidates)];
}

function packageImportTarget(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const conditions = value as Record<string, unknown>;
    return packageImportTarget(conditions.import) ?? packageImportTarget(conditions.default);
}

function findTokenizerImportPaths(): { tokenizerPath: string; encodingPath: string } | undefined {
    for (const packageRoot of tokenizerPackageRoots()) {
        const packageJsonPath = join(packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        try {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
                module?: unknown;
                main?: unknown;
                exports?: Record<string, unknown>;
            };
            const tokenizerTarget =
                packageImportTarget(packageJson.exports?.["."]) ??
                (typeof packageJson.module === "string" ? packageJson.module : undefined) ??
                (typeof packageJson.main === "string" ? packageJson.main : undefined);
            const encodingTarget = packageImportTarget(packageJson.exports?.["./encoding/claude"]);
            if (!tokenizerTarget || !encodingTarget) continue;
            return {
                tokenizerPath: realpathSync(join(packageRoot, tokenizerTarget)),
                encodingPath: realpathSync(join(packageRoot, encodingTarget)),
            };
        } catch {
            // Try the next npm layout; the caller warns if none is usable.
        }
    }
    return undefined;
}

function constructTokenizer(tokenizerModule: unknown, claudeEncoding: unknown): TokenizerLike {
    const typedModule = tokenizerModule as {
        default?: TokenizerConstructor;
        Tokenizer?: TokenizerConstructor;
    };
    const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
    if (!Tokenizer) {
        throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
    }
    return new Tokenizer(claudeEncoding);
}

function loadTokenizer(): TokenizerLike {
    // Non-literal specifiers keep Bun's bundler static analysis from folding the
    // Claude vocabulary into the eager chunk.
    const requireFromThisModule = createRequire(import.meta.url);
    return constructTokenizer(
        requireFromThisModule("ai-" + "tokenizer"),
        requireFromThisModule("ai-tokenizer/encoding/" + "claude"),
    );
}

async function loadTokenizerFromInstalledPackage(): Promise<TokenizerLike> {
    const installedPaths = findTokenizerImportPaths();
    if (!installedPaths) {
        throw new Error(
            "ai-tokenizer was not found under the project, runtime, or OpenCode cache node_modules roots",
        );
    }
    const [tokenizerModule, claudeEncoding] = await Promise.all([
        import(pathToFileURL(installedPaths.tokenizerPath).href),
        import(pathToFileURL(installedPaths.encodingPath).href),
    ]);
    return constructTokenizer(tokenizerModule, claudeEncoding);
}

function warnTokenizerFallback(error: unknown): void {
    if (tokenizerWarningSent) return;
    tokenizerWarningSent = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
        "[magic-context] ai-tokenizer is unavailable; using approximate character-based token counts for this process. Token budgets, persisted per-message counts, and protected-tail/compartment boundaries may be less accurate until restart:",
        reason,
    );
}

export async function preloadTokenizer(): Promise<boolean> {
    if (tokenizer) return true;
    if (tokenizerLoadAttempted) return false;
    if (tokenizerLoadPromise) return tokenizerLoadPromise;

    tokenizerLoadPromise = (async () => {
        try {
            try {
                tokenizer = loadTokenizer();
            } catch {
                tokenizer = await loadTokenizerFromInstalledPackage();
            }
            tokenizerLoadAttempted = true;
            return true;
        } catch (error) {
            tokenizerLoadAttempted = true;
            warnTokenizerFallback(error);
            return false;
        } finally {
            tokenizerLoadPromise = undefined;
        }
    })();
    return tokenizerLoadPromise;
}

function getTokenizer(): TokenizerLike | undefined {
    if (tokenizer || tokenizerLoadAttempted) return tokenizer;
    tokenizerLoadAttempted = true;
    try {
        tokenizer = loadTokenizer();
    } catch (error) {
        warnTokenizerFallback(error);
    }
    return tokenizer;
}

function estimateTokensHeuristically(text: string): number {
    return Math.ceil(text.length / 3.5);
}

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const activeTokenizer = getTokenizer();
    if (!activeTokenizer) return estimateTokensHeuristically(text);
    try {
        // Encode with allowedSpecial="all" so literal special-token strings (e.g.
        // `<EOT>` in tool output) are counted as text instead of throwing.
        return activeTokenizer.encode(text, "all").length;
    } catch (error) {
        // Estimation must not fail a prompt. Latch the deterministic fallback for
        // the rest of this process so identical text does not alternate between
        // exact and approximate counts as cache/budget decisions are made.
        tokenizer = undefined;
        tokenizerLoadAttempted = true;
        warnTokenizerFallback(error);
        return estimateTokensHeuristically(text);
    }
}

export function normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

export function compactRole(role: string): string {
    if (role === "assistant") return "A";
    if (role === "user") return "U";
    return role.slice(0, 1).toUpperCase() || "M";
}

export function formatBlock(block: ChunkBlock): string {
    const range =
        block.startOrdinal === block.endOrdinal
            ? `[${block.startOrdinal}]`
            : `[${block.startOrdinal}-${block.endOrdinal}]`;
    const commitSuffix =
        block.commitHashes.length > 0 ? ` commits: ${block.commitHashes.join(", ")}` : "";
    return `${range} ${block.role}:${commitSuffix} ${block.parts.join(" / ")}`;
}

export function extractCommitHashes(text: string): string[] {
    const hashes: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(createCommitHashExtractPattern())) {
        const hash = match[1]?.toLowerCase();
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        hashes.push(hash);
        if (hashes.length >= MAX_COMMITS_PER_BLOCK) break;
    }
    return hashes;
}

export function compactTextForSummary(
    text: string,
    role: string,
): { text: string; commitHashes: string[] } {
    const commitHashes = role === "assistant" ? extractCommitHashes(text) : [];
    if (commitHashes.length === 0 || !COMMIT_VERB_PATTERN.test(text)) {
        return { text, commitHashes };
    }

    const withoutHashes = text
        .replace(createCommitHashExtractPattern(), "")
        .replace(/\(\s*\)/g, "")
        .replace(/\s+,/g, ",")
        .replace(/,\s*,+/g, ", ")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.;:])/g, "$1")
        .trim();

    return {
        text: withoutHashes.length > 0 ? withoutHashes : text,
        commitHashes,
    };
}

export function mergeCommitHashes(existing: string[], next: string[]): string[] {
    if (next.length === 0) return existing;
    const merged = [...existing];
    for (const hash of next) {
        if (merged.includes(hash)) continue;
        merged.push(hash);
        if (merged.length >= MAX_COMMITS_PER_BLOCK) break;
    }
    return merged;
}
