/**
 * Pi-side `hasVisibleNoteReadCall` — detects a non-stripped
 * `ctx_note(action="read")` tool call in a Pi `AgentMessage[]`. Used
 * by note-nudger to suppress note nudges while the agent currently
 * has visibility into the notes (and re-surface them once the read
 * has aged out). Mirrors OpenCode's `note-visibility.ts`.
 *
 * Pi shapes we care about:
 *   - Assistant message with content array containing
 *     `{ type: "toolCall", name: "ctx_note", arguments: { action: "read" } }`
 *
 * Pi's tool result message lives separately (`role: "toolResult"`), but
 * for visibility purposes the toolCall part on the assistant is what
 * tells us the read happened. The corresponding result is irrelevant
 * — even if the result was stripped, the call itself in context is
 * what gives the agent the memory of having read.
 *
 * Run AFTER all drops have been materialized so we don't false-
 * positive on a tool call that has been replaced by `[dropped §N§]`.
 * Pi tool calls that have been dropped via the sentinel path lose
 * their `arguments.action` field (replaced by an empty/sentinel
 * payload), so the action check naturally filters them out.
 */

const NOTE_TOOL_NAME = "ctx_note";
const READ_ACTION = "read";

type PiToolCall = {
	type: "toolCall";
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
};
type PiAssistantMessage = {
	role: "assistant";
	content?: unknown;
};

/**
 * Returns true if the Pi message array contains at least one non-stripped
 * `ctx_note(action="read")` tool call. Iterates newest-first so we
 * short-circuit on the most recent visible read.
 */
export function hasVisibleNoteReadCallPi(messages: unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAssistantMessage;
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content as unknown[]) {
			if (!part || typeof part !== "object") continue;
			const p = part as PiToolCall;
			if (p.type !== "toolCall") continue;
			if (p.name !== NOTE_TOOL_NAME) continue;
			const args = p.arguments;
			if (!args || typeof args !== "object") continue;
			const action = (args as { action?: unknown }).action;
			if (action === READ_ACTION) return true;
		}
	}
	return false;
}
