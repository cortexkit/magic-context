import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COMMIT_VERB_PATTERN, createCommitHashExtractPattern } from "../../shared/commit-detection";
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker";
import { log } from "../../shared/logger";
import { isSystemDirective, removeSystemReminders } from "../../shared/system-directive";
import { countTokensExactly } from "./token-count-exact";
import {
    loadInstalledTokenizer,
    loadPrimaryTokenizer,
    type TokenizerLike,
} from "./tokenizer-loader";

export { tokenizerPackageRoots } from "./tokenizer-loader";

export interface SessionChunkLine {
    ordinal: number;
    messageId: string;
    /** Hashes from this raw message only, never from its merged display block. */
    commitHashes?: string[];
}

export interface ChunkBlock {
    role: string;
    startOrdinal: number;
    endOrdinal: number;
    parts: string[];
    partMeta: Array<{ ordinal: number; toolResultBodyTokens: number }>;
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

/** Count omitted tool-result bodies so pathological splits prefer the largest result boundary. */
export function extractToolResultBodyTokens(parts: unknown[]): number {
    let tokens = 0;
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type !== "tool") continue;
        const state = p.state as Record<string, unknown> | null;
        if (!state || typeof state !== "object") continue;
        const body = state.output ?? state.error;
        if (body === undefined) continue;
        const text = typeof body === "string" ? body : JSON.stringify(body);
        tokens += Math.ceil(text.length / 4);
    }
    return tokens;
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

// Loading stays lazy: Pi imports this module during cold start, before any
// estimates are needed. The shared loader owns all package probing.
let tokenizer: TokenizerLike | undefined;
let tokenizerLoadAttempted = false;
let tokenizerLoadPromise: Promise<boolean> | undefined;
let tokenizerWarningSent = false;
let tokenizerEncodingPath: string | undefined;
let tokenizerSerializedTableBytes: number | null | undefined;

function recordTokenizerEncodingPath(path: string): void {
    tokenizerEncodingPath = path;
    tokenizerSerializedTableBytes = undefined;
}

function loadTokenizer(): TokenizerLike {
    return loadPrimaryTokenizer(recordTokenizerEncodingPath);
}

async function loadTokenizerFromInstalledPackage(): Promise<TokenizerLike> {
    return loadInstalledTokenizer(recordTokenizerEncodingPath);
}

export interface TokenizerNativeMemoryStats {
    loaded: boolean;
    loadAttempted: boolean;
    tableBytes: number | null;
    tablePath: string | null;
}

