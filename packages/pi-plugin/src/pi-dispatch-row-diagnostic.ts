import { piDateReminderText } from "./pi-dispatch-date-reminder";

type PiDispatchRoleKind =
	| "user"
	| "assistant"
	| "tool-result"
	| "system"
	| "missing"
	| "unknown";
type PiDispatchInjectorKind =
	| "date-cwd"
	| "anthropic-continue"
	| "superpowers-bootstrap"
	| "none";

export interface PiDispatchRowDiagnostic {
	role: PiDispatchRoleKind;
	parts: number;
	kinds: number;
	chars: number;
	injector: PiDispatchInjectorKind;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** Only fixed vocabularies and counts leave this reader; never block text or IDs. */
export function piDispatchRowDiagnostic(
	role: PiDispatchRoleKind | "toolResult",
	content: unknown,
): PiDispatchRowDiagnostic {
	const parts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content
				: [];
	let kinds = 0;
	let chars = 0;
	let onlyText: string | undefined;
	for (const part of parts) {
		const block = object(part);
		const text = typeof part === "string" ? part : block?.text;
		if (typeof text === "string") {
			kinds |= block?.thought === true ? 16 : 1;
			chars += text.length;
			onlyText = parts.length === 1 ? text : undefined;
		} else if (
			["image", "image_url", "input_image"].includes(String(block?.type)) ||
			block?.inlineData ||
			block?.fileData ||
			block?.image
		)
			kinds |= 2;
		else if (
			["toolCall", "tool_use", "function_call"].includes(String(block?.type)) ||
			block?.functionCall ||
			block?.toolUse
		)
			kinds |= 4;
		else if (
			["tool_result", "function_call_output"].includes(String(block?.type)) ||
			block?.functionResponse ||
			block?.toolResult
		)
			kinds |= 8;
		else if (
			["thinking", "redacted_thinking", "reasoning"].includes(
				String(block?.type),
			)
		) {
			kinds |= 16;
			if (typeof block?.thinking === "string") chars += block.thinking.length;
		} else kinds |= 32;
	}
	const bootstrap = onlyText?.replace(
		/^<system-reminder>\nToday: [^\n]+\n<\/system-reminder>\n{0,2}/u,
		"",
	);
	return {
		role: role === "toolResult" ? "tool-result" : role,
		parts: parts.length,
		kinds,
		chars,
		injector: piDateReminderText(onlyText)
			? "date-cwd"
			: bootstrap?.startsWith(
						"<EXTREMELY_IMPORTANT>\nsuperpowers:using-superpowers bootstrap for pi\n",
					) && bootstrap.endsWith("</EXTREMELY_IMPORTANT>")
				? "superpowers-bootstrap"
				: role === "user" && onlyText === "Continue."
					? "anthropic-continue"
					: "none",
	};
}
