import {
	piForeignKnownContentKind,
	piForeignServerToolBlock,
} from "./pi-foreign-omp-kinds";

const piForeignRecord = (
	value: unknown,
): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

function jsonValues(
	value: unknown,
	out: unknown[],
	longStringsOnly = false,
	ancestors = new Set<object>(),
): void {
	if (
		value === undefined ||
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		if (!longStringsOnly) out.push(value);
		return;
	}
	if (typeof value === "string") {
		if (!longStringsOnly || value.length >= 64) out.push(value);
		return;
	}
	if (typeof value !== "object" || ancestors.has(value) || ancestors.size > 100)
		throw new Error("unreadable revision value");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new Error("unreadable revision object");
	out.push(value);
	ancestors.add(value);
	for (const [key, child] of Object.entries(value)) {
		if (!longStringsOnly) out.push(key);
		jsonValues(child, out, longStringsOnly, ancestors);
	}
	ancestors.delete(value);
}

function contentValues(content: unknown, out: unknown[]): void {
	out.push(content);
	if (typeof content === "string") return;
	if (!Array.isArray(content)) throw new Error("unreadable content revision");
	out.push(content.length);
	for (const value of content) {
		const block = piForeignRecord(value);
		if (!block) throw new Error("unreadable block revision");
		if (!piForeignKnownContentKind(block.type))
			throw new Error("unreadable block revision kind");
		out.push(value, block.type);
		switch (block.type) {
			case "text":
			case "input_text":
			case "output_text":
				if (typeof block.text !== "string")
					throw new Error("unreadable text revision");
				out.push(block.text);
				break;
			case "thinking":
				if (
					typeof block.thinking !== "string" ||
					(block.thinkingSignature !== undefined &&
						typeof block.thinkingSignature !== "string")
				)
					throw new Error("unreadable thinking revision");
				out.push(block.thinking, block.thinkingSignature);
				break;
			case "redactedThinking":
				if (typeof block.data !== "string")
					throw new Error("unreadable redacted revision");
				out.push(block.data);
				break;
			case "image":
				jsonValues(block, out);
				break;
			case "anthropicServerTool":
				jsonValues(piForeignServerToolBlock(block.block), out);
				break;
			case "fallback":
				// Explicit transport marker: no model-visible conversation text.
				break;
			case "toolCall":
			case "tool_use":
				out.push(block.name);
				jsonValues(block.arguments ?? block.input, out, true);
				break;
			case "tool_result":
				contentValues(block.content, out);
				break;
			default:
				throw new Error("unreadable block revision kind");
		}
	}
}

/** Compare model-visible values, not object identity: Oh My Pi shake/prune edits entries in place. */
export function piForeignRevision(
	message: Record<string, unknown>,
	role = message.role,
): readonly unknown[] {
	const out: unknown[] = [role];
	switch (role) {
		case "user":
		case "assistant":
		case "developer":
		case "toolResult":
		case "custom":
		case "hookMessage":
			contentValues(message.content, out);
			out.push(message.prunedAt, message.customType, message.attribution);
			break;
		case "bashExecution":
		case "pythonExecution":
			out.push(
				message.command,
				message.code,
				message.output,
				message.cancelled,
				message.exitCode,
			);
			jsonValues(message.images, out);
			jsonValues(message.meta, out);
			break;
		case "fileMention":
			if (!Array.isArray(message.files))
				throw new Error("unreadable files revision");
			out.push(message.files, message.files.length);
			for (const value of message.files) {
				const file = piForeignRecord(value);
				if (!file) throw new Error("unreadable file revision");
				out.push(value, file.path, file.content);
				jsonValues(file.image, out);
			}
			break;
		case "compactionSummary":
		case "branchSummary":
			out.push(message.summary, message.method);
			if (message.blocks !== undefined) contentValues(message.blocks, out);
			jsonValues(message.images, out);
			break;
		default:
			throw new Error("unreadable message revision role");
	}
	return out;
}

export function piSameForeignRevision(
	a: readonly unknown[],
	b: readonly unknown[],
	stats?: { comparisons: number },
): boolean {
	if (stats) stats.comparisons++;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (stats) stats.comparisons++;
		if (a[index] !== b[index]) return false;
	}
	return true;
}
