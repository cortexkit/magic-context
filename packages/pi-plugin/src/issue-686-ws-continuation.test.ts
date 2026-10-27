import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

// Oh My Pi 18.12.x with WebSockets on (providers.openaiWebsockets) sends a
// Codex continuation as only the items appended after the previous response,
// naming that response in previous_response_id. It builds that frame before
// emitting before_provider_request (@oh-my-pi/pi-ai 18.12.3,
// src/providers/openai-codex-responses.ts:3864-3880 and 1955-1962), so the
// frame holds none of the managed history head. These shapes follow that
// provider: response IDs and native output items come from response.completed
// (2739-2785) and reach extensions through the awaited assistant_message event.
const session = "issue-686-ws-continuation";
const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-6.1-sol",
};
const own = { api: model.api, provider: model.provider, model: model.id };
const signature = (id: string, phase: string) =>
	JSON.stringify({ v: 1, id, phase });

const HEAD = "<session-history>managed</session-history>";
const head = userMessage(HEAD, 1);
const user = (text: string, timestamp: number) => userMessage(text, timestamp);
const userItem = (text: string) => ({
	role: "user",
	content: [{ type: "input_text", text }],
});
const reasoningItem = (id: string) => ({
	type: "reasoning",
	id,
	summary: [],
	encrypted_content: `opaque-${id}`,
});
const messageItem = (text: string, id: string, phase: string) => ({
	type: "message",
	role: "assistant",
	id,
	phase,
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const callItem = (callId: string) => ({
	type: "function_call",
	id: `fc_${callId}`,
	call_id: callId,
	name: "read",
	arguments: "{}",
});
const outputItem = (callId: string, output: string) => ({
	type: "function_call_output",
	call_id: callId,
	output,
});

/**
 * One completed Codex response. `host` is the message as Oh My Pi finalizes
 * it (assistant_message); `prepared` is the same message after Magic Context
 * tagged its text for the next pass.
 */
function response(options: {
	id: string;
	text: string;
	tag: number;
	timestamp: number;
	call?: string;
	stopReason?: string;
}) {
	const msgId = `msg_${options.id}`;
	const phase = options.call ? "commentary" : "final_answer";
	const items = [
		reasoningItem(`rs_${options.id}`),
		messageItem(options.text, msgId, phase),
		...(options.call ? [callItem(options.call)] : []),
	];
	const build = (text: string) => ({
		role: "assistant",
		...own,
		stopReason: options.stopReason ?? (options.call ? "toolUse" : "stop"),
		responseId: options.id,
		timestamp: options.timestamp,
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify(reasoningItem(`rs_${options.id}`)),
				summary: false,
			},
			{ type: "text", text, textSignature: signature(msgId, phase) },
			...(options.call
				? [
						{
							type: "toolCall",
							id: `${options.call}|fc_${options.call}`,
							name: "read",
							arguments: {},
						},
					]
				: []),
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items,
		},
	});
	return {
		host: build(options.text),
		prepared: build(`§${options.tag}§ ${options.text}`),
		// Replay-sanitized items as OMP's full requests carry them.
		wire: items.map(({ id: _id, status: _status, ...item }) => item),
	};
}
const toolResult = (call: string, text: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId: `${call}|fc_${call}`,
	toolName: "read",
	content: [{ type: "text", text }],
	timestamp,
});
const todoReminder = (timestamp: number) => ({
	role: "developer",
	content: [
		{
			type: "text",
			text: "<system-reminder>\nYou stopped with 1 incomplete todo item(s):\n- Work\n  - finish\n</system-reminder>",
		},
	],
	attribution: "agent",
	timestamp,
});
const developerItem = (message: ReturnType<typeof todoReminder>) => ({
	role: "developer",
	content: [{ type: "input_text", text: message.content[0].text }],
});
const full = (input: unknown[]) => ({
	type: "response.create",
	model: model.id,
	instructions: "system",
	input,
	stream: true,
});
const chained = (previous: string, input: unknown[]) => ({
	...full(input),
	previous_response_id: previous,
});

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let prepared: unknown[] = [];
	let started = false;
	const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(prepared) }) as never,
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing handler ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		get aborts() {
			return aborts;
		},
		/** One context pass; `newRun` ends the previous run first, as continuations do. */
		async pass(messages: unknown[], newRun = false) {
			if (newRun) emit("agent_end", { messages: [] });
			if (newRun || !started) emit("agent_start");
			started = true;
			prepared = messages;
			await emit("context", { messages: [user("input", 99)] });
		},
		send(body: unknown) {
			emit("before_provider_request", { payload: structuredClone(body) });
		},
		respond(message: unknown) {
			emit("assistant_message", { message: structuredClone(message) });
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

const u1 = user("§1§ read the file", 2);
const a1 = response({
	id: "resp_1",
	text: "checking the file",
	tag: 2,
	timestamp: 3,
	call: "call_1",
});
const r1 = toolResult("call_1", "§3§ file body", 4);
const m1 = [head, u1];
const w1 = [userItem(HEAD), userItem("§1§ read the file")];
const m2 = [...m1, a1.prepared, r1];

/** A full first request, its tool-call response, then the pass that continues it. */
async function toolTurn() {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	await h.pass(m2);
	return h;
}

test("issue 686 WebSocket continuation: a full request then a tool-result delta admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a hidden resumed custom notice is encoded as developer, not system", async () => {
	const h = await toolTurn();
	const notice = {
		role: "custom",
		customType: "eval-state-context",
		display: false,
		attribution: "agent",
		content:
			"<system-reminder>Eval runtime state is host-retained.</system-reminder>",
		timestamp: 5,
	};
	await h.pass([...m2, notice], true);
	h.send(
		chained("resp_1", [
			outputItem("call_1", "§3§ file body"),
			{
				role: "developer",
				content: [{ type: "input_text", text: notice.content }],
			},
		]),
	);
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: changed hidden custom notice text refuses before admission", async () => {
	const h = await toolTurn();
	const notice = {
		role: "custom",
		customType: "eval-state-context",
		display: false,
		attribution: "agent",
		content: "prepared runtime notice",
		timestamp: 5,
	};
	await h.pass([...m2, notice], true);
	h.send(
		chained("resp_1", [
			outputItem("call_1", "§3§ file body"),
			{
				role: "developer",
				content: [{ type: "input_text", text: "unprepared runtime notice" }],
			},
		]),
	);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"delta differs from the prepared provider input tail",
	);
});

