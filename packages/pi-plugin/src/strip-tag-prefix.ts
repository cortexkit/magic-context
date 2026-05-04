/**
 * Strip injected `§N§` tag prefixes from assistant text before Pi
 * persists the message.
 *
 * # Why this exists
 *
 * Magic Context tags every visible message part with a `§N§` prefix in
 * the transform pipeline so the agent can reference parts by tag id
 * (`ctx_reduce(§3§)`). LLMs frequently mimic that prefix in their own
 * generated text — emitting `§4§ Yes...` at the start of an assistant
 * response. This is harmless for cache (the agent emitting the prefix
 * doesn't bust prefix cache; it's the same content shape we already
 * inject) and the next transform pass strips/re-injects with the
 * correct tag id.
 *
 * BUT: Pi persists the raw assistant text from `message_end` events
 * directly into the session jsonl, and the Pi UI renders from that
 * stored text. So while OpenCode hides the prefix from its own UI via
 * `experimental.text.complete` (which mutates `output.text` before
 * persistence), Pi's UI shows the raw mimicked prefix to the user
 * because nothing scrubs it on the way to disk.
 *
 * This module mirrors OpenCode's `text-complete.ts` for Pi by hooking
 * `pi.on("message_end", ...)`. The event fires synchronously before
 * `agent-session.ts:appendMessage()` persists the message — the event
 * runner emits to extensions FIRST, then persists by reference, so
 * mutating `event.message.content[i].text` is visible to the
 * persistence call.
 *
 * # Regex
 *
 * `^(§\d+§\s*)+` — same shape as the OpenCode handler. Matches one or
 * more `§N§` blocks at the very start of a string, optionally followed
 * by whitespace, allowing for the rare case where the model emits
 * multiple consecutive prefixes (`§4§ §5§ ...`).
 *
 * Only the leading run is stripped; embedded `§N§` references inside
 * the response (e.g. agent referencing past tags) are intentionally
 * preserved because they may carry meaning.
 *
 * # Scope
 *
 * Only `assistant` messages need stripping. User messages are
 * user-typed text (no LLM mimicking). Tool result messages already
 * have prefixes added by the tagger and the same persistence model
 * applies, but we leave those untouched because the tag prefix on tool
 * results is intentional context — the user expects to see "§5§ ..."
 * in the displayed tool result so they can reference it later.
 *
 * Actually wait — tool results are the output of `tool_result`
 * messages from the user role in Pi's model. If the tagger added a
 * §N§ prefix to those, they'd persist with the prefix. But the
 * tagger only injects prefixes when `skipPrefixInjection: false`
 * (i.e. `ctx_reduce_enabled: true`). For users with reduction
 * disabled, no prefixes get injected anywhere, so this strip is
 * a no-op — but still safe and cheap.
 */

const TAG_PREFIX_REGEX = /^(\u00a7\d+\u00a7\s*)+/;

/**
 * Mutate the given assistant message's text parts in place to strip
 * any leading `§N§` tag prefixes.
 *
 * Returns true if any text was modified, false otherwise. The return
 * value is informational; the actual mutation happens on the passed
 * message reference.
 *
 * Exported for testing. Production callers should use `registerStripTagPrefix`.
 */
export function stripTagPrefixFromAssistantMessage(message: {
	role: string;
	content: unknown;
}): boolean {
	if (message.role !== "assistant") return false;
	if (!Array.isArray(message.content)) return false;

	let mutated = false;
	for (const part of message.content) {
		if (
			part === null ||
			typeof part !== "object" ||
			(part as { type?: unknown }).type !== "text"
		) {
			continue;
		}
		const textPart = part as { type: "text"; text: unknown };
		if (typeof textPart.text !== "string") continue;
		const stripped = textPart.text.replace(TAG_PREFIX_REGEX, "");
		if (stripped !== textPart.text) {
			textPart.text = stripped;
			mutated = true;
		}
	}
	return mutated;
}
