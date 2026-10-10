import { expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Load the installed host implementation, not a copy of its exception handling.
const { ExtensionRunner } = await import(
	new URL(
		"./core/extensions/runner.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	).href
);

export function contextHost() {
	const entries: Array<{ customType: string; data: unknown }> = [];
	const renderers = new Map<string, unknown>();
	const errors: unknown[] = [];
	const controller = new AbortController();
	let original: unknown[] | undefined;
	return {
		entries,
		renderers,
		errors,
		controller,
		api: {
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			registerEntryRenderer(customType: string, renderer: unknown) {
				renderers.set(customType, renderer);
			},
		},
		async emit(
			handler: (...args: never[]) => unknown,
			messages: unknown[],
			ctx: unknown,
		) {
			return ExtensionRunner.prototype.emitContext.call(
				{
					createContext: () => ({
						...(ctx as ExtensionContext),
						signal: controller.signal,
						abort: () => controller.abort(),
					}),
					extensions: [
						{
							path: "magic-context",
							handlers: new Map([
								[
									"context",
									[
										async (
											event: { messages: unknown[] },
											context: unknown,
										) => {
											original = event.messages;
											return handler(event as never, context as never);
										},
									],
								],
							]),
						},
					],
					emitError: (error: unknown) => errors.push(error),
				},
				messages,
			);
		},
		assertRefused(served: unknown[], pristine: unknown[]) {
			expect(controller.signal.aborted).toBe(true);
			expect(entries).toHaveLength(1);
			const data = entries[0]?.data as { message?: string } | undefined;
			expect(data?.message).toStartWith(
				"Magic Context could not safely prepare this turn; send your message again.",
			);
			expect(data?.message).toMatch(/stage=.+ elapsed=\d+ms recovery=.+/);
			expect(renderers.has(entries[0]?.customType ?? "")).toBe(true);
			expect(served).toBe(original);
			expect(served).toEqual(pristine);
			expect(errors).toEqual([]);
		},
	};
}
