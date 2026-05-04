import type { ThinkingLikePart } from "./tag-messages";

const encoder = new TextEncoder();

// Well-formed tag prefix: one or more `§N§` tokens separated by whitespace.
const TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;

// Malformed tag prefix repair.
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
//
// Match loop: one or more leading malformed chunks, each followed by
// optional whitespace — then the well-formed prefix regex finishes the job.
//   §<digits>">§          → strip
//   §<digits>">§<digits>§ → strip
// The closing "§" on the repair variants is optional so the partial stub
// form (`§15298">§ hello`) also matches.
const MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/;

export function byteSize(value: string): number {
    return encoder.encode(value).length;
}

export function stripTagPrefix(value: string): string {
    // Strip malformed shapes first so a following well-formed tag (if any)
    // is exposed for the canonical regex to also strip. Both regexes are
    // anchored at the start, so order-dependent application is safe.
    let stripped = value.replace(MALFORMED_TAG_PREFIX_REGEX, "");
    stripped = stripped.replace(TAG_PREFIX_REGEX, "");
    return stripped;
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
