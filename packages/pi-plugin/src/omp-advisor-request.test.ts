import { afterEach, expect, test } from "bun:test";
import {
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import captures from "./fixtures/omp-advisor-18.10.4.json";
import { isOmpAdvisorRequest } from "./omp-request-kind";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

type Row = { role: string; content: unknown };
type Body = {
	[key: string]: unknown;
	tools: Record<string, unknown>[];
	messages?: Row[];
	input?: Row[];
};
const advisors: Record<string, Body> = captures.advisors;
const main: Body = captures.main;
const clone = (body: Body): Body => structuredClone(body);
const rows = (body: Body): Row[] => body.messages ?? body.input ?? [];
const user = (body: Body): Row => {
	const row = rows(body).find((row) => row.role === "user");
	if (!row) throw new Error("capture has no user message");
	return row;
};

function fence() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event) => ({ messages: event.messages }),
	);
	const ctx = {
		...fakeContext("advisor-686"),
		ui: { notify: () => {} },
		abort: () => aborts++,
	};
	return {
		refusals,
		get stops() {
			return aborts + piBlockedDispatches(ctx);
		},
		dispatch: (payload: unknown) =>
			handlers.get("before_provider_request")?.({ payload }, ctx),
	};
}
afterEach(() => __setPiHarnessKindForTesting(undefined));

function refused(body: unknown) {
	expect(isOmpAdvisorRequest(body)).toBe(false);
	const h = fence();
	h.dispatch(body);
	expect(h.stops).toBe(1);
	expect(h.refusals).toHaveLength(1);
	expect(h.refusals[0]).toContain("no context pass ran for this operation");
}

// Captures come from the real 18.10.4 SDK, not hand-written provider envelopes.
// The fixture keeps instruction/message fields and tool names, omits schemas and
// unrelated request options, and replaces temporary paths with a fixed location.
for (const [name, body] of Object.entries(advisors)) {
	test(`issue 686 advisor: accepts captured ${name}`, () => {
		const before = JSON.stringify(body);
		expect(isOmpAdvisorRequest(body)).toBe(true);
		const h = fence();
		h.dispatch(body);
		expect(h.refusals).toEqual([]);
		expect(h.stops).toBe(0);
		expect(JSON.stringify(body)).toBe(before);
		// Letting an advisor review through must not authorize the next ordinary
		// conversation: it still needs its own completed context-preparation pass.
		h.dispatch(main);
		expect(h.stops).toBe(1);
		expect(h.refusals[0]).toContain("no context pass ran for this operation");
	});

	test(`issue 686 advisor: ${name} still requires advise`, () => {
		refused({ ...body, tools: [] });
	});

	test(`issue 686 advisor: ${name} still requires a session update first`, () => {
		const ordinary = clone(body);
		user(ordinary).content = "An ordinary user turn";
		refused(ordinary);
	});

	for (const [label, replace] of [
		[
			"advisor prefix",
			"User, code-quality, robustness advocate; peer-shadow main agent.",
		],
		[
			"advisor workflow",
			"<workflow>\nReceive incremental agent transcript, including thoughts.\n",
		],
	] as const) {
		test(`issue 686 advisor: ${name} still requires ${label}`, () => {
			const changed = JSON.parse(
				JSON.stringify(body).replaceAll(
					JSON.stringify(replace).slice(1, -1),
					"ordinary instructions",
				),
			) as Body;
			refused(changed);
		});
	}
}

test("issue 686 advisor: main lane owning advise stays checked", () => {
	expect(main.tools.some((tool) => tool.name === "_advise")).toBe(true);
	refused(main);
});

test("issue 686 advisor: captured main context stays checked in OpenAI envelopes", () => {
	const system = (main.system as { text: string }[])
		.map((part) => part.text)
		.join("\n\n");
	refused({
		messages: [{ role: "system", content: system }, ...rows(main)],
		tools: advisors.chat.tools,
	});
	refused({
		instructions: system,
		input: rows(main),
		tools: advisors.responses.tools,
	});
	refused({
		input: [{ role: "developer", content: system }, ...rows(main)],
		tools: advisors.responses.tools,
	});
});

