import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	isUntaggedAssistantText,
	TEXT_TAG_IDENTITY_MARKER,
	tagTranscript,
} from "@magic-context/core/shared/tag-transcript";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

// Gemini's stream (pi-antigravity, among others) leaves an empty text block
// after a function call, so a reply that says something before calling a tool
// arrives as [text, toolCall, text("")]. Tagging skips that blank block, so it
// has no stored row. The text identity check must skip it the same way, or the
// reply counts as changed on the next pass, its tag is renumbered and the
// rewritten prefix breaks the provider's prompt cache on every tool turn.

const { dir: root, cleanup } = createTestTempDir("mc-issue-948-");
const keys = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys) {
	process.env[key] = join(root, key);
	mkdirSync(process.env[key] as string, { recursive: true });
}
afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanup();
});

const model = {
	provider: "antigravity",
	id: "gemini-4-hydrogen",
	api: "google-gemini-cli",
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const user = (text: string, timestamp: number): PiMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp }) as PiMessage;

/** A Gemini tool-calling reply: visible text, the call, then the empty block. */
const geminiReply = (text: string, callId: string, timestamp: number) =>
	assistantMessage("unused", timestamp, {
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		content: [
			{ type: "text", text },
			{
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: { path: callId },
			},
			{ type: "text", text: "" },
		],
	});

const toolResult = (callId: string, timestamp: number): PiMessage =>
	({
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: `contents of ${callId}\n`.repeat(40) }],
		isError: false,
		timestamp,
	}) as PiMessage;

const REPLIES = [
	"Checking the parser first.",
	"Now the lexer.",
	"And the tests.",
];

/** The history after `turns` tool turns, each a reply and its result. */
function history(turns: number, replies = REPLIES): PiMessage[] {
	const messages: PiMessage[] = [user("Fix the parser bug.", 1)];
	for (let turn = 0; turn < turns; turn += 1) {
		const callId = `call_${turn + 1}`;
		messages.push(
			geminiReply(replies[turn] ?? "", callId, 2 + turn * 2),
			toolResult(callId, 3 + turn * 2),
		);
	}
	return messages;
}

const textOf = (message: unknown, index: number): string | undefined =>
	(message as { content?: Array<{ text?: string }> }).content?.[index]?.text;

async function runTurns(sessionId: string, histories: PiMessage[][]) {
	const db = createTestDb();
	const fake = createFakePi();
	const handler = fake.handlers;
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const context = handler.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] } | undefined>;
	const served: unknown[][] = [];
	try {
		for (const raw of histories) {
			const messages = structuredClone(raw);
			const ctx = {
				...fakeContext(
					sessionId,
					root,
					messages.map((_, index) => `e${index}`),
					messages,
				),
				model,
			};
			const result = await context({ messages }, ctx);
			expect(result?.messages).toBeDefined();
			served.push(JSON.parse(JSON.stringify(result?.messages)));
		}
		const textTags = getTagsBySession(db, sessionId)
			.filter((tag) => tag.type === "message")
			.map((tag) => tag.messageId);
		return { served, textTags };
	} finally {
		clearContextHandlerSession(sessionId);
		await drainPiTagSnapshotSession(sessionId);
		db.close();
	}
}

describe("a reply with visible text and a trailing empty text block", () => {
	test("keeps its tag across later tool turns, so every served request only appends", async () => {
		const { served, textTags } = await runTurns("issue-948-append-only", [
			history(1),
			history(2),
			history(3),
		]);
		expect(served.map((messages) => messages.length)).toEqual([3, 5, 7]);
		for (let pass = 1; pass < served.length; pass += 1) {
			const before = served[pass - 1] as unknown[];
			const after = served[pass] as unknown[];
			// Every message the previous request sent goes out byte for byte again.
			expect(JSON.stringify(after.slice(0, before.length))).toBe(
				JSON.stringify(before),
			);
		}
		const firstReply = textOf(served[2]?.[1], 0);
		expect(firstReply).toMatch(/^§\d+§ Checking the parser first\.$/);
		expect(textOf(served[0]?.[1], 0)).toBe(firstReply);
		// The trailing blank is never tagged, and no reply moved to a
		// content-derived identity.
		expect(textOf(served[2]?.[1], 2)).toBe("");
		expect(
			textTags.filter((id) => id.includes(TEXT_TAG_IDENTITY_MARKER)),
		).toEqual([]);
		expect(textTags.filter((id) => id.startsWith("e1:"))).toEqual(["e1:p0"]);
	});

	test("still gets a new tag when its visible text really changed", async () => {
		const edited = [
			"Checking the parser and the grammar first.",
			...REPLIES.slice(1),
		];
		const { served, textTags } = await runTurns("issue-948-real-edit", [
			history(1),
			history(2, edited),
		]);
		const before = textOf(served[0]?.[1], 0);
		const after = textOf(served[1]?.[1], 0);
		expect(before).toMatch(/^§\d+§ Checking the parser first\.$/);
		expect(after).toMatch(
			/^§\d+§ Checking the parser and the grammar first\.$/,
		);
		const number = (text: string | undefined) =>
			Number(/^§(\d+)§/.exec(text ?? "")?.[1]);
		expect(number(after)).toBeGreaterThan(number(before));
		expect(
			textTags.filter(
				(id) => id.startsWith("e1") && id.includes(TEXT_TAG_IDENTITY_MARKER),
			),
		).toHaveLength(1);
	});
});

