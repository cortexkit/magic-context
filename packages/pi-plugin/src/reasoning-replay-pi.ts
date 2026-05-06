/**
 * Pi-side reasoning clearing & inline-thinking strip — mirrors
 * OpenCode's `clearOldReasoning`, `replayClearedReasoning`, and
 * `replayStrippedInlineThinking`.
 *
 * Why this matters for Pi:
 *   - Pi assistants carry `(PiTextContent | PiThinkingContent | PiToolCall)[]`
 *     in their `content` arrays.
 *   - Older assistant turns' thinking content stays visible to the
 *     model on every pass, wasting tokens AND mutating cached prefix
 *     content if it ever changes shape (e.g. thinking blocks getting
 *     stripped lazily by the provider). Both are exactly what
 *     OpenCode's reasoning-clearing replay was added to fix.
 *
 * Behavior:
 *   - On execute passes (cache-busting): walk Pi assistant messages
 *     whose tag number is older than `clear_reasoning_age` from the
 *     newest tag, replace each `PiThinkingContent.thinking` with
 *     `[cleared]`, persist watermark = max-tag-cleared in
 *     `session_meta.cleared_reasoning_through_tag`.
 *   - On EVERY pass (including defer): replay the cleared state from
 *     the watermark so the message array stays byte-stable — same
 *     contract as OpenCode's `replayClearedReasoning`.
 *   - Inline `<thinking>...</thinking>` markup in text content is also
 *     stripped on every pass via the same watermark.
 *
 * Providers with `capabilities.interleaved.field` (e.g. Moonshot/Kimi
 * `reasoning_content`) used to need a special bypass to keep typed
 * reasoning intact. OpenCode PR #24146 (preserve empty reasoning_content
 * for DeepSeek V4 thinking mode) made the provider transform always
 * emit the interleaved field — empty when no reasoning parts remain —
 * so the bypass is no longer needed.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";

type PiTextContent = { type: "text"; text: string };
type PiThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};
type PiToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};
type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCall;
type PiAssistantMessage = {
	role: "assistant";
	content: PiAssistantContent[];
	timestamp?: number;
};

const INLINE_THINKING_PATTERN = /<thinking>[\s\S]*?<\/thinking>\s*/gi;

const CLEARED = "[cleared]";

/**
 * Build a `messageIdToTagNumber` map from the tagger's `targets` map
 * (returned by `tagTranscript`). For each message that has any tagged
 * part, record the MAX tag number across its parts — same contract
 * OpenCode's `messageTagNumbers` uses (see tag-messages.ts:209).
 *
 * Only text and tool tags are present in `targets`; thinking parts
 * are not tagged. That's fine: we only need the message's primary
 * tag to gate reasoning replay, and the primary tag always comes
 * from a text or tool part.
 */
export function buildMessageIdToMaxTag(
	targets: Map<number, TagTarget>,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [tagNumber, target] of targets) {
		const id = target.message?.info?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const prev = out.get(id) ?? 0;
		if (tagNumber > prev) out.set(id, tagNumber);
	}
	return out;
}

/**
 * Clear typed reasoning on assistant messages whose tag number is
 * older than `(maxTag - clearReasoningAge)`. Returns the highest tag
 * number that was actually cleared, so the caller can persist the
 * watermark via `setReasoningWatermark`.
 *
 * Mirrors OpenCode's `clearOldReasoning` (strip-content.ts).
 */
export function clearOldReasoningPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	clearReasoningAge: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): { cleared: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, clearReasoningAge, piMessageStableId } =
		args;

	let maxTag = 0;
	for (const t of messageIdToMaxTag.values()) if (t > maxTag) maxTag = t;
	if (maxTag === 0) return { cleared: 0, newWatermark: 0 };

	const ageCutoff = maxTag - clearReasoningAge;
	if (ageCutoff <= 0) return { cleared: 0, newWatermark: 0 };

	let cleared = 0;
	let newWatermark = 0;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				if (tp.thinking !== CLEARED) {
					tp.thinking = CLEARED;
					cleared++;
				}
			}
		}

		if (cleared > 0 && msgTag > newWatermark) newWatermark = msgTag;
	}

	return { cleared, newWatermark };
}

/**
 * Replay typed-reasoning clearing on EVERY pass (execute or defer).
 * Mirrors OpenCode's `replayClearedReasoning` — required for cache
 * stability so the Pi assistant content array stays byte-identical
 * across passes.
 */
export function replayClearedReasoningPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let cleared = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				if (tp.thinking !== CLEARED) {
					tp.thinking = CLEARED;
					cleared++;
				}
			}
		}
	}
	return cleared;
}

/**
 * Replay inline `<thinking>...</thinking>` stripping on EVERY pass.
 * Mirrors OpenCode's `replayStrippedInlineThinking`. Some providers
 * (e.g. older Anthropic responses, Kimi non-interleaved) emit inline
 * thinking markup inside text content; once we strip it on an
 * execute pass via the same watermark, we must keep stripping on
 * every later pass to keep the prefix stable.
 */
export function replayStrippedInlineThinkingPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let stripped = 0;
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > watermark) continue;

		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = tp.text.replace(INLINE_THINKING_PATTERN, "");
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
				}
			}
		}
	}
	return stripped;
}

/**
 * Helper: replicate the stable id Pi's transcript-pi.ts builds for a
 * Pi message. We can't import the transcript adapter's private
 * `extractStableId` helper here, so we replicate its rule:
 *   `pi-msg-<index>-<timestamp>-<role>` (or `pi-msg-<index>-<role>`
 *   when no timestamp).
 *
 * If transcript-pi.ts ever changes its stable-id format, this helper
 * MUST be updated in lockstep.
 */
export function piMessageStableId(
	msg: unknown,
	index: number,
): string | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	const m = msg as { role?: string; timestamp?: number };
	const role = m.role ?? "unknown";
	if (typeof m.timestamp !== "number") return `pi-msg-${index}-${role}`;
	return `pi-msg-${index}-${m.timestamp}-${role}`;
}
