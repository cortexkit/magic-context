/**
 * Pi synthetic-todowrite injection.
 *
 * # Why this is separate from OpenCode's path
 *
 * OpenCode synthesizes a single `tool` part on the latest assistant message
 * (`buildSyntheticTodoPart` in `packages/plugin/src/hooks/magic-context/todo-view.ts`);
 * OpenCode's wire serializer (`MessageV2.toModelMessagesEffect`) splits that
 * combined part into provider-shape `tool_use` (assistant) and `tool_result`
 * (next user) at wire-emit time.
 *
 * Pi RPC has no equivalent split — Pi delivers a `Message[]` (UserMessage |
 * AssistantMessage | ToolResultMessage) where assistant `toolCall` blocks
 * and `toolResult` messages already live in separate top-level messages. To
 * produce the same on-wire shape we must:
 *
 *   1. Push a Pi `ToolCall` block onto the latest assistant's `content`.
 *   2. Insert a Pi `ToolResultMessage` immediately after it.
 *
 * # Cache safety
 *
 * - Pi message identity uses `AssistantMessage.responseId` when present,
 *   else `String(timestamp)`. Persisted `messageId` is used on later defer
 *   passes to re-anchor at the same assistant message, idempotent on
 *   callID match.
 * - This injection runs AFTER tagging + drops + nudges in `runPipeline`,
 *   so the synthetic blocks are never tagged, never dropped, and never
 *   reach `ctx_reduce`.
 * - The synthetic callID is deterministic (`mc_synthetic_todo_<sha256[:16]>`),
 *   so identical persisted state produces byte-identical wire shape.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	clearPersistedTodoSyntheticAnchor,
	getPersistedTodoSyntheticAnchor,
	setPersistedTodoSyntheticAnchor,
} from "@magic-context/core/features/magic-context/storage-meta";
import {
	buildSyntheticTodoPart,
	type SyntheticTodoPart,
} from "@magic-context/core/hooks/magic-context/todo-view";

// Pi message shape (mirrors @earendil-works/pi-ai types — kept local because
// the pi-plugin builds against a stable subset of those types via TypeScript
// path mapping into packages/plugin/src for the rest of magic-context).
//
// Only the fields we read/write are typed; other fields pass through opaquely.
type PiToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	// Carry the synthetic marker so other Pi paths (e.g. tagger) can detect
	// these blocks if needed. Mirrors `SyntheticTodoPart.syntheticTodoMarker`.
	syntheticTodoMarker: true;
};

type PiAssistantMessage = {
	role: "assistant";
	content: Array<Record<string, unknown>>;
	responseId?: string;
	timestamp?: number;
};

type PiToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
	timestamp?: number;
	syntheticTodoMarker?: true;
};

type PiMessage =
	| PiAssistantMessage
	| PiToolResultMessage
	| Record<string, unknown>;

function getMessageId(message: PiAssistantMessage): string {
	if (typeof message.responseId === "string" && message.responseId.length > 0) {
		return message.responseId;
	}
	if (typeof message.timestamp === "number") {
		return `pi-ts-${message.timestamp}`;
	}
	// Last-resort fallback: index-based ID would change every pass, which
	// would defeat replay byte-stability. Caller is expected to filter
	// these out, but return a stable empty marker just in case.
	return "";
}

function hasToolCallWithId(
	message: PiAssistantMessage,
	callId: string,
): boolean {
	if (!Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const t = (block as { type?: unknown }).type;
		const id = (block as { id?: unknown }).id;
		if (t === "toolCall" && id === callId) return true;
	}
	return false;
}

function findToolResultAfter(
	messages: PiMessage[],
	assistantIndex: number,
	callId: string,
): number {
	for (let i = assistantIndex + 1; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		const role = (m as { role?: unknown }).role;
		const tcId = (m as { toolCallId?: unknown }).toolCallId;
		if (role === "toolResult" && tcId === callId) return i;
		// Stop at the next assistant — Pi pairs tool calls/results within
		// the same assistant turn.
		if (role === "assistant") return -1;
	}
	return -1;
}

/**
 * Pi-shape adapter for the OpenCode `SyntheticTodoPart`. Builds the
 * provider-style `toolCall` block + `toolResult` message that Pi will
 * forward to the LLM.
 */
function piBlocksFromSynthetic(part: SyntheticTodoPart): {
	call: PiToolCallBlock;
	result: PiToolResultMessage;
} {
	return {
		call: {
			type: "toolCall",
			id: part.callID,
			name: part.tool,
			arguments: { todos: part.state.input.todos },
			syntheticTodoMarker: true,
		},
		result: {
			role: "toolResult",
			toolCallId: part.callID,
			toolName: part.tool,
			content: [{ type: "text", text: part.state.output }],
			timestamp: 0,
			syntheticTodoMarker: true,
		},
	};
}