describe("Pi text identity check and untagged assistant text", () => {
	const reply = (...texts: string[]) =>
		assistantMessage("unused", 2, {
			content: texts.map((text) => ({ type: "text", text })),
		});

	/** Tag `seed`, then plan the next pass over `current` for the same entry. */
	function planAfter(seed: PiMessage, current: PiMessage) {
		const db = createTestDb();
		const sessionId = `issue-948-plan-${Math.random()}`;
		try {
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const seeded = createPiTranscript([seed], sessionId, ["entry-m"]);
			tagTranscript(sessionId, seeded, tagger, db, {
				preserveTagOnlyAssistantText: true,
			});
			seeded.commit();
			const plan = contextHandlerInternals.buildPiTextIdentityPlan(
				db,
				sessionId,
				tagger,
				createPiTranscript([current], sessionId, ["entry-m"]),
				new Set(["entry-m"]),
			);
			return {
				drifted: plan.driftedMessageIds.has("entry-m"),
				reusable: plan.reusableMessageIds.has("entry-m"),
				rows: [...tagger.getAssignments(sessionId).keys()],
			};
		} finally {
			closeQuietly(db);
			clearContextHandlerSession(sessionId);
		}
	}

	const unchanged: Array<[string, string[]]> = [
		["a trailing empty block", ["Checking the parser.", ""]],
		["a leading empty block", ["", "Checking the parser."]],
		["a whitespace-only block", ["Checking the parser.", "\n  "]],
		["a block holding only a tag", ["Checking the parser.", "§12§ "]],
		["a block holding only tag notation", ["Checking the parser.", "§7"]],
		["blocks between two texts", ["First.", "", "Second.", " "]],
	];
	for (const [name, texts] of unchanged)
		test(`an unchanged reply with ${name} is not drifted`, () => {
			const result = planAfter(reply(...texts), reply(...texts));
			expect(result.rows.length).toBeLessThan(texts.length);
			expect(result.drifted).toBe(false);
			expect(result.reusable).toBe(true);
		});

	const drifted: Array<[string, string[], string[]]> = [
		[
			"edited visible text",
			["Checking the parser.", ""],
			["Checking the lexer.", ""],
		],
		[
			"an empty block that now holds text",
			["Checking the parser.", ""],
			["Checking the parser.", "More."],
		],
		[
			"text that moved past an empty block",
			["Checking the parser.", ""],
			["", "Checking the parser."],
		],
		[
			"a removed leading empty block",
			["", "Checking the parser."],
			["Checking the parser."],
		],
		[
			"a tagged text that is now empty",
			["Checking the parser.", "More."],
			["Checking the parser.", ""],
		],
	];
	for (const [name, seed, current] of drifted)
		test(`a reply with ${name} is drifted`, () => {
			const result = planAfter(reply(...seed), reply(...current));
			expect(result.drifted).toBe(true);
			expect(result.reusable).toBe(false);
		});

	test("user text is never treated as untagged", () => {
		expect(isUntaggedAssistantText("user", "", true)).toBe(false);
		expect(isUntaggedAssistantText("assistant", "", true)).toBe(true);
		expect(isUntaggedAssistantText("assistant", "§7", true)).toBe(true);
		expect(isUntaggedAssistantText("assistant", "§7", false)).toBe(false);
		expect(isUntaggedAssistantText("assistant", "Hi §7", true)).toBe(false);
	});
});
