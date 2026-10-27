import { expect, test } from "bun:test";
import {
	ANTHROPIC_CONTINUE_PAD_TEXT,
	piModelsAnthropicContinuePad,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Issue 789: Magic Context drops old `todo` calls with their results, leaving
// text-only assistants adjacent. OMP's Anthropic converter repairs adjacent
// assistant params with a neutral `Continue.` user row, which the dispatch
// check must expect exactly where OMP inserts it.

const anthropic = {
	api: "anthropic-messages",
	compat: {},
	input: ["text"],
};

const head = { role: "user", content: "managed history", timestamp: 1 };
const tail = { role: "user", content: "current request", timestamp: 9 };

// Two text-only assistants adjacent in prepared history: this is what remains
// after the `todo` call and its result are dropped from each turn.
function adjacentHistory() {
	return [
		head,
		{
			role: "assistant",
			content: [{ type: "text", text: "Refreshing the todo list." }],
			timestamp: 2,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "Dispatching next." }],
			timestamp: 3,
		},
		tail,
	];
}

function anthropicAssistant(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	};
}

function anthropicUser(text: string) {
	return {
		role: "user",
		content: text,
	};
}

test("issue 789: shared predicate covers only the OMP Anthropic route", () => {
	expect(piModelsAnthropicContinuePad("anthropic-messages", "omp")).toBe(true);
	// Bedrock/Vertex endpoint variants share the anthropic-messages api and
	// converter, so they are covered. Other converters never pad.
	expect(piModelsAnthropicContinuePad("bedrock-converse-stream", "omp")).toBe(
		false,
	);
	expect(piModelsAnthropicContinuePad("google-vertex", "omp")).toBe(false);
	expect(piModelsAnthropicContinuePad("openai-completions", "omp")).toBe(false);
	// Plain Pi never pads, even for the same api.
	expect(piModelsAnthropicContinuePad("anthropic-messages", "pi")).toBe(false);
	expect(piModelsAnthropicContinuePad(undefined, "omp")).toBe(false);
});

test("issue 789: adjacent assistants expect one Continue pad between them", () => {
	const prepared = piPreparedStructure(adjacentHistory(), anthropic);
	expect(prepared?.anthropicContinuePad).toBe(true);
	// Prepared rows gain exactly one user Continue row between the assistants.
	expect(prepared?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
		"user",
	]);
	expect(prepared?.messages[2]?.exactText).toBe(ANTHROPIC_CONTINUE_PAD_TEXT);
	const wire = {
		messages: [
			anthropicUser("managed history"),
			anthropicAssistant("Refreshing the todo list."),
			anthropicUser(ANTHROPIC_CONTINUE_PAD_TEXT),
			anthropicAssistant("Dispatching next."),
			anthropicUser("current request"),
		],
	};
	expect(piPreparedStructureMismatch(wire, prepared)).toBeUndefined();
});

test("issue 789: missing interior pad still refuses", () => {
	const prepared = piPreparedStructure(adjacentHistory(), anthropic);
	const wire = {
		messages: [
			anthropicUser("managed history"),
			anthropicAssistant("Refreshing the todo list."),
			anthropicAssistant("Dispatching next."),
			anthropicUser("current request"),
		],
	};
	// OMP always pads adjacent assistants on this route, so the unpadded wire
	// cannot be a managed dispatch.
	expect(piPreparedStructureMismatch(wire, prepared)).toContain("comparison=");
});

test("issue 789: trailing assistant accepts the single trailing pad", () => {
	const prepared = piPreparedStructure(
		[
			head,
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				timestamp: 2,
			},
		],
		anthropic,
	);
	const base = {
		messages: [
			anthropicUser("managed history"),
			anthropicAssistant("final answer"),
		],
	};
	// Compaction requests end without the pad; live requests append it.
	expect(piPreparedStructureMismatch(base, prepared)).toBeUndefined();
	expect(
		piPreparedStructureMismatch(
			{
				messages: [
					...base.messages,
					anthropicUser(ANTHROPIC_CONTINUE_PAD_TEXT),
				],
			},
			prepared,
		),
	).toBeUndefined();
});

test("issue 789: a Continue row where OMP would not put one still refuses", () => {
	const prepared = piPreparedStructure(
		[
			head,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "one", name: "read", arguments: {} }],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "one",
				toolName: "read",
				content: [{ type: "text", text: "body" }],
				timestamp: 3,
			},
			tail,
		],
		anthropic,
	);
	// No adjacent assistants, so no pad is expected. An extra Continue user row
	// shifts the turn and must refuse.
	const wire = {
		messages: [
			anthropicUser("managed history"),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "one", name: "read", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "one", content: "body" }],
			},
			anthropicUser(ANTHROPIC_CONTINUE_PAD_TEXT),
			anthropicUser("current request"),
		],
	};
	expect(piPreparedStructureMismatch(wire, prepared)).toContain("comparison=");
	// A Continue pad masquerading as the tool-result run also refuses: the
	// prepared turn expects a result run, not a user pad.
	const swapped = {
		messages: [
			anthropicUser("managed history"),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "one", name: "read", input: {} }],
			},
			anthropicUser(ANTHROPIC_CONTINUE_PAD_TEXT),
			anthropicUser("current request"),
		],
	};
	expect(piPreparedStructureMismatch(swapped, prepared)).toContain(
		"comparison=",
	);
});

test("issue 789: Plain Pi never models the pad", () => {
	const prepared = piPreparedStructure(adjacentHistory(), anthropic, "pi");
	expect(prepared?.anthropicContinuePad).toBeUndefined();
	// Adjacent assistants stay adjacent for Pi; no pad row is expected.
	expect(prepared?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"assistant",
		"user",
	]);
});
