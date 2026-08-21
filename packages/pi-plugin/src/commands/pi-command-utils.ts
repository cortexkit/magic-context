import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, matchesKey, Text } from "@earendil-works/pi-tui";
import { sessionLog } from "@magic-context/core/shared/logger";

export const CTX_STATUS_CUSTOM_TYPE = "ctx-status";

export type CtxStatusLevel = "info" | "success" | "warning" | "error";

export interface CtxStatusEntryData {
	title: string;
	text: string;
	level?: CtxStatusLevel;
	rpcDisplay?: "notification" | "dialog";
	details?: unknown;
}

export type CtxStatusMessageContent = CtxStatusEntryData;

type CtxStatusEntryRenderer = (
	entry: CustomEntry<CtxStatusEntryData>,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

type PiEntryRendererRegistration = {
	registerEntryRenderer?: <T = unknown>(
		customType: string,
		renderer: (
			entry: CustomEntry<T>,
			options: { expanded: boolean },
			theme: Theme,
		) => Component | undefined,
	) => void;
};

export type PiMessageSender = Pick<ExtensionAPI, "appendEntry"> &
	PiEntryRendererRegistration;

type CtxStatusPresenter = (content: CtxStatusMessageContent) => void;

const ctxStatusPresenters = new WeakMap<PiMessageSender, CtxStatusPresenter>();

export function setCtxStatusPresenter(
	pi: PiMessageSender,
	present: CtxStatusPresenter,
): void {
	ctxStatusPresenters.set(pi, present);
}

export function shouldShowCtxStatusDialog(
	content: CtxStatusMessageContent,
): boolean {
	return (
		content.rpcDisplay === "dialog" ||
		(content.rpcDisplay !== "notification" &&
			content.level !== undefined &&
			content.level !== "info")
	);
}

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

export async function showCtxStatusDialog(
	ctx: Pick<ExtensionCommandContext, "ui">,
	content: CtxStatusMessageContent,
): Promise<void> {
	await ctx.ui.custom<undefined>(
		(_tui, theme, _keybindings, done) =>
			new CtxStatusDialog(content, theme, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: 92 } },
	);
}

class CtxStatusDialog implements Component {
	constructor(
		private readonly content: CtxStatusMessageContent,
		private readonly theme: Theme,
		private readonly done: (value: undefined) => void,
	) {}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "return")
		) {
			this.done(undefined);
		}
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [
			this.theme.bold(
				this.theme.fg(
					statusTitleColor(this.content.level),
					`[${this.content.title}]`,
				),
			),
			"",
			...this.content.text.split("\n"),
			"",
			this.theme.fg("dim", "Press Enter or Escape to close"),
		];
	}
}

function statusTitleColor(level: CtxStatusLevel | undefined) {
	switch (level) {
		case "success":
			return "success" as const;
		case "warning":
			return "warning" as const;
		case "error":
			return "error" as const;
		default:
			return "accent" as const;
	}
}

export const renderCtxStatusEntry: CtxStatusEntryRenderer = (
	entry,
	_options,
	theme,
) => {
	const data = entry?.data;
	if (
		!data ||
		typeof data !== "object" ||
		typeof data.title !== "string" ||
		typeof data.text !== "string"
	) {
		return undefined;
	}

	const title = theme.bold(
		theme.fg(statusTitleColor(data.level), `[${data.title}]`),
	);
	const body = theme.fg("customMessageText", data.text);
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${title}\n${body}`));
	return box;
};

/**
 * Register the model-invisible status-entry renderer when the Pi runtime supports it.
 * Older Pi versions still persist status entries through appendEntry; they simply do
 * not render those entries in the TUI.
 */
export function registerCtxStatusEntryRenderer(pi: PiMessageSender): boolean {
	if (typeof pi.registerEntryRenderer !== "function") return false;
	try {
		pi.registerEntryRenderer<CtxStatusEntryData>(
			CTX_STATUS_CUSTOM_TYPE,
			renderCtxStatusEntry,
		);
		return true;
	} catch {
		return false;
	}
}

export function sendCtxStatusMessage(
	pi: PiMessageSender,
	content: CtxStatusMessageContent,
	details?: unknown,
): void {
	const data: CtxStatusEntryData = {
		...content,
		details: details ?? content.details,
	};

	// Custom entries are persisted without entering model context. On older Pi
	// versions they may be invisible in the TUI, but model safety takes priority.
	if (typeof pi.appendEntry === "function") {
		pi.appendEntry<CtxStatusEntryData>(CTX_STATUS_CUSTOM_TYPE, data);
	}
	ctxStatusPresenters.get(pi)?.(data);

	// Minimal non-interactive API shims may omit appendEntry; logging remains the
	// safe fallback and status text must never be routed through sendMessage.
	sessionLog("pi-status", `${content.title}: ${content.text}`);
}
