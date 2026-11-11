// Exhaustive against the pinned OMP unions, checked by pi-foreign-omp-kinds.test.
// Images can render as text placeholders, so they belong in the rendered list.
export const PI_FOREIGN_RENDERED_CONTENT_KINDS = [
	"text",
	"thinking",
	"redactedThinking",
	"image",
	"toolCall",
	"anthropicServerTool",
] as const;
// A fallback is model-switch transport metadata, not conversation text.
export const PI_FOREIGN_NON_TEXT_CONTENT_KINDS = ["fallback"] as const;
export const PI_FOREIGN_COMPAT_CONTENT_KINDS = [
	"input_text",
	"output_text",
	"tool_use",
	"tool_result",
] as const;
export const PI_FOREIGN_SERVER_TOOL_KINDS = [
	"server_tool_use",
	"web_search_tool_result",
	"tool_search_tool_result",
] as const;

export const PI_FOREIGN_RENDERED_ENTRY_TYPES = [
	"message",
	"custom_message",
	"branch_summary",
	"compaction",
] as const;
// buildSessionContext does not replay these records as conversation messages.
// session_init records a subagent's initial task/system for revival, not a new turn.
export const PI_FOREIGN_NON_TEXT_ENTRY_TYPES = [
	"model_usage",
	"thinking_level_change",
	"model_change",
	"service_tier_change",
	"reset_boundary",
	"custom",
	"label",
	"title_change",
	"ttsr_injection",
	"credential_pin",
	"session_init",
	"mode_change",
] as const;

const contentKinds = new Set<string>([
	...PI_FOREIGN_RENDERED_CONTENT_KINDS,
	...PI_FOREIGN_NON_TEXT_CONTENT_KINDS,
	...PI_FOREIGN_COMPAT_CONTENT_KINDS,
]);
export const piForeignKnownContentKind = (kind: unknown): boolean =>
	typeof kind === "string" && contentKinds.has(kind);

export function piForeignServerToolBlock(
	value: unknown,
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!PI_FOREIGN_SERVER_TOOL_KINDS.some(
			(kind) => kind === Reflect.get(value, "type"),
		)
	)
		throw new Error("unreadable server-tool block");
	return value as Record<string, unknown>;
}

/** Retained provider JSON carries queries/results, including strings shorter than tool arguments. */
export function piForeignServerToolStrings(
	value: unknown,
	out: string[],
	ancestors = new Set<object>(),
): void {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === undefined
	)
		return;
	if (typeof value !== "object" || ancestors.has(value) || ancestors.size > 100)
		throw new Error("unreadable server-tool value");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new Error("unreadable server-tool object");
	ancestors.add(value);
	for (const child of Object.values(value))
		piForeignServerToolStrings(child, out, ancestors);
	ancestors.delete(value);
}
