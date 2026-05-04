/**
 * Pi-side raw session reader.
 *
 * Reads from `pi.sessionManager.getBranch()` and produces the same
 * `RawMessage[]` shape OpenCode uses for historian input. The shared
 * `read-session-formatting.ts` and `read-session-chunk.ts` modules
 * are duck-typed against `parts: unknown[]` with specific field
 * conventions, so by synthesizing OpenCode-compatible parts here we
 * reuse 100% of the formatting/chunking/trigger logic unchanged.
 *
 * # Shape mapping
 *
 * Pi's session branch is a `SessionEntry[]` from
 * `@mariozechner/pi-coding-agent` core/session-manager.d.ts:
 *
 *   SessionMessageEntry { id, parentId, type: "message", timestamp,
 *                         message: AgentMessage }
 *
 * Where `AgentMessage` is one of:
 *   - UserMessage:     { role: "user", content: string | (Text|Image)[] }
 *   - AssistantMessage:{ role: "assistant", content: (Text|Thinking|ToolCall)[] }
 *   - ToolResultMessage:{ role: "toolResult", toolCallId, toolName,
 *                         content: (Text|Image)[] }
 *
 * Shared `RawMessage` is `{ ordinal, id, role, parts: unknown[] }`.
 *
 * Mapping:
 *   - User & assistant messages each become one RawMessage with parts
 *     synthesized in OpenCode's shape.
 *   - ToolResult messages get folded into the IMMEDIATELY-FOLLOWING
 *     user message as `{ type: "tool", tool, callID, state: { output } }`
 *     parts. This matches OpenCode's convention: tool results live in
 *     the next user turn, paired by callID with the assistant's
 *     prior tool_use parts.
 *   - When a tool-result run has no following user message (live tail
 *     ends with `assistant + tool_result`), we emit a synthetic user
 *     RawMessage with no stable id (id="" and ordinal still
 *     incremented). Formatting treats it as a normal user turn.
 *
 * # Ordinals
 *
 * Ordinals are assigned by walking the branch in order and counting
 * monotonically from 1. The mapping is stable for the duration of a
 * Pi session because `getBranch()` returns the linear sequence from
 * root to leaf — entries are append-only on the active branch.
 *
 * # Entry types we skip
 *
 * `getBranch()` may return non-message entries (thinking_level_change,
 * model_change, compaction, branch_summary, custom, label,
 * session_info, custom_message). We skip everything except
 * SessionMessageEntry — those carry no `parts` content the historian
 * needs to summarize. Future steps may surface compaction/branch
 * summary entries differently if needed.
 *
 * # Why not use Pi's compaction directly?
 *
 * Pi has its own compaction primitive (CompactionEntry +
 * `pi.compact()`). Magic Context replaces it with historian-driven
 * compartments because:
 *   1. Compartments preserve a structured XML view of older turns
 *      (categorized facts, ranges, dates) that Pi's monolithic
 *      summary text can't.
 *   2. Cross-harness consistency: OpenCode users see the same
 *      `<session-history>` shape regardless of which harness ran the
 *      historian.
 *   3. Pi's compaction lives in the session JSONL file; magic-context
 *      compartments live in the shared cortexkit DB scoped by
 *      sessionId. Different storage, different lifecycle.
 */

import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Read the active Pi session branch and synthesize an OpenCode-shape
 * RawMessage[]. Returns an empty array if no branch is available.
 *
 * The function is pure given `getBranch()` is pure (which it is — Pi
 * documents it as a defensive copy). Safe to call repeatedly per
 * transform pass; the per-transform cache (`withRawSessionMessageCache`
 * from the shared module) wraps individual sessionId lookups so
 * repeated calls inside a single trigger evaluation don't re-walk the
 * branch.
 */
export function readPiSessionMessages(ctx: ExtensionContext): RawMessage[] {
	const sm = ctx.sessionManager;
	if (sm === undefined) return [];
	const getBranch = (sm as { getBranch?: (fromId?: string) => unknown[] })
		.getBranch;
	if (typeof getBranch !== "function") return [];

	let entries: unknown[];
	try {
		entries = getBranch.call(sm);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];

	return convertEntriesToRawMessages(entries);
}

/**
 * Pure conversion exposed for unit testing — call sites in production
 * always go through `readPiSessionMessages`.
 */
