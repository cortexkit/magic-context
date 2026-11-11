import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	PI_FOREIGN_MAX_CHARS,
	PI_FOREIGN_MAX_ROWS,
	piForeignEvidence,
	piMaterializeForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

const apis = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"ollama-chat",
	"openrouter",
	"factory-droid-agent",
	"devin-agent",
];

function fixture(
	api: string,
	host: "omp" | "pi" = "omp",
	branchAvailable = true,
) {
	const raw = [
		{ role: "user", content: "first session prompt", timestamp: 1 },
		{
			role: "assistant",
			api,
			provider: "test",
			model: "test",
			timestamp: 2,
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "call_foreign", name: "read", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_foreign",
			toolName: "read",
			content: [{ type: "text", text: "tool result" }],
			timestamp: 3,
		},
		{ role: "user", content: "latest session prompt", timestamp: 4 },
	];
	const managed = structuredClone(raw);
	managed[0].content = "§1§ first session prompt";
	managed[3].content = "§3§ latest session prompt";
	const prepared = piPreparedStructure(
		managed,
		{ api, provider: "test", id: "test" },
		host,
	);
	const branch = branchAvailable
		? [
				{
					type: "message",
					id: "cut-entry",
					message: {
						role: "user",
						content: "cut or summarized session prompt",
						timestamp: 0,
					},
				},
				...raw.map((message, i) => ({
					type: "message",
					id: `entry-${i}`,
					message,
				})),
			]
		: undefined;
	const evidence = piForeignEvidence(branch, raw)!;
	piProtectPreparedRows(evidence, managed, prepared);
	const responses = api.endsWith("responses");
	const google = api.startsWith("google-");
	const bedrock = api === "bedrock-converse-stream";
	const anthropic =
		api === "anthropic-messages" || api === "factory-droid-agent";
	const user = (text: string): Record<string, unknown> =>
		google
			? { role: "user", parts: [{ text }] }
			: bedrock
				? { role: "user", content: [{ text }] }
				: responses
					? { role: "user", content: [{ type: "input_text", text }] }
					: { role: "user", content: text };
	let rows: Record<string, unknown>[];
	if (google)
		rows = [
			user(String(managed[0].content)),
			{ role: "model", parts: [{ functionCall: { name: "read", args: {} } }] },
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "read",
							response: { result: "tool result" },
						},
					},
				],
			},
			user(String(managed[3].content)),
		];
	else if (responses)
		rows = [
			user(String(managed[0].content)),
			{
				type: "function_call",
				call_id: "call_foreign",
				name: "read",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_foreign",
				output: "tool result",
			},
			user(String(managed[3].content)),
		];
	else if (bedrock)
		rows = [
			user(String(managed[0].content)),
			{
				role: "assistant",
				content: [
					{ toolUse: { toolUseId: "call_foreign", name: "read", input: {} } },
				],
			},
			{
				role: "user",
				content: [
					{
						toolResult: {
							toolUseId: "call_foreign",
							content: [{ text: "tool result" }],
						},
					},
				],
			},
			user(String(managed[3].content)),
		];
	else if (anthropic)
		rows = [
			user(String(managed[0].content)),
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call_foreign", name: "read", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_foreign",
						content: "tool result",
					},
				],
			},
			user(String(managed[3].content)),
		];
	else if (api === "ollama-chat")
		rows = [
			user(String(managed[0].content)),
			{
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "read", arguments: {} } }],
			},
			{ role: "tool", tool_name: "read", content: "tool result" },
			user(String(managed[3].content)),
		];
	else
		rows = [
			user(String(managed[0].content)),
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "call_foreign",
						type: "function",
						function: { name: "read", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_foreign", content: "tool result" },
			user(String(managed[3].content)),
		];
	const payload = (messages: unknown[]) =>
		google
			? api === "google-gemini-cli"
				? { request: { contents: messages } }
				: { contents: messages }
			: responses
				? { input: messages }
				: {
						messages,
						...(bedrock
							? { inferenceConfig: {} }
							: anthropic
								? {
										system: [{ type: "text", text: "system" }],
										max_tokens: 100,
									}
								: {}),
					};
	return {
		raw,
		managed,
		prepared,
		evidence,
		user,
		rows,
		payload,
		check: (rows: unknown[]) =>
			piCheckPreparedDispatch(payload(rows), prepared, evidence),
	};
}

