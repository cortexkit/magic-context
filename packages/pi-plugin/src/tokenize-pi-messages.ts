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
 * Why not walk the OpenCode-style cached-by-message-id map? Pi messages
 * mutate in place via the transcript adapter's part proxies, and
 * historian/compressor publication can change tag-prefix bytes on
 * already-emitted messages. A per-pass walk is cheap (estimateTokens
 * is sub-microsecond per call for the typical part) and avoids the
 * cache-staleness cliff OpenCode accepts as a display tradeoff.
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

export interface PiMessageTokenCounts {
	conversation: number;
	toolCall: number;
}

interface MaybePart {
	type?: string;
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
}

/**
 * Compute conversation + tool-call token totals for a Pi message array.
 *
 * Always-walk semantics: no caching. Pi messages mutate in place
 * across pipeline phases (tag prefixes, sentinels, injection) and the
 * walk is cheap relative to the LLM call we're about to make.
 */
export function tokenizePiMessages(messages: unknown[]): PiMessageTokenCounts {
	let conversation = 0;
	let toolCall = 0;

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as MaybeMessage;
		const content = msg.content;

		// User/Assistant: content is array of PiTextContent | PiImageContent
		// | PiThinkingContent | PiToolCall (or a plain string for user
		// messages — Pi allows that shape too).
		if (msg.role === "user" || msg.role === "assistant") {
			if (typeof content === "string") {
				conversation += estimateTokens(content);
				continue;
			}
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as MaybePart;
				switch (p.type) {
					case "text":
						if (typeof p.text === "string")
							conversation += estimateTokens(p.text);
						if (typeof p.textSignature === "string")
							conversation += estimateTokens(p.textSignature);
						break;
					case "thinking":
						if (typeof p.thinking === "string")
							conversation += estimateTokens(p.thinking);
						if (typeof p.thinkingSignature === "string")
							conversation += estimateTokens(p.thinkingSignature);
						break;
					case "image":
						// Pi image content is base64. Anthropic-style visual
						// token estimate would need width/height, which Pi
						// doesn't expose at this layer. Use the OpenCode
						// fallback (1200 tokens) — over-estimates small
						// thumbnails, under-estimates 4K screenshots, but is
						// stable and matches the OpenCode fallback path.
						conversation += 1200;
						break;
					case "toolCall":
						// Tool invocation: name + JSON-serialized arguments.
						// Mirrors OpenCode's `tool_use` case where input is
						// the args payload.
						if (typeof p.name === "string") toolCall += estimateTokens(p.name);
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
					toolCall += 1200;
				}
			}
		}
	}

	return { conversation, toolCall };
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