function serializedTokenizerTableBytes(entryPath: string): number | null {
    const root = dirname(entryPath);
    const pending = [entryPath];
    const visited = new Set<string>();
    let total = 0;
    try {
        while (pending.length > 0) {
            const nextPath = pending.pop();
            if (!nextPath) break;
            const path = realpathSync(nextPath);
            if (visited.has(path)) continue;
            visited.add(path);
            total += statSync(path).size;
            const source = readFileSync(path, "utf8");
            const localImports = source.matchAll(
                /(?:require\(|\bfrom\s+|\bimport\()\s*["'](\.\.?\/[^"']+)["']/g,
            );
            for (const match of localImports) {
                const specifier = match[1];
                if (!specifier) continue;
                const dependency = resolve(dirname(path), specifier);
                if (dependency.startsWith(root)) pending.push(dependency);
            }
        }
        return total;
    } catch {
        return null;
    }
}

/** Serialized vocabulary bytes are the only tokenizer size exposed by ai-tokenizer. */
export function getTokenizerNativeMemoryStats(): TokenizerNativeMemoryStats {
    if (tokenizerSerializedTableBytes === undefined) {
        tokenizerSerializedTableBytes = tokenizerEncodingPath
            ? serializedTokenizerTableBytes(tokenizerEncodingPath)
            : null;
    }
    return {
        loaded: tokenizer !== undefined,
        loadAttempted: tokenizerLoadAttempted || tokenizerLoadPromise !== undefined,
        tableBytes: tokenizerSerializedTableBytes,
        tablePath: tokenizerEncodingPath ?? null,
    };
}

function warnTokenizerFallback(error: unknown): void {
    if (tokenizerWarningSent) return;
    tokenizerWarningSent = true;
    const reason = error instanceof Error ? error.message : String(error);
    log(
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

// Mixed prose, code, numbers, non-ASCII text and a special-token literal, so a
// tokenizer whose vocabulary counts differently is likely to give another count.
const TOKEN_ESTIMATOR_SAMPLE =
    'Coverage check: const windows = chunk(text, 0x1f, 512); // ok? "naïve" café 日本語 <EOT> 3.14159 ->  done.';
let estimatorFingerprintTokenizer: TokenizerLike | undefined;
let estimatorFingerprint = "";

/**
 * Short identity of the estimator `estimateTokens` currently uses. Results that
 * depend on token counts and outlive the process (such as where embedding
 * windows were split) record it, so a process running a different estimator
 * (the character heuristic after a failed tokenizer load, or a tokenizer that
 * counts differently) recomputes them instead of trusting them. Reads the
 * tokenizer directly so callers counting `estimateTokens` calls are unaffected.
 */
export function getTokenEstimatorFingerprint(): string {
    const activeTokenizer = getTokenizer();
    if (!activeTokenizer) {
        return `heuristic:${estimateTokensHeuristically(TOKEN_ESTIMATOR_SAMPLE)}`;
    }
    if (estimatorFingerprintTokenizer === activeTokenizer) return estimatorFingerprint;
    let fingerprint: string;
    try {
        fingerprint = `tokenizer:${activeTokenizer.encode(TOKEN_ESTIMATOR_SAMPLE, "all").length}`;
    } catch {
        // Still an exact identity: the same tokenizer fails on the sample the same way.
        fingerprint = "tokenizer:sample-unencodable";
    }
    estimatorFingerprintTokenizer = activeTokenizer;
    estimatorFingerprint = fingerprint;
    return fingerprint;
}

/** Admission must refuse rather than treating a heuristic fallback as an exact count. */
export function hasTokenizerForFit(): boolean {
    return getTokenizer() !== undefined;
}

/** Size check that keeps refusal-only estimates from expensive tokenization;
 * shared estimates still tokenize whole texts. */
export function tokenCountUsesByteBound(text: string): boolean {
    return text.length > 1024 * 1024 || /[\p{L}\p{N}]{16385}/u.test(text);
}

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const activeTokenizer = getTokenizer();
    if (!activeTokenizer) return estimateTokensHeuristically(text);
    try {
        // Encode with allowedSpecial="all" so literal special-token strings (e.g.
        // `<EOT>` in tool output) are counted as text instead of throwing. The
        // count is the library's, but long unbroken runs are merged without its
        // quadratic loop (see token-count-exact.ts).
        return countTokensExactly(activeTokenizer, text);
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

/** Exact-content, bounded counts; fallback invalidates counts from the previous tokenizer. */
export function createTokenCountMemo(
    maxEntries: number,
    maxBytes: number,
): (text: string) => number {
    const counts = new Map<
        string,
        { tokenizer: ReturnType<typeof getTokenizer>; tokens: number }
    >();
    let bytes = 0;
    return (text) => {
        const cached = counts.get(text);
        if (cached && cached.tokenizer === getTokenizer()) return cached.tokens;
        const tokens = estimateTokens(text);
        if (cached) {
            bytes -= text.length * 2;
            counts.delete(text);
        }
        if (text.length * 2 <= maxBytes) {
            while (counts.size >= maxEntries || bytes + text.length * 2 > maxBytes) {
                const oldest = counts.keys().next().value;
                if (oldest === undefined) break;
                bytes -= oldest.length * 2;
                counts.delete(oldest);
            }
            counts.set(text, { tokenizer: getTokenizer(), tokens });
            bytes += text.length * 2;
        }
        return tokens;
    };
}

const promptTokenCounts = new Map<
    string,
    { tokenizer: ReturnType<typeof getTokenizer>; tokens: number }
>();
let promptTokenCountBytes = 0;
const PROMPT_TOKEN_COUNT_BYTES = 8 * 1024 * 1024;

/** Count identical fixed historian prompts once, without borrowing counts after tokenizer fallback. */
export function estimateFixedPromptTokens(text: string): number {
    const activeTokenizer = getTokenizer();
    const cached = promptTokenCounts.get(text);
    if (cached && cached.tokenizer === activeTokenizer) {
        promptTokenCounts.delete(text);
        promptTokenCounts.set(text, cached);
        return cached.tokens;
    }
    const tokens = estimateTokens(text);
    if (cached) {
        promptTokenCountBytes -= text.length * 2;
        promptTokenCounts.delete(text);
    }
    if (text.length * 2 <= PROMPT_TOKEN_COUNT_BYTES) {
        while (
            promptTokenCounts.size >= 64 ||
            promptTokenCountBytes + text.length * 2 > PROMPT_TOKEN_COUNT_BYTES
        ) {
            const oldest = promptTokenCounts.keys().next().value;
            if (oldest === undefined) break;
            promptTokenCountBytes -= oldest.length * 2;
            promptTokenCounts.delete(oldest);
        }
        promptTokenCounts.set(text, { tokenizer: getTokenizer(), tokens });
        promptTokenCountBytes += text.length * 2;
    }
    return tokens;
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
