import { describe, expect, it } from "bun:test";

import {
	CTX_STATUS_CUSTOM_TYPE,
	type CtxStatusEntryData,
	type PiMessageSender,
	registerCtxStatusEntryRenderer,
	sendCtxStatusMessage,
	shouldShowCtxStatusDialog,
	showCtxStatusDialog,
} from "./pi-command-utils";

describe("ctx-status entries", () => {
	it("appends model-invisible entry data instead of sending a message", () => {
		const appended: Array<{ customType: string; data: unknown }> = [];
		let sent = 0;
		const pi = {
			registerEntryRenderer() {},
			appendEntry(customType: string, data?: unknown) {
				appended.push({ customType, data });
			},
			sendMessage() {
				sent += 1;
			},
		} as unknown as PiMessageSender;

		registerCtxStatusEntryRenderer(pi);
		sendCtxStatusMessage(
			pi,
			{ title: "Magic Embed", text: "Embedding history…", level: "info" },
			{ completed: 2 },
		);

		expect(appended).toEqual([
			{
				customType: CTX_STATUS_CUSTOM_TYPE,
				data: {
					title: "Magic Embed",
					text: "Embedding history…",
					level: "info",
					details: { completed: 2 },
				},
			},
		]);
		expect(sent).toBe(0);
	});

	it("registers one ctx-status entry renderer and ignores malformed data", () => {
		let customType = "";
		let renderer:
			| ((
					entry: { data?: CtxStatusEntryData },
					options: unknown,
					theme: unknown,
			  ) => unknown)
			| undefined;
		const pi = {
			registerEntryRenderer(type: string, value: typeof renderer) {
				customType = type;
				renderer = value;
			},
			appendEntry() {},
		} as unknown as PiMessageSender;

		expect(registerCtxStatusEntryRenderer(pi)).toBe(true);
		expect(customType).toBe(CTX_STATUS_CUSTOM_TYPE);
		expect(renderer).toBeDefined();
		expect(
			renderer?.({ data: undefined }, { expanded: false }, {}),
		).toBeUndefined();
	});

	it("keeps statuses model-invisible on Pi 0.80.2 without entry renderers", () => {
		const appended: Array<{ customType: string; data: unknown }> = [];
		let sent = 0;
		const pi = {
			appendEntry(customType: string, data?: unknown) {
				appended.push({ customType, data });
			},
			sendMessage() {
				sent += 1;
			},
		} as unknown as PiMessageSender;

		expect(registerCtxStatusEntryRenderer(pi)).toBe(false);
		sendCtxStatusMessage(pi, { title: "Magic Status", text: "Ready" });

		expect(appended).toEqual([
			{
				customType: CTX_STATUS_CUSTOM_TYPE,
				data: { title: "Magic Status", text: "Ready" },
			},
		]);
		expect(sent).toBe(0);
	});

	it("keeps progress notifications short and routes detailed results to a dialog", () => {
		expect(
			shouldShowCtxStatusDialog({
				title: "/ctx-dream",
				text: "Starting…",
				level: "info",
			}),
		).toBe(false);
		expect(
			shouldShowCtxStatusDialog({
				title: "/ctx-flush",
				text: "Complete",
				level: "success",
			}),
		).toBe(true);
		expect(
			shouldShowCtxStatusDialog({
				title: "/ctx-status",
				text: "Detailed status",
				level: "info",
				rpcDisplay: "dialog",
			}),
		).toBe(true);
	});

	it("renders RPC detail output through Pi custom UI", async () => {
		let rendered: string[] = [];
		let closed = false;
		let options: unknown;
		const ctx = {
			ui: {
				async custom(factory: unknown, customOptions: unknown) {
					options = customOptions;
					const create = factory as (...args: unknown[]) => {
						render: (width: number) => string[];
						handleInput: (data: string) => void;
					};
					const component = create(
						{},
						{
							fg: (_name: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						() => {
							closed = true;
						},
					);
					rendered = component.render(92);
					component.handleInput("\r");
				},
			},
		};

		await showCtxStatusDialog(ctx as never, {
			title: "/ctx-flush",
			text: "## /ctx-flush\n\nDetailed result",
			level: "success",
		});

		expect(rendered.join("\n")).toContain("Detailed result");
		expect(closed).toBe(true);
		expect(options).toEqual({
			overlay: true,
			overlayOptions: { anchor: "center", width: 92 },
		});
	});
});
