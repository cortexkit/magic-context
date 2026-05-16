/**
 * Two-step strip at the `experimental.text.complete` persistence boundary:
 *
 * 1. **Canonical leading prefix** — `^(§N§\s*)+` removes well-formed leading
 *    `§N§ ` runs (digit-aware, removes the whole pair including digits and
 *    trailing whitespace). This handles the legitimate case where the model
 *    correctly mimics MC's tag prefix at the start of its response; persisted
 *    assistant text stays clean, and the transform layer re-injects the
 *    canonical `§N§ ` prefix on the next pass from authoritative DB tag state.
 *    Cache-stable across turns.
 *
 * 2. **Defensive global `§` strip** — `\u00a7/g` removes any remaining `§`
 *    character anywhere in the text. Defends against the cargo-cult patterns
 *    observed in dashboard screenshots and live wire dumps:
 *      - `§40827§` mid-text (well-formed cargo-cult pair)
 *      - `§40827"&gt;` (malformed partial — hybrid of MC tag and XML)
 *      - stray `§` characters anywhere
 *    The defense is intentionally aggressive: only the MC transform layer is
 *    authorized to write `§N§` prefixes, and it injects them AFTER this hook
 *    runs. Any `§` reaching this hook from the model is by definition wrong.
 *
 * Why the two-step ordering matters: stripping the leading prefix FIRST means
 * `§42§ Hello` becomes `Hello` (clean), not `42 Hello` (digit residue). The
 * global `§` strip then catches any cargo-cult emission that survived the
 * leading match.
 *
 * Cost: legitimate `§` usage in section references (`§5.1`) becomes plain
 * digits (`5.1`). Models adapt naturally to alternative notation (`Section
 * 5.1`, `[5.1]`, `#5.1`). This is an acceptable cosmetic loss.
 *
 * Notes on what this does NOT affect:
 * - User message text — this hook only fires for assistant completions.
 * - `[dropped §N§]` / `[truncated §N§]` sentinels — these are injected by the
 *   transform layer AFTER persistence; they appear in the wire-visible message
 *   tree, not in persisted assistant text.
 * - The tagger's `§N§ ` prefix injection on user/tool text — injected during
 *   transform, not persisted; this hook never sees it.
 */
const LEADING_TAG_PREFIX_REGEX = /^(\u00a7\d+\u00a7\s*)+/;
const SECTION_CHAR_REGEX = /\u00a7/g;

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ): Promise<void> => {
        output.text = output.text
            .replace(LEADING_TAG_PREFIX_REGEX, "")
            .replace(SECTION_CHAR_REGEX, "");
    };
}