test("issue 686 WebSocket continuation: a final answer then the automatic todo-reminder continuation admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	const a2 = response({ id: "resp_2", text: "done", tag: 4, timestamp: 5 });
	h.respond(a2.host);
	// OMP appends a developer reminder and schedules a new run
	// (pi-coding-agent session/todo-tracker.ts:288-318).
	const reminder = todoReminder(6);
	await h.pass([...m2, a2.prepared, reminder], true);
	h.send(chained("resp_2", [developerItem(reminder)]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: two consecutive user turns on a reused transport admit", async () => {
	const h = harness();
	const answer1 = response({ id: "resp_1", text: "hi", tag: 2, timestamp: 3 });
	const answer2 = response({ id: "resp_2", text: "ok", tag: 4, timestamp: 5 });
	const u2 = user("§3§ second turn", 4);
	const u3 = user("§5§ third turn", 6);
	await h.pass(m1);
	h.send(full(w1));
	h.respond(answer1.host);
	await h.pass([...m1, answer1.prepared, u2], true);
	h.send(chained("resp_1", [userItem("§3§ second turn")]));
	h.respond(answer2.host);
	await h.pass([...m1, answer1.prepared, u2, answer2.prepared, u3], true);
	h.send(chained("resp_2", [userItem("§5§ third turn")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a provider retry of the admitted continuation admits", async () => {
	const h = await toolTurn();
	const frame = chained("resp_1", [outputItem("call_1", "§3§ file body")]);
	h.send(frame);
	h.send(frame);
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a full SSE fallback after the continuation in the same pass admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	h.send(full([...w1, ...a1.wire, outputItem("call_1", "§3§ file body")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation guard: a history mutation breaks the chain", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	// The earlier prompt changed after the previous request; the provider's
	// stored context no longer matches what this pass prepared.
	await h.pass([head, user("§1§ read the other file", 2), a1.prepared, r1]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"prepared history does not extend the previous managed request",
	);
});

const m1Text =
	"<session-history-since>(no new content since last materialization)</session-history-since>";
const injectedUser = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const injectedPair = (headTimestamp: number) => [
	injectedUser(HEAD, headTimestamp - 2),
	injectedUser(m1Text, headTimestamp - 1),
];

test("issue 791: a drain changing only the injected pair's timestamps admits a chained pass", async () => {
	const h = harness();
	const beforeDrain = [...injectedPair(100), u1];
	const wire = [
		userItem(HEAD),
		userItem(m1Text),
		userItem("§1§ read the file"),
	];
	await h.pass(beforeDrain);
	h.send(full(wire));
	h.respond(a1.host);
	// The covered head has disappeared from the host branch. Injection still
	// serves the same cached text and visible tail, but derives new timestamps.
	const afterDrain = [...injectedPair(533), u1, a1.prepared, r1];
	const untouched = JSON.stringify(afterDrain);
	await h.pass(afterDrain);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
	expect(JSON.stringify(afterDrain)).toBe(untouched);
	expect(afterDrain.slice(0, 2).map((m) => m.content)).toEqual(
		beforeDrain.slice(0, 2).map((m) => m.content),
	);
});

for (const changed of [
	"m0 text",
	"m1 text",
	"user timestamp",
	"m0 image",
] as const) {
	test(`issue 791: a real ${changed} change still refuses a chained pass`, async () => {
		const h = harness();
		const initial = [...injectedPair(100), u1];
		await h.pass(initial);
		h.send(
			full([userItem(HEAD), userItem(m1Text), userItem("§1§ read the file")]),
		);
		h.respond(a1.host);
		const next = [...injectedPair(533), structuredClone(u1), a1.prepared, r1];
		if (changed === "m0 text" || changed === "m1 text") {
			const index = changed === "m0 text" ? 0 : 1;
			next[index] = injectedUser(
				(index === 0 ? HEAD : m1Text).replace("</", "changed</"),
				533 + index,
			);
		} else if (changed === "user timestamp")
			next[2] = { ...u1, timestamp: 999 };
		else
			(next[0].content as unknown[]).push({
				type: "image",
				data: "changed",
				mimeType: "image/png",
			});
		await h.pass(next);
		h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
		expect(h.aborts).toBe(1);
		expect(h.refusals[0]).toContain(
			"prepared history does not extend the previous managed request",
		);
	});
}

test("issue 686 WebSocket continuation guard: a stale previous_response_id refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	const a2 = response({ id: "resp_2", text: "done", tag: 4, timestamp: 5 });
	h.respond(a2.host);
	const reminder = todoReminder(6);
	await h.pass([...m2, a2.prepared, reminder], true);
	h.send(chained("resp_1", [developerItem(reminder)]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: a wrong previous_response_id refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_forged", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: a fresh process without the recorded response refuses", async () => {
	const h = harness();
	await h.pass(m2);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"no completed managed response is recorded for this continuation",
	);
});

test("issue 686 WebSocket continuation guard: malformed chain ids cannot fall through to the full-request fence", async () => {
	for (const id of ["", null, 7]) {
		const h = harness();
		await h.pass(m1);
		h.send({ ...full(w1), previous_response_id: id });
		expect(h.aborts).toBe(1);
		expect(h.refusals[0]).toContain("invalid chained continuation frame");
		clearPiContextReceipt(session);
	}
});

test("issue 686 WebSocket continuation guard: an unknown prefix before the delta refuses", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	// The prepared history continues from some other response, not the one the
	// provider holds for this chain.
	const other = response({
		id: "resp_other",
		text: "checking the file",
		tag: 2,
		timestamp: 3,
		call: "call_1",
	});
	await h.pass([...m1, other.prepared, r1]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"prepared history does not continue from the previous managed response",
	);
});

test("issue 686 WebSocket continuation guard: a delta answering another call refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_other", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"delta differs from the prepared provider input tail",
	);
});

test("issue 686 WebSocket continuation guard: a delta with an unprepared extra item refuses", async () => {
	const h = await toolTurn();
	h.send(
		chained("resp_1", [
			outputItem("call_1", "§3§ file body"),
			userItem("UNMANAGED appended prompt"),
		]),
	);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"delta differs from the prepared provider input tail",
	);
});

test("issue 686 WebSocket continuation guard: an altered resend of the admitted continuation refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	h.send(chained("resp_1", [outputItem("call_1", "§3§ altered body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"provider request does not match this pass's managed dispatch",
	);
});

test("issue 686 WebSocket continuation guard: a resend naming another response refuses", async () => {
	const h = await toolTurn();
	const tail = [outputItem("call_1", "§3§ file body")];
	h.send(chained("resp_1", tail));
	h.send(chained("resp_0", tail));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: an errored response is not a continuation point", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(
		response({
			id: "resp_1",
			text: "checking the file",
			tag: 2,
			timestamp: 3,
			call: "call_1",
			stopReason: "error",
		}).host,
	);
	await h.pass(m2);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"no completed managed response is recorded for this continuation",
	);
});

