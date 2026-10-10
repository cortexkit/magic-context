/**
 * Signed-thinking prefix audit for the Pi context handler (Pi and OMP share
 * it). Same design as the OpenCode audit in
 * packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts:
 * a strict-binding provider mock answers every served request of a realistic
 * Opus 5.5 tool loop, one mutation lane is offered a cache-busting pass while
 * the current turn holds signed thinking (mid loop in a primary session, or a
 * subagent run), and each primary lane has a control at a new user turn that
 * must land the lane's own edit validly.
 *
 * Findings: docs/reports/signed-thinking-prefix-edits-audit.md. Run with
 * MC_AUDIT_STRICT=1 to make every exposed lane fail on its strict-binding 400.
 */
import { describe, it } from "bun:test";
import {
	appendCompartments,
	replaceAllCompartmentState,
	replaceAllCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { isPrefixBoundThinkingModel } from "@magic-context/core/features/magic-context/overflow-detection";
import {
	clearCachedM0M1,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { assertAdmissionParity } from "../../plugin/src/hooks/magic-context/__tests__/admission-parity.test";
import {
	auditName,
	auditExpect as expect,
	GOLDEN,
	GoldenCapture,
} from "../../plugin/src/hooks/magic-context/__tests__/golden-capture.test";
import {
	type Block,
	beforeLastThinking,
	PREFIX_ERROR,
	STRICT_AUDIT,
	StrictBindingMock,
	thinkingBlocks,
	type Wire,
	withoutThinking,
} from "../../plugin/src/hooks/magic-context/__tests__/strict-binding-mock";
import {
	__test,
	clearContextHandlerSession,
	hasPendingMaterialization,
	hasPiParkedBustTrigger,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const MODEL = {
	provider: "anthropic",
	id: process.env.MC_AUDIT_MODEL ?? "claude-opus-5-5",
	api: "anthropic-messages",
	contextWindow: 100_000,
};

// Keep the strict thinking-identity assertion disabled until older-turn thinking is stripped
// only alongside an admitted prefix edit, rather than alongside every bust permission.
const THINKING_STRIP_GATED = false;

/**
 * What Pi's Anthropic provider sends: thinking with its signature, tool calls
 * as tool_use, tool results as user tool_result blocks; empty text and empty
 * thinking are not sent.
 */
interface PiPart {
	type?: string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	data?: string;
	mimeType?: string;
}

function wire(messages: unknown[]): Wire {
	return messages.flatMap((raw) => {
		const m = raw as {
			role: string;
			content: string | PiPart[];
			toolCallId?: string;
		};
		const parts =
			typeof m.content === "string"
				? [{ type: "text", text: m.content }]
				: m.content;
		const content: Block[] = parts.flatMap((p): Block[] => {
			if (p.type === "thinking")
				return p.thinking && p.thinkingSignature
					? [
							{
								type: "thinking",
								thinking: p.thinking,
								signature: p.thinkingSignature,
							},
						]
					: [];
			if (p.type === "toolCall")
				return [
					{ type: "tool_use", id: p.id, name: p.name, input: p.arguments },
				];
			if (p.type === "text")
				return p.text ? [{ type: "text", text: p.text }] : [];
			if (p.type === "image")
				return [{ type: "image", data: p.data, mimeType: p.mimeType }];
			return [];
		});
		if (m.role === "toolResult")
			return [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: m.toolCallId, content },
					],
				},
			];
		return content.length ? [{ role: m.role, content }] : [];
	});
}

type Lane =
	| "ctx_reduce drop (full removal)"
	| "ctx_reduce drop (skeleton beside reasoning)"
	| "age reclaim and heuristic cleanup"
	| "supersession and dedup"
	| "emergency 85% force band"
	| "emergency 95% wall"
	| "/ctx-flush"
	| "HARD fold after historian publication"
	| "m[0]/m[1] re-render after a recomp clears the cached pair"
	| "prefix cut moved by a compartment rewrite that keeps the cached pair"
	| "synthetic todo"
	| "caveman text compression"
	| "reasoning clearing (keep_reasoning_tokens)"
	| "processed image strip"
	| "stale ctx_reduce strip"
	| "frozen-sentinel first application";

/**
 * Lanes whose mid-loop bust changes the request before a signed thinking block the
 * request still carries, which a strict-binding provider rejects.
 */
const EXPOSED = new Set<Lane>([
	"m[0]/m[1] re-render after a recomp clears the cached pair",
	"synthetic todo",
	"frozen-sentinel first application",
]);

const PRIMARY_LANES: Lane[] = [
	"ctx_reduce drop (full removal)",
	"ctx_reduce drop (skeleton beside reasoning)",
	"age reclaim and heuristic cleanup",
	"supersession and dedup",
	"emergency 85% force band",
	"emergency 95% wall",
	"/ctx-flush",
	"HARD fold after historian publication",
	"m[0]/m[1] re-render after a recomp clears the cached pair",
	"synthetic todo",
	"caveman text compression",
	"reasoning clearing (keep_reasoning_tokens)",
	"processed image strip",
	"stale ctx_reduce strip",
	"frozen-sentinel first application",
];
/**
 * Obligation lanes whose held work must still be released at the next user turn when the
 * process restarts in between.
 */
