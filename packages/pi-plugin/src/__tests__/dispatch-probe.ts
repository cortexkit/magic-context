import { expect } from "bun:test";
import { registerPiGuardedContext as register } from "../pi-context-refusal";

export * from "../pi-context-refusal";

const blocked = new WeakMap<object, number>();
function counterKey(ctx: object): object {
	const abort = (ctx as { abort?: unknown }).abort;
	return typeof abort === "function" ? abort : ctx;
}
export function piBlockedDispatches(ctx: object): number {
	return blocked.get(counterKey(ctx)) ?? 0;
}

export function assertPiRefusedDispatch(
	payload: unknown,
	reason: string,
): void {
	let providerCalls = 0;
	expect(() => {
		JSON.stringify(payload);
		providerCalls++;
	}).toThrow(reason);
	expect(providerCalls).toBe(0);
}

/**
 * Older fence fixtures counted session aborts as dispatch stops. Exercise the
 * replacement at a mock transport boundary instead, preserving their original
 * admission/reason assertions while requiring every refusal to prevent a send.
 */
export const registerPiGuardedContext: typeof register = (
	pi,
	handler,
	options,
) => {
	let reason: string | undefined;
	register(
		{
			...pi,
			appendEntry(type, data) {
				if (type === "magic-context-turn-refused")
					reason = (data as { message: string }).message;
				return pi.appendEntry(type, data);
			},
			on: ((name: string, fn: (event: unknown, ctx: object) => unknown) => {
				pi.on(
					name as never,
					(name === "before_provider_request"
						? (event: unknown, ctx: object) => {
								const result = fn(event, ctx);
								if (result === undefined) return result;
								assertPiRefusedDispatch(
									result,
									reason ?? "Magic Context request cancelled",
								);
								blocked.set(counterKey(ctx), piBlockedDispatches(ctx) + 1);
								(
									ctx as { onDispatchBlocked?: () => void }
								).onDispatchBlocked?.();
								return undefined;
							}
						: fn) as never,
				);
			}) as typeof pi.on,
		} as typeof pi,
		handler,
		options,
	);
};