for (const api of apis)
	for (const host of ["omp", "pi"] as const) {
		test(`${host} ${api}: whole foreign text user rows may precede, follow, or separate prepared turns`, () => {
			const f = fixture(api, host);
			expect(
				piPreparedStructureMismatch(f.payload(f.rows), f.prepared),
			).toBeUndefined();
			const before = JSON.stringify(f.prepared);
			for (const at of [0, 1, 4]) {
				const rows = [...f.rows];
				rows.splice(at, 0, f.user("Foreign bootstrap, not session history."));
				expect(
					piPreparedStructureMismatch(f.payload(rows), f.prepared),
				).toBeDefined();
				const result = f.check(rows);
				expect(result.mismatch).toBeUndefined();
				expect(result.foreign?.count).toBe(1);
				expect(result.foreign?.before).toEqual([at]);
			}
			expect(JSON.stringify(f.prepared)).toBe(before);
			expect(f.managed[0].content).toBe("§1§ first session prompt");
			expect(f.managed[3].content).toBe("§3§ latest session prompt");
			for (const separator of ["\n", "\n\n"]) {
				const datedFirst = f.user(
					"<system-reminder>\nToday: 2026-11-10; current working directory: '/project'. Do not repeat this information in your reply.\n</system-reminder>" +
						separator +
						String(f.managed[0].content),
				);
				for (const at of [1, 4]) {
					const dated = [datedFirst, ...f.rows.slice(1)];
					dated.splice(at, 0, f.user("foreign"));
					expect(f.check(dated).mismatch).toBeUndefined();
				}
			}
			if (api === "bedrock-converse-stream") {
				const cached = {
					role: "user",
					content: [
						{ text: "foreign" },
						{ cachePoint: { type: "default", ttl: "1h" } },
					],
				};
				expect(f.check([...f.rows, cached]).mismatch).toBeUndefined();
				const badCache = {
					role: "user",
					content: [
						{ text: "foreign" },
						{
							cachePoint: {
								type: "default",
								privateText: "not cache metadata",
							},
						},
					],
				};
				expect(f.check([...f.rows, badCache]).mismatch).toBeDefined();
			}
			const steering =
				"<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\n";
			const steeredRows = [
				...f.rows.slice(0, -1),
				f.user(steering + String(f.managed[3].content)),
			];
			expect(
				f.check([f.user("foreign"), ...steeredRows]).mismatch,
			).toBeUndefined();
		});

		test(`${host} ${api}: session history and IDs cannot masquerade as foreign additions`, () => {
			const f = fixture(api, host);
			for (const text of [
				"first session prompt",
				"cut or summarized session prompt",
				"§999§ cut or summarized session prompt",
			]) {
				expect(f.check([f.user(text), ...f.rows]).mismatch).toContain(
					"session-content",
				);
			}
			expect(
				f.check([
					{ ...f.user("changed entry text"), id: "cut-entry" },
					...f.rows,
				]).mismatch,
			).toBeDefined();
		});

		test(`${host} ${api}: kept user text stays under the existing comparator after host rewrites`, () => {
			const f = fixture(api, host);
			for (const text of [
				"§3§ latest #SECRET_1#",
				"§3§ lone surrogate replaced by \ufffd",
				"§3§ see screenshot\n[image omitted: the active model does not support image input]",
			]) {
				const rows = [...f.rows.slice(0, -1), f.user(text)];
				expect(
					piPreparedStructureMismatch(f.payload(rows), f.prepared),
				).toBeUndefined();
				expect(f.check([f.user("foreign"), ...rows]).mismatch).toBeUndefined();
			}
		});

		test(`${host} ${api}: foreign rows cannot split tools, replace prepared rows, or exceed bounds`, () => {
			const f = fixture(api, host);
			expect(
				f.check([
					...Array.from({ length: PI_FOREIGN_MAX_ROWS }, (_, i) =>
						f.user(`foreign ${i}`),
					),
					...f.rows,
				]).mismatch,
			).toBeUndefined();
			expect(
				f.check([f.user("x".repeat(PI_FOREIGN_MAX_CHARS)), ...f.rows]).mismatch,
			).toBeUndefined();
			expect(
				f.check([...f.rows.slice(0, 2), f.user("foreign"), ...f.rows.slice(2)])
					.mismatch,
			).toContain("rule=2 reason=tool-pair");
			expect(
				f.check([f.user("foreign"), ...f.rows.slice(0, -1)]).mismatch,
			).toBeDefined();
			expect(
				f.check([
					f.user("foreign"),
					...f.rows.slice(0, -1),
					f.user("latest session prompt"),
				]).mismatch,
			).toBeDefined();
			expect(
				f.check([
					f.user("foreign"),
					...f.rows.slice(0, -1),
					f.user("cut or summarized session prompt"),
				]).mismatch,
			).toContain("rule=3 reason=session-content");
			expect(
				f.check([
					...Array.from({ length: PI_FOREIGN_MAX_ROWS + 1 }, (_, i) =>
						f.user(`foreign ${i}`),
					),
					...f.rows,
				]).mismatch,
			).toContain("rule=4 reason=limit");
			expect(
				f.check([f.user("x".repeat(PI_FOREIGN_MAX_CHARS + 1)), ...f.rows])
					.mismatch,
			).toContain("rule=4 reason=limit");
			const extraAssistant = api.startsWith("google-")
				? { role: "model", parts: [{ text: "foreign" }] }
				: { role: "assistant", content: "foreign" };
			expect(f.check([...f.rows, extraAssistant]).mismatch).toBeDefined();
			const extraTool = api.startsWith("google-")
				? {
						role: "user",
						parts: [{ functionResponse: { name: "read", response: {} } }],
					}
				: { role: "tool", tool_call_id: "unprepared", content: "foreign" };
			expect(f.check([...f.rows, extraTool]).mismatch).toBeDefined();
			const extraImage = api.startsWith("google-")
				? {
						role: "user",
						parts: [{ inlineData: { mimeType: "image/png", data: "private" } }],
					}
				: {
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", data: "private" } },
						],
					};
			expect(f.check([...f.rows, extraImage]).mismatch).toBeDefined();
			const extraReasoning = api.startsWith("google-")
				? { role: "user", parts: [{ text: "foreign", thought: true }] }
				: {
						role: "user",
						content: [{ type: "thinking", thinking: "foreign" }],
					};
			expect(f.check([...f.rows, extraReasoning]).mismatch).toBeDefined();
		});
	}

