import { afterEach, expect, test } from "bun:test";
import { registerPiGuardedContext } from "./pi-context-refusal";
import { piCursorManagedRoots } from "./pi-dispatch-cursor";
import {
	piConversationFields,
	piHasManagedSignature,
} from "./pi-dispatch-identity";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const marker = "<session-history>";
const managed = `${marker}managed history</session-history>`;
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
const request = (text = managed) => ({
	conversationState: {
		rootPromptMessagesJson: [
			bytes({ role: "system", content: "system instructions" }),
			bytes({ role: "user", content: [{ type: "text", text }] }),
		],
		turns: [
			bytes({ userMessage: { text }, steps: [{ text: "prior answer" }] }),
		],
	},
	action: {
		action: {
			case: "userMessageAction",
			value: { userMessage: { text: "active user", messageId: "random" } },
		},
	},
});

afterEach(() => __setPiHarnessKindForTesting(undefined));

test("Cursor inline JSON: managed history and active action participate in signature and identity", () => {
	const payload = request();
	expect(piHasManagedSignature(payload, marker)).toBe(true);
	expect(piHasManagedSignature(request("raw history"), marker)).toBe(false);
	const first = piConversationFields(payload);
	expect(first).toBeDefined();
	expect(piConversationFields(structuredClone(payload))).toEqual(first);
	for (const mutate of [
		(body: ReturnType<typeof request>) => {
			body.conversationState.turns[0] = bytes({
				userMessage: { text: "changed" },
			});
		},
		(body: ReturnType<typeof request>) => {
			body.action.action.value.userMessage.text = "changed";
		},
		(body: ReturnType<typeof request>) => {
			body.conversationState.rootPromptMessagesJson[0] = bytes({
				role: "system",
				content: "changed instructions",
			});
		},
	]) {
		const changed = structuredClone(payload);
		mutate(changed);
		expect(piConversationFields(changed)).not.toEqual(first);
	}
	const active = request("raw history");
	active.action.action.value.userMessage.text = managed;
	expect(piHasManagedSignature(active, marker)).toBe(true);
	active.conversationState.rootPromptMessagesJson = Array.from(
		{ length: 10 },
		() => bytes({ role: "user", content: "raw" }),
	);
	expect(piHasManagedSignature(active, marker)).toBe(true);
	const turnOnly = request("raw");
	turnOnly.conversationState.turns = [
		bytes({ userMessage: { text: managed } }),
	];
	expect(piHasManagedSignature(turnOnly, marker)).toBe(true);
	const invalid = request();
	invalid.conversationState.rootPromptMessagesJson[0] = new Uint8Array([255]);
	expect(piConversationFields(invalid)).toBeUndefined();
});

test("Cursor managed signature passes the plugin fence; missing signature and unknown shapes fail closed with API diagnostics", async () => {
	for (const [payload, refused] of [
		[request(), false],
		[request("raw"), true],
		[{ mystery: [] }, true],
	] as const) {
		__setPiHarnessKindForTesting("omp");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const notices: string[] = [];
		const ctx = {
			...fakeContext(`cursor-${refused}`),
			model: { api: "cursor-agent", id: "model", provider: "cursor" },
			abort: () => {
				throw new Error("dispatch must not abort");
			},
			ui: { notify: (message: string) => notices.push(message) },
		};
		registerPiGuardedContext(
			{
				on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
					handlers.set(name, fn),
				appendEntry: () => {},
			} as never,
			async () => ({
				messages: [userMessage(managed, 1), userMessage("active user", 2)],
			}),
		);
		await handlers.get("context")?.({ messages: [userMessage("raw", 1)] }, ctx);
		const result = handlers.get("before_provider_request")?.({ payload }, ctx);
		if (refused) {
			expect(() => JSON.stringify(result)).toThrow(
				"Magic Context could not safely prepare",
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("provider API=cursor-agent");
			expect(notices[0]).toContain("shape=");
			expect(notices[0]).toContain("Cursor root hash did not match");
		} else {
			expect(result).toBeUndefined();
			expect(notices).toEqual([]);
		}
	}
});

test("Cursor opaque IDs require an exact managed root, not a hash-shaped placeholder", () => {
	const roots = piCursorManagedRoots([userMessage(managed, 1)], marker);
	expect(roots).toHaveLength(1);
	const payload = request("raw");
	payload.conversationState.rootPromptMessagesJson = [
		Uint8Array.from(Buffer.from(roots[0], "hex")),
	];
	payload.conversationState.turns = [new Uint8Array(32)];
	expect(piHasManagedSignature(payload, marker, roots)).toBe(true);
	expect(piHasManagedSignature(payload, marker, ["0".repeat(64)])).toBe(false);
});
