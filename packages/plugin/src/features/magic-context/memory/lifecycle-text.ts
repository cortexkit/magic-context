import { createHash } from "node:crypto";
import { CLAUSE_ABBREVIATIONS, CONCRETE_UNITS, NARROW_CHECK_WINDOW_MAX } from "./lifecycle-constants";

const SPACE = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
export const isLifecycleWhitespace = (char: string): boolean => SPACE.test(char);
export function normalizeLifecycleText(text: string): string {
    return text.replace(/[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ").replace(/^ | $/g, "");
}
export const lifecycleTextHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface Clause { ordinal: number; text: string; start: number; end: number }
export function splitMemoryClauses(text: string): Clause[] {
    const clauses: Clause[] = [];
    let start = 0;
    let tickWidth = 0;
    let listLine = /^\s*(?:[-*+] |\d+[.)] )/.test(text.split("\n")[0] ?? "");
    const emit = (end: number) => {
        if (end > start) clauses.push({ ordinal: clauses.length + 1, text: text.slice(start, end), start, end });
        start = end;
    };
    for (let i = 0; i < text.length; i++) {
        const char = text[i] ?? "";
        if (char === "`") {
            let end = i + 1;
            while (text[end] === "`") end++;
            const width = end - i;
            if (tickWidth === 0) tickWidth = width;
            else if (tickWidth === width) tickWidth = 0;
            i = end - 1;
            continue;
        }
        if (tickWidth !== 0) continue;
        if (char === "\n") {
            emit(i + 1);
            listLine = /^\s*(?:[-*+] |\d+[.)] )/.test(text.slice(i + 1).split("\n")[0] ?? "");
            continue;
        }
        if (listLine) continue;
        if (char === "—" && isLifecycleWhitespace(text[i - 1] ?? "") && isLifecycleWhitespace(text[i + 1] ?? "")) {
            let end = i + 1;
            while (end < text.length && text[end] !== "\n" && isLifecycleWhitespace(text[end] ?? "")) end++;
            emit(end);
            i = end - 1;
            continue;
        }
        if (!".!?".includes(char) || !isLifecycleWhitespace(text[i + 1] ?? "")) continue;
        if (char === ".") {
            const prefix = text.slice(start, i + 1);
            if (CLAUSE_ABBREVIATIONS.some((abbr) => prefix.endsWith(abbr))) continue;
            if (/(?:^|[^A-Za-z])[A-Za-z]\.$/.test(prefix)) continue;
            if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
        }
        let end = i + 1;
        while (end < text.length && isLifecycleWhitespace(text[end] ?? "")) end++;
        emit(end);
        i = end - 1;
    }
    emit(text.length);
    return clauses;
}

export interface EvidenceBlock { startOrdinal: number; endOrdinal: number; role: string; parts: string[]; joinedText: string }
export interface EvidenceSpan { blockStartOrdinal: number; partIndex: number; start: number; end: number; text: string; window: string }

// Ordinal prefixes and Pi message headers contain varying numbers, so match their whole formats.
export const EVIDENCE_MARKERS: readonly string[] = [
    " / ", "...[truncated]", "[… tokens truncated by Magic Context to fit the historian window …]", "…",
    "[dropped]", "[dropped §", "[truncated §", "<!-- +",
];
export const EVIDENCE_MARKER_PATTERNS: readonly RegExp[] = [/\[\d+(?:-\d+)?\]/, /Messages \d+-\d+:/];
export function hasEvidenceMarker(text: string): boolean {
    return EVIDENCE_MARKERS.some((marker) => text.includes(marker)) || EVIDENCE_MARKER_PATTERNS.some((marker) => marker.test(text));
}

