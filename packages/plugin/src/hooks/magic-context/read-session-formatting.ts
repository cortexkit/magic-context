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

const COMMIT_HASH_PATTERN = /`?\b([0-9a-f]{6,12})\b`?/gi;
const COMMIT_HINT_PATTERN = /\b(commit(?:ted)?|cherry-?pick(?:ed)?|hash(?:es)?|sha)\b/i;
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

// Real Claude tokenizer (ai-tokenizer with Claude encoding). Static ESM
// import — ai-tokenizer is a hard runtime dependency and is used on every
// transform pass, so there's no reason to lazy-load it. The previous
// dynamic `eval("require")` pattern silently failed in Bun's ESM runtime
// and fell back to `Math.ceil(text.length / 3.5)`, which over-counted
// base64 thinking signatures and under-counted JSON tool content, making
// the sidebar's "Tool Defs + Overhead" residual wrong on long sessions.
import Tokenizer from "ai-tokenizer";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";

const tokenizer = new Tokenizer(claudeEncoding);

export function estimateTokens(text: string): number {
    if (!text) return 0;
    return tokenizer.count(text);
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
    for (const match of text.matchAll(COMMIT_HASH_PATTERN)) {
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
    if (commitHashes.length === 0 || !COMMIT_HINT_PATTERN.test(text)) {
        return { text, commitHashes };
    }

    const withoutHashes = text
        .replace(COMMIT_HASH_PATTERN, "")
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
