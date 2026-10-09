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
 *     newest tag, EMPTY each `PiThinkingContent.thinking` (and drop its
 *     stale signature), persist watermark = max-tag-cleared in
 *     `session_meta.cleared_reasoning_through_tag`. Pi serializers drop
 *     empty thinking before the wire, so nothing (and no stale signature)
 *     reaches any provider.
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
import {
	hasAnthropicReasoning,
	isInActiveAnthropicTurn,
} from "@magic-context/core/hooks/magic-context/active-anthropic-turn";
import { latestAssistantTurnMessages } from "@magic-context/core/hooks/magic-context/latest-assistant-turn";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	reasoningBudgetCutoff,
	reasoningStepCost,
} from "@magic-context/core/hooks/magic-context/reasoning-budget";
import type {
	MessageLike,
	TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { isRecord } from "@magic-context/core/shared/record-type-guard";

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
	usage?: { reasoning?: number };
	providerPayload?: { items?: unknown[] };
	timestamp?: number;
};

const INLINE_THINKING_PATTERNS = [
	/<thinking>[\s\S]*?<\/thinking>\s*/gi,
	/<think>[\s\S]*?<\/think>\s*/gi,
] as const;

// Pi clears old reasoning to an EMPTY thinking block (not "[cleared]"). Every Pi
// serializer drops empty thinking before the wire — anthropic.ts (empty thinking
// skipped), openai-completions.ts (filtered out of nonEmptyThinkingBlocks, with
// reasoning_content="" auto-filled for providers that require it), and
// amazon-bedrock.ts (empty thinking skipped). So an emptied block reaches NO
// provider, which structurally eliminates the stale-signature hazard that
// "[cleared]" + the original signature created on canonical Claude/Bedrock (a
// content/signature mismatch). The signature is dropped too since the block is
// discarded everywhere. This is intentionally DIFFERENT from OpenCode, whose
// non-Anthropic adapters forward empty parts, so OpenCode must keep "[cleared]"
// for canonical-anthropic-only and gate the write off elsewhere (see PARITY.md).
const CLEARED = "";

function stripInlineThinkingMarkup(text: string): string {
	let cleaned = text;
	for (const pattern of INLINE_THINKING_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}
	return cleaned;
}

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

/** Diagnostic adapter only; evaluated on /ctx-status, never to select on defer. */
export function piReasoningStatusMessages(messages: unknown[]): MessageLike[] {
	return messages.filter(isRecord).map((message) => {
		const usage = isRecord(message.usage) ? message.usage : {};
		const parts = Array.isArray(message.content)
			? message.content.filter(isRecord).map((part) =>
					part.type === "thinking"
						? {
								...part,
								type: part.redacted === true ? "redacted_thinking" : "thinking",
							}
						: part,
				)
			: [];
		const payload = isRecord(message.providerPayload)
			? message.providerPayload
			: undefined;
		if (
			payload &&
			Array.isArray(payload.items) &&
			payload.items.some((item) => isRecord(item) && item.type === "reasoning")
		)
			parts.push({ type: "reasoning", text: "", metadata: {} });
		return {
			info: { role: message.role, tokens: { reasoning: usage.reasoning } },
			parts,
		} as unknown as MessageLike;
	});
}

/**
 * Highest tag the typed-reasoning clear (and the inline strip that shares its
 * watermark) may cover on this execute pass. Replay re-clears every assistant
 * whose tag is at or below the persisted watermark, so the cutoff stays below
 * the newest assistant's tag and that message's reasoning is never touched on
 * any later pass.
 *
 * Prefix-bound models (signed thinking bound to the request prefix: Fable 5.1,
 * Opus 5.5, Sonnet 5.5) get a cutoff that clears only a contiguous oldest
 * prefix; see `piPrefixBoundReasoningCutoff`.
 */
export function piReasoningClearCutoff(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	keepReasoningTokens: number;
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
	prefixBound: boolean;
	proseRatio?: number;
	anthropic?: boolean;
	/** Entries whose thinking another strip already removed for good. */
	alreadyGone?: (id: string) => boolean;
}): number {
	if (args.prefixBound) return piPrefixBoundReasoningCutoff(args);
	return piBudgetCutoff(args);
}