const RESTART_LANES: Lane[] = [
	"ctx_reduce drop (full removal)",
	"emergency 85% force band",
	"/ctx-flush",
	"HARD fold after historian publication",
];

/**
 * Restart lanes whose release is lost today: the release signal lives only in process memory
 * (`signalPiPendingMaterialization`, `signalPiHistoryRefresh`).
 */
const RESTART_GAP = new Set<Lane>(["/ctx-flush"]);

/**
 * Held primary lanes whose bust pass strips the previous turn's thinking today, although it
 * applies nothing before the kept thinking: Pi's proactive strip rides the pass's bust
 * permission (`cacheBustingPass`), not an admitted edit.
 */
const STRIPS_THINKING_WHEN_HELD = new Set<Lane>([
	"emergency 95% wall",
	"/ctx-flush",
	"HARD fold after historian publication",
]);

// Pi discovers placeholder-only messages on a history refresh, which a
// subagent (no historian) does not receive; subagents also get no synthetic
// todo, caveman, m[0]/m[1] or /ctx-flush.
const SUBAGENT_LANES: Lane[] = [
	"ctx_reduce drop (full removal)",
	"ctx_reduce drop (skeleton beside reasoning)",
	"age reclaim and heuristic cleanup",
	"supersession and dedup",
	"emergency 85% force band",
	"emergency 95% wall",
	"reasoning clearing (keep_reasoning_tokens)",
	"stale ctx_reduce strip",
];

const PARSER_SOURCE =
	"export function parse(tokens) { /* recursive descent */ }\n".repeat(150);
const SUMMARY_TEXT =
	"I have finished reading the parser and the lexer. The parser consumes tokens from the lexer, and the error recovery path is incomplete because it never resynchronises after an unexpected token.";
const COMPARTMENT_TITLE = "Parser inspection";
/** The first turn as one compartment, ending inclusively at its summary message. */
const FIRST_TURN_COMPARTMENT = {
	sequence: 0,
	startMessage: 1,
	endMessage: 5,
	startMessageId: "prompt-1",
	endMessageId: "step-4",
	title: COMPARTMENT_TITLE,
	content:
		"Read parser.ts, ast.ts and lexer.ts; error recovery never resynchronises.",
};

interface Fixture {
	db: ReturnType<typeof createTestDb>;
	sessionId: string;
	mock: StrictBindingMock;
	served: unknown[];
	pass: () => Promise<{ messages: unknown[]; bustedThisPass: boolean }>;
	respond: (
		content: (n: number) => Record<string, unknown>[],
		results?: (n: number) => [string, string][],
		withThinking?: boolean,
	) => void;
	userTurn: (id: string, text: string) => void;
	setPercent: (percent: number) => void;
	setModel: (modelID: string) => void;
	tagStatus: (callId: string) => string | undefined;
	tag: (callId: string) => number;
}

function read(id: string, path: string): Record<string, unknown> {
	return { type: "toolCall", id, name: "read", arguments: { path } };
}
function reduce(id: string, drop: string): Record<string, unknown> {
	return { type: "toolCall", id, name: "ctx_reduce", arguments: { drop } };
}

