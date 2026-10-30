// Models sometimes imitate dropped placeholders with a blank or bare numeric tag.
// Match only complete marker-only text, never prose that mentions a placeholder.
const MARKER_ONLY_PATTERN = /^(?:(?:§\d+§|\[dropped\s*(?:\d+|§\d*§)?\]|\[cleared\])\s*)+$/;

export function isMarkerOnlyText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length > 0 && MARKER_ONLY_PATTERN.test(trimmed);
}