export function piBudgetCutoff(args: {
	messages: unknown[];
	messageIdToMaxTag: ReadonlyMap<string, number>;
	keepReasoningTokens: number;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
	alreadyGone?: (id: string) => boolean;
	proseRatio?: number;
	prefixBound?: boolean;
	anthropic?: boolean;
}): number {
	const assistants = args.messages
		.map((message, index) => ({ message, index }))
		.filter((entry): entry is { message: PiAssistantMessage; index: number } =>
			isAssistantWithContent(entry.message),
		);
	const newest = assistants.at(-1);
	const exempt = [...assistants]
		.reverse()
		.find((entry) =>
			entry.message.content.some(
				(part) => part.type !== "text" || part.text.trim() !== "",
			),
		);
	return reasoningBudgetCutoff(
		assistants.map((entry) => {
			const id = args.piMessageStableId(entry.message, entry.index);
			return {
				tag: id ? (args.messageIdToMaxTag.get(id) ?? 0) : 0,
				exempt:
					entry === newest ||
					entry === exempt ||
					isInActiveAnthropicTurn(
						args.messages,
						entry.index,
						args.anthropic === true ||
							args.prefixBound === true ||
							hasAnthropicReasoning(args.messages),
					),
				alreadyRemoved:
					id !== undefined &&
					args.alreadyGone?.(id) === true &&
					!hasInlineThinkingMarkup(entry.message),
				cost: () => {
					let text = "";
					let inlineText = "";
					let opaque = false;
					const typedGone = id !== undefined && args.alreadyGone?.(id) === true;
					const hasTypedReasoning =
						!typedGone && thinkingParts(entry.message).length > 0;
					for (const part of typedGone
						? []
						: thinkingParts(entry.message).filter(isLiveThinking)) {
						if (part.redacted) opaque = true;
						else text += part.thinking;
						opaque ||= !!part.thinkingSignature && !part.thinking;
					}
					for (const part of entry.message.content) {
						if (part.type !== "text") continue;
						for (const match of part.text.matchAll(
							/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/gi,
						))
							inlineText += match[1];
					}
					opaque ||=
						!typedGone &&
						entry.message.providerPayload?.items?.some(
							(item) => isRecord(item) && item.type === "reasoning",
						) === true;
					if (!hasTypedReasoning && !text && !opaque && !inlineText) return 0;
					const reported = entry.message.usage?.reasoning;
					const typed =
						hasTypedReasoning || text || opaque
							? reported !== undefined && reported > 0
								? reported
								: reasoningStepCost(
										reported,
										estimateTokens(text) * (args.proseRatio ?? 1),
										opaque,
									)
							: 0;
					return (
						typed +
						Math.ceil(estimateTokens(inlineText) * (args.proseRatio ?? 1))
					);
				},
			};
		}),
		args.keepReasoningTokens,
	);
}

function isAssistantWithContent(raw: unknown): raw is PiAssistantMessage {
	return (
		!!raw &&
		typeof raw === "object" &&
		(raw as { role?: unknown }).role === "assistant" &&
		Array.isArray((raw as { content?: unknown }).content)
	);
}

function thinkingParts(msg: PiAssistantMessage): PiThinkingContent[] {
	return msg.content.filter(
		(part): part is PiThinkingContent =>
			!!part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "thinking",
	);
}

/** A thinking part the age clear has not emptied yet (it still reaches the wire). */
function isLiveThinking(part: PiThinkingContent): boolean {
	return (
		part.redacted === true ||
		part.thinking !== CLEARED ||
		part.thinkingSignature !== undefined
	);
}

function hasInlineThinkingMarkup(msg: PiAssistantMessage): boolean {
	return msg.content.some(
		(part) =>
			!!part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as PiTextContent).text === "string" &&
			stripInlineThinkingMarkup((part as PiTextContent).text) !==
				(part as PiTextContent).text,
	);
}

/**
 * Age cutoff for a prefix-bound model, chosen so that the clear (and every
 * later replay of its watermark) removes thinking from a contiguous oldest
 * prefix of the assistants and from nothing after it.
 *
 * Anthropic's preserved-thinking page ("What counts as an edit") lists
 * "Remove `thinking` blocks from the start of the history, from the end, or
 * all of them" as valid, and "Remove a `thinking` block from the middle of the
 * history and keep later ones" as invalid for every later thinking block.
 *
 * The walk goes oldest first. It passes over assistants whose thinking is
 * already gone (emptied by an earlier clear, or in `alreadyGone`) and stops at
 * the first assistant the clear may not fully handle: the newest assistant, an
 * untagged or too-young one, one whose id cannot be resolved, one with a
 * redacted block (the clear leaves those in place), or one whose text holds
 * inline `<thinking>` markup (the shared watermark would make the inline strip
 * rewrite that text, an edit of an earlier assistant message). The cutoff then
 * sits below every tag at or after the stop, and the stop moves back until
 * every assistant before it lies at or below the cutoff.
 */
