/**
 * Review witnesses for the Oh My Pi foreign-row allowance (the dispatch check
 * that accepts bounded text-only user rows another extension adds after Magic
 * Context's context pass). Every test here FAILS BY DESIGN against commit
 * b8015d008e52, the allowance as first delivered: each states the behaviour
 * the allowance's rules require, and each must pass once the defect it names
 * is fixed. The findings they belong to
 * are written up in .cortexkit/internal-docs/audits/omp-foreign-rows-review.md.
 */
import { describe, expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

const api = "anthropic-messages";
const model = { api, provider: "test", id: "test" };

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	message?: Record<string, unknown>;
}

/** Same walk as Oh My Pi's SessionManager.getBranch(): leaf to root via parentId. */
function branchOf(entries: readonly Entry[], leaf: string): Entry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: Entry[] = [];
	for (
		let entry = byId.get(leaf);
		entry;
		entry = entry.parentId ? byId.get(entry.parentId) : undefined
	)
		path.unshift(entry);
	return path;
}

/** A chain of message entries in session order. */
function chain(messages: readonly Record<string, unknown>[], prefix = "e") {
	return messages.map(
		(message, index): Entry => ({
			type: "message",
			id: `${prefix}${index}`,
			parentId: index ? `${prefix}${index - 1}` : null,
			message,
		}),
	);
}

const assistant = (timestamp: number, text = "answer") => ({
	role: "assistant",
	api,
	provider: "test",
	model: "test",
	timestamp,
	stopReason: "stop",
	content: [{ type: "text", text }],
});

/**
 * The handler's input is `raw`; Magic Context prints its tags on the user rows.
 * `session` is a complete entry snapshot or the host's getEntries accessor.
 */
function setup(
	raw: Record<string, unknown>[],
	session: unknown,
	wire: Record<string, unknown>[],
	managed = raw.map((message, index) =>
		message.role === "user" && typeof message.content === "string"
			? { ...message, content: `§${index + 1}§ ${message.content}` }
			: message,
	),
) {
	const prepared = piPreparedStructure(managed, model, "omp");
	// Mirror registerPiGuardedContext: evidence is snapshotted before the
	// handler runs and only protected when it could be read.
	const evidence = piForeignEvidence(session, raw);
	if (evidence) piProtectPreparedRows(evidence, managed, prepared);
	const payload = (messages: unknown[]) => ({
		system: [{ type: "text", text: "system" }],
		max_tokens: 100,
		messages,
	});
	return {
		evidence,
		prepared,
		payload,
		base: (rows: unknown[]) =>
			piPreparedStructureMismatch(payload(rows), prepared),
		check: (rows: unknown[]) =>
			piCheckPreparedDispatch(payload(rows), prepared, evidence),
		wire,
	};
}

const user = (text: string) => ({ role: "user", content: text });
const foreign = user(
	"<EXTREMELY_IMPORTANT>\nbootstrap inserted by another extension\n</EXTREMELY_IMPORTANT>",
);

describe("evidence for Oh My Pi message roles without a content field", () => {
	// Oh My Pi's AgentMessage union includes roles whose model text is built by
	// convertToLlm from other fields: bashExecution (command/output),
	// pythonExecution (code/output), fileMention (files[]), compactionSummary and
	// branchSummary (summary). The host supplies the whole branch here, so the
	// allowance must stay on.
	test("a `!cmd` bash execution in the served turn keeps the allowance on", () => {
		const bash = {
			role: "bashExecution",
			command: "ls",
			output: "a.txt",
			cancelled: false,
			truncated: false,
			exitCode: 0,
			timestamp: 2,
		};
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			bash,
			{ role: "user", content: "latest session prompt", timestamp: 3 },
		];
		const f = setup(raw, chain(raw), [
			user("§1§ first session prompt"),
			{
				role: "user",
				content: [{ type: "text", text: "Ran `ls`\n```\na.txt\n```" }],
			},
			user("§3§ latest session prompt"),
		]);
		// Control: the base comparator accepts the managed turn without inserts.
		expect(f.base(f.wire)).toBeUndefined();
		expect(f.check([foreign, ...f.wire]).mismatch).toBeUndefined();
	});

	for (const cut of [
		{
			role: "pythonExecution",
			code: "print(1)",
			output: "1",
			cancelled: false,
			truncated: false,
			timestamp: 0,
		},
		{
			role: "fileMention",
			files: [{ path: "notes.md", content: "notes" }],
			timestamp: 0,
		},
	])
		test(`an earlier ${cut.role} entry that Magic Context cut keeps the allowance on`, () => {
			const raw = [
				{ role: "user", content: "first session prompt", timestamp: 1 },
				assistant(2),
				{ role: "user", content: "latest session prompt", timestamp: 3 },
			];
			const f = setup(raw, chain([cut, ...raw]), [
				user("§1§ first session prompt"),
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				user("§3§ latest session prompt"),
			]);
			expect(f.base(f.wire)).toBeUndefined();
			expect(f.check([foreign, ...f.wire]).mismatch).toBeUndefined();
		});

	test("a native compaction or branch summary in the input does not make a complete branch unreadable", () => {
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			assistant(2),
		];
		for (const summary of [
			{
				role: "compactionSummary",
				summary: "earlier work",
				tokensBefore: 1000,
				timestamp: 0,
			},
			{
				role: "branchSummary",
				summary: "abandoned path",
				fromId: "e0",
				timestamp: 0,
			},
		])
			expect(piForeignEvidence(chain(raw), [summary, ...raw])).toBeDefined();
	});
});

