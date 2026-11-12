import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piForeignEvidenceStats,
	piMaterializeForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import { piPreparedStructure } from "./pi-dispatch-structure";

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const prompt = { role: "user", content: "prompt", timestamp: 1 };
const managed = [{ ...prompt, content: "§1§ prompt" }];
const prepared = piPreparedStructure(managed, model);
const wire = (text: string) => ({
	system: "system",
	messages: [{ role: "user", content: text }, ...managed],
});

test("a failed complete-session accessor never assumes an empty first-turn branch", () => {
	const source = {
		getEntries: () => {
			throw new Error("session unavailable");
		},
		getBranch: () => [],
	};
	const evidence = piForeignEvidence(source, [prompt]);
	piProtectPreparedRows(evidence, managed, prepared);
	expect(
		piCheckPreparedDispatch(wire("foreign"), prepared, evidence).mismatch,
	).toContain("unreadable-branch");
});

test("argument identity threshold includes 64 characters and excludes 63", () => {
	for (const size of [63, 64]) {
		const body = "x".repeat(size);
		const prior = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "write",
					name: "write",
					arguments: { content: body },
				},
			],
		};
		const entries = [{ type: "message", id: "prior", message: prior }];
		const evidence = piForeignEvidence({ getEntries: () => entries }, [prompt]);
		piProtectPreparedRows(evidence, managed, prepared);
		const result = piCheckPreparedDispatch(wire(body), prepared, evidence);
		if (size === 64)
			expect(result.mismatch).toContain(
				"another extension added a message identical to session content",
			);
		else expect(result.mismatch).toBeUndefined();
	}
});

test("unknown message roles fail closed even when they were cut from the prepared turn", () => {
	const source = {
		getEntries: () => [
			{
				type: "message",
				id: "unknown",
				message: { role: "futureRole", data: "unknown context" },
			},
		],
	};
	const evidence = piForeignEvidence(source, [prompt]);
	piProtectPreparedRows(evidence, managed, prepared);
	expect(
		piCheckPreparedDispatch(wire("foreign"), prepared, evidence).mismatch,
	).toContain("unreadable-branch");
});

test("additional blocks in a kept tagged row remain the existing comparator's decision", () => {
	const source = {
		getEntries: () => [{ type: "message", id: "entry", message: prompt }],
	};
	const evidence = piForeignEvidence(source, [prompt]);
	piProtectPreparedRows(evidence, managed, prepared);
	const changed = {
		role: "user",
		content: [
			{ type: "text", text: "§1§ prompt" },
			{ type: "text", text: "later host text" },
		],
	};
	expect(
		piCheckPreparedDispatch(
			{ system: "system", messages: [changed] },
			prepared,
			evidence,
		).mismatch,
	).toBeUndefined();
	expect(
		piCheckPreparedDispatch(
			{
				system: "system",
				messages: [{ role: "user", content: "foreign" }, changed],
			},
			prepared,
			evidence,
		).mismatch,
	).toBeUndefined();
});

test("an exact generated control is an anchor, never an extra-row deletion candidate", () => {
	const control = { role: "user", content: "generated control", timestamp: 0 };
	const output = [control, ...managed];
	const structure = piPreparedStructure(output, model);
	const evidence = piForeignEvidence({ getEntries: () => [] }, [prompt]);
	piProtectPreparedRows(evidence, output, structure);
	const payload = {
		system: "system",
		messages: [
			control,
			{ role: "user", content: "generated control" },
			...managed,
		],
	};
	expect(
		piCheckPreparedDispatch(payload, structure, evidence).mismatch,
	).toContain("prepared-row");
});

test("entry-body replacement under a stable id is indexed incrementally", () => {
	const entry = {
		type: "message",
		id: "old",
		message: { role: "user", content: "before", timestamp: 0 },
	};
	const source = { getEntries: () => [entry] };
	const index = createPiForeignSessionIndex();
	for (const text of ["before", "after"]) {
		entry.message = { ...entry.message, content: text };
		const evidence = piForeignEvidence(source, [prompt], index);
		piProtectPreparedRows(evidence, managed, prepared);
		expect(
			piCheckPreparedDispatch(wire(text), prepared, evidence).mismatch,
		).toContain("session-content");
	}
});