function normalizedOffsets(text: string): { text: string; starts: number[]; ends: number[] } {
    let normalized = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < text.length;) {
        if (isLifecycleWhitespace(text[i] ?? "")) {
            const start = i;
            while (i < text.length && isLifecycleWhitespace(text[i] ?? "")) i++;
            if (normalized && i < text.length) {
                normalized += " "; starts.push(start); ends.push(i);
            }
        } else {
            normalized += text[i]; starts.push(i); ends.push(i + 1); i++;
        }
    }
    return { text: normalized, starts, ends };
}
function safeStart(text: string, start: number): number {
    const code = text.charCodeAt(start);
    return code >= 0xDC00 && code <= 0xDFFF ? start + 1 : start;
}
export function extractEvidenceWindow(part: string, start: number, end: number): string | null {
    if (end - start > NARROW_CHECK_WINDOW_MAX) return null;
    const clauses = splitMemoryClauses(part);
    const first = clauses.findIndex((clause) => clause.end > start);
    const last = clauses.findIndex((clause) => clause.end >= end);
    const a = clauses[first];
    const b = clauses[last];
    if (!a || !b) return null;
    let windowStart = a.start;
    let windowEnd = b.end;
    if (windowEnd - windowStart > NARROW_CHECK_WINDOW_MAX) {
        windowEnd = end;
        windowStart = safeStart(part, Math.max(0, end - NARROW_CHECK_WINDOW_MAX));
    } else {
        for (let n = 1; n <= 2; n++) {
            const previous = clauses[first - n];
            if (!previous || windowEnd - previous.start > NARROW_CHECK_WINDOW_MAX) break;
            windowStart = previous.start;
        }
    }
    return part.slice(windowStart, windowEnd);
}
export function matchFactEvidence(blocks: readonly EvidenceBlock[], ordinal: number, excerpt: string): EvidenceSpan | null {
    if (hasEvidenceMarker(excerpt)) return null;
    const needle = normalizeLifecycleText(excerpt);
    if (!needle) return null;
    const block = blocks.find((candidate) => candidate.startOrdinal === ordinal);
    if (!block) return null;
    for (const [partIndex, part] of block.parts.entries()) {
        const haystack = normalizedOffsets(part);
        const offset = haystack.text.indexOf(needle);
        if (offset < 0) continue;
        const start = haystack.starts[offset];
        const end = haystack.ends[offset + needle.length - 1];
        if (start === undefined || end === undefined) continue;
        const text = part.slice(start, end);
        if (hasEvidenceMarker(text)) return null;
        const window = extractEvidenceWindow(part, start, end);
        if (window === null) return null;
        return { blockStartOrdinal: ordinal, partIndex, start, end, text, window };
    }
    return null;
}

/** Scan whole paths, identifiers and dates before numbers, avoiding numeric prefix/suffix matches. */
export function scanConcreteTokens(input: string): string[] {
    const text = normalizeLifecycleText(input);
    const tokens: string[] = [];
    const units = [...CONCRETE_UNITS].sort((a, b) => b.length - a.length);
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        if (text[i] === "`") {
            const ticks = /^`+/.exec(rest)?.[0] ?? "`";
            const end = text.indexOf(ticks, i + ticks.length);
            if (end >= 0) { tokens.push(text.slice(i, end + ticks.length)); i = end + ticks.length; continue; }
        }
        if (isLifecycleWhitespace(text[i] ?? "")) { i++; continue; }
        const raw = /^[^\s`]+/.exec(rest)?.[0] ?? "";
        const word = raw.replace(/[.,;:!?)}\]]+$/, "");
        if (word.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(word) || /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/.test(word) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(word)) {
            tokens.push(word); i += raw.length; continue;
        }
        const date = /^(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2})(?![A-Za-z0-9_])/.exec(rest)?.[0];
        if (date) { tokens.push(date); i += date.length; continue; }
        const number = /^[><≥≤]?\d+(?:\.\d+)?/.exec(rest)?.[0];
        if (number && !/[A-Za-z0-9_]/.test(text[i + number.length] ?? "")) {
            let end = i + number.length;
            let unitStart = end;
            while (isLifecycleWhitespace(text[unitStart] ?? "")) unitStart++;
            const unit = units.find((candidate) => text.startsWith(candidate, unitStart) && !/[A-Za-z0-9_]/.test(text[unitStart + candidate.length] ?? ""));
            if (unit) end = unitStart + unit.length;
            tokens.push(text.slice(i, end)); i = end; continue;
        }
        // Skip whole non-token words to avoid numeric and identifier suffix collisions.
        i += raw.length || 1;
    }
    return tokens;
}