async function fixture(
	subagent: boolean,
	lane: Lane,
	scenario: string,
	injectionEnabled = true,
): Promise<Fixture> {
	const db = createTestDb();
	const sessionId = `pi-prefix-audit-${subagent ? "sub" : "pri"}-${lane.replace(/\W+/g, "-")}`;
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		isSubagent: subagent,
		cacheTtl: "59m",
		lastResponseTime: Date.now(),
	});
	if (lane === "synthetic todo")
		updateSessionMeta(db, sessionId, {
			lastTodoState: JSON.stringify([
				{ content: "Inspect parser", status: "in_progress", priority: "high" },
			]),
		});
	const fake = createFakePi();
	let bustedThisPass: boolean | undefined;
	const capture = new GoldenCapture(auditName("pi", subagent, lane, scenario));
	registerPiContextHandler(fake.pi as never, {
		onPostprocess: (result) => {
			bustedThisPass = result.bustedThisPass;
		},
		db,
		protectedTokens: 4000,
		todowriteEnabled: true,
		injection: injectionEnabled
			? {
					injectionBudgetTokens: 4000,
					memoryEnabled: false,
					injectDocs: false,
				}
			: undefined,
		heuristics: {
			keepReasoningTokens:
				lane === "reasoning clearing (keep_reasoning_tokens)" ? 0 : 1_000_000,
			...(lane === "caveman text compression"
				? { caveman: { enabled: true, minChars: 40 } }
				: {}),
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: PiMessage[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const messages: PiMessage[] = [];
	const ids: string[] = [];
	let percent = 20;
	let liveModel = { ...MODEL };
	const pass = async () => {
		const source = structuredClone(messages);
		if (!GOLDEN)
			assertAdmissionParity(
				source.map((m, i) => ({
					info: { id: ids[i], role: m.role },
					parts: Array.isArray(m.content)
						? m.content
						: [{ type: "text", text: m.content }],
				})),
				isPrefixBoundThinkingModel(MODEL.provider, MODEL.id),
			);
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ids, source),
			model: liveModel,
			getContextUsage: () => ({
				tokens: percent * 1000,
				percent,
				contextWindow: 100_000,
			}),
		};
		bustedThisPass = undefined;
		const output =
			(await handler({ messages: source }, ctx as never))?.messages ?? source;
		if (bustedThisPass === undefined)
			throw new Error("audit pass did not reach postprocess");
		capture.write(
			wire(output),
			bustedThisPass,
			mock.hasCurrentTurnThinking(wire(output)),
			hasPiParkedBustTrigger(sessionId),
		);
		return { messages: output, bustedThisPass };
	};
	const mock = new StrictBindingMock(Boolean(GOLDEN));
	let step = 0;
	const respond: Fixture["respond"] = (
		content,
		results,
		withThinking = true,
	) => {
		const block = mock.respond(wire(f.served), withThinking);
		step++;
		messages.push({
			role: "assistant",
			content: [
				...(block
					? [
							{
								type: "thinking",
								thinking: block.thinking,
								thinkingSignature: block.signature,
							},
						]
					: []),
				...content(step),
			],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1000 + step * 2,
		} as PiMessage);
		ids.push(`step-${step}`);
		for (const [callId, text] of results?.(step) ?? []) {
			messages.push(toolResultMessage(callId, text, 1001 + step * 2));
			ids.push(`result-${callId}`);
		}
	};
	const userTurn = (id: string, text: string, extra: unknown[] = []) => {
		mock.newUserTurn();
		messages.push(
			userMessage(
				extra.length ? ([{ type: "text", text }, ...extra] as never) : text,
				1000 + messages.length,
			),
		);
		ids.push(id);
	};
	const tagRow = (callId: string) =>
		getTagsBySession(db, sessionId).find(
			(t) => t.messageId === callId || t.messageId.endsWith(callId),
		);
	const f: Fixture = {
		db,
		sessionId,
		mock,
		served: [],
		setModel: (id) => {
			liveModel = { ...MODEL, id };
		},
		pass,
		respond,
		userTurn,
		setPercent: (p) => {
			percent = p;
		},
		tagStatus: (callId) => tagRow(callId)?.status,
		tag: (callId) => {
			const row = tagRow(callId);
			if (!row) throw new Error(`no tag for ${callId}`);
			return row.tagNumber;
		},
	};
	const image =
		lane === "processed image strip"
			? [
					{
						type: "image",
						data: "iVBORw0KGgo".repeat(40),
						mimeType: "image/png",
					},
				]
			: [];
	userTurn(
		"prompt-1",
		"Inspect the parser and the attached screenshot, then report.",
		image,
	);
	f.served = (await pass()).messages;
	respond(
		() => [read("old-read-a", "/project/src/parser.ts")],
		() => [["old-read-a", PARSER_SOURCE]],
	);
	f.served = (await pass()).messages;
	respond(
		() => [
			read(
				"old-read-b",
				lane === "supersession and dedup"
					? "/project/src/parser.ts"
					: "/project/src/ast.ts",
			),
		],
		() => [
			[
				"old-read-b",
				lane === "supersession and dedup"
					? PARSER_SOURCE
					: "export interface Node { kind: string }\n".repeat(150),
			],
		],
		false,
	);
	f.served = (await pass()).messages;
	if (lane === "stale ctx_reduce strip")
		respond(
			() => [reduce("old-reduce", "3")],
			() => [["old-reduce", "Queued: drop §3§"]],
		);
	else
		respond(
			() => [read("old-read-c", "/project/src/lexer.ts")],
			() => [["old-read-c", "export function lex(src) {}\n".repeat(150)]],
		);
	f.served = (await pass()).messages;
	respond(() => [{ type: "text", text: SUMMARY_TEXT }]);
	if (lane === "frozen-sentinel first application") {
		messages.push({
			...(messages.at(-1) as object),
			content: [{ type: "text", text: "[dropped §998§]" }],
			timestamp: 5000,
		} as PiMessage);
		ids.push("placeholder-only");
	}
	if (!subagent) {
		f.served = (await pass()).messages;
		expect(mock.check(wire(f.served))).toBeNull();
		userTurn(
			"prompt-2",
			"Now repair the error recovery in the parser; keep using tools until it is done.",
		);
	}
	f.served = (await pass()).messages;
	return f;
}

async function toolLoop(
	f: Fixture,
	steps: number,
	lane?: Lane,
): Promise<unknown[]> {
	for (let i = 0; i < steps; i++) {
		const stale = lane === "stale ctx_reduce strip" && i < 3;
		f.respond(
			(n) => [
				stale
					? reduce(`loop-reduce-${n}`, "1")
					: read(`call-${n}`, `/project/src/file-${n}.ts`),
			],
			(n) => [
				[
					stale ? `loop-reduce-${n}` : `call-${n}`,
					stale
						? "Queued: drop §1§"
						: `export const v${n} = ${n};\n`.repeat(400),
				],
			],
		);
		f.served = (await f.pass()).messages;
		expect(f.mock.check(wire(f.served))).toBeNull();
	}
	return f.served;
}

async function nextUserTurn(f: Fixture, id: string): Promise<void> {
	f.respond((n) => [
		{
			type: "text",
			text: `Step ${n}: this part of the work is done and verified.`,
		},
	]);
	f.served = (await f.pass()).messages;
	expect(f.mock.check(wire(f.served))).toBeNull();
	f.userTurn(
		id,
		"Continue with the next part of the parser work; keep using tools until done.",
	);
	f.served = (await f.pass()).messages;
	expect(f.mock.check(wire(f.served))).toBeNull();
}

async function prepareLane(f: Fixture, lane: Lane): Promise<void> {
	if (lane === "synthetic todo") {
		signalPiPendingMaterialization(f.sessionId);
		f.served = (await f.pass()).messages;
		expect(f.mock.check(wire(f.served))).toBeNull();
	}
	if (
		lane ===
		"prefix cut moved by a compartment rewrite that keeps the cached pair"
	) {
		// The first turn is folded at the start of this turn, so the cached m[0]/m[1]
		// pair is served with an inclusive cut through step-4, the summary message.
		appendCompartments(f.db, f.sessionId, [FIRST_TURN_COMPARTMENT]);
		signalPiHistoryRefresh(f.sessionId);
		f.served = (await f.pass()).messages;
		expect(f.mock.check(wire(f.served))).toBeNull();
		expect(JSON.stringify(wire(f.served))).toContain(COMPARTMENT_TITLE);
		expect(JSON.stringify(wire(f.served))).not.toContain(SUMMARY_TEXT);
	}
}

function armAndBust(f: Fixture, lane: Lane, subagent: boolean): void {
	switch (lane) {
		case "ctx_reduce drop (full removal)":
		case "/ctx-flush":
		case "processed image strip":
			// An answered image is stripped once its tag is at or below the
			// highest dropped tag number; Pi computes that after this pass's
			// drops, so the image is stripped on the same pass as a drop.
			queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
			break;
		case "frozen-sentinel first application":
			// Pi discovers placeholder-only messages on a history refresh.
			signalPiHistoryRefresh(f.sessionId);
			break;
		case "ctx_reduce drop (skeleton beside reasoning)":
			queuePendingOp(f.db, f.sessionId, f.tag("old-read-a"), "drop");
			break;
		case "age reclaim and heuristic cleanup":
			updateSessionMeta(f.db, f.sessionId, {
				toolReclaimWatermark: f.tag("old-read-c"),
			});
			break;
		case "HARD fold after historian publication":
			appendCompartments(f.db, f.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 5,
					startMessageId: "prompt-1",
					endMessageId: "step-4",
					title: COMPARTMENT_TITLE,
					content:
						"Read parser.ts, ast.ts and lexer.ts; error recovery never resynchronises.",
				},
			]);
			signalPiHistoryRefresh(f.sessionId);
			break;
		case "m[0]/m[1] re-render after a recomp clears the cached pair":
			// A recomp promotion (or a history-boundary repair) rewrites the
			// compartments and clears the cached m[0]/m[1] pair in the same
			// transaction. No bust is offered: the next pass is a defer pass.
			replaceAllCompartmentState(
				f.db,
				f.sessionId,
				[
					{
						sequence: 0,
						startMessage: 1,
						endMessage: 5,
						startMessageId: "prompt-1",
						endMessageId: "step-4",
						title: COMPARTMENT_TITLE,
						content:
							"Read parser.ts, ast.ts and lexer.ts; error recovery never resynchronises.",
					},
				],
				[],
			);
			return;
		case "prefix cut moved by a compartment rewrite that keeps the cached pair":
			// A compartment writer that does not clear the cached pair rewrites the served
			// boundary row so that it ends part-way through step-4. The pair stays
			// complete, and Pi's trim re-reads the partial-end decision from the live
			// row. No bust is offered: the next pass is a defer pass.
			replaceAllCompartments(f.db, f.sessionId, [
				{ ...FIRST_TURN_COMPARTMENT, endBlockIndex: 0 },
			]);
			return;
		case "synthetic todo":
			updateSessionMeta(f.db, f.sessionId, {
				lastTodoState: JSON.stringify([
					{ content: "Inspect parser", status: "completed", priority: "high" },
					{
						content: "Repair error recovery",
						status: "in_progress",
						priority: "high",
					},
				]),
			});
			break;
		default:
			break;
	}
	if (lane === "/ctx-flush") {
		signalPiPendingMaterialization(f.sessionId);
		return;
	}
	f.setPercent(lane === "emergency 95% wall" ? 95 : subagent ? 76 : 85);
}

