import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

export const CTX_STATUS_CUSTOM_TYPE = "ctx-status";

export interface CtxStatusMessageContent {
	title: string;
	text: string;
	level?: "info" | "success" | "warning" | "error";
	details?: unknown;
}

export type PiMessageSender = Pick<ExtensionAPI, "sendMessage">;

export function resolveSessionId(
	ctx: ExtensionCommandContext,
): string | undefined {
	const sm = ctx.sessionManager;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export function sendCtxStatusMessage(
	pi: PiMessageSender,
	content: CtxStatusMessageContent,
	details?: unknown,
): void {
	pi.sendMessage(
		{
			customType: CTX_STATUS_CUSTOM_TYPE,
			content: content.text,
			display: true,
			details: { ...content, details },
		} as never,
		{ triggerTurn: false },
	);
}