describe("rule 3: session content the evidence does not recognise", () => {
	const raw = [
		{ role: "user", content: "first session prompt", timestamp: 10 },
		assistant(11),
		{ role: "user", content: "latest session prompt", timestamp: 12 },
	];
	const wire = [
		user("§1§ first session prompt"),
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		user("§3§ latest session prompt"),
	];

	test("a prompt from a branch the user rewound away from is session content", () => {
		// Session tree: c0 -> c1 -> old (abandoned), and c1 -> c2 (current leaf).
		const current = chain(raw, "c");
		const abandoned: Entry = {
			type: "message",
			id: "old",
			parentId: "c1",
			message: {
				role: "user",
				content: "rewound prompt with the abandoned plan",
				timestamp: 11.5,
			},
		};
		const entries = [...current, abandoned];
		// Keep the current-leaf branch available as a control, but supply the
		// complete host entry list so the abandoned prompt is also protected.
		const f = setup(
			raw,
			{
				getEntries: () => entries,
				getBranch: () => branchOf(entries, "c2"),
			},
			wire,
		);
		expect(f.base(wire)).toBeUndefined();
		expect(
			f.check([user("rewound prompt with the abandoned plan"), ...wire])
				.mismatch ?? "accepted",
		).toContain("session-content");
	});

	test("assistant reasoning from the session is session content", () => {
		const reasoning = {
			role: "assistant",
			api,
			provider: "test",
			model: "test",
			timestamp: 5,
			stopReason: "stop",
			content: [
				{
					type: "thinking",
					thinking: "private reasoning the session already produced",
					thinkingSignature: "sig",
				},
				{ type: "text", text: "earlier answer" },
			],
		};
		const f = setup(raw, chain([reasoning, ...raw]), wire);
		expect(f.base(wire)).toBeUndefined();
		expect(
			f.check([user("private reasoning the session already produced"), ...wire])
				.mismatch ?? "accepted",
		).toContain("session-content");
	});

	test("tool-call arguments from the session are session content", () => {
		const write = {
			role: "assistant",
			api,
			provider: "test",
			model: "test",
			timestamp: 5,
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "call_write",
					name: "write",
					arguments: {
						path: "plan.md",
						content:
							"file body the agent wrote earlier in this session, retained as a long argument value",
					},
				},
			],
		};
		const f = setup(raw, chain([write, ...raw]), wire);
		expect(f.base(wire)).toBeUndefined();
		expect(
			f.check([
				user(
					"file body the agent wrote earlier in this session, retained as a long argument value",
				),
				...wire,
			]).mismatch ?? "accepted",
		).toContain("session-content");
	});
});

describe("rule 1: host rewrites of a prepared row's text after the context hook", () => {
	// Oh My Pi's final convertToLlm obfuscates configured secrets in outbound
	// text (sdk.ts convertToLlmFinal -> obfuscateMessages), after every
	// extension's context handler. The base comparator does not read user text,
	// so the managed turn is accepted; adding one bounded foreign row must not
	// turn the same managed turn into a refusal.
	test("an obfuscated secret in a prepared user row does not refuse a turn with a foreign insert", () => {
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			assistant(2),
			{
				role: "user",
				content: "deploy with key sk-live-0123456789",
				timestamp: 3,
			},
		];
		const wire = [
			user("§1§ first session prompt"),
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			user("§3§ deploy with key #SECRET_1#"),
		];
		const f = setup(raw, chain(raw), wire);
		expect(f.base(wire)).toBeUndefined();
		expect(f.check([foreign, ...wire]).mismatch).toBeUndefined();
	});

	// The same final conversion replaces image blocks with a text placeholder
	// for a text-only model or when images are blocked (sdk.ts
	// convertToLlmWithBlockImages -> replaceLlmImagesWithText), which turns a
	// prepared text-and-image user row into a text-only row on the wire.
	test("an image a text-only model receives as a placeholder does not refuse a turn with a foreign insert", () => {
		const image = { type: "image", mimeType: "image/png", data: "AAAA" };
		const raw = [
			{ role: "user", content: "first session prompt", timestamp: 1 },
			assistant(2),
			{
				role: "user",
				content: [{ type: "text", text: "see screenshot" }, image],
				timestamp: 3,
			},
		];
		const managed = [
			{ ...raw[0], content: "§1§ first session prompt" },
			raw[1],
			{
				...raw[2],
				content: [{ type: "text", text: "§3§ see screenshot" }, image],
			},
		];
		const wire = [
			user("§1§ first session prompt"),
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "§3§ see screenshot" },
					{
						type: "text",
						text: "[image omitted: the active model does not support image input]",
					},
				],
			},
		];
		const f = setup(raw, chain(raw), wire, managed);
		expect(f.base(wire)).toBeUndefined();
		expect(f.check([foreign, ...wire]).mismatch).toBeUndefined();
	});
});
