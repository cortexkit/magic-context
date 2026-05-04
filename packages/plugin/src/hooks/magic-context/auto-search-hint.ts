/**
 * Build a compact "you may recall something related" hint from unified search
 * results, ready to append to a user message.
 *
 * The hint intentionally compresses fragments so they feel like vague recall
 * rather than a drop-in answer — the goal is to nudge the agent to run
 * ctx_search for full context, not to provide the answer itself.
 *
 * Compression strategy per source:
 *   - memory → caveman-ultra via `cavemanCompress()` (token-dense)
 *   - git_commit → raw commit subject (already terse); prefixed with SHA + age
 *   - message → caveman-ultra, role tag
 *
 * Guardrails:
 *   - Per-fragment token cap (~20 tokens, ~80 chars) with ellipsis truncation
 *   - Skip fragments whose source is already present in visible session-history
 *     (caller handles) — this module only knows about search results
 *   - Hard-caps total output at ~200 tokens so misconfigured thresholds can't
 *     balloon the user message
 */

import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { cavemanCompress } from "./caveman";

const MAX_FRAGMENTS = 3;
const FRAGMENT_CHAR_CAP = 80; // ~20 tokens at 3.5 chars/token
const MAX_HINT_CHARS = 800; // ~200 tokens hard ceiling
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AutoSearchHintOptions {
    maxFragments?: number;
    fragmentCharCap?: number;
}

function truncate(text: string, limit: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatAge(committedAtMs: number): string {
    const delta = Date.now() - committedAtMs;
    if (delta < 0) return "future";
    const days = Math.floor(delta / MS_PER_DAY);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}

function renderFragment(result: UnifiedSearchResult, charCap: number): string {
    switch (result.source) {
        case "memory": {
            const compressed = cavemanCompress(result.content, "ultra");
            return truncate(compressed, charCap);
        }
        case "git_commit": {
            // Use only the subject line (first line) — bodies add noise without
            // changing the recall trigger. Preserve the short SHA + relative age
            // so the agent can decide if the age is even relevant.
            const subject = result.content.split(/\r?\n/)[0] ?? result.content;
            const body = truncate(subject, Math.max(10, charCap - 20));
            return `commit ${result.shortSha} ${formatAge(result.committedAtMs)}: ${body}`;
        }
        case "message": {
            const compressed = cavemanCompress(result.content, "ultra");
            return truncate(compressed, charCap);
        }
    }
}

/**
 * Build the hint text. Returns null when `results` is empty, when no fragment
 * has meaningful content after compression, or when limits zero out the budget.
 *
 * This function does NOT enforce score thresholds or message-length rules —
 * callers (the transform-time auto-search wiring) apply those gates first.
 */
export function buildAutoSearchHint(
    results: UnifiedSearchResult[],
    options: AutoSearchHintOptions = {},
): string | null {
    const maxFragments = Math.max(1, options.maxFragments ?? MAX_FRAGMENTS);
    const fragmentCharCap = Math.max(20, options.fragmentCharCap ?? FRAGMENT_CHAR_CAP);

    const picks = results.slice(0, maxFragments);
    const lines: string[] = [];

    for (const result of picks) {
        const fragment = renderFragment(result, fragmentCharCap);
        if (fragment.length === 0) continue;
        lines.push(`- ${fragment}`);
    }

    if (lines.length === 0) return null;

    const header =
        lines.length === 1
            ? "Your memory may contain 1 related fragment:"
            : `Your memory may contain ${lines.length} related fragments:`;
    const footer =
        "If the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.";
    const body = [header, ...lines, footer].join("\n");
    const wrapped = `<ctx-search-hint>\n${body}\n</ctx-search-hint>`;

    if (wrapped.length > MAX_HINT_CHARS) {
        // Truncate from the tail of the body, preserving wrapper + footer cue.
        const overflow = wrapped.length - MAX_HINT_CHARS;
        const trimmedBody = body.slice(0, Math.max(0, body.length - overflow - 1)).trimEnd();
        return `<ctx-search-hint>\n${trimmedBody}…\n</ctx-search-hint>`;
    }

    return wrapped;
}
