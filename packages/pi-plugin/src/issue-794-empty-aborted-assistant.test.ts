import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { piAnthropicAssistantReplay } from "./pi-dispatch-assistant-history";
import {
	ANTHROPIC_CONTINUE_PAD_TEXT,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Issue 794: after a refused turn, Oh My Pi persists an aborted assistant
// whose content is one empty text block. OMP's Anthropic converter skips the
// blank text and then the whole message, so the wire has one row fewer than
// the dispatch check expected and every later pass refused. These tests
// rebuild the two session shapes reported in the issue (one and two such
// turns) and encode them with the real 18.13.0 converter.

const require = createRequire(import.meta.url);

type Converter = (
	messages: unknown[],
	model: unknown,
	isOAuthToken: boolean,
	opts?: Record<string, unknown>,
) => { role: string; content: unknown }[];

const root = require.resolve("omp-pi-ai-1813/package.json").slice(0, -12);
const { convertAnthropicMessages: convert } = (await import(
	`${root}src/providers/anthropic.ts`
)) as { convertAnthropicMessages: Converter };

const model = {
	api: "anthropic-messages",
	id: "claude-sonnet-4-5",
	provider: "anthropic",
	input: ["text"],
	compat: {},
};

type Msg = Record<string, unknown>;

let clock = 0;
const user = (text: string): Msg => ({
	role: "user",
	content: text,
	timestamp: ++clock,
});
const answer = (text: string): Msg => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "stop",
	timestamp: ++clock,
});
// What the host persists for a turn Magic Context refused and aborted.
const abortedEmptyText = (): Msg => ({
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "aborted",
	timestamp: ++clock,
});
// The abort of a refused retry: no blocks at all, omitted by both sides.
const abortedEmpty = (): Msg => ({
	...abortedEmptyText(),
	content: [],
});

// Rows the check expected before the fix: every message except the empty
// aborted retries, which the host's replay pass already omitted.
function rowsBeforeFix(messages: readonly Msg[]): number {
	return messages.filter(
		(message) =>
			!(
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.length === 0
			),
	).length;
}

function check(messages: Msg[]) {
	const prepared = piPreparedStructure(structuredClone(messages), model);
	const wire = convert(structuredClone(messages), model, false, {});
	return {
		prepared,
		wire,
		mismatch: piPreparedStructureMismatch({ messages: wire }, prepared),
	};
}

// The issue's passes: the refused retries persist `content: []`, and each
// new message adds one row on both sides, so the gap stayed constant.
function session(emptyTextTurns: number, passes: number) {
	const history: Msg[] = [user("start"), answer("ready")];
	for (let turn = 0; turn < emptyTextTurns; turn++)
		history.push(user(`refused ${turn}`), abortedEmptyText());
	const counts: { expected: number; actual: number; prepared: number }[] = [];
	for (let pass = 0; pass < passes; pass++) {
		if (pass > 0) history.push(abortedEmpty());
		history.push(user(`retry ${pass}`));
		const { prepared, wire, mismatch } = check(history);
		expect(mismatch).toBeUndefined();
		counts.push({
			expected: rowsBeforeFix(history),
			actual: wire.length,
			prepared: prepared?.messages.length ?? -1,
		});
	}
	return counts;
}

test("issue 794: session 1, two empty-text aborted turns, is admitted", () => {
	// Issue table: refusals 7/5, 8/6, 9/7 (expected / actual rows).
	expect(session(2, 3)).toEqual([
		{ expected: 7, actual: 5, prepared: 5 },
		{ expected: 8, actual: 6, prepared: 6 },
		{ expected: 9, actual: 7, prepared: 7 },
	]);
});

test("issue 794: session 2, one empty-text aborted turn, is admitted", () => {
	// Issue table: refusals 5/4, 6/5, 7/6, 8/7.
	expect(session(1, 4)).toEqual([
		{ expected: 5, actual: 4, prepared: 4 },
		{ expected: 6, actual: 5, prepared: 5 },
		{ expected: 7, actual: 6, prepared: 6 },
		{ expected: 8, actual: 7, prepared: 7 },
	]);
});

