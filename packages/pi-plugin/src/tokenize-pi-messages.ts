/**
 * Pi-side counterpart of OpenCode's per-message conversation/tool-call
 * token accounting in `transform.ts:996-1124`.
 *
 * Walks the post-compaction Pi `event.messages` array (same view the LLM
 * receives on the wire) and partitions tokens into two buckets:
 *
 *   - `conversation` — text/thinking/image content the user/agent
 *     authored or read.
 *   - `toolCall` — tool invocation arguments and tool results — the
 *     mechanical tool I/O that compaction can compress.
 *
 * The result is persisted to `session_meta.{conversation_tokens,tool_call_tokens}`
 * so `/ctx-status` and the dashboard can render an accurate breakdown
 * bar that sums to the wire `inputTokens` (give or take provider
 * tokenizer drift).
 *
 * IMPORTANT: this walks the AFTER-tagging, AFTER-injection, AFTER-strip
 * Pi message array — i.e. exactly what the LLM sees. Sentinels for
 * dropped tags (`[dropped §N§]`) are tiny and tokenize to ~3 tokens
 * each, which correctly reflects what's on the wire.
 *
 * Stable message ids use a guarded cache: every token-relevant field must still
 * match exactly. This retains correctness when tagging, drops, or historian
 * publication changes an old message while avoiding repeated BPE work and
 * serialization of fields the counter ignores.
 * Synthetic injection messages are deliberately re-counted on every pass.
 *
 * Mirrors OpenCode's switch in `transform.ts:1028-1119` adapted to
 * Pi part shapes:
 *   - PiTextContent (user/assistant/toolResult) → conversation
 *   - PiThinkingContent (assistant) → conversation (incl. signature)
 *   - PiImageContent (user/toolResult) → conversation (visual tokens)
 *   - PiToolCall (assistant) → toolCall (name + JSON arguments)
 *   - PiToolResult content text → toolCall (the bulky result body)
 *
 * Tool definitions (the schemas Pi sends in the separate `tools` field
 * of the request) are NOT counted here. They're computed at status-
 * dialog render time from `pi.getAllTools()` — same approach as
 * OpenCode (residual at display).
 */

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";

export const PI_IMAGE_TOKENS = 1200;

export interface PiMessageTokenCounts {
	conversation: number;
	toolCall: number;
}

export interface PiMessageTokenCacheEntry {
	fingerprint: readonly (string | null)[];
	counts: PiMessageTokenCounts;
}

export interface TokenizePiMessagesOptions {
	cache: Map<string, PiMessageTokenCacheEntry>;
	stableId: (message: object) => string | undefined;
	/**
	 * Drop cached ids absent from this call (default true). A caller that
	 * counts a different selection of the same request, such as the outgoing
	 * fit estimate, passes false so it cannot evict entries the pass's own
	 * accounting still needs.
	 */
	prune?: boolean;
	onTiming?: (
		phase: "cacheValidation" | "bpe" | "cachePrune",
		elapsedMs: number,
	) => void;
}

interface MaybePart {
	type?: string;
	redacted?: boolean;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	textSignature?: string;
	data?: string;
	mimeType?: string;
	name?: string;
	arguments?: unknown;
}

interface MaybeMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	usage?: { output?: number; reasoning?: number };
}

/**
 * Compute conversation + tool-call token totals for a Pi message array.
 *
 * Stable SessionEntry ids can reuse a per-message result when every field that
 * affects token accounting still matches. The fingerprint keeps exact text,
 * signatures, tool names, and canonical tool arguments while omitting fields the
 * counter never reads (including base64 image bytes, whose count is fixed).
 * Synthetic injection messages have no stable id and always run.
 */
