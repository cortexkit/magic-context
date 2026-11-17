import { afterEach, expect, test } from "bun:test";
import {
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import captures from "./fixtures/omp-advisor-18.10.4.json";
import captures18190 from "./fixtures/omp-advisor-18.19.0.json";
import captures18203 from "./fixtures/omp-advisor-18.20.3.json";
import captures18220 from "./fixtures/omp-advisor-18.22.0.json";
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

// Issue 940: real-host captures from OMP 18.19.0 (the last release whose stock
// advisor prompt starts with a <conventions> block), 18.20.3 and 18.22.0 (after
// 18.20.2 removed it). Each version has stock and WATCHDOG.yml-customised
// advisors on the chat-completions and Anthropic lanes, sanitised like the
// 18.10.4 fixture. "main" is the session's next main request.
type HostCaptures = {
	version: string;
	advisors: Record<string, Body>;
	main: Body;
	compactedAdvisor?: Body;
	typedHeadingMain?: Body;
};
const hostCaptures = [captures18190, captures18203, captures18220].map(
	(capture) => capture as unknown as HostCaptures,
);
const omp18220 = captures18220 as unknown as HostCaptures;

const ADVISOR_ROLE =
	"User, code-quality, robustness advocate; peer-shadow main agent.\n";
const ADVISOR_WORKFLOW =
	"<workflow>\nReceive incremental agent transcript, including thoughts.\n";
const SESSION_UPDATE = "### Session update\n\n";
const COMPACTION_SUMMARY =
	"Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\n";
// The conventions line of OMP 18.2.6, older than any advisor this rule covers.
const CONVENTIONS_18_2_6 =
	"<conventions>\nRFC 2119: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.\n</conventions>\n\n";

type TextBlock = { type: string; text: string };
const isAdviseTool = (tool: Record<string, unknown>) =>
	["advise", "_advise"].includes(
		String(tool.name ?? (tool.function as { name?: unknown })?.name),
	);

/** The instruction text holding OMP's stock advisor prompt: the leading system row, or an Anthropic system block. */
function stockText(body: Body): string {
	const texts = Array.isArray(body.system)
		? (body.system as TextBlock[]).map((block) => block.text)
		: [rows(body)[0].content as string];
	const matches = texts.filter((text) => text.includes(ADVISOR_ROLE));
	expect(matches).toHaveLength(1);
	return matches[0];
}

/** A copy whose stock advisor prompt text is rewritten. */
function rewriteStock(body: Body, rewrite: (text: string) => string): Body {
	const changed = clone(body);
	if (Array.isArray(changed.system)) {
		for (const block of changed.system as TextBlock[])
			if (block.text.includes(ADVISOR_ROLE)) block.text = rewrite(block.text);
	} else {
		const row = rows(changed)[0];
		row.content = rewrite(row.content as string);
	}
	return changed;
}

/** The stock prompt from its role line on, without any conventions block before it. */
const fromRole = (text: string) => text.slice(text.indexOf(ADVISOR_ROLE));

/** A main request's instructions as one text, the way chat completions send them. */
const mainSystemText = (body: Body) =>
	(body.system as TextBlock[]).map((block) => block.text).join("\n\n");

/** The first user row's review text, after OMP's date reminder. */
function firstReviewText(body: Body): string {
	const content = user(body).content;
	const blocks =
		typeof content === "string"
			? [content]
			: (content as TextBlock[]).map((block) => block.text);
	const first = blocks[0].replace(
		/^<system-reminder>\nToday: [^\n]+\n<\/system-reminder>(?:\n|$)/,
		"",
	);
	return first === "" ? blocks[1] : first;
}

function accepted(body: Body, next: Body) {
	const before = JSON.stringify(body);
	expect(isOmpAdvisorRequest(body)).toBe(true);
	const h = fence();
	h.dispatch(body);
	expect(h.refusals).toEqual([]);
	expect(h.stops).toBe(0);
	expect(JSON.stringify(body)).toBe(before);
	// Letting an advisor review through must not authorize the next ordinary
	// conversation: it still needs its own completed context-preparation pass.
	h.dispatch(next);
	expect(h.stops).toBe(1);
	expect(h.refusals[0]).toContain("no context pass ran for this operation");
}

for (const capture of hostCaptures) {
	for (const [name, body] of Object.entries(capture.advisors)) {
		const label = `OMP ${capture.version} ${name}`;

		test(`issue 940 advisor: accepts captured ${label}`, () => {
			expect(firstReviewText(body).startsWith(SESSION_UPDATE)).toBe(true);
			accepted(body, capture.main);
		});

		test(`issue 940 advisor: ${label} still requires advise`, () => {
			expect(isOmpAdvisorRequest(body)).toBe(true);
			expect(body.tools.some(isAdviseTool)).toBe(true);
			refused({
				...body,
				tools: body.tools.filter((tool) => !isAdviseTool(tool)),
			});
		});

		test(`issue 940 advisor: ${label} still requires a session update first`, () => {
			expect(isOmpAdvisorRequest(body)).toBe(true);
			const ordinary = clone(body);
			user(ordinary).content = "An ordinary user turn";
			refused(ordinary);
		});

		test(`issue 940 advisor: ${label} is recognised with or without the conventions block`, () => {
			expect(isOmpAdvisorRequest(rewriteStock(body, fromRole))).toBe(true);
		});

		for (const [rule, rewrite] of [
			[
				"a changed role line",
				(text: string) =>
					text.replace(ADVISOR_ROLE, "Ordinary main-lane instructions.\n"),
			],
			[
				"no workflow line",
				(text: string) => text.replace(ADVISOR_WORKFLOW, ""),
			],
			[
				"OMP 18.2.6's conventions line",
				(text: string) => CONVENTIONS_18_2_6 + fromRole(text),
			],
			[
				"another conventions block",
				(text: string) =>
					`<conventions>x</conventions>\n\n${fromRole(text)}`,
			],
			[
				"the stock prompt later in the instruction block",
				(text: string) => `Ordinary main-lane instructions\n\n${text}`,
			],
		] as const) {
			test(`issue 940 advisor: ${label} with ${rule} stays checked`, () => {
				expect(isOmpAdvisorRequest(body)).toBe(true);
				const changed = rewriteStock(body, rewrite);
				expect(JSON.stringify(changed)).not.toBe(JSON.stringify(body));
				refused(changed);
			});
		}

		test(`issue 940 advisor: ${label} cannot borrow the stock prompt from a user row`, () => {
			expect(isOmpAdvisorRequest(body)).toBe(true);
			const stock = stockText(body);
			const changed = clone(body);
			if (Array.isArray(changed.system)) changed.system = capture.main.system;
			else rows(changed)[0].content = mainSystemText(capture.main);
			const messages = rows(changed);
			const firstUser = messages.findIndex((row) => row.role === "user");
			messages.splice(firstUser + 1, 0, { role: "user", content: stock });
			refused(changed);
		});
	}
}

test("issue 940 advisor: OMP 18.22.0 custom chat advisor without the conventions block is admitted", () => {
	// The reported case: a WATCHDOG.yml advisor with its own instructions and
	// tools [read, grep, glob] on the openai-completions lane. OMP 18.20.2
	// dropped the conventions block, appends the instructions after the stock
	// prompt, and always adds advise to the tool list.
	const body = omp18220.advisors["chat-custom"];
	const system = rows(body)[0];
	expect(system.role).toBe("system");
	const text = system.content as string;
	expect(text.startsWith(ADVISOR_ROLE)).toBe(true);
	expect(text.includes("<conventions>")).toBe(false);
	expect(
		text.endsWith(
			"\n\nYou are the RevEng reviewer. Check every claim the agent makes against the files before agreeing.",
		),
	).toBe(true);
	expect(
		body.tools.map((tool) => (tool.function as { name: string }).name),
	).toEqual(["advise", "read", "glob", "grep"]);
	accepted(body, omp18220.main);
});

test("issue 940 advisor: a typed Session update heading leaves the raw main request checked", () => {
	// A session whose first typed prompt starts with OMP's advisor heading,
	// captured from a real 18.22.0 host without Magic Context: the raw request
	// the dispatch fence exists to stop.
	const raw = omp18220.typedHeadingMain;
	if (!raw) throw new Error("18.22.0 capture has no typed-heading request");
	expect(rows(raw)).toHaveLength(1);
	expect(firstReviewText(raw).startsWith(SESSION_UPDATE)).toBe(true);
	refused(raw);
	refused({ ...raw, tools: [...raw.tools, { name: "advise" }] });
	refused({ ...raw, tools: [...raw.tools, { name: "_advise" }] });
});

for (const capture of hostCaptures) {
	const compacted = capture.compactedAdvisor;
	if (!compacted) continue;
	const label = `OMP ${capture.version}`;

	test(`issue 940 advisor: accepts the ${label} advisor after OMP compacted its own context`, () => {
		expect(firstReviewText(compacted).startsWith(COMPACTION_SUMMARY)).toBe(
			true,
		);
		accepted(compacted, capture.main);
	});

	test(`issue 940 advisor: the compacted ${label} advisor still requires a summary or session update first`, () => {
		expect(isOmpAdvisorRequest(compacted)).toBe(true);
		const ordinary = clone(compacted);
		const content = user(ordinary).content as TextBlock[];
		content[1].text = "An ordinary user turn";
		refused(ordinary);
	});

	test(`issue 940 advisor: a raw ${label} main request after OMP compaction stays checked`, () => {
		// After OMP compacts a main session, its raw request starts with the
		// same summary row, under the main prompt instead of the advisor's.
		expect(isOmpAdvisorRequest(compacted)).toBe(true);
		const main = clone(compacted);
		rows(main)[0].content = mainSystemText(capture.main);
		refused(main);
	});
}
