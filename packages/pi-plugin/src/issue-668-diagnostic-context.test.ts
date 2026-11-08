import { afterEach, expect, spyOn, test } from "bun:test";
import {
	clearPiContextReceipt,
	PiContextSupersededError,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import * as diagnostic from "./omp-diagnostic-context";
import { isOmpDumpContextStack } from "./omp-diagnostic-context";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const dumpStack = `Error
    at emitContext (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:2015:38)
    at #formatLlmRequestJson (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:13436:34)
    at dumpLlmRequestToTmpDir (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:13431:40)`;

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	clearPiContextReceipt("issue-668");
	clearPiContextReceipt("issue-668-other");
});

function harness(
	handler: Parameters<typeof registerPiGuardedContext>[1],
	kind: "omp" | "pi" = "omp",
	compactionOff = false,
) {
	__setPiHarnessKindForTesting(kind);
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const entries: unknown[] = [];
	const notices: unknown[] = [];
	let aborts = 0;
	registerPiGuardedContext(
		{
			on: (name: string, fn: (...args: never[]) => unknown) =>
				handlers.set(name, fn),
			appendEntry: (_type: string, data: unknown) => entries.push(data),
		} as never,
		handler,
		{ compactionOff: () => compactionOff },
	);
	const ctx = {
		...fakeContext("issue-668"),
		ui: { notify: (...args: unknown[]) => notices.push(args) },
		abort: () => aborts++,
	};
	const emit = (name: string, event: unknown = {}, sessionId = "issue-668") =>
		handlers.get(name)?.(
			event as never,
			(sessionId === "issue-668"
				? ctx
				: {
						...ctx,
						sessionManager: fakeContext(sessionId).sessionManager,
					}) as never,
		);
	return {
		emit,
		entries,
		notices,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("issue 668: only the pinned OMP dump frames identify a diagnostic", () => {
	expect(isOmpDumpContextStack(dumpStack)).toBe(true);
	expect(isOmpDumpContextStack(dumpStack.replaceAll("/", "\\"))).toBe(true);
	expect(
		isOmpDumpContextStack(
			dumpStack.replace("dumpLlmRequestToTmpDir", "dumpSessionArchiveToTmpDir"),
		),
	).toBe(false);
	expect(
		isOmpDumpContextStack(
			dumpStack.replace("#formatLlmRequestJson", "prepareProviderCall"),
		),
	).toBe(false);
	expect(
		isOmpDumpContextStack(
			dumpStack.replaceAll("@oh-my-pi/pi-coding-agent", "extension"),
		),
	).toBe(false);
	expect(isOmpDumpContextStack(undefined)).toBe(false);
});

test("issue 668: diagnostic snapshots bypass all handler writes and leave a live pass owned", async () => {
	const held = deferred();
	const entered = deferred();
	let calls = 0;
	let ownerChecks = 0;
	const h = harness(async (event, _ctx, budget) => {
		calls++;
		entered.resolve();
		await held.promise;
		budget.assertOutcome();
		ownerChecks++;
		return { messages: event.messages };
	});
	h.emit("agent_start");
	const live = [userMessage("live", 1)];
	const pending = h.emit("context", { messages: live });
	await entered.promise;
	const detect = spyOn(diagnostic, "isOmpDumpContext").mockReturnValue(true);
	try {
		const raw = [userMessage("snapshot", 2)];
		const result = await h.emit("context", { messages: raw });
		expect(result).toEqual({ messages: raw });
		expect((result as { messages: unknown[] }).messages).toBe(raw);
		held.resolve();
		await pending;
		h.emit("before_provider_request", {
			payload: { messages: [{ role: "user", content: "live" }] },
		});
		expect(calls).toBe(1);
		expect(ownerChecks).toBe(1);
		expect(h.entries).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(h.stops).toBe(0);
	} finally {
		held.resolve();
		detect.mockRestore();
	}
});

test("issue 668: an idle diagnostic does not mint a dispatch receipt", async () => {
	let writes = 0;
	const h = harness(async (event) => {
		writes++;
		return { messages: event.messages };
	});
	const detect = spyOn(diagnostic, "isOmpDumpContext").mockReturnValue(true);
	try {
		await h.emit("context", { messages: [userMessage("dump", 1)] });
		expect(writes).toBe(0);
		expect(h.entries).toEqual([]);
		h.emit("before_provider_request", { payload: { messages: [] } });
		expect(h.stops).toBe(1);
		expect(JSON.stringify(h.entries)).toContain("no context pass ran");
	} finally {
		detect.mockRestore();
	}
});

test("issue 668: Pi treats even a dump-looking caller as a normal pass", async () => {
	let calls = 0;
	const h = harness(async (event) => {
		calls++;
		return { messages: event.messages };
	}, "pi");
	const detect = spyOn(diagnostic, "isOmpDumpContext").mockReturnValue(true);
	try {
		const messages = [userMessage("ordinary Pi request", 1)];
		expect(await h.emit("context", { messages })).toEqual({ messages });
		expect(calls).toBe(1);
		expect(detect).not.toHaveBeenCalled();
	} finally {
		detect.mockRestore();
	}
});

test("issue 668: real conflict fallback and retries refuse without revoking the newer receipt", async () => {
	const held = deferred();
	const entered = deferred();
	let calls = 0;
	const h = harness(async (event, _ctx, budget) => {
		if (++calls === 1) {
			entered.resolve();
			await held.promise;
		}
		budget.assertOutcome();
		return { messages: event.messages };
	});
	h.emit("agent_start");
	const raw = [userMessage("loser", 1)];
	const old = Promise.resolve(h.emit("context", { messages: raw }));
	await entered.promise;
	const newer = [userMessage("managed winner", 2)];
	const next = Promise.resolve(h.emit("context", { messages: newer }));
	held.resolve();
	await expect(old).rejects.toBeInstanceOf(PiContextSupersededError);
	await next;
	expect(raw).toHaveLength(2);
	const marker = raw[1];
	expect(marker.role).toBe("user");
	expect(marker.content).toHaveLength(1);
	expect(marker.content[0]).toMatchObject({ type: "text" });
	const text = (marker.content[0] as { type: "text"; text: string }).text;
	expect(text).toMatch(
		/^Magic Context did not prepare this request for the current turn\. [0-9a-f-]{36}$/,
	);
	expect(JSON.stringify(newer)).not.toContain(text);
	for (const payload of [
		{ messages: raw },
		{
			input: raw.map((message) => ({
				role: "user",
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((block) => ({
								type: "input_text",
								text: (block as { text: string }).text,
							})),
			})),
		},
	])
		h.emit("before_provider_request", { payload });
	expect(h.stops).toBe(2);
	expect(JSON.stringify(h.entries)).toContain(
		"superseded context fallback is not a managed request",
	);
	h.emit("before_provider_request", { payload: { messages: newer } });
	expect(h.stops).toBe(2);
	h.emit("before_provider_request", {
		payload: {
			messages: newer,
			metadata: { nonceFragment: text.slice(0, -1) },
		},
	});
	expect(h.stops).toBe(2);
	await h.emit("context", { messages: [userMessage("later clean pass", 3)] });
	h.emit("before_provider_request", { payload: { input: "later clean pass" } });
	expect(h.stops).toBe(2);
	h.emit("before_provider_request", { payload: { messages: raw } });
	expect(h.stops).toBe(3);
	h.emit("agent_end");
	h.emit("before_provider_request", { payload: { messages: raw } });
	expect(h.stops).toBe(4);
	expect(JSON.stringify(h.entries.at(-1))).toContain(
		"superseded context fallback is not a managed request",
	);
});

function nonceHarness() {
	return harness(async (event) => {
		if (event.messages[0]?.content !== "managed")
			throw new PiContextSupersededError("replaced pass");
		return { messages: event.messages };
	});
}

async function markedFallback(
	h: ReturnType<typeof nonceHarness>,
	index: number,
	sessionId = "issue-668",
) {
	const messages = [userMessage(`replaced ${index}`, index)];
	await expect(
		Promise.resolve(h.emit("context", { messages }, sessionId)),
	).rejects.toBeInstanceOf(PiContextSupersededError);
	expect(messages).toHaveLength(2);
	return messages;
}

test("issue 668: nonce-free sessions never serialize the provider payload", async () => {
	const h = nonceHarness();
	await h.emit("context", { messages: [userMessage("managed")] });
	const payload = {
		messages: [{ role: "user", content: "managed" }],
		toJSON() {
			throw new Error("nonce-free dispatch serialized the payload");
		},
	};
	expect(() => h.emit("before_provider_request", { payload })).not.toThrow();
	expect(h.stops).toBe(0);
	const other = await markedFallback(h, 1, "issue-668-other");
	await h.emit(
		"context",
		{ messages: [userMessage("managed")] },
		"issue-668-other",
	);
	// The other session's superseded-request nonce must not make this session
	// serialize its payload.
	expect(() => h.emit("before_provider_request", { payload })).not.toThrow();
	expect(h.stops).toBe(0);
	const candidate = await prepareNonceCandidate(h, other);
	h.emit("before_provider_request", { payload: { messages: candidate } });
	expect(h.stops).toBe(0);
	h.emit(
		"before_provider_request",
		{ payload: { messages: candidate } },
		"issue-668-other",
	);
	expect(h.stops).toBe(1);
});

test("issue 668: each session retains exactly its newest 32 unsendable nonces", async () => {
	const h = nonceHarness();
	const raw = [];
	for (let index = 0; index < 33; index++)
		raw.push(await markedFallback(h, index));
	const other = await markedFallback(h, 100, "issue-668-other");
	const retired = await prepareNonceCandidate(h, raw[0]);
	h.emit("before_provider_request", { payload: { messages: retired } });
	expect(h.stops).toBe(0);
	for (const messages of raw.slice(1)) {
		const candidate = await prepareNonceCandidate(h, messages);
		h.emit("before_provider_request", { payload: { messages: candidate } });
	}
	expect(h.stops).toBe(32);
	await h.emit(
		"context",
		{ messages: [userMessage("managed"), ...other] },
		"issue-668-other",
	);
	h.emit(
		"before_provider_request",
		{ payload: { messages: [userMessage("managed"), ...other] } },
		"issue-668-other",
	);
	expect(h.stops).toBe(33);
});

test("issue 668: receipt cleanup also clears only that session's nonces", async () => {
	const h = nonceHarness();
	const raw = await markedFallback(h, 1);
	const other = await markedFallback(h, 2, "issue-668-other");
	await h.emit(
		"context",
		{ messages: [userMessage("managed")] },
		"issue-668-other",
	);
	clearPiContextReceipt("issue-668");
	const candidate = await prepareNonceCandidate(h, raw);
	h.emit("before_provider_request", { payload: { messages: candidate } });
	expect(h.stops).toBe(0);
	const payload = {
		messages: candidate,
		toJSON() {
			throw new Error("cleared session serialized the payload");
		},
	};
	expect(() => h.emit("before_provider_request", { payload })).not.toThrow();
	expect(h.stops).toBe(0);
	h.emit(
		"before_provider_request",
		{ payload: { messages: [userMessage("managed"), ...other] } },
		"issue-668-other",
	);
	expect(h.stops).toBe(1);
});

async function prepareNonceCandidate(
	h: ReturnType<typeof nonceHarness>,
	messages: ReturnType<typeof userMessage>[],
) {
	// Return the candidate from a fresh pass so this test isolates which nonce
	// markers are retained, without an unrelated raw body borrowing its receipt.
	const candidate = [userMessage("managed"), ...messages];
	await h.emit("context", { messages: candidate });
	return candidate;
}

for (const kind of [
	"pi",
	"omp-side",
	"omp-latched",
	"omp-compaction-off",
] as const) {
	test(`issue 668: no fallback marker when dispatch cannot inspect it (${kind})`, async () => {
		const h = harness(
			async (_event, _ctx, _budget) => {
				throw new PiContextSupersededError("conflict");
			},
			kind === "pi" ? "pi" : "omp",
			kind === "omp-compaction-off",
		);
		const side = [
			{
				role: "developer",
				attribution: "agent",
				content:
					"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>",
				timestamp: 1,
			},
			{ ...userMessage("side prompt", 2), attribution: "agent" },
		];
		if (kind === "omp-latched") {
			await expect(
				Promise.resolve(h.emit("context", { messages: side })),
			).rejects.toThrow("conflict");
		}
		const messages = kind === "omp-side" ? side : [userMessage("normal", 3)];
		const length = messages.length;
		await expect(
			Promise.resolve(h.emit("context", { messages })),
		).rejects.toThrow("conflict");
		expect(messages).toHaveLength(length);
		expect(JSON.stringify(messages)).not.toContain(
			"Magic Context did not prepare this request",
		);
	});
}
