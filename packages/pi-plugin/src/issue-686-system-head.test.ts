import { afterEach, expect, test } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { injectM0M1Pi } from "./inject-compartments-pi";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

const heads = [
	{
		role: "system",
		content: "<session-history>materialized m[0]</session-history>",
		timestamp: 1,
	},
	{
		role: "system",
		content: "<session-history-since>materialized m[1]</session-history-since>",
		timestamp: 2,
	},
];
const prompt = userMessage("§3§ current request", 3);
afterEach(() => {
	clearPiContextReceipt("issue-686");
	__setPiHarnessKindForTesting(undefined);
});

test("issue 686: session-provided leading system history has a defined prepared structure", () => {
	const prepared = piPreparedStructure([...heads, prompt]);
	expect(prepared).toBeDefined();
	expect(prepared?.messages).toHaveLength(1);
	expect(
		piMatchesPreparedStructure(
			{
				messages: [
					{ role: "system", content: "provider instructions" },
					...heads,
					prompt,
				],
			},
			prepared,
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			{
				input: [
					{ role: "developer", content: "provider instructions" },
					prompt,
				],
				instructions: heads.map((head) => head.content).join("\n"),
			},
			prepared,
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			{
				contents: [{ role: "user", parts: [{ text: "§3§ current request" }] }],
				config: {
					systemInstruction: {
						parts: heads.map((head) => ({ text: head.content })),
					},
				},
			},
			prepared,
		),
	).toBe(true);
});

test("issue 686: real compartment injection preserves the session's existing leading system entry", () => {
	const db = createTestDb();
	try {
		const cwd = process.cwd();
		const state = {
			sessionId: "issue-686-injector",
			projectIdentity: resolveProjectIdentity(cwd),
			projectDirectory: cwd,
			injectionBudgetTokens: 10000,
		};
		appendCompartments(db, state.sessionId, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 1,
				startMessageId: "prior",
				endMessageId: "prior",
				title: "Prior compartment",
				content: "U: prior turn\nCOMPARTMENT686_UNIT_BODY",
			},
		]);
		const existing = {
			role: "system",
			content: "Session-owned initial instructions",
			timestamp: 0,
		};
		const messages: unknown[] = [existing, userMessage("current user", 3)];
		injectM0M1Pi(state, db, messages as never, ["initial-system", "prior"]);
		expect(messages[0]).toBe(existing);
		expect((messages[1] as { role: string }).role).toBe("user");
		expect((messages[2] as { role: string }).role).toBe("user");
		expect(textOf(messages[1] as never)).toContain("COMPARTMENT686_UNIT_BODY");
		const prepared = piPreparedStructure(messages);
		expect(prepared).toBeDefined();
		expect(piMatchesPreparedStructure({ messages }, prepared)).toBe(true);
	} finally {
		db.close();
	}
});

test("issue 686: leading developer and mixed instruction heads use the same rule on both sides", () => {
	for (const prefix of [
		heads.map((head) => ({ ...head, role: "developer" })),
		[heads[0], { ...heads[1], role: "developer" }],
	]) {
		const prepared = piPreparedStructure([...prefix, prompt]);
		expect(prepared?.messages).toHaveLength(1);
		expect(
			piMatchesPreparedStructure({ messages: [...prefix, prompt] }, prepared),
		).toBe(true);
	}
});

test("issue 686: a prepared system row inside the conversation is counted, not skipped", () => {
	const messages = [prompt, heads[0], prompt];
	const prepared = piPreparedStructure(messages);
	expect(prepared?.messages).toHaveLength(3);
	expect(piMatchesPreparedStructure({ messages }, prepared)).toBe(true);
	expect(
		piMatchesPreparedStructure(
			{ messages: [prompt, heads[0], prompt] },
			piPreparedStructure([prompt, prompt]),
		),
	).toBe(false);
});

test("issue 686: an injected session dispatches its managed result but raw history still refuses", async () => {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	const ctx = { ...fakeContext("issue-686"), abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone([...heads, prompt]) as never }),
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	emit("agent_start");
	await emit("context", { messages: [prompt] });
	emit("before_provider_request", {
		payload: { messages: [...heads, prompt] },
	});
	expect(aborts).toBe(0);
	expect(refusals).toEqual([]);
	emit("before_provider_request", {
		payload: { messages: [userMessage("unmanaged request", 3)] },
	});
	expect(aborts + piBlockedDispatches(ctx)).toBe(1);
	expect(refusals[0]).toContain("missing current receipt signature");
});