/** First differing non-thinking block, for diagnosing an unexpected edit (MC_AUDIT_DEBUG=1). */
function debugDiff(label: string, before: Wire, after: Wire): void {
	if (process.env.MC_AUDIT_DEBUG !== "1") return;
	const flat = (w: Wire) =>
		w.flatMap((m) =>
			m.content
				.filter((b) => b.type !== "thinking")
				.map((b) => JSON.stringify([m.role, b]).slice(0, 160)),
		);
	const a = flat(before);
	const b = flat(after);
	const i = a.findIndex((x, k) => x !== b[k]);
	console.log(
		`DIFF ${label} at=${i} lens=${a.length}/${b.length}\n  before: ${a[i]}\n  after:  ${b[i]}`,
	);
}

function landed(f: Fixture, lane: Lane, after: Wire): boolean {
	const text = JSON.stringify(after);
	const old = ["old-read-a", "old-read-b", "old-read-c"];
	switch (lane) {
		case "ctx_reduce drop (full removal)":
		case "/ctx-flush":
			return f.tagStatus("old-read-b") === "dropped";
		case "ctx_reduce drop (skeleton beside reasoning)":
			return f.tagStatus("old-read-a") === "dropped";
		case "age reclaim and heuristic cleanup":
		case "emergency 85% force band":
		case "emergency 95% wall":
		case "supersession and dedup":
			return old.some((id) => f.tagStatus(id) === "dropped");
		case "HARD fold after historian publication":
		case "m[0]/m[1] re-render after a recomp clears the cached pair":
			return text.includes(COMPARTMENT_TITLE);
		case "prefix cut moved by a compartment rewrite that keeps the cached pair":
			// The inclusive cut removed step-4; a partial cut serves it again.
			return text.includes(SUMMARY_TEXT);
		case "synthetic todo":
			return text.includes("Repair error recovery");
		case "caveman text compression":
			return !text.includes(SUMMARY_TEXT);
		case "reasoning clearing (keep_reasoning_tokens)":
			// Quoted, so that a later "mock-signature-10" does not match.
			return !text.includes('"mock-signature-1"');
		case "processed image strip":
			return !text.includes('"type":"image"');
		case "stale ctx_reduce strip":
			return f.tagStatus("old-reduce") === "dropped";
		case "frozen-sentinel first application":
			return !text.includes("[dropped §998§]");
	}
}

