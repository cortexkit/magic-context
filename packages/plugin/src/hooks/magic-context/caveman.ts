/**
 * Deterministic rule-based text compression in the style of caveman-speak.
 *
 * Inspired by the caveman Claude Code skill (JuliusBrussee/caveman, 40k stars)
 * which validated telegraph-style compression as the right LLM-friendly
 * compression style — backed by research showing brevity constraints can
 * actually improve LLM accuracy (arxiv 2604.00025, March 2026).
 *
 * This module is pure and stateless. It takes text, applies progressively
 * aggressive rule-based transformations by level, and returns the compressed
 * output. It is used by the compressor to post-process historian output at
 * depths 2-4, enforcing style consistency without relying on LLM compliance.
 *
 * Preservation guarantees (all levels):
 *  - Code blocks (` and ``` fenced)
 *  - URLs (http://, https://)
 *  - File paths (contain / or start with ./ or ../)
 *  - Commit hashes (7-40 hex chars at word boundaries)
 *  - Compartment markers (§N§, U: lines, msg_*, ses_*, toolu_*)
 *  - Lines starting with "U: " (user quotes — irreplaceable phrasing)
 *
 * Compression by level:
 *  - lite   (depth 2): drops filler words and hedging
 *  - full   (depth 3): lite + drops articles and most auxiliaries, allows fragments
 *  - ultra  (depth 4): full + symbol connectives and common-term abbreviation
 */

export type CavemanLevel = "lite" | "full" | "ultra";

// ---------------------------------------------------------------------------
// Preservation: detect regions that must pass through untouched.
// ---------------------------------------------------------------------------

interface PreservedRegion {
    placeholder: string;
    original: string;
}

/** Matches things that must never be modified. Order matters: more specific
 *  patterns come first so they take precedence in the regex alternation. */