export function convertEntriesToRawMessages(entries: unknown[]): RawMessage[] {
	const result: RawMessage[] = [];
	let nextOrdinal = 1;

	// Buffer for tool-result runs waiting to fold into the next user
	// message. Each item is the synthesized "tool" part shape.
	let pendingToolParts: unknown[] = [];

	for (const entry of entries) {
		if (!isMessageEntry(entry)) {
			// Skip non-message entries (thinking_level_change, model_change,
			// compaction, branch_summary, custom, label, session_info,
			// custom_message). They don't carry parts the historian needs.
			continue;
		}

		const msg = entry.message;
		const role = (msg as { role?: string }).role;

		if (role === "toolResult") {
			pendingToolParts.push(...synthesizeToolResultParts(msg));
			continue;
		}

		if (role === "user") {
			// Fold any pending tool-result parts into THIS user's parts
			// (they precede the user's own content in real conversation
			// order, matching OpenCode's flow).
			const parts: unknown[] = [
				...pendingToolParts,
				...synthesizeUserParts(msg),
			];
			pendingToolParts = [];
			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "user",
				parts,
			});
			continue;
		}

		if (role === "assistant") {
			// If there are pending tool-result parts when we hit an
			// assistant (very unusual — tool results normally precede the
			// user that triggered the next assistant), fold them as a
			// synthetic user turn before emitting the assistant. This
			// preserves chunk-formatting invariants.
			if (pendingToolParts.length > 0) {
				result.push({
					ordinal: nextOrdinal++,
					id: "",
					role: "user",
					parts: pendingToolParts,
				});
				pendingToolParts = [];
			}

			result.push({
				ordinal: nextOrdinal++,
				id: entry.id,
				role: "assistant",
				parts: synthesizeAssistantParts(msg),
			});
			continue;
		}

		// Unknown role — pass through with raw parts so formatting can
		// drop them into "noise" lines. Forward compatibility for new
		// AgentMessage roles Pi may add later.
		result.push({
			ordinal: nextOrdinal++,
			id: entry.id,
			role: typeof role === "string" ? role : "unknown",
			parts: [],
		});
	}

	// Tail tool-results with no following user message: emit synthetic
	// user turn so they're still part of the chunked history.
	if (pendingToolParts.length > 0) {
		result.push({
			ordinal: nextOrdinal,
			id: "",
			role: "user",
			parts: pendingToolParts,
		});
	}

	return result;
}

interface MessageEntry {
	type: "message";
	id: string;
	message: unknown;
}

function isMessageEntry(value: unknown): value is MessageEntry {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.type !== "message") return false;
	if (typeof v.id !== "string") return false;
	if (v.message === null || typeof v.message !== "object") return false;
	return true;
}

/**
 * User content can be `string` or `(TextContent | ImageContent)[]`.
 * Synthesize OpenCode-shape `{ type: "text", text }` parts (image
 * parts are dropped — historian ignores them anyway).
 */
function synthesizeUserParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (typeof m.content === "string") {
		if (m.content.trim().length === 0) return [];
		return [{ type: "text", text: m.content }];
	}
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		}
		// Skip image content — historian doesn't summarize images and
		// embedding image bytes in chunks would blow the token budget.
	}
	return parts;
}

/**
 * Assistant content is `(TextContent | ThinkingContent | ToolCall)[]`.
 * We map:
 *   - text  → `{ type: "text", text }` (kept)
 *   - thinking → DROPPED (historian doesn't summarize reasoning)
 *   - toolCall → `{ type: "tool", tool: name, callID: id,
 *                   state: { input: arguments, output: undefined } }`
 *
 * Tool calls without a paired result (output undefined) still surface
 * in TC: lines so historian sees what was attempted.
 */
function synthesizeAssistantParts(msg: unknown): unknown[] {
	const m = msg as { content?: unknown };
	if (!Array.isArray(m.content)) return [];

	const parts: unknown[] = [];
	for (const c of m.content) {
		if (c === null || typeof c !== "object") continue;
		const cc = c as Record<string, unknown>;
		if (cc.type === "text" && typeof cc.text === "string") {
			parts.push({ type: "text", text: cc.text });
		} else if (cc.type === "toolCall" && typeof cc.id === "string") {
			parts.push({
				type: "tool",
				tool: typeof cc.name === "string" ? cc.name : "unknown",
				callID: cc.id,
				state: {
					input: cc.arguments ?? {},
				},
			});
		}
		// thinking parts dropped intentionally
	}
	return parts;
}

/**
 * ToolResult content is `(TextContent | ImageContent)[]`. We collapse
 * to a single `{ type: "tool", tool, callID, state: { output } }`
 * part, joining text fragments. The OpenCode formatting layer expects
 * one tool part per call result; multiple text fragments inside one
 * ToolResultMessage are concatenated.
 */
function synthesizeToolResultParts(msg: unknown): unknown[] {
	const m = msg as {
		toolCallId?: unknown;
		toolName?: unknown;
		content?: unknown;
	};
	const callID = typeof m.toolCallId === "string" ? m.toolCallId : "";
	const tool = typeof m.toolName === "string" ? m.toolName : "unknown";

	if (!callID) return []; // no useful pairing handle

	let output = "";
	if (Array.isArray(m.content)) {
		const fragments: string[] = [];
		for (const c of m.content) {
			if (c === null || typeof c !== "object") continue;
			const cc = c as Record<string, unknown>;
			if (cc.type === "text" && typeof cc.text === "string") {
				fragments.push(cc.text);
			}
		}
		output = fragments.join("\n");
	}

	return [
		{
			type: "tool",
			tool,
			callID,
			state: {
				output,
			},
		},
	];
}
