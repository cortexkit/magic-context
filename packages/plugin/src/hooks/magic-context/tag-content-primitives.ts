import type { ThinkingLikePart } from "./tag-messages";

const encoder = new TextEncoder();

// Well-formed tag prefix: one or more `§N§` tokens separated by whitespace.
const TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;

// Malformed tag prefix repair (leading only — see MALFORMED_TAG_GLOBAL_REGEX).
//
// Some models occasionally produce a garbled tag reference at the start of an
// assistant text part — the patterns observed in production are:
//
//   §15298">§15298§ hello...  ← same number twice, with `">` interjected
//   §15298">§ hello...        ← partial, no closing digits
//   §15298">§ §15298§ hello   ← partial stub followed by a normal tag
//
// The root cause is token-level confusion between our `§N§` tag format and
// the many quoted `"N"` / `"N">` substrings the model sees in rendered
// `<compartment start="N" end="M" start-date="..." end-date="..." title="...">`
// lines inside <session-history>. After temporal awareness added `start-date`
// and `end-date` attributes, quoted-number density near tag references
// roughly doubled — reports of this pattern are timestamped to immediately
// after that flag was turned on.
//
// This regex recognizes the malformed shapes so stripTagPrefix removes them
// BEFORE the next prependTag runs. Without this, the regex above
// (`/^(?:§\d+§\s*)+/`) fails to match the malformed prefix, leaves it in
// place, and prepends a NEW `§N§ ` in front — creating double-tagged text
// that persists through re-tagging on every future transform pass and
// reinforces the pattern in-context.
const MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/;

/** Well-formed `§N§` pairs anywhere (persistence cargo-cult cleanup). */
const COMPLETE_TAG_PAIR_GLOBAL_REGEX = /\u00a7\d+\u00a7/g;

/** Malformed tag/XML hybrid shapes anywhere (persistence cargo-cult cleanup). */
const MALFORMED_TAG_GLOBAL_REGEX = /\u00a7\d+">(?:\u00a7(?:\d+\u00a7)?)?/g;

/** Lone section signs after pair/malformed removal (persistence only). */
const STRAY_SECTION_CHAR_REGEX = /\u00a7/g;

export function stripWellFormedLeadingTagPrefix(value: string): string {
    return value.replace(/^(\u00a7\d+\u00a7\s*)+/, "");
}

export function stripCompleteTagPairsGlobally(value: string): string {
    return value.replace(COMPLETE_TAG_PAIR_GLOBAL_REGEX, "");
}

export function stripMalformedTagNotationGlobally(value: string): string {
    return value.replace(MALFORMED_TAG_GLOBAL_REGEX, "");
}

export function stripTagSectionCharacters(value: string): string {
    return value.replace(STRAY_SECTION_CHAR_REGEX, "");
}

/**
 * Strip MC tag notation from assistant text at the persistence boundary
 * (`experimental.text.complete`, Pi `message_end`). Removes whole `§N§` pairs
 * (never bare leading digits), then malformed hybrids and stray `§`.
 */
export function stripPersistedAssistantText(value: string): string {
    let text = stripWellFormedLeadingTagPrefix(value);
    text = stripCompleteTagPairsGlobally(text);
    text = stripMalformedTagNotationGlobally(text);
    text = stripTagSectionCharacters(text);
    return text.trim();
}

export function byteSize(value: string): number {
    return encoder.encode(value).length;
}

/**
 * Strip only §-shaped MC tag notation from the start of transform-visible text.
 * Does not remove bare leading digits — those may be legitimate user content
 * (`99 files`, `2024 roadmap`, numbered lists).
 */
export function stripTagPrefix(value: string): string {
    let stripped = value;
    for (let pass = 0; pass < 8; pass++) {
        const prev = stripped;
        stripped = stripped.replace(MALFORMED_TAG_PREFIX_REGEX, "");
        stripped = stripped.replace(TAG_PREFIX_REGEX, "");
        if (stripped === prev) break;
    }
    return stripped;
}

/**
 * Split leading MC tag notation from the body (temporal marker injection).
 * Uses the same §-only rules as {@link stripTagPrefix}.
 */
export function peelLeadingMcTagNotation(value: string): { tagPrefix: string; body: string } {
    const body = stripTagPrefix(value);
    if (body === value) return { tagPrefix: "", body };
    return { tagPrefix: value.slice(0, value.length - body.length), body };
}

export function prependTag(tagId: number, value: string): string {
    const stripped = stripTagPrefix(value);
    return `§${tagId}§ ${stripped}`;
}

export function isThinkingPart(part: unknown): part is ThinkingLikePart {
    if (part === null || typeof part !== "object") return false;
    const candidate = part as Record<string, unknown>;
    return candidate.type === "thinking" || candidate.type === "reasoning";
}
