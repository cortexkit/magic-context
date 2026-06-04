/**
 * Strip injected `§N§` tag prefixes AND defensively strip cargo-cult MC tag
 * notation from assistant text before Pi persists the message.
 *
 * Mirrors OpenCode's `text-complete.ts` via {@link stripPersistedAssistantText}:
 * whole `§N§` pairs globally, malformed hybrids, then stray `§`. Does not strip
 * bare leading digits on the transform path.
 *
 * Pi persists raw assistant text from `message_end`; this hook mutates text parts
 * before `agent-session.ts:appendMessage()` writes jsonl.
 *
 * Only `assistant` messages are stripped. User/tool messages keep intentional tags.
 */

import { stripPersistedAssistantText } from "../../plugin/src/hooks/magic-context/tag-content-primitives";

/**
 * Mutate the given assistant message's text parts in place to strip MC tag notation.
 *
 * Returns true if any text was modified. Production callers use `registerStripTagPrefix`.
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

		const stripped = stripPersistedAssistantText(textPart.text);

		if (stripped !== textPart.text) {
			textPart.text = stripped;

			mutated = true;
		}
	}

	return mutated;
}