test("issue 794: the dropped turn leaves its neighbours as OMP sends them", () => {
	clock = 0;
	// Two users become adjacent and stay two rows.
	const users = check([user("one"), abortedEmptyText(), user("two")]);
	expect(users.wire.map((row) => row.role)).toEqual(["user", "user"]);
	expect(users.mismatch).toBeUndefined();
	// Two assistants become adjacent and OMP puts its Continue pad between.
	const assistants = check([
		user("one"),
		answer("first"),
		{ ...abortedEmptyText(), content: [{ type: "text", text: " \n\t" }] },
		answer("second"),
		user("two"),
	]);
	expect(assistants.wire.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
		"user",
	]);
	expect(assistants.wire[2]?.content).toBe(ANTHROPIC_CONTINUE_PAD_TEXT);
	expect(assistants.mismatch).toBeUndefined();
});

test("issue 794: a wire that still sends the empty turn refuses", () => {
	clock = 0;
	const messages = [user("one"), answer("ok"), abortedEmptyText(), user("two")];
	const prepared = piPreparedStructure(messages, model);
	const wire = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "user", content: ANTHROPIC_CONTINUE_PAD_TEXT },
		{ role: "assistant", content: [{ type: "text", text: "late" }] },
		{ role: "user", content: "two" },
	];
	expect(piPreparedStructureMismatch({ messages: wire }, prepared)).toContain(
		"comparison=",
	);
});

test("issue 794: a wire missing an always-sent assistant still refuses", () => {
	clock = 0;
	const messages = [
		user("one"),
		answer("kept"),
		abortedEmptyText(),
		user("two"),
		{
			...answer(""),
			content: [
				{ type: "text", text: "" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "body" }],
			timestamp: ++clock,
		},
		user("three"),
	];
	const { prepared, wire, mismatch } = check(messages);
	expect(mismatch).toBeUndefined();
	// Remove the text assistant, then the tool-call assistant.
	for (const index of [1, 3]) {
		const missing = wire.filter((_, at) => at !== index);
		expect(
			piPreparedStructureMismatch({ messages: missing }, prepared),
		).toContain("comparison=");
	}
	// An extra assistant row also refuses.
	const extra = [
		...wire.slice(0, 2),
		{ role: "user", content: ANTHROPIC_CONTINUE_PAD_TEXT },
		{ role: "assistant", content: [{ type: "text", text: "extra" }] },
		...wire.slice(2),
	];
	expect(piPreparedStructureMismatch({ messages: extra }, prepared)).toContain(
		"comparison=",
	);
});

const thinkingOnly = (signature: string, text: string): Msg => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: text, thinkingSignature: signature },
		{ type: "text", text: "" },
	],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "aborted",
	timestamp: ++clock,
});

test("issue 794: a thinking-only turn is admitted with and without its thinking", () => {
	clock = 0;
	const messages = [
		user("one"),
		answer("first"),
		user("two"),
		thinkingOnly("sig-a", "plan <a>"),
		user("three"),
	];
	const prepared = piPreparedStructure(structuredClone(messages), model);
	expect(prepared?.anthropicOptional).toBeDefined();
	const kept = convert(structuredClone(messages), model, false, {});
	const dropped = convert(structuredClone(messages), model, false, {
		dropAllThinking: true,
	});
	expect(kept.length).toBe(5);
	expect(dropped.length).toBe(4);
	expect(
		piPreparedStructureMismatch({ messages: kept }, prepared),
	).toBeUndefined();
	expect(
		piPreparedStructureMismatch({ messages: dropped }, prepared),
	).toBeUndefined();
	// The sent row must carry this turn's signature, not another one.
	const forged = structuredClone(kept);
	forged[3] = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "plan <a>", signature: "sig-b" }],
	};
	expect(piPreparedStructureMismatch({ messages: forged }, prepared)).toContain(
		"comparison=",
	);
	// Nor can it be plain text that is not this turn's thinking.
	forged[3] = {
		role: "assistant",
		content: [{ type: "text", text: "unrelated reply" }],
	};
	expect(piPreparedStructureMismatch({ messages: forged }, prepared)).toContain(
		"comparison=",
	);
});

test("issue 794: two readings of one optional turn refuse", () => {
	clock = 0;
	// Two adjacent thinking-only turns with the same unsigned thinking: a wire
	// with one of them fits either, so the check cannot tell which was sent.
	const twin = (): Msg => ({
		...thinkingOnly("", "same plan"),
		stopReason: "stop",
	});
	const messages = [user("one"), twin(), twin(), user("two")];
	const prepared = piPreparedStructure(structuredClone(messages), model);
	const wire = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: [{ type: "text", text: "same plan" }] },
		{ role: "user", content: "two" },
	];
	expect(piPreparedStructureMismatch({ messages: wire }, prepared)).toContain(
		"comparison=alignment",
	);
});

