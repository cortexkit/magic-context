import { stripPersistedAssistantText } from "./tag-content-primitives";

/**
 * Persistence-boundary strip for assistant completions (`experimental.text.complete`).
 *
 * 1. **Leading well-formed runs** — `^(§N§\s*)+` removes canonical mimicked prefixes
 *    at the start so persisted text stays clean; the transform layer re-injects the
 *    authoritative `§N§ ` from DB tag state on the next pass.
 *
 * 2. **Global complete pairs** — `/§\d+§/g` removes whole cargo-cult `§N§` tokens
 *    mid-text without leaving digit residue (unlike stripping `§` alone).
 *
 * 3. **Global malformed hybrids** — `§N">§…` shapes from compartment/XML confusion.
 *
 * 4. **Stray `§`** — any remaining section signs after pair removal.
 *
 * Transform-layer `stripTagPrefix` intentionally does NOT strip bare leading digits;
 * only this persistence path performs global MC-notation cleanup.
 *
 * Cost: legitimate lone `§` (e.g. `§5.1` section refs) becomes `5.1` after step 4.
 * Models adapt to alternatives (`Section 5.1`, `[5.1]`).
 *
 * Does not affect user message text (hook is assistant-only) or transform-injected
 * sentinels like `[dropped §N§]`.
 */

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },

        output: { text: string },
    ): Promise<void> => {
        output.text = stripPersistedAssistantText(output.text);
    };
}