function withFixture(
	subagent: boolean,
	lane: Lane,
	body: (f: Fixture) => Promise<void>,
	scenario = "mid-loop",
	injectionEnabled = true,
) {
	return async () => {
		const f = await fixture(subagent, lane, scenario, injectionEnabled);
		try {
			await body(f);
		} finally {
			clearContextHandlerSession(f.sessionId);
			closeQuietly(f.db);
		}
	};
}

for (const subagent of [false, true]) {
	const scope = subagent ? "subagent run" : "primary mid tool loop";
	describe(`signed prefix audit: Pi/OMP, ${scope}`, () => {
		for (const lane of subagent ? SUBAGENT_LANES : PRIMARY_LANES) {
			it(
				lane,
				withFixture(subagent, lane, async (f) => {
					await prepareLane(f, lane);
					const before = wire(await toolLoop(f, 4, lane));
					armAndBust(f, lane, subagent);
					const afterMessages = (await f.pass()).messages;
					const after = wire(afterMessages);
					const error = f.mock.check(after);
					const edit = landed(f, lane, after);
					debugDiff(lane, before, after);
					const nonThinkingEdit =
						withoutThinking(after) !== withoutThinking(before);
					console.log(
						`AUDIT Pi/OMP | ${scope} | ${lane}: ${error ?? "accepted"}; laneLanded=${edit}; nonThinkingEdit=${nonThinkingEdit}; pendingOps=${getPendingOps(f.db, f.sessionId).length}`,
					);
					// Under MC_AUDIT_STRICT=1 every lane must behave as held, which is
					// the acceptance bar of docs/designs/signed-thinking-hold.md.
					if (!GOLDEN && !STRICT_AUDIT && EXPOSED.has(lane)) {
						expect(edit).toBe(true);
						expect(error).toBe(PREFIX_ERROR);
						return;
					}
					expect(error).toBeNull();
					if (lane !== "reasoning clearing (keep_reasoning_tokens)")
						expect(edit).toBe(false);
					// At the 95% wall Pi drops the newest tool result, which sits
					// after every kept thinking block: valid, so not a prefix edit.
					// Nothing before the last kept block may change.
					if (lane === "emergency 95% wall") {
						expect(JSON.stringify(after)).toContain("[dropped §");
						expect(beforeLastThinking(after)).toBe(beforeLastThinking(before));
					} else expect(nonThinkingEdit).toBe(false);
					// A pass that applies nothing before the kept thinking changes no
					// thinking either: the strip of older-turn thinking is the companion
					// of an admitted edit before kept older-turn thinking, which a pass
					// with kept current-turn thinking never has.
					if (lane !== "reasoning clearing (keep_reasoning_tokens)") {
						const thinkingChanged =
							thinkingBlocks(after) !== thinkingBlocks(before);
						if (STRICT_AUDIT && THINKING_STRIP_GATED)
							expect(thinkingChanged).toBe(false);
						else if (!STRICT_AUDIT)
							expect(thinkingChanged).toBe(
								!subagent && STRIPS_THINKING_WHEN_HELD.has(lane),
							);
					}
					// A held edit is never recorded as served: repeating the pass with
					// no new response serves exactly the same bytes.
					expect(wire((await f.pass()).messages)).toEqual(after);
					f.served = afterMessages;
					await toolLoop(f, 2);
					if (subagent) return;
					// The held edit is released, not lost: once a real user message
					// starts the next turn, the same state (still armed, nothing
					// re-queued) lands the lane's edit validly.
					await nextUserTurn(f, "prompt-release");
					const released = wire(f.served);
					console.log(
						`AUDIT-RELEASE Pi/OMP | next user turn | ${lane}: ${f.mock.check(released) ?? "accepted"}; laneLanded=${landed(f, lane, released)}`,
					);
					expect(f.mock.check(released)).toBeNull();
					expect(landed(f, lane, released)).toBe(true);
				}),
			);
		}
		if (subagent) return;
		it(
			"pass returns the postprocess bust verdict",
			withFixture(
				false,
				"HARD fold after historian publication",
				async (f) => {
					expect((await f.pass()).bustedThisPass).toBe(false);
					armAndBust(f, "HARD fold after historian publication", false);
					expect((await f.pass()).bustedThisPass).toBe(true);
				},
				"bust-signal",
			),
		);
		for (const lane of PRIMARY_LANES) {
			it(
				`control: ${lane} lands validly at a new user turn`,
				withFixture(
					false,
					lane,
					async (f) => {
						await prepareLane(f, lane);
						await toolLoop(f, 4, lane);
						await nextUserTurn(f, "prompt-next");
						armAndBust(f, lane, false);
						const afterMessages = (await f.pass()).messages;
						const after = wire(afterMessages);
						const error = f.mock.check(after);
						const edit = landed(f, lane, after);
						console.log(
							`AUDIT-CONTROL Pi/OMP | new user turn | ${lane}: ${error ?? "accepted"}; laneLanded=${edit}`,
						);
						expect(edit).toBe(true);
						expect(error).toBeNull();
						f.served = afterMessages;
						await toolLoop(f, 3);
					},
					"control",
				),
			);
		}
		for (const lane of RESTART_LANES) {
			it(
				`release survives a restart: ${lane}`,
				withFixture(
					false,
					lane,
					async (f) => {
						await prepareLane(f, lane);
						await toolLoop(f, 4, lane);
						armAndBust(f, lane, false);
						const afterMessages = (await f.pass()).messages;
						const after = wire(afterMessages);
						expect(f.mock.check(after)).toBeNull();
						expect(landed(f, lane, after)).toBe(false);
						f.served = afterMessages;
						await toolLoop(f, 2);
						// The process restarts while the work is held: every in-memory
						// per-session state is dropped, the database survives. The next real
						// user turn must still release the work.
						clearContextHandlerSession(f.sessionId);
						await nextUserTurn(f, "prompt-release");
						const released = wire(f.served);
						const edit = landed(f, lane, released);
						console.log(
							`AUDIT-RESTART Pi/OMP | next user turn after a restart | ${lane}: ${f.mock.check(released) ?? "accepted"}; laneLanded=${edit}`,
						);
						expect(f.mock.check(released)).toBeNull();
						if (!GOLDEN && !STRICT_AUDIT && RESTART_GAP.has(lane)) {
							expect(edit).toBe(false);
							return;
						}
						expect(edit).toBe(true);
					},
					"restart",
				),
			);
		}
		it(
			"mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held",
			withFixture(
				false,
				"emergency 95% wall",
				async (f) => {
					await toolLoop(f, 3);
					// The newest step calls two tools at once; Pi stores each result as its
					// own toolResult message.
					f.respond(
						(n) => [
							read(`call-${n}-a`, `/project/src/file-${n}a.ts`),
							read(`call-${n}-b`, `/project/src/file-${n}b.ts`),
						],
						(n) => [
							[`call-${n}-a`, `export const a${n} = ${n};\n`.repeat(400)],
							[`call-${n}-b`, `export const b${n} = ${n};\n`.repeat(400)],
						],
					);
					f.served = (await f.pass()).messages;
					expect(f.mock.check(wire(f.served))).toBeNull();
					const before = wire(f.served);
					const older = f.tag("old-read-b");
					queuePendingOp(f.db, f.sessionId, older, "drop");
					f.setPercent(95);
					const afterMessages = (await f.pass()).messages;
					const after = wire(afterMessages);
					const tailLanded = withoutThinking(after) !== withoutThinking(before);
					console.log(
						`AUDIT-MIXED Pi/OMP | 95% wall beside a held drop: ${f.mock.check(after) ?? "accepted"}; tailLanded=${tailLanded}; olderDropped=${f.tagStatus("old-read-b") === "dropped"}`,
					);
					// Valid, including tool pairing on both sides of the parallel arc.
					expect(f.mock.check(after)).toBeNull();
					expect(beforeLastThinking(after)).toBe(beforeLastThinking(before));
					// The older drop sits before kept thinking: held and still queued.
					expect(f.tagStatus("old-read-b")).not.toBe("dropped");
					expect(
						getPendingOps(f.db, f.sessionId).some((op) => op.tagId === older),
					).toBe(true);
					// Pi lands the admitted tail reduction, so the pass is really mixed.
					expect(tailLanded).toBe(true);
					expect(wire((await f.pass()).messages)).toEqual(after);
					f.served = afterMessages;
					await toolLoop(f, 2);
					// Landing the tail reduction did not spend the older drop's release.
					await nextUserTurn(f, "prompt-release");
					expect(f.mock.check(wire(f.served))).toBeNull();
					expect(f.tagStatus("old-read-b")).toBe("dropped");
				},
				"mixed",
			),
		);
		// A replayed m[0]/m[1] pair must be replayed with the cut it was served with.
		// Today Pi's trim re-reads the partial-end decision from the live compartment
		// row, so a writer that rewrites that row without clearing the pair moves the cut
		// on a defer pass. The design replays head and cut as one unit (section 7).
		const CUT_LANE: Lane =
			"prefix cut moved by a compartment rewrite that keeps the cached pair";
		it(
			`${CUT_LANE}: mid tool loop`,
			withFixture(
				false,
				CUT_LANE,
				async (f) => {
					await prepareLane(f, CUT_LANE);
					const before = wire(await toolLoop(f, 4));
					armAndBust(f, CUT_LANE, false);
					const afterMessages = (await f.pass()).messages;
					const after = wire(afterMessages);
					const error = f.mock.check(after);
					const moved = landed(f, CUT_LANE, after);
					debugDiff(CUT_LANE, before, after);
					console.log(
						`AUDIT-CUT Pi/OMP | mid tool loop: ${error ?? "accepted"}; cutMoved=${moved}`,
					);
					if (!GOLDEN && !STRICT_AUDIT) {
						expect(moved).toBe(true);
						expect(error).toBe(PREFIX_ERROR);
						return;
					}
					expect(error).toBeNull();
					expect(moved).toBe(false);
					expect(withoutThinking(after)).toBe(withoutThinking(before));
					expect(wire((await f.pass()).messages)).toEqual(after);
					f.served = afterMessages;
					await toolLoop(f, 2);
					// The rewrite is ride-only: it lands with the next prefix render, which this
					// fixture does not offer, so the next turn must only stay valid.
					await nextUserTurn(f, "prompt-release");
					expect(f.mock.check(wire(f.served))).toBeNull();
				},
				"cut-mid-loop",
			),
		);
		it(
			`${CUT_LANE}: defer pass at a new user turn`,
			withFixture(
				false,
				CUT_LANE,
				async (f) => {
					await prepareLane(f, CUT_LANE);
					await toolLoop(f, 4);
					await nextUserTurn(f, "prompt-next");
					const before = wire(f.served);
					armAndBust(f, CUT_LANE, false);
					const afterMessages = (await f.pass()).messages;
					const after = wire(afterMessages);
					const error = f.mock.check(after);
					const moved = landed(f, CUT_LANE, after);
					console.log(
						`AUDIT-CUT Pi/OMP | defer pass at a new user turn: ${error ?? "accepted"}; cutMoved=${moved}`,
					);
					// No current-turn thinking yet, but the previous turn's signed blocks are
					// still sent, and a defer pass strips none of them.
					if (!GOLDEN && !STRICT_AUDIT) {
						expect(moved).toBe(true);
						expect(error).toBe(PREFIX_ERROR);
						return;
					}
					expect(error).toBeNull();
					expect(moved).toBe(false);
					expect(withoutThinking(after)).toBe(withoutThinking(before));
					f.served = afterMessages;
					await toolLoop(f, 2);
				},
				"cut-new-turn",
			),
		);
	});
}

