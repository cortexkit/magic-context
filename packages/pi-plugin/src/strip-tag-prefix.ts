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

import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";

/**
 * Mutate the given assistant message's text parts in place to strip MC tag notation.
 *
 * Returns true if any text was modified. Production callers use `registerStripTagPrefix`.
 */

export function stripTagPrefixFromAssistantMessage(message: {
	role: string;
	provider?: string;

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

		const stripped = stripPersistedAssistantText(
			textPart.text,
			message.provider === "anthropic",
		);

		if (stripped !== textPart.text) {
			textPart.text = stripped;

			mutated = true;
		}
	}

	return mutated;
}

/**
 * Content for an Oh My Pi `assistant_message` result: a copy of `content` with
 * each text part stripped by the same rule as
 * {@link stripTagPrefixFromAssistantMessage}, or undefined when nothing changes.
 * Parts stay in their positions and keep every other field, because Oh My Pi
 * rejects a replacement that changes anything except text.
 *
 * A text part with no `§` in it is left exactly as the model wrote it. The
 * shared cleanup also trims surrounding whitespace, and Oh My Pi treats any
 * byte change as a rewrite: it drops the part's `textSignature` (the binding
 * of the text to its native OpenAI Responses item and phase) and, from 18.19.0,
 * copies the trimmed text into the stored native item. A whitespace-only trim
 * removes no tag notation, so it is not worth losing that binding.
 */
export function strippedAssistantContent(
	content: unknown,
	provider = "anthropic",
): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	let copy: unknown[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index] as { type?: unknown; text?: unknown } | null;
		if (part === null || typeof part !== "object" || part.type !== "text") {
			continue;
		}
		if (typeof part.text !== "string" || !part.text.includes("§")) continue;
		const stripped = stripPersistedAssistantText(
			part.text,
			provider === "anthropic",
		);
		if (stripped === part.text) continue;
		copy ??= content.slice();
		copy[index] = { ...part, text: stripped };
	}
	return copy;
}

/** The one Oh My Pi extension call this module needs; stock Pi's types lack the event. */
type AssistantMessageHookApi = {
	on(
		event: "assistant_message",
		handler: (event: unknown) => { content: unknown[] } | undefined,
	): unknown;
};

/**
 * Strip the tag prefix from the reply Oh My Pi saves.
 *
 * Oh My Pi hands `message_end` handlers a detached copy of the message
 * (`cloneMessageNotification`), so the in-place `message_end` strip changes
 * nothing there. Its supported hook for editing a finished assistant message
 * is `assistant_message`: it runs before the message reaches agent context,
 * `message_end` listeners and session persistence, and takes replacement
 * `content` whose text parts may differ only in `text`. Stock Pi has no such
 * event and keeps using the `message_end` strip.
 */
export function registerOmpAssistantMessageStrip(
	pi: unknown,
	isActive: () => boolean,
): void {
	const api = pi as AssistantMessageHookApi;
	api.on("assistant_message", (event) => {
		try {
			if (!isActive()) return undefined;
			const message = (event as { message?: unknown } | null)?.message as
				| { role?: unknown; content?: unknown; provider?: string }
				| undefined;
			if (message?.role !== "assistant") return undefined;
			const content = strippedAssistantContent(
				message.content,
				message.provider ?? "unknown",
			);
			return content === undefined ? undefined : { content };
		} catch {
			return undefined;
		}
	});
}
