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

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
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