describe("signed prefix parking: Pi/OMP", () => {
	for (const trigger of [
		"flush-and-force",
		"held-execute",
		"first-render",
	] as const) {
		it(
			`${trigger} is not a standing permission`,
			withFixture(
				false,
				"/ctx-flush",
				async (f) => {
					await toolLoop(f, 4);
					queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
					if (trigger === "first-render") {
						clearCachedM0M1(f.db, f.sessionId);
					} else {
						if (trigger === "flush-and-force")
							signalPiPendingMaterialization(f.sessionId);
						f.setPercent(trigger === "held-execute" ? 76 : 85);
						f.served = (await f.pass()).messages;
						expect(f.mock.check(wire(f.served))).toBeNull();
						expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
						if (trigger === "held-execute") f.setPercent(20);
						else signalPiPendingMaterialization(f.sessionId);
					}
					let gate:
						| { shouldApplyPendingOps: boolean; shouldRunHeuristics: boolean }
						| undefined;
					const stop = __test.setMutationGateObserverForTests((snapshot) => {
						gate = snapshot;
					});
					try {
						const held = await f.pass();
						expect(gate?.shouldApplyPendingOps).toBe(false);
						expect(gate?.shouldRunHeuristics).toBe(false);
						expect(hasPendingMaterialization(f.sessionId)).toBe(true);
						expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
						if (trigger !== "first-render") {
							expect(held.bustedThisPass).toBe(false);
							expect(f.mock.check(wire(held.messages))).toBeNull();
						}
						expect(wire((await f.pass()).messages)).toEqual(
							wire(held.messages),
						);
						f.userTurn(
							`parking-release-${trigger}`,
							"Continue the parser work.",
						);
						const release = await f.pass();
						expect(gate?.shouldApplyPendingOps).toBe(true);
						expect(release.bustedThisPass).toBe(true);
						expect(f.mock.check(wire(release.messages))).toBeNull();
						expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
						expect(hasPendingMaterialization(f.sessionId)).toBe(false);
						expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
						expect((await f.pass()).bustedThisPass).toBe(false);
					} finally {
						stop();
					}
				},
				`parking-${trigger}`,
			),
		);
	}

	it(
		"parked force cancels when pressure ends with no bust",
		withFixture(
			false,
			"ctx_reduce drop (full removal)",
			async (f) => {
				await toolLoop(f, 4);
				queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
				f.setPercent(85);
				f.served = (await f.pass()).messages;
				expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
				f.setPercent(20);
				const cancelled = await f.pass();
				expect(cancelled.bustedThisPass).toBe(false);
				expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
				expect(f.mock.check(wire(cancelled.messages))).toBeNull();
				f.userTurn("cancelled-release", "Continue the parser work.");
				const next = await f.pass();
				expect(next.bustedThisPass).toBe(false);
				expect(f.mock.check(wire(next.messages))).toBeNull();
				expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
			},
			"parking-cancelled",
		),
	);
});