test("foreign reasoning remains required as demoted text or native thinking", () => {
	for (const replayUnsignedThinking of [false, true]) {
		for (const signature of ["", "foreign-signature"]) {
			const target = { ...model, compat: { replayUnsignedThinking } };
			const messages = [
				user("before"),
				{
					...thinkingOnly(signature, "foreign reasoning must survive"),
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
				},
				user("after"),
			];
			const prepared = piPreparedStructure(messages, target);
			const wire = convert(structuredClone(messages), target, false, {});
			expect(wire[1].role).toBe("assistant");
			expect(wire[1].content).toEqual([
				replayUnsignedThinking
					? {
							type: "thinking",
							thinking: "foreign reasoning must survive",
							signature: "",
						}
					: { type: "text", text: "foreign reasoning must survive" },
			]);
			expect(
				piPreparedStructureMismatch({ messages: wire }, prepared),
			).toBeUndefined();
			expect(
				piPreparedStructureMismatch(
					{ messages: wire.filter((_, index) => index !== 1) },
					prepared,
				),
			).toContain("comparison=");
			const dropped = convert(structuredClone(messages), target, false, {
				dropAllThinking: true,
			});
			// Preparation cannot see the effective per-attempt replay override.
			// Refuse omitted foreign reasoning even when native replay permits
			// the converter to drop it, rather than guess it was not required text.
			expect(
				piPreparedStructureMismatch({ messages: dropped }, prepared) !==
					undefined,
			).toBe(replayUnsignedThinking);
		}
	}
});

test("foreign blank signatures and foreign redacted thinking do not survive API conversion", () => {
	for (const content of [
		[{ type: "thinking", thinking: " ", thinkingSignature: "foreign-sig" }],
		[{ type: "redactedThinking", data: "foreign-opaque" }],
	]) {
		const messages = [
			user("before"),
			{
				...answer(""),
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				content,
			},
			user("after"),
		];
		const wire = convert(structuredClone(messages), model, false, {});
		expect(wire.map((row) => row.role)).toEqual(["user", "user"]);
		expect(
			piPreparedStructureMismatch(
				{ messages: wire },
				piPreparedStructure(messages, model),
			),
		).toBeUndefined();
	}
});

test("only same-provider Anthropic thinking can make an assistant optional", () => {
	for (const content of [
		[{ type: "thinking", thinking: "foreign", thinkingSignature: "sig" }],
		[{ type: "redactedThinking", data: "opaque" }],
	]) {
		expect(
			piAnthropicAssistantReplay(
				{ ...answer(""), content, provider: "other-provider" },
				model,
				"omp",
			),
		).toBe("kept");
		expect(
			piAnthropicAssistantReplay(
				{ ...answer(""), content, model: "another-anthropic-model" },
				model,
				"omp",
			),
		).toBe("optional");
	}
	for (const api of ["openai-completions", "openai-responses", "custom-api"]) {
		expect(
			piAnthropicAssistantReplay(abortedEmptyText(), { ...model, api }, "omp"),
		).toBe("kept");
	}
});

test("issue 794: Plain Pi drops a whitespace-only finished assistant", () => {
	clock = 0;
	const blank = { ...answer(" "), stopReason: "stop" };
	expect(piAnthropicAssistantReplay(blank, model, "pi")).toBe("dropped");
	// Pi's replay pass already omits every errored or aborted turn, so only a
	// finished blank turn reaches this rule. Pi 0.87.1 sends foreign nonblank
	// thinking as text and 1.3.0 drops it, so the classifier keeps that row.
	expect(
		piAnthropicAssistantReplay(
			{
				...blank,
				model: "other",
				content: [{ type: "thinking", thinking: "foreign" }],
			},
			model,
			"pi",
		),
	).toBe("kept");
	const prepared = piPreparedStructure(
		[user("one"), blank, user("two")],
		model,
		"pi",
	);
	expect(prepared?.messages.map((row) => row.role)).toEqual(["user", "user"]);
	// The classifier models only the Anthropic converter and keeps every
	// assistant on other APIs.
	expect(
		piAnthropicAssistantReplay(
			abortedEmptyText(),
			{ api: "openai-responses" },
			"omp",
		),
	).toBe("kept");
});