test("issue 686 WebSocket continuation guard: an aborted, cut-off or unreplayable response is never a continuation point", async () => {
	// Oh My Pi runs assistant_message on every finalized message, including ones
	// whose stream ended in an error or abort (agent-core agent-loop.ts:2309-2310
	// and 2592-2593 run before stopReason is consulted). Only a completed
	// response with replayable native items may anchor a chain.
	const base = response({
		id: "resp_1",
		text: "checking the file",
		tag: 2,
		timestamp: 3,
		call: "call_1",
	}).host;
	const variants: Record<string, unknown> = {
		aborted: { ...base, stopReason: "aborted" },
		length: { ...base, stopReason: "length" },
		"no response id": { ...base, responseId: undefined },
		"no native items": { ...base, providerPayload: undefined },
		"replacing items": {
			...base,
			providerPayload: { ...base.providerPayload, dt: false },
		},
	};
	const outcomes: Record<string, string | undefined> = {};
	for (const [name, message] of Object.entries(variants)) {
		const h = harness();
		await h.pass(m1);
		h.send(full(w1));
		h.respond(message);
		await h.pass(m2);
		h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
		outcomes[name] = h.refusals[0]?.includes(
			"no completed managed response is recorded for this continuation",
		)
			? "refused"
			: h.refusals[0];
		clearPiContextReceipt(session);
	}
	expect(outcomes).toEqual(
		Object.fromEntries(Object.keys(variants).map((name) => [name, "refused"])),
	);
});