describe("step2b review: Pi/OMP", () => {
	for (const subagent of [false, true]) {
		it(
			`model switch releases held work without a new user (${subagent ? "subagent" : "primary"})`,
			withFixture(
				subagent,
				"/ctx-flush",
				async (f) => {
					await toolLoop(f, 4);
					queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
					f.setPercent(76);
					f.served = (await f.pass()).messages;
					f.setPercent(20);
					expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
					expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
					for (let i = 0; i < 3; i++) {
						const held = await f.pass();
						expect(held.bustedThisPass).toBe(false);
						expect(wire(held.messages)).toEqual(wire(f.served));
					}
					f.setModel("claude-opus-4-6");
					const release = await f.pass();
					expect(release.bustedThisPass).toBe(true);
					expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
					expect(hasPendingMaterialization(f.sessionId)).toBe(false);
					expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
					expect((await f.pass()).bustedThisPass).toBe(false);
				},
				`review-model-${subagent}`,
			),
		);
	}
	it(
		"85 parking does not disable the live 95 wall",
		withFixture(
			false,
			"/ctx-flush",
			async (f) => {
				await toolLoop(f, 4);
				queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
				signalPiPendingMaterialization(f.sessionId);
				f.setPercent(85);
				f.served = (await f.pass()).messages;
				expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
				f.setPercent(90);
				const held = await f.pass();
				expect(held.bustedThisPass).toBe(false);
				expect(wire(held.messages)).toEqual(wire(f.served));
				f.setPercent(95);
				const wall = await f.pass();
				expect(wall.bustedThisPass).toBe(true);
				expect(f.mock.check(wire(wall.messages))).toBeNull();
				expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
				expect(hasPiParkedBustTrigger(f.sessionId)).toBe(true);
				f.userTurn("review-wall-release", "Continue.");
				const release = await f.pass();
				expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
				expect(f.mock.check(wire(release.messages))).toBeNull();
				f.setPercent(20);
				expect((await f.pass()).bustedThisPass).toBe(false);
			},
			"review-wall",
		),
	);
	it(
		"pending signal with no held work drains normally",
		withFixture(
			false,
			"/ctx-flush",
			async (f) => {
				expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
				signalPiPendingMaterialization(f.sessionId);
				const result = await f.pass();
				expect(f.mock.hasCurrentTurnThinking(wire(result.messages))).toBe(
					false,
				);
				expect(hasPendingMaterialization(f.sessionId)).toBe(false);
				expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
				expect((await f.pass()).bustedThisPass).toBe(false);
			},
			"review-empty-signal",
		),
	);
});

it(
	"step2b review: Pi/OMP empty subagent flush leaves no standing signal under thinking",
	withFixture(
		true,
		"/ctx-flush",
		async (f) => {
			await toolLoop(f, 4);
			expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
			signalPiPendingMaterialization(f.sessionId);
			const pass = await f.pass();
			expect(f.mock.check(wire(pass.messages))).toBeNull();
			expect(hasPendingMaterialization(f.sessionId)).toBe(false);
			expect(hasPiParkedBustTrigger(f.sessionId)).toBe(false);
			expect((await f.pass()).bustedThisPass).toBe(false);
		},
		"review-empty-subagent",
		false,
	),
);