const PRESERVATION_PATTERNS: RegExp[] = [
    // Fenced code blocks (``` ... ```)
    /```[\s\S]*?```/g,
    // Inline code (` ... `)
    /`[^`\n]+`/g,
    // URLs
    /https?:\/\/\S+/g,
    // Magic Context tags and opencode IDs
    /§\d+§/g,
    /\b(?:msg|ses|toolu)_[A-Za-z0-9]+/g,
    // File paths — rough heuristic: starts with ./ or ../ or contains / and a common file extension
    /(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/g,
    // Commit hashes (7-40 hex) surrounded by word boundaries or backticks
    /(?<![a-z0-9])[0-9a-f]{7,40}(?![a-z0-9])/gi,
];

/** Replace preserved regions with sentinel placeholders so text transforms
 *  can run without damaging them. Returns the rewritten text and the list of
 *  placeholders to restore afterward. */
function protectRegions(text: string): { text: string; preserved: PreservedRegion[] } {
    const preserved: PreservedRegion[] = [];
    let working = text;

    for (const pattern of PRESERVATION_PATTERNS) {
        working = working.replace(pattern, (match) => {
            const placeholder = `\u0000MC_PRES_${preserved.length}\u0000`;
            preserved.push({ placeholder, original: match });
            return placeholder;
        });
    }

    return { text: working, preserved };
}

/** Restore placeholders to their original content. */
function restoreRegions(text: string, preserved: PreservedRegion[]): string {
    let working = text;
    // Restore in reverse order so nested placeholders resolve correctly.
    for (let i = preserved.length - 1; i >= 0; i--) {
        working = working.split(preserved[i].placeholder).join(preserved[i].original);
    }
    return working;
}

// ---------------------------------------------------------------------------
// Wordlists (all compared case-insensitively against word boundaries).
// ---------------------------------------------------------------------------

const FILLER_WORDS = [
    "just",
    "really",
    "basically",
    "actually",
    "essentially",
    "simply",
    "clearly",
    "obviously",
    "quite",
    "very",
    "somewhat",
    "rather",
    "fairly",
    "sort of",
    "kind of",
    "a bit",
];

const HEDGING_PHRASES = [
    "i think",
    "i believe",
    "i feel",
    "probably",
    "perhaps",
    "maybe",
    "it seems",
    "it appears",
    "arguably",
    "i suppose",
    "i guess",
];

const PLEASANTRIES = ["please", "thanks", "thank you", "kindly", "if possible"];

/** Auxiliary verbs we drop when they appear in non-essential positions.
 *  We only drop them between a subject noun and a participle/verb, where
 *  dropping changes tense but preserves meaning enough for a terse summary. */
const AUXILIARIES = [
    "was",
    "were",
    "is",
    "are",
    "am",
    "be",
    "been",
    "being",
    "has been",
    "had been",
    "have been",
    "will be",
    "would be",
    "could be",
    "should be",
    "might be",
    "may be",
];

/** Phrase replacements — always applied at lite+ to shorten common verbose forms. */
const PHRASE_SHORTENINGS: Array<[RegExp, string]> = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "now"],
    [/\bat the moment\b/gi, "now"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "for"],
    [/\bwith regard to\b/gi, "about"],
    [/\bin spite of the fact that\b/gi, "though"],
    [/\bon the grounds that\b/gi, "because"],
    [/\bfor the reason that\b/gi, "because"],
];

/** Symbol connectives for ultra level.
 *  Ordered longest-first so ", and then" gets replaced before ", then". */
const ULTRA_CONNECTIVE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(?:and then|then after|afterwards)\b/gi, "→"],
    [/\bbecause of\b/gi, "//"],
    [/\btherefore\b/gi, "→"],
    [/\bbecause\b/gi, "//"],
    [/\bhowever\b/gi, "but"],
    [/\bfurthermore\b/gi, "+"],
    [/\badditionally\b/gi, "+"],
    [/\bas well as\b/gi, "+"],
    // Word-boundary " and " / " or " in prose — not inside identifiers.
    // Leading + trailing space ensures we don't touch "stand" or "word".
    [/ and /gi, " + "],
    [/ or /gi, " | "],
];

/** Abbreviate common repeat terms at ultra level when a single region uses them
 *  3+ times. Applied per-region, not globally, so one-off uses stay readable. */
const ULTRA_ABBREVIATIONS: Record<string, string> = {
    historian: "hist",
    compartment: "cmpt",
    compartments: "cmpts",
    compressor: "cmp",
    compression: "cmp",
    context: "ctx",
    message: "msg",
    messages: "msgs",
    session: "ses",
    configuration: "cfg",
    config: "cfg",
    implementation: "impl",
    implemented: "impl",
    repository: "repo",
    database: "db",
    directory: "dir",
};

// ---------------------------------------------------------------------------
// Transformation helpers.
// ---------------------------------------------------------------------------

/** Build a regex matching any exact phrase from `phrases` as a whole-word match
 *  anywhere in text, case-insensitive, allowing optional leading space (not at
 *  start of line) so we can eat the space after removal and avoid double-spaces. */
function buildPhraseDropRegex(phrases: string[]): RegExp {
    const escaped = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Match: optional leading space + phrase + word boundary, case-insensitive
    return new RegExp(`(\\s+)?\\b(?:${escaped.join("|")})\\b`, "gi");
}

function dropPhrases(text: string, phrases: string[]): string {
    return text.replace(buildPhraseDropRegex(phrases), "");
}

/** Drop articles but keep them if they follow a preposition that needs them
 *  for grammatical sense in fragments. Applies a simple rule: drop all unless
 *  immediately after specific disambiguators. Heuristic, good enough for the
 *  already-compressed historian prose we operate on. */
function dropArticles(text: string): string {
    // Match " the ", " a ", " an " (with leading space) and replace with single space.
    // Also match at start of line: "The X" → "X".
    let working = text.replace(/\b(?:the|a|an)\b\s+/gi, "");
    // Collapse resulting multiple spaces.
    working = working.replace(/ +/g, " ");
    return working;
}

/** Drop auxiliary verbs in simple Subject-Aux-Verb patterns.
 *  Example: "historian was compressed" → "historian compressed"
 *  We only match " <AUX> <verb-like-token>" to avoid changing "was" as a
 *  standalone past-tense main verb in sentences like "X was complex".  */
function dropAuxiliaries(text: string): string {
    // Sort longest-first so "has been" matches before "has".
    const sorted = [...AUXILIARIES].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((a) => a.replace(/\s+/g, "\\s+"));
    const pattern = new RegExp(
        // Space + aux + space + (gerund or past participle or verb-like word)
        // Participle heuristic: word ending in -ed, -en, -ing, or a common irregular.
        `\\s+\\b(?:${escaped.join("|")})\\b\\s+(?=\\w+(?:ed|en|ing|ized|ised)\\b)`,
        "gi",
    );
    let working = text.replace(pattern, " ");
    working = working.replace(/ +/g, " ");
    return working;
}

function applyPhraseShortenings(text: string): string {
    let working = text;
    for (const [pattern, replacement] of PHRASE_SHORTENINGS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

function applyUltraConnectives(text: string): string {
    let working = text;
    for (const [pattern, replacement] of ULTRA_CONNECTIVE_REPLACEMENTS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

/** Count case-insensitive occurrences of `term` as a whole word in `text`. */
function countWordOccurrences(text: string, term: string): number {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, "gi"));
    return matches ? matches.length : 0;
}

function applyUltraAbbreviations(text: string): string {
    let working = text;
    for (const [term, abbreviation] of Object.entries(ULTRA_ABBREVIATIONS)) {
        if (countWordOccurrences(working, term) < 3) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        working = working.replace(new RegExp(`\\b${escaped}\\b`, "gi"), (match) => {
            // Preserve first-letter capitalization.
            return match[0] === match[0].toUpperCase()
                ? abbreviation[0].toUpperCase() + abbreviation.slice(1)
                : abbreviation;
        });
    }
    return working;
}

/** Preserve every line that starts with "U: " verbatim. Splits text into U:
 *  and non-U: chunks, applies the transform to non-U: chunks only. */
function transformPreservingUserLines(text: string, transform: (chunk: string) => string): string {
    const lines = text.split("\n");
    const output: string[] = [];
    let buffer: string[] = [];

    const flushBuffer = () => {
        if (buffer.length === 0) return;
        const joined = buffer.join("\n");
        output.push(transform(joined));
        buffer = [];
    };

    for (const line of lines) {
        if (line.startsWith("U: ")) {
            flushBuffer();
            output.push(line);
        } else {
            buffer.push(line);
        }
    }
    flushBuffer();

    return output.join("\n");
}

/** Normalize whitespace: collapse multiple spaces to single, trim line ends,
 *  remove excess blank lines (max one consecutive). */
function normalizeWhitespace(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Compress `text` using caveman-style rules at the given `level`.
 *
 *  Preserved regions (code, URLs, paths, hashes, tag markers, U: lines) are
 *  never modified. Only surrounding prose is transformed.
 *
 *  The function is pure: same input always produces the same output. */
export function cavemanCompress(text: string, level: CavemanLevel): string {
    if (text.length === 0) return text;

    // Protect regions that must never change.
    const { text: protectedText, preserved } = protectRegions(text);

    // Apply transforms to non-U:-line chunks only.
    const transformed = transformPreservingUserLines(protectedText, (chunk) => {
        let working = chunk;

        // Lite, Full, Ultra all apply these:
        working = dropPhrases(working, FILLER_WORDS);
        working = dropPhrases(working, HEDGING_PHRASES);
        working = dropPhrases(working, PLEASANTRIES);
        working = applyPhraseShortenings(working);

        if (level === "full" || level === "ultra") {
            working = dropAuxiliaries(working);
            working = dropArticles(working);
        }

        if (level === "ultra") {
            working = applyUltraConnectives(working);
            working = applyUltraAbbreviations(working);
        }

        return working;
    });

    // Restore preserved regions, then normalize whitespace.
    const restored = restoreRegions(transformed, preserved);
    return normalizeWhitespace(restored).trim();
}