test("issue 686 WebSocket continuation guard: an errored response drops the earlier anchor too", async () => {
	// After a failed response neither it nor the response before it describes
	// what the provider holds for this session's next request.
	const refusals: string[] = [];
	for (const previous of ["resp_1", "resp_2"]) {
		const h = await toolTurn();
		h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
		const failed = response({
			id: "resp_2",
			text: "done",
			tag: 4,
			timestamp: 5,
			stopReason: "error",
		});
		h.respond(failed.host);
		const u2 = user("§5§ try again", 6);
		await h.pass([...m2, failed.prepared, u2], true);
		h.send(chained(previous, [userItem("§5§ try again")]));
		expect(h.aborts).toBe(1);
		refusals.push(h.refusals[0] ?? "");
		clearPiContextReceipt(session);
	}
	for (const refusal of refusals)
		expect(refusal).toContain(
			"no completed managed response is recorded for this continuation",
		);
});

test("issue 686 WebSocket continuation guard: after an aborted response the earlier response is stale", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	// The stream was aborted through the request signal: Oh My Pi emits no
	// assistant_message (agent-core agent-loop.ts:2225-2236 and 2795-2838), so
	// that request has no response.
	const u2 = user("§4§ next prompt", 5);
	await h.pass([...m2, u2], true);
	h.send(chained("resp_1", [userItem("§4§ next prompt")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"the last managed request has no completed response",
	);
});

test("issue 686 WebSocket continuation guard: altered tool-result text on the first delta refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ edited body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"delta differs from the prepared provider input tail",
	);
});

test("issue 686 WebSocket continuation parity: full requests retain their existing text-rewrite policy", async () => {
	const h = await toolTurn();
	// Full requests use the existing structural policy. A continuation may reuse
	// a recorded response only if its delta exactly matches the prepared input tail.
	h.send(full([...w1, ...a1.wire, outputItem("call_1", "§3§ edited body")]));
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation guard: altered user and todo-reminder text refuses", async () => {
	const answer = response({ id: "resp_1", text: "done", tag: 2, timestamp: 3 });
	for (const tail of [user("§3§ next turn", 4), todoReminder(4)]) {
		const h = harness();
		await h.pass(m1);
		h.send(full(w1));
		h.respond(answer.host);
		await h.pass([...m1, answer.prepared, tail], true);
		h.send(
			chained("resp_1", [
				{
					role: tail.role,
					content: [{ type: "input_text", text: "UNMANAGED replacement" }],
				},
			]),
		);
		expect(h.aborts).toBe(1);
		expect(h.refusals[0]).toContain(
			"delta differs from the prepared provider input tail",
		);
		clearPiContextReceipt(session);
	}
});

test("issue 686 WebSocket continuation guard: altered native response with the same id refuses", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	const changed = structuredClone(a1.prepared);
	changed.providerPayload.items[0] = {
		...reasoningItem("rs_resp_1"),
		encrypted_content: "altered",
	};
	await h.pass([...m1, changed, r1]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"prepared response or tail encoding cannot continue",
	);
});

test("issue 686 WebSocket continuation: split text blocks use the provider's exact newline encoding", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	await h.pass([
		...m1,
		a1.prepared,
		{
			...r1,
			content: [
				{ type: "text", text: "§3§ first" },
				{ type: "text", text: "second" },
			],
		},
	]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ first\nsecond")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});