test("fresh first input is proved by complete session metadata when getBranch fails", () => {
	for (const branch of [
		undefined,
		[],
		[
			{ type: "service_tier_change", id: "tier", serviceTier: null },
			{ type: "model_change", id: "model" },
			{ type: "thinking_level_change", id: "thinking" },
		],
	]) {
		for (const content of ["first prompt", "\nfirst prompt", " first prompt"]) {
			const raw = [{ role: "user", content, timestamp: 1 }];
			const managed = [{ ...raw[0], content: `§1§ ${content}` }];
			const evidence = piForeignEvidence(
				{
					getEntries: () => branch ?? [],
					getBranch: () => {
						throw new Error("branch resolution failed");
					},
				},
				raw,
			)!;
			piProtectPreparedRows(evidence, managed);
			const prepared = piPreparedStructure(managed, {
				api: "anthropic-messages",
				id: "test",
				provider: "test",
			});
			expect(
				piCheckPreparedDispatch(
					{
						system: "system",
						messages: [{ role: "user", content: "foreign" }, ...managed],
					},
					prepared,
					evidence,
				).mismatch,
			).toBeUndefined();
		}
	}
});

test("missing branch evidence refuses when a cut or summary hides whole session rows", () => {
	const f = fixture("anthropic-messages", "omp", false);
	piProtectPreparedRows(f.evidence, f.managed.slice(1));
	expect(f.check([f.user("foreign"), ...f.rows]).mismatch).toContain(
		"unreadable-branch",
	);
	const summary = {
		role: "compactionSummary",
		summary: "old history",
		timestamp: 1,
	};
	const evidence = piForeignEvidence(undefined, [summary])!;
	piProtectPreparedRows(evidence, [summary]);
	expect(piMaterializeForeignEvidence(evidence)).toBe(false);
	const raw = [
		{ role: "user", content: "removed", timestamp: 1 },
		{ role: "user", content: "kept", timestamp: 1 },
	];
	const collision = piForeignEvidence(undefined, raw)!;
	piProtectPreparedRows(collision, [
		{ role: "user", content: "synthetic history head", timestamp: 1 },
		raw[1],
	]);
	expect(piMaterializeForeignEvidence(collision)).toBe(false);
});

test("foreign additions preserve the prepared Chat orphan-result note", () => {
	const messages = [
		{ role: "user", content: "§1§ prompt", timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "orphan",
			toolName: "read",
			content: [{ type: "text", text: "orphan output" }],
			timestamp: 2,
		},
		{ role: "user", content: "§2§ next", timestamp: 3 },
	];
	const prepared = piPreparedStructure(messages, {
		api: "openai-completions",
		id: "test",
		provider: "test",
	});
	const note = prepared?.chatMessages?.find(
		(row) => row.exactText !== undefined,
	)?.exactText;
	expect(typeof note).toBe("string");
	const wire = {
		messages: [
			{ role: "user", content: "§1§ prompt" },
			{ role: "user", content: note },
			{ role: "user", content: "§2§ next" },
		],
	};
	expect(piPreparedStructureMismatch(wire, prepared)).toBeUndefined();
	const evidence = piForeignEvidence(
		messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			message,
		})),
		messages,
	)!;
	piProtectPreparedRows(evidence, messages, prepared);
	expect(
		piCheckPreparedDispatch(
			{ messages: [{ role: "user", content: "foreign" }, ...wire.messages] },
			prepared,
			evidence,
		).mismatch,
	).toBeUndefined();
});
