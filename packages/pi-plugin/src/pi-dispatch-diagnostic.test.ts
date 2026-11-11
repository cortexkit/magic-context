import { expect, test } from "bun:test";
import { IssuePrivacy } from "../../cli/src/lib/issue-privacy";
import { logPiDispatchMismatch } from "./pi-dispatch-diagnostic";
import { piDispatchRowDiagnostic } from "./pi-dispatch-row-diagnostic";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

for (const api of [
	"google-generative-ai",
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"bedrock-converse-stream",
	"google-vertex",
	"google-gemini-cli",
	"ollama-chat",
]) {
	test(`${api}: unexpected trailing row refuses with content-free issue diagnostics`, () => {
		const privateText =
			"PRIVATE user source /home/private/repository token=not-a-real-secret";
		const prepared = piPreparedStructure(
			[{ role: "user", content: privateText, timestamp: 1 }],
			{ api, provider: "test", id: "test" },
		);
		const wire = api.startsWith("google-")
			? {
					contents: [
						{ role: "user", parts: [{ text: privateText }] },
						{ role: "user", parts: [{ text: privateText }] },
					],
				}
			: api.endsWith("responses")
				? {
						input: [
							{
								role: "user",
								content: [{ type: "input_text", text: privateText }],
							},
							{
								role: "user",
								content: [{ type: "input_text", text: privateText }],
							},
						],
					}
				: {
						...(api === "anthropic-messages"
							? { system: [{ type: "text", text: "system" }], max_tokens: 10 }
							: {}),
						...(api === "bedrock-converse-stream"
							? { inferenceConfig: {} }
							: {}),
						messages: [
							{ role: "user", content: privateText },
							{ role: "user", content: privateText },
						],
					};
		const mismatch = piPreparedStructureMismatch(wire, prepared);
		expect(mismatch).toContain("row=1 expectedRows=1 actualRows=2");
		const lines: string[] = [];
		logPiDispatchMismatch(wire, prepared, mismatch!, (line) =>
			lines.push(line),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`expectedPrevious role=user parts=1 kinds=1 chars=${privateText.length}`,
		);
		expect(lines[0]).toContain("expectedCurrent role=missing");
		expect(lines[0]).toContain(
			`actualCurrent role=user parts=1 kinds=1 chars=${privateText.length} injector=none`,
		);
		expect(lines[0]).not.toContain(privateText);
		expect(
			new IssuePrivacy({}).logLine(`[2026-11-10T20:00:00.000Z] ${lines[0]}`),
		).toContain(
			`actualCurrent role=user parts=1 kinds=1 chars=${privateText.length} injector=none`,
		);
	});
}

test("diagnostic kinds and injector tags use only fixed vocabularies", () => {
	expect(
		piDispatchRowDiagnostic("user", [
			{
				type: "text",
				text: "<system-reminder>\nToday: 2026-11-10; current working directory: '/private/project'. Do not repeat this information in your reply.\n</system-reminder>",
			},
		]).injector,
	).toBe("date-cwd");
	expect(piDispatchRowDiagnostic("user", "Continue.").injector).toBe(
		"anthropic-continue",
	);
	expect(
		piDispatchRowDiagnostic("assistant", [
			{ type: "PRIVATE_KIND", text: "secret" },
			{ type: "image", data: "secret" },
			{ type: "toolCall", arguments: { secret: "secret" } },
			{ type: "thinking", thinking: "secret" },
			{ type: "tool_result", content: "secret" },
			{ type: "PRIVATE_KIND" },
		]),
	).toEqual({
		role: "assistant",
		parts: 6,
		kinds: 63,
		chars: 12,
		injector: "none",
	});
});

test("ambiguous rewritten-row gap sizes survive doctor issue redaction without text", () => {
	const secret = "PRIVATE session body /home/private/repository";
	const model = { api: "anthropic-messages", provider: "test", id: "test" };
	const prepared = piPreparedStructure(
		[{ role: "user", content: secret, timestamp: 1 }],
		model,
	);
	const wire = {
		system: "system",
		messages: [
			{ role: "user", content: secret },
			{ role: "user", content: "bootstrap" },
		],
	};
	const mismatch = `${piPreparedStructureMismatch(wire, prepared)}; foreign rule=4 reason=ambiguous-rewrite count=1 chars=40023 gapPrepared=1 gapWire=2 gapChars=40023`;
	const lines: string[] = [];
	logPiDispatchMismatch(wire, prepared, mismatch, (line) => lines.push(line));
	expect(lines).toHaveLength(1);
	const redacted = new IssuePrivacy({}).logLine(
		`[2026-11-10T20:00:00.000Z] ${lines[0]}`,
	);
	expect(redacted).toContain(
		"foreignRule=4 foreignReason=ambiguous-rewrite foreignCount=1 foreignChars=40023 foreignGapPrepared=1 foreignGapWire=2 foreignGapChars=40023",
	);
	expect(redacted).not.toContain(secret);
	expect(redacted).not.toContain("/home/private");
});

test("diagnostic failures cannot mask the original refusal", () => {
	const payload = Object.defineProperty({}, "messages", {
		get() {
			throw new Error("PRIVATE exception");
		},
	});
	const lines: string[] = [];
	expect(() =>
		logPiDispatchMismatch(payload, undefined, "comparison=count", (line) =>
			lines.push(line),
		),
	).not.toThrow();
	expect(lines[0]).toContain("actualCurrent role=unknown");
	expect(lines[0]).not.toContain("PRIVATE");
	expect(() =>
		logPiDispatchMismatch(payload, undefined, "comparison=count", () => {
			throw new Error("sink unavailable");
		}),
	).not.toThrow();
});

test("recognized injector tag survives redaction even outside the first-difference window", () => {
	const raw = ["one", "two", "three"].map((content, timestamp) => ({
		role: "user",
		content,
		timestamp,
	}));
	const prepared = piPreparedStructure(raw, {
		api: "anthropic-messages",
		provider: "test",
		id: "test",
	});
	const payload = {
		system: "system",
		messages: [
			{
				role: "user",
				content:
					"<EXTREMELY_IMPORTANT>\nsuperpowers:using-superpowers bootstrap for pi\nPRIVATE_BOOTSTRAP_CONTENT\n</EXTREMELY_IMPORTANT>",
			},
			...raw.map(({ role, content }) => ({ role, content })),
		],
	};
	const mismatch = piPreparedStructureMismatch(payload, prepared)!;
	expect(mismatch).toContain("row=3");
	const lines: string[] = [];
	logPiDispatchMismatch(payload, prepared, mismatch, (line) =>
		lines.push(line),
	);
	const safe = new IssuePrivacy({}).logLine(
		`[2026-11-10T20:00:00.000Z] ${lines[0]}`,
	);
	expect(safe).toContain(
		"firstInjectorRow=0 firstInjectorKind=superpowers-bootstrap",
	);
	expect(safe).not.toContain("PRIVATE_BOOTSTRAP_CONTENT");
});