export function tokenizePiMessages(
	messages: unknown[],
	options?: TokenizePiMessagesOptions,
): PiMessageTokenCounts {
	let conversation = 0;
	let toolCall = 0;
	let cacheValidationMs = 0;
	let bpeMs = 0;
	const liveIds = options ? new Set<string>() : undefined;

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const cacheValidationStart = options?.onTiming ? performance.now() : 0;
		const resolvedStableId = options?.stableId(raw);
		// Cache equality is only meaningful when JSON.stringify observes the same
		// fields the tokenizer reads. Pi's JSONL messages satisfy this shape; custom
		// prototypes and toJSON hooks must take the uncached path.
		const stableId =
			resolvedStableId !== undefined && isTokenCacheSafeMessage(raw)
				? resolvedStableId
				: undefined;
		const fingerprint =
			stableId === undefined ? null : buildTokenCacheFingerprint(raw);
		if (stableId !== undefined && fingerprint !== null) {
			liveIds?.add(stableId);
			const cached = options?.cache.get(stableId);
			if (
				cached &&
				tokenCacheFingerprintsEqual(cached.fingerprint, fingerprint)
			) {
				conversation += cached.counts.conversation;
				toolCall += cached.counts.toolCall;
				cacheValidationMs += performance.now() - cacheValidationStart;
				continue;
			}
		}
		cacheValidationMs += performance.now() - cacheValidationStart;
		const bpeStart = options?.onTiming ? performance.now() : 0;
		const beforeConversation = conversation;
		const beforeToolCall = toolCall;
		try {
			const msg = raw as MaybeMessage;
			const content = msg.content;

			// User/Assistant: content is array of PiTextContent | PiImageContent
			// | PiThinkingContent | PiToolCall (or a plain string for user
			// messages — Pi allows that shape too).
			if (
				msg.role === "user" ||
				msg.role === "assistant" ||
				msg.role === "custom"
			) {
				if (typeof content === "string") {
					conversation += estimateTokens(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				let opaqueCounted = false;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					switch (p.type) {
						case "text":
							if (typeof p.text === "string")
								conversation += estimateTokens(p.text);

							break;
						case "thinking":
						case "redacted_thinking":
							if (!p.redacted && typeof p.thinking === "string")
								conversation += estimateTokens(p.thinking);
							if (
								!opaqueCounted &&
								(p.redacted ||
									p.type === "redacted_thinking" ||
									(!p.thinking && p.thinkingSignature))
							) {
								opaqueCounted = true;
								conversation += opaqueThinkingCost(
									msg.usage?.reasoning,
									msg.usage?.output,
								).tokens;
							}
							break;
						case "image":
							// Pi image content is base64. Anthropic-style visual
							// token estimate would need width/height, which Pi
							// doesn't expose at this layer. Use the OpenCode
							// fallback (1200 tokens) — over-estimates small
							// thumbnails, under-estimates 4K screenshots, but is
							// stable and matches the OpenCode fallback path.
							conversation += PI_IMAGE_TOKENS;
							break;
						case "toolCall":
							// Tool invocation: name + JSON-serialized arguments.
							// Mirrors OpenCode's `tool_use` case where input is
							// the args payload.
							if (typeof p.name === "string")
								toolCall += estimateTokens(p.name);
							if (p.arguments !== undefined) {
								const s =
									typeof p.arguments === "string"
										? p.arguments
										: safeJsonStringify(p.arguments);
								if (s) toolCall += estimateTokens(s);
							}
							break;
					}
				}
				continue;
			}

			// ToolResult: top-level content is the bulky output body. This is
			// the LARGER of the two halves of a tool tag (args ~58 bytes vs
			// result ~4KB on a typical `read`), so it dominates the bucket.
			if (msg.role === "toolResult") {
				if (typeof content === "string") {
					toolCall += estimateTokens(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					if (p.type === "text" && typeof p.text === "string") {
						toolCall += estimateTokens(p.text);
					} else if (p.type === "image") {
						toolCall += PI_IMAGE_TOKENS;
					}
				}
			}
		} finally {
			bpeMs += performance.now() - bpeStart;
			if (stableId !== undefined && fingerprint !== null) {
				options?.cache.set(stableId, {
					fingerprint,
					counts: {
						conversation: conversation - beforeConversation,
						toolCall: toolCall - beforeToolCall,
					},
				});
			}
		}
	}

	if (options && liveIds && options.prune !== false) {
		const cachePruneStart = options.onTiming ? performance.now() : 0;
		for (const id of options.cache.keys()) {
			if (!liveIds.has(id)) options.cache.delete(id);
		}
		options.onTiming?.("cachePrune", performance.now() - cachePruneStart);
	}
	options?.onTiming?.("cacheValidation", cacheValidationMs);
	options?.onTiming?.("bpe", bpeMs);
	return { conversation, toolCall };
}

function buildTokenCacheFingerprint(value: object): readonly (string | null)[] {
	const message = value as MaybeMessage;
	const role = typeof message.role === "string" ? message.role : null;
	const fingerprint: (string | null)[] = [
		role,
		String(message.usage?.reasoning ?? ""),
		String(message.usage?.output ?? ""),
	];
	if (
		role !== "user" &&
		role !== "assistant" &&
		role !== "toolResult" &&
		role !== "custom"
	) {
		return fingerprint;
	}
	if (typeof message.content === "string") {
		fingerprint.push("string", message.content);
		return fingerprint;
	}
	if (!Array.isArray(message.content)) {
		fingerprint.push("non-array");
		return fingerprint;
	}
	fingerprint.push("parts");
	for (const rawPart of message.content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as MaybePart;
		if (role === "toolResult") {
			if (part.type === "text" && typeof part.text === "string") {
				fingerprint.push("text", part.text);
			} else if (part.type === "image") {
				fingerprint.push("image");
			}
			continue;
		}
		switch (part.type) {
			case "text":
				fingerprint.push(
					"text",
					typeof part.text === "string" ? part.text : null,
					typeof part.textSignature === "string" ? part.textSignature : null,
				);
				break;
			case "thinking":
			case "redacted_thinking":
				fingerprint.push(
					part.type,
					String(part.redacted ?? false),
					typeof part.thinking === "string" ? part.thinking : null,
					typeof part.thinkingSignature === "string"
						? part.thinkingSignature
						: null,
				);
				break;
			case "image":
				fingerprint.push("image");
				break;
			case "toolCall": {
				const argumentsJson =
					part.arguments === undefined
						? null
						: typeof part.arguments === "string"
							? part.arguments
							: safeJsonStringify(part.arguments);
				fingerprint.push(
					"toolCall",
					typeof part.name === "string" ? part.name : null,
					argumentsJson,
				);
				break;
			}
		}
	}
	return fingerprint;
}

export function piOpaqueThinkingFallbackSteps(
	messages: readonly unknown[],
): number {
	return messages.filter((raw) => {
		if (!raw || typeof raw !== "object") return false;
		const message = raw as MaybeMessage;
		return (
			opaqueThinkingCost(message.usage?.reasoning, message.usage?.output)
				.fallback &&
			Array.isArray(message.content) &&
			message.content.some(
				(p: MaybePart) =>
					p &&
					(p.type === "redacted_thinking" ||
						(p.type === "thinking" &&
							(p.redacted || (!p.thinking && p.thinkingSignature)))),
			)
		);
	}).length;
}

/** The byte-size estimate omits ciphertext; replay still uses the original messages. */
export function piFitMessageBytes(raw: unknown): number {
	const message = raw as MaybeMessage;
	const opaque =
		Array.isArray(message.content) &&
		message.content.some(
			(p: MaybePart) =>
				p &&
				(p.type === "redacted_thinking" ||
					(p.type === "thinking" &&
						(p.redacted || (!p.thinking && p.thinkingSignature)))),
		);
	if (
		!opaque &&
		(!Array.isArray(message.content) ||
			!message.content.some(
				(part) =>
					part &&
					((part.type === "thinking" && part.thinkingSignature !== undefined) ||
						(part.type === "text" && part.textSignature !== undefined)),
			))
	)
		return Buffer.byteLength(JSON.stringify(raw));
	const content = Array.isArray(message.content)
		? message.content.map((part) => {
				if (!part || typeof part !== "object") return part;
				if (
					part.type === "redacted_thinking" ||
					(part.type === "thinking" && part.redacted)
				)
					return { type: part.type, redacted: true };
				if (part.type === "thinking") {
					const plain = { ...part };
					delete plain.thinkingSignature;
					return plain;
				}
				if (part.type === "text") {
					const plain = { ...part };
					delete plain.textSignature;
					return plain;
				}
				return part;
			})
		: undefined;
	const bytes = Buffer.byteLength(
		JSON.stringify(content ? { ...message, content } : raw),
	);
	return (
		bytes +
		(opaque
			? 4 *
				opaqueThinkingCost(message.usage?.reasoning, message.usage?.output)
					.tokens
			: 0)
	);
}

function tokenCacheFingerprintsEqual(
	left: readonly (string | null)[],
	right: readonly (string | null)[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isTokenCacheSafeMessage(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if ("toJSON" in value) return false;
	if (
		!isJsonVisibleDataProperty(value, "role") ||
		!isJsonVisibleDataProperty(value, "content")
	) {
		return false;
	}
	return isPlainJsonData((value as { content?: unknown }).content, new Set());
}

function isJsonVisibleDataProperty(value: object, key: string): boolean {
	if (!(key in value)) return true;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return (
		descriptor !== undefined &&
		descriptor.enumerable === true &&
		"value" in descriptor
	);
}

function isPlainJsonData(value: unknown, seen: Set<object>): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return true;
	}
	if (typeof value !== "object" || seen.has(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (
		!Array.isArray(value) &&
		prototype !== Object.prototype &&
		prototype !== null
	) {
		return false;
	}
	if ("toJSON" in value) return false;
	seen.add(value);
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (Array.isArray(value) && key === "length") continue;
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				return false;
			}
			if (!isPlainJsonData(descriptor.value, seen)) return false;
		}
		return true;
	} finally {
		seen.delete(value);
	}
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

import { opaqueThinkingCost } from "@magic-context/core/hooks/magic-context/opaque-thinking";