export function piPrefixBoundReasoningCutoff(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	keepReasoningTokens: number;
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
	alreadyGone?: (id: string) => boolean;
	proseRatio?: number;
}): number {
	const ageCutoff = piBudgetCutoff({ ...args, prefixBound: true });
	if (ageCutoff <= 0) return 0;
	const protectedMessages = args.protectLatestTurn
		? latestAssistantTurnMessages(args.messages)
		: new Set<unknown>();

	let newestIndex = -1;
	for (let i = args.messages.length - 1; i >= 0; i--) {
		if (isAssistantWithContent(args.messages[i])) {
			newestIndex = i;
			break;
		}
	}

	// Assistants that still put thinking (or inline markup) on the wire, oldest
	// first, with whether the clear may remove it.
	const walk: { index: number; tag: number; removable: boolean }[] = [];
	const tagAt = (i: number): number => {
		const id = args.piMessageStableId(args.messages[i], i);
		return id ? (args.messageIdToMaxTag.get(id) ?? 0) : 0;
	};
	for (let i = 0; i < args.messages.length; i++) {
		const raw = args.messages[i];
		if (!isAssistantWithContent(raw)) continue;
		const inline = hasInlineThinkingMarkup(raw);
		const live = thinkingParts(raw).filter(isLiveThinking);
		if (live.length === 0 && !inline) continue;
		const id = args.piMessageStableId(raw, i);
		if (id && !inline && args.alreadyGone?.(id)) continue;
		const tag = tagAt(i);
		const removable =
			!protectedMessages.has(raw) &&
			i !== newestIndex &&
			id !== undefined &&
			tag > 0 &&
			tag <= ageCutoff &&
			!inline &&
			!live.some((part) => part.redacted === true);
		walk.push({ index: i, tag, removable });
	}

	let stop = walk.findIndex((entry) => !entry.removable);
	if (stop < 0) stop = walk.length;
	for (;;) {
		// Nothing at or after the stop may fall under the cutoff, including
		// assistants with no thinking: the watermark is replayed on every pass.
		const firstKept =
			stop < walk.length ? walk[stop].index : args.messages.length;
		let cutoff = ageCutoff;
		for (let i = firstKept; i < args.messages.length; i++) {
			if (!isAssistantWithContent(args.messages[i])) continue;
			const tag = tagAt(i);
			if (tag > 0) cutoff = Math.min(cutoff, tag - 1);
		}
		if (newestIndex >= 0) {
			const newestTag = tagAt(newestIndex);
			if (newestTag > 0) cutoff = Math.min(cutoff, newestTag - 1);
		}
		const late = walk.slice(0, stop).findIndex((entry) => entry.tag > cutoff);
		if (late < 0) return Math.max(0, cutoff);
		stop = late;
	}
}

/**
 * Clear local typed reasoning on assistant messages whose tag number is older
 * than `(maxTag - clearReasoningAge)`. Returns the highest tag number that was
 * actually cleared, so the caller can persist the local watermark via
 * `setReasoningWatermark`.
 *
 * Mirrors OpenCode's `clearOldReasoning` (strip-content.ts).
 */
export function clearOldReasoningPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
	/** Frozen cutoff selected by piReasoningClearCutoff on this execute pass. */
	maxCutoff: number;
}): { cleared: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, piMessageStableId } = args;

	const ageCutoff = args.maxCutoff;
	if (!Number.isFinite(ageCutoff) || ageCutoff <= 0)
		return { cleared: 0, newWatermark: 0 };

	let cleared = 0;
	let newWatermark = 0;

	const protectedMessages = args.protectLatestTurn
		? latestAssistantTurnMessages(messages)
		: new Set<unknown>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (protectedMessages.has(raw)) continue;
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		let clearedThisMessage = false;
		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "thinking"
			) {
				const tp = part as PiThinkingContent;
				// Leave REDACTED thinking blocks untouched. Unlike normal thinking,
				// redacted blocks bypass the empty-drop in Pi's serializers
				// (transform-messages.ts and anthropic.ts serialize `redacted`
				// before the empty-thinking check), so emptying one + dropping its
				// signature would leave a malformed redacted block (no data, no sig)
				// on the wire. A redacted block carries no plaintext to save anyway;
				// keeping it verbatim is both safe and byte-stable across passes.
				if (tp.redacted) continue;
				// Empty the thinking AND drop its now-stale signature (a signature
				// over the original text would mismatch the emptied content). The
				// empty block is dropped by every Pi serializer, so neither reaches
				// the wire; dropping the sig keeps clear/replay producing identical
				// working-array state.
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
					cleared++;
					clearedThisMessage = true;
				}
			}
		}
		if (clearedThisMessage && msgTag > newWatermark) {
			newWatermark = msgTag;
		}
	}

	return { cleared, newWatermark };
}

