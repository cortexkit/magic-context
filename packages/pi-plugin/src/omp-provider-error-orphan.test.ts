import { expect, test } from "bun:test";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
	preparePiDispatch,
} from "./pi-dispatch-structure";

const model = {
	api: "openai-completions",
	provider: "mock",
	id: "mock",
};
const header = {
	role: "user",
	content: "<session-history>managed</session-history>",
	timestamp: 1,
};
const tail = { role: "user", content: "next", timestamp: 4 };
const originalText =
	"§2§ Tool call was not executed because the provider stream ended with an error before the tool could run: 500 upstream fault";
const replayText =
	"Tool call was not executed because the provider stream ended with an error before the tool could run.";
const orphan = {
	role: "toolResult",
	toolCallId: "call_orphan",
	toolName: "write",
	content: [{ type: "text", text: originalText }],
	details: {
		__synthetic: true,
		source: "assistant_stop_error",
		executed: false,
		upstreamError: "500 upstream fault",
	},
	isError: true,
	timestamp: 3,
};
const note = (text: string, toolCallId = "call_orphan") => ({
	role: "user",
	content: `<stale-tool-result tool="write" id="${toolCallId}" is-error="true">\n${text}\n</stale-tool-result>`,
});
const wire = (messages: unknown[]) => ({ messages });

test("provider-error orphan accepts both OMP replay bodies", () => {
	const messages = [header, orphan, tail];
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, model, true);
	expect(prepared.messages).toBe(messages);
	expect(JSON.stringify(messages)).toBe(before);
	expect(
		piMatchesPreparedStructure(
			wire([header, note(originalText), tail]),
			prepared.structure,
		),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			wire([header, note(replayText), tail]),
			prepared.structure,
		),
	).toBe(true);
});

test("provider-error orphan still binds the complete note text", () => {
	const prepared = piPreparedStructure([header, orphan, tail], model);
	for (const text of [
		replayText.replace("before the tool could run", "after the tool ran"),
		`${replayText}\nuser-controlled suffix`,
	]) {
		expect(
			piMatchesPreparedStructure(wire([header, note(text), tail]), prepared),
		).toBe(false);
	}
});

test("canonical replay body requires OMP's structured synthetic-error evidence", () => {
	for (const details of [
		undefined,
		{ __synthetic: true, source: "assistant_stop_aborted", executed: false },
		{ __synthetic: false, source: "assistant_stop_error", executed: false },
	]) {
		const result = { ...orphan, details };
		const prepared = piPreparedStructure([header, result, tail], model);
		expect(
			piMatchesPreparedStructure(
				wire([header, note(replayText), tail]),
				prepared,
			),
		).toBe(false);
	}
});

test("an orphan-only replay alternative cannot admit a foreign user row", () => {
	const prepared = piPreparedStructure([header, tail], model);
	expect(
		piMatchesPreparedStructure(
			wire([header, note(replayText), tail]),
			prepared,
		),
	).toBe(false);
});

test("a fresh retry pass models its new orphan without admitting it to the old pass", () => {
	const oldPrepared = piPreparedStructure([header, orphan, tail], model);
	expect(
		piMatchesPreparedStructure(
			wire([header, note(replayText, "call_new_orphan"), tail]),
			oldPrepared,
		),
	).toBe(false);

	const nextOrphan = {
		...orphan,
		toolCallId: "call_new_orphan",
		content: [
			{
				type: "text",
				text: "§3§ Tool call was not executed because the provider stream ended with an error before the tool could run: a different upstream failure",
			},
		],
		timestamp: 5,
	};
	const nextPrepared = piPreparedStructure(
		[header, orphan, nextOrphan, tail],
		model,
	);
	expect(
		piMatchesPreparedStructure(
			wire([
				header,
				note(replayText),
				note(replayText, "call_new_orphan"),
				tail,
			]),
			nextPrepared,
		),
	).toBe(true);
});

test("paired synthetic results retain byte-identical prepared messages", () => {
	const assistant = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: orphan.toolCallId,
				name: orphan.toolName,
				arguments: {},
			},
		],
		stopReason: "error",
		timestamp: 2,
	};
	const messages = [header, assistant, orphan, tail];
	const before = JSON.stringify(messages);
	const prepared = preparePiDispatch(messages, model, true);
	expect(prepared.messages).toBe(messages);
	expect(JSON.stringify(prepared.messages)).toBe(before);
	expect(prepared.structure?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"user",
	]);
	for (const rows of [
		prepared.structure?.messages,
		prepared.structure?.chatMessages,
	]) {
		expect(
			rows?.every(
				(row) =>
					row.exactText === undefined &&
					row.exactTextAlternatives === undefined,
			),
		).toBe(true);
	}
});
