import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// OMP marks an ephemeral request with a developer reminder and a final user
// prompt, both attributed to "agent" in the context event. Provider adapters
// erase attribution; reminder text on the wire is not proof of a side request.
const SIDE_REMINDER =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

function textContainsReminder(value: unknown): boolean {
	if (typeof value === "string") return value.trim() === SIDE_REMINDER;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (!block || typeof block !== "object") return false;
		const part = block as { text?: unknown; content?: unknown };
		return typeof part.text === "string" && part.text.trim() === SIDE_REMINDER;
	});
}

export function isOmpSideContext(event: ContextEvent): boolean {
	const tail = event.messages.at(-1) as
		| { role?: unknown; attribution?: unknown }
		| undefined;
	if (tail?.role !== "user" || tail.attribution !== "agent") return false;
	return event.messages.some((message) => {
		const row = message as {
			role?: unknown;
			attribution?: unknown;
			content?: unknown;
		};
		return (
			row.role === "developer" &&
			row.attribution === "agent" &&
			textContainsReminder(row.content)
		);
	});
}