for (const name of [
	"chat",
	"chat-reasoning",
	"responses-reasoning",
	"azure",
	"azure-reasoning",
]) {
	test(`issue 686 advisor: ${name} cannot borrow later instruction text`, () => {
		const changed = clone(advisors[name]);
		const messages = rows(changed);
		const instructions = messages.splice(
			0,
			messages.findIndex((row) => row.role === "user"),
		);
		messages.push(...instructions);
		refused(changed);
	});

	test(`issue 686 advisor: ${name} cannot borrow quoted user instructions`, () => {
		const changed = clone(advisors[name]);
		for (const row of rows(changed)) row.role = "user";
		refused(changed);
	});

	test(`issue 686 advisor: ${name} cannot borrow a later instruction prefix`, () => {
		const changed = clone(advisors[name]);
		rows(changed).unshift({
			role: rows(changed)[0].role,
			content: "Ordinary main-lane instructions",
		});
		refused(changed);
	});
}

test("issue 686 advisor: Responses instructions cannot borrow an inline advisor prefix", () => {
	refused({
		...advisors["responses-reasoning"],
		instructions: "Ordinary main-lane instructions",
	});
});

test("issue 686 advisor: Responses accepts the adapter's undefined instructions field", () => {
	expect(
		isOmpAdvisorRequest({
			...advisors["responses-reasoning"],
			instructions: undefined,
		}),
	).toBe(true);
});

test("issue 686 advisor: unknown and hybrid envelopes stay checked", () => {
	for (const body of [
		null,
		{},
		{ ...advisors.chat, input: [] },
		{ ...advisors.chat, instructions: "" },
		{ ...advisors.chat, system: advisors["anthropic-plain"].system },
		{ ...advisors.chat, tools: advisors.responses.tools },
		{ ...advisors.responses, messages: [] },
		{ ...advisors.responses, system: [] },
		{ ...advisors.responses, tools: advisors.chat.tools },
		{ ...advisors["anthropic-plain"], tools: advisors.chat.tools },
		{ ...advisors["anthropic-plain"], tools: advisors.responses.tools },
		{ ...advisors["responses-reasoning"], instructions: null },
		{ ...advisors["responses-reasoning"], instructions: 1 },
	])
		refused(body);
});

test("issue 686 advisor: only Anthropic strips one tool-name underscore", () => {
	refused({
		...advisors.chat,
		tools: [{ type: "function", function: { name: "_advise" } }],
	});
	refused({
		...advisors.responses,
		tools: [{ type: "function", name: "_advise" }],
	});
	refused({ ...advisors["anthropic-plain"], tools: [{ name: "__advise" }] });
});

test("issue 686 advisor: malformed advise tools do not authorize a request", () => {
	for (const tool of [
		null,
		"advise",
		{ name: "advise" },
		{ type: "function", function: "advise" },
		{ type: "function", function: { name: 1 } },
		{ type: "function", name: "advise", function: { name: "advise" } },
	]) {
		refused({ ...advisors.chat, tools: [tool] });
	}
	refused({
		...advisors.responses,
		tools: [{ type: "custom", name: "advise" }],
	});
});

test("issue 686 advisor: inline instruction content must have the adapter's string shape", () => {
	for (const name of ["chat", "responses-reasoning", "azure"]) {
		const changed = clone(advisors[name]);
		rows(changed)[0].content = [
			{ type: "text", text: rows(changed)[0].content },
		];
		refused(changed);
	}
});

test("issue 686 advisor: Codex developer blocks must be typed input text", () => {
	for (const content of [
		[],
		[{ type: "text", text: "instructions" }],
		[{ type: "input_text", text: 1 }],
	]) {
		const changed = clone(advisors.codex);
		rows(changed)[0].content = content;
		refused(changed);
	}
	const changed = clone(advisors.codex);
	delete (rows(changed)[0] as Row & { type?: unknown }).type;
	refused(changed);
});