/**
 * Strip inline `<thinking>...</thinking>` and `<think>...</think>` markup
 * from assistant text content on execute passes. Returns the highest
 * message tag actually stripped so callers can persist it through
 * `setReasoningWatermark` and replay the same stripping on defer passes.
 */
export function stripInlineThinkingPi(args: {
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
	/** Frozen cutoff selected by piReasoningClearCutoff on this execute pass. */
	maxCutoff: number;
}): { stripped: number; newWatermark: number } {
	const { messages, messageIdToMaxTag, piMessageStableId } = args;

	const ageCutoff = args.maxCutoff;
	if (!Number.isFinite(ageCutoff) || ageCutoff <= 0)
		return { stripped: 0, newWatermark: 0 };

	let stripped = 0;
	let newWatermark = 0;

	const protectedMessages = args.protectLatestTurn
		? latestAssistantTurnMessages(messages)
		: new Set<unknown>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (protectedMessages.has(raw)) continue;
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const id = piMessageStableId(raw, i);
		if (!id) continue;
		const msgTag = messageIdToMaxTag.get(id) ?? 0;
		if (msgTag === 0 || msgTag > ageCutoff) continue;

		let strippedThisMessage = false;
		for (const part of msg.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text"
			) {
				const tp = part as PiTextContent;
				if (typeof tp.text !== "string") continue;
				const cleaned = stripInlineThinkingMarkup(tp.text);
				if (cleaned !== tp.text) {
					tp.text = cleaned;
					stripped++;
					strippedThisMessage = true;
				}
			}
		}

		if (strippedThisMessage && msgTag > newWatermark) newWatermark = msgTag;
	}

	return { stripped, newWatermark };
}

/**
 * Replay local typed-reasoning clearing on EVERY pass (execute or defer).
 * Mirrors OpenCode's `replayClearedReasoning` — required for cache stability
 * so the Pi assistant content array stays byte-identical across passes.
 */
export function replayClearedReasoningPi(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	messageIdToMaxTag: Map<string, number>;
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let cleared = 0;
	const protectedMessages = args.protectLatestTurn
		? latestAssistantTurnMessages(messages)
		: new Set<unknown>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (protectedMessages.has(raw)) continue;
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
				// Mirror clearOldReasoningPi exactly: redacted blocks are left
				// untouched (they bypass the serializers' empty-drop, so emptying
				// one would put a malformed redacted block on the wire).
				if (tp.redacted) continue;
				// Replay the exact clear shape from clearOldReasoningPi: empty
				// thinking + dropped signature, so defer passes are byte-identical
				// to the cache-busting pass that set the watermark.
				if (tp.thinking !== CLEARED || tp.thinkingSignature !== undefined) {
					tp.thinking = CLEARED;
					tp.thinkingSignature = undefined;
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
	protectLatestTurn?: boolean;
	piMessageStableId: (msg: unknown, index: number) => string | undefined;
}): number {
	const { db, sessionId, messages, messageIdToMaxTag, piMessageStableId } =
		args;

	const meta = getOrCreateSessionMeta(db, sessionId);
	const watermark = meta.clearedReasoningThroughTag ?? 0;
	if (watermark <= 0) return 0;

	let stripped = 0;
	const protectedMessages = args.protectLatestTurn
		? latestAssistantTurnMessages(messages)
		: new Set<unknown>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (protectedMessages.has(raw)) continue;
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
				const cleaned = stripInlineThinkingMarkup(tp.text);
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
 * @internal TEST-ONLY legacy index-id helper. NOT for production use.
 *
 * Production code resolves stable ids exclusively through
 * `resolvePiStableId` (read-session-pi.ts), which prefers the real
 * SessionEntry id and only falls back to this `pi-msg-<index>-...` format.
 * This standalone export produces ONLY the index-based fallback, which DRIFTS
 * when the visible array shifts — using it in production would reintroduce the
 * orphaned-state / cache-bust bug the unification fixed. It is retained solely
 * so the reasoning-replay unit tests can exercise the index-id shape directly.
 * Do not import it into production modules; reach for `resolvePiStableId`.
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