/**
 * Inject the synthetic toolCall/toolResult pair onto the assistant message
 * matching `messageId`. Idempotent on callID — if the pair is already
 * present, returns `true` without mutating. Returns `false` when the target
 * assistant or its paired position isn't available in the visible window.
 */
function injectByAssistantId(
	messages: PiMessage[],
	messageId: string,
	part: SyntheticTodoPart,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		if (getMessageId(assistant) !== messageId) continue;
		if (hasToolCallWithId(assistant, part.callID)) {
			// Already injected — verify the result is also still next to it.
			if (findToolResultAfter(messages, i, part.callID) >= 0) return true;
			// toolCall present but result missing (shouldn't happen). Re-insert.
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		// Insert result right after assistant if not already present.
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return true;
	}
	return false;
}

/**
 * Append the synthetic pair to the latest assistant message in the array.
 * Returns the assistant's message id on success, null when there's no
 * assistant to anchor to (e.g. first turn before assistant has spoken).
 */
function injectIntoLatestAssistant(
	messages: PiMessage[],
	part: SyntheticTodoPart,
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m || typeof m !== "object") continue;
		if ((m as { role?: unknown }).role !== "assistant") continue;
		const assistant = m as PiAssistantMessage;
		const id = getMessageId(assistant);
		if (id.length === 0) continue;
		if (hasToolCallWithId(assistant, part.callID)) {
			if (findToolResultAfter(messages, i, part.callID) >= 0) return id;
		}
		const { call, result } = piBlocksFromSynthetic(part);
		if (!Array.isArray(assistant.content)) assistant.content = [];
		if (!hasToolCallWithId(assistant, part.callID)) {
			assistant.content.push(call as unknown as Record<string, unknown>);
		}
		if (findToolResultAfter(messages, i, part.callID) < 0) {
			messages.splice(i + 1, 0, result);
		}
		return id;
	}
	return null;
}

/**
 * Pi synthetic-todowrite injection entry point. Mirrors the B7 block in
 * OpenCode's `transform-postprocess-phase.ts` but uses Pi's wire-shape
 * helpers.
 *
 * Returns the (possibly-mutated) messages array. The array itself is
 * mutated in place; the return is for call-site clarity.
 */
export function injectSyntheticTodowriteForPi(args: {
	db: ContextDatabase;
	sessionId: string;
	isSubagent: boolean;
	isCacheBusting: boolean;
	lastTodoState: string;
	messages: PiMessage[];
}): PiMessage[] {
	if (args.isSubagent) return args.messages;

	const persistedAnchor = getPersistedTodoSyntheticAnchor(
		args.db,
		args.sessionId,
	);

	if (args.isCacheBusting) {
		const part = buildSyntheticTodoPart(args.lastTodoState);
		if (part === null) {
			if (persistedAnchor) {
				clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
			}
			return args.messages;
		}
		if (
			persistedAnchor &&
			persistedAnchor.callId === part.callID &&
			injectByAssistantId(args.messages, persistedAnchor.messageId, part)
		) {
			// Snapshot unchanged AND persisted anchor still present —
			// idempotent re-inject; backfill stateJson if it was empty
			// (legacy row from a build that persisted callID without state).
			// Mirrors the council Finding #1 v2 self-heal in the OpenCode path.
			if (persistedAnchor.stateJson.length === 0) {
				setPersistedTodoSyntheticAnchor(
					args.db,
					args.sessionId,
					persistedAnchor.callId,
					persistedAnchor.messageId,
					args.lastTodoState,
				);
			}
			return args.messages;
		}
		const anchoredMessageId = injectIntoLatestAssistant(args.messages, part);
		if (anchoredMessageId) {
			setPersistedTodoSyntheticAnchor(
				args.db,
				args.sessionId,
				part.callID,
				anchoredMessageId,
				args.lastTodoState,
			);
		} else if (persistedAnchor) {
			clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
		}
		return args.messages;
	}

	// Defer pass — byte-identical replay from PERSISTED state, not current
	// snapshot. The agent may have called todowrite between T0 and T1; if
	// we rebuilt from the current snapshot we'd inject a different shape
	// and bust Anthropic prompt cache.
	if (!persistedAnchor || persistedAnchor.stateJson.length === 0) {
		return args.messages;
	}
	const part = buildSyntheticTodoPart(persistedAnchor.stateJson);
	if (part === null || part.callID !== persistedAnchor.callId) {
		return args.messages;
	}
	// If the anchor is not in Pi's visible window, skip silently — same
	// behavior as OpenCode's `injectToolPartIntoAssistantById`. Re-anchoring
	// on defer would change the message-array position versus prior defer
	// passes and bust prompt-cache wire shape.
	injectByAssistantId(args.messages, persistedAnchor.messageId, part);
	return args.messages;
}
