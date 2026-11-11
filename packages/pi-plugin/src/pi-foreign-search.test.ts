import { expect, test } from "bun:test";
import { IssuePrivacy } from "../../cli/src/lib/issue-privacy";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import { logPiDispatchMismatch } from "./pi-dispatch-diagnostic";
import {
	piForeignEvidence,
	piProtectPreparedRows,
	piWithoutForeignRows,
} from "./pi-dispatch-foreign";
import {
	type PiDispatchAlignedRow,
	piDispatchRowCount,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

for (const hint of [3, undefined, Number.NaN]) {
	test(`surplus counting reuses only an exact safe comparator hint: ${String(hint)}`, () => {
		const { prepared, evidence } = fixture();
		const wire = {
			messages: [
				user("foreign"),
				user("prepared head"),
				user("§1§ session prompt"),
			],
		};
		let fullReads = 0;
		const result = piWithoutForeignRows(
			wire,
			evidence,
			(payload: any) => {
				if (payload.messages.length === wire.messages.length) fullReads++;
				return piDispatchRowCount(payload, prepared);
			},
			(payload) => {
				let alignment: readonly PiDispatchAlignedRow[] | undefined;
				return piPreparedStructureMismatch(
					payload,
					prepared,
					undefined,
					(rows) => {
						alignment = rows;
					},
				)
					? undefined
					: alignment;
			},
			hint,
		);
		expect(result.reason).toBeUndefined();
		expect(result.payload).toBeDefined();
		expect(fullReads).toBe(hint === 3 ? 0 : 1);
	});
}

const model = { api: "anthropic-messages", provider: "test", id: "test" };
const user = (content: string) => ({ role: "user", content });
const raw = [user("session prompt")];
function fixture(
	messages: readonly unknown[] = [
		user("prepared head"),
		user("§1§ session prompt"),
	],
) {
	const prepared = piPreparedStructure(messages, model, "omp");
	const evidence = piForeignEvidence(
		{
			getEntries: () =>
				raw.map((message, index) => ({
					type: "message",
					id: `e${index}`,
					message,
				})),
		},
		raw,
	);
	piProtectPreparedRows(evidence, messages, prepared);
	return { prepared, evidence };
}

for (const [count, expectedRuns] of [
	[0, 1],
	[1, 2],
	[5, 1],
	[30, 1],
]) {
	test(`a dispatch with ${count} added rows performs ${expectedRuns} total comparator runs`, () => {
		const { prepared, evidence } = fixture();
		const added = Array.from({ length: count }, (_, i) => user(`foreign ${i}`));
		let runs = 0;
		const result = piCheckPreparedDispatch(
			{
				messages: [...added, user("prepared head"), user("§1§ session prompt")],
			},
			prepared,
			evidence,
			undefined,
			() => runs++,
		);
		expect(runs).toBe(expectedRuns);
		if (count > 4) {
			expect(result.mismatch).toContain("foreign rule=4 reason=limit");
			expect(result.mismatch).toContain(
				`expectedRows=2 actualRows=${count + 2}`,
			);
		} else expect(result.mismatch).toBeUndefined();
	});
}

test("a normalized surplus refusal performs zero reconciliation runs", () => {
	const { prepared, evidence } = fixture();
	let runs = 0;
	const result = piWithoutForeignRows(
		{
			messages: [
				...Array.from({ length: 30 }, (_, i) => user(`foreign ${i}`)),
				user("prepared head"),
				user("§1§ session prompt"),
			],
		},
		evidence,
		(payload) => piDispatchRowCount(payload, prepared),
		() => {
			runs++;
			return undefined;
		},
	);
	expect(result.reason).toBe("limit");
	expect(runs).toBe(0);
});

test("a no-fit request within the surplus bound stops at 64 comparator runs with a content-free search-limit", () => {
	const controls = Array.from({ length: 8 }, (_, i) =>
		user(`prepared control ${i}`),
	);
	const messages = [
		...controls,
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		user("§1§ session prompt"),
	];
	const { prepared, evidence } = fixture(messages);
	const wire = {
		messages: [
			...controls.map((_, i) => user(`SECRET_REWRITTEN_${i}`)),
			user("wrong role, not the prepared assistant"),
			user("§1§ session prompt"),
			...Array.from({ length: 4 }, (_, i) => user(`SECRET_FOREIGN_${i}`)),
		],
	};
	let runs = 0;
	const result = piCheckPreparedDispatch(
		wire,
		prepared,
		evidence,
		undefined,
		() => runs++,
	);
	expect(runs).toBe(64);
	expect(result.mismatch).toContain(
		"foreign rule=4 reason=search-limit count=13",
	);
	expect(result.mismatch).toContain("expectedRows=10 actualRows=14");
	const logs: string[] = [];
	logPiDispatchMismatch(wire, prepared, result.mismatch!, (line) =>
		logs.push(line),
	);
	expect(logs).toHaveLength(1);
	expect(logs[0]).toContain("foreignReason=search-limit foreignCount=13");
	expect(logs[0]).not.toContain("SECRET_");
	expect(
		new IssuePrivacy({}).logLine(`[2026-11-10T20:00:00.000Z] ${logs[0]}`),
	).toContain("foreignReason=search-limit foreignCount=13");
});

test("prepared whole text, tags and an insertion inside a tool pair are excluded before reconciliation", () => {
	const messages = [
		user("prepared head"),
		user("§1§ session prompt"),
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "call1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
		},
		user("§4§ next"),
	];
	const { prepared, evidence } = fixture(messages);
	const wire = {
		messages: [
			user("prepared head"),
			user("§1§ session prompt"),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call1", name: "read", input: {} }],
			},
			user("foreign inside the pair"),
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call1", content: "result" },
				],
			},
			user("§4§ next"),
		],
	};
	let runs = 0;
	const result = piWithoutForeignRows(
		wire,
		evidence,
		(payload) => piDispatchRowCount(payload, prepared),
		() => {
			runs++;
			return undefined;
		},
	);
	expect(result.reason).toBe("tool-pair");
	expect(runs).toBe(0);
});
