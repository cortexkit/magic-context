// Review witness driven through the real Pi context handler: the history cut
// on the pass after the head is rebuilt over a summary that ends on a hidden
// failed reply. The test states the property it checks and is expected to fail
// on the code it was written against; see
// .cortexkit/internal-docs/audits/issue-938-cut-review.md for the findings.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiHistoryRefresh,
} from "./context-handler";
import { clearPiOrdinalAlignmentSession } from "./pi-ordinal-alignment";
import { convertEntriesToRawMessages } from "./read-session-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";

type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: Record<string, unknown>;
	[key: string]: unknown;
};

type Served = Record<string, unknown>[];

const WINDOW = 983_040;
const READING = 669_065;
const T0 = 1_700_000_000_000;
const TURNS = 40;
const LIVE_PROMPT = "make one more";

// One turn: a prompt, a tool call, its result, an answer.
function turn(n: number, parentId: string | null): Entry[] {
	const t = T0 + n * 10_000;
	const at = (offset: number) => new Date(t + offset).toISOString();
	const meta = {
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-3.8-flash",
		usage: {},
	};
	return [
		{
			type: "message",
			id: `u${n}`,
			parentId,
			timestamp: at(0),
			message: { role: "user", content: `make image ${n}`, timestamp: t },
		},
		{
			type: "message",
			id: `a${n}`,
			parentId: `u${n}`,
			timestamp: at(1),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: `c${n}`,
						name: "generate_image",
						arguments: { prompt: `image ${n}` },
					},
				],
				...meta,
				stopReason: "toolUse",
				timestamp: t + 1,
			},
		},
		{
			type: "message",
			id: `r${n}`,
			parentId: `a${n}`,
			timestamp: at(2),
			message: {
				role: "toolResult",
				toolCallId: `c${n}`,
				toolName: "generate_image",
				content: [{ type: "text", text: `generated image ${n}` }],
				isError: false,
				timestamp: t + 2,
			},
		},
		{
			type: "message",
			id: `f${n}`,
			parentId: `r${n}`,
			timestamp: at(3),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `here is image ${n}` }],
				...meta,
				stopReason: "stop",
				timestamp: t + 3,
			},
		},
	];
}

/**
 * A branch with a host compaction entry (its summary message leads the
 * context), the live prompt, and a failed reply a `context_edit` hides from
 * the context before Pi retries.
 */
function hostSession() {
	const branch: Entry[] = [];
	let parent: string | null = null;
	for (let n = 0; n < TURNS; n++) {
		const next = turn(n, parent);
		branch.push(...next);
		parent = next.at(-1)?.id ?? parent;
	}
	const tLate = T0 + TURNS * 10_000;
	const summary = "[Host compaction checkpoint]\nOlder context was reduced.";
	branch.push({
		type: "compaction",
		id: "cmp1",
		parentId: parent,
		timestamp: new Date(tLate).toISOString(),
		summary,
		firstKeptEntryId: "u0",
		tokensBefore: 900_000,
	});
	branch.push({
		type: "message",
		id: "u-new",
		parentId: "cmp1",
		timestamp: new Date(tLate + 1).toISOString(),
		message: { role: "user", content: LIVE_PROMPT, timestamp: tLate + 1 },
	});
	branch.push({
		type: "message",
		id: "a-err",
		parentId: "u-new",
		timestamp: new Date(tLate + 2).toISOString(),
		message: {
			role: "assistant",
			content: [],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-3.8-flash",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			},
			stopReason: "error",
			errorMessage: "503 overloaded",
			timestamp: tLate + 2,
		},
	});
	branch.push({
		type: "context_edit",
		id: "edit-1",
		parentId: "a-err",
		timestamp: new Date(tLate + 3).toISOString(),
		targetId: "a-err",
		replacement: null,
	});
	const visible = branch
		.filter((entry) => entry.type === "message" && entry.id !== "a-err")
		.map((entry) => entry.message as Record<string, unknown>);
	const summaryMessage = {
		role: "compactionSummary",
		summary,
		tokensBefore: 900_000,
		timestamp: tLate,
	};
	return { branch, messages: [summaryMessage, ...visible] };
}

function roles(messages: Served): string[] {
	return messages.map((message) => String(message.role));
}

/** Store one compartment covering the raw branch from `fromId` through `endId`. */
function addSummary(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	branch: Entry[],
	sequence: number,
	fromId: string | null,
	endId: string,
) {
	const raw = convertEntriesToRawMessages(branch as never);
	const start = fromId
		? raw.findIndex((message) => message.id === fromId) + 1
		: 0;
	const end = raw.find((message) => message.id === endId);
	if (!end || start < 0) throw new Error(`no raw message ${endId}`);
	appendCompartments(db, sessionId, [
		{
			sequence,
			startMessage: raw[start]?.ordinal ?? 1,
			endMessage: end.ordinal,
			startMessageId: raw[start]?.id ?? "",
			endMessageId: endId,
			title: `Summary ${sequence}`,
			content: `Summary ${sequence}.`,
			p1: `Summary ${sequence}.`,
		},
	]);
	updateSessionMeta(db, sessionId, {
		lastResponseTime: Date.now(),
		cacheTtl: "59m",
		piStableIdScheme: 1,
	});
}

function createHost(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	branch: Entry[],
	systemPrompt: { text: string },
) {
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => [
			{
				name: "generate_image",
				description: "Make an image",
				parameters: { type: "object" },
			},
		],
		getActiveTools: () => ["generate_image"],
	});
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 20,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		heuristics: {},
		scheduler: {
			executeThresholdPercentage: 35,
			executeThresholdTokens: { default: 150_000 },
		},
	});
	const handler = fake.handlers.get("context") as (
		event: unknown,
		ctx: unknown,
	) => Promise<{ messages: unknown[] } | undefined>;
	const ctx = {
		...fakeContext(sessionId),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		getSystemPrompt: () => systemPrompt.text,
		model: {
			provider: "google",
			id: "gemini-3.8-flash",
			api: "google-generative-ai",
			contextWindow: WINDOW,
		},
		getContextUsage: () => ({
			tokens: READING,
			percent: (READING / WINDOW) * 100,
			contextWindow: WINDOW,
		}),
	};
	return async (messages: Record<string, unknown>[]): Promise<Served> => {
		const event = { messages: structuredClone(messages) };
		const result = await handler(event, ctx);
		return (result?.messages ?? event.messages) as Served;
	};
}

const sessions = new Set<string>();

afterEach(() => {
	mock.restore();
	for (const sessionId of sessions) {
		clearContextHandlerSession(sessionId);
		clearPiOrdinalAlignmentSession(sessionId);
	}
	sessions.clear();
	resetLkgSlotsForTest();
});

function session(name: string) {
	const sessionId = `review938-${name}`;
	sessions.add(sessionId);
	return sessionId;
}

function captureSessionLog(): string[] {
	const lines: string[] = [];
	spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
		lines.push(parts.map(String).join(" "));
	});
	return lines;
}

describe("history cut across a head rebuild, through the context handler", () => {
	test("the pass after the head is rebuilt over a summary ending on a hidden reply replays the rebuild pass's request", async () => {
		const lines = captureSessionLog();
		const sessionId = session("rebuild-then-replay");
		const db = createTestDb();
		try {
			const { branch, messages } = hostSession();
			const systemPrompt = { text: "You are an image agent." };
			// The first summary ends on a visible answer, found by id.
			addSummary(db, sessionId, branch, 0, null, "f20");
			const serve = createHost(db, sessionId, branch, systemPrompt);
			const first = await serve(messages);
			// The historian publishes a summary that ends on the hidden failed reply.
			addSummary(db, sessionId, branch, 1, "f20", "a-err");
			signalPiHistoryRefresh(sessionId);
			// A changed system prompt rebuilds the head over both summaries.
			systemPrompt.text = "You are an image agent. Be brief.";
			const rebuild = await serve(messages);
			// Nothing changes before the next pass, so it must replay those bytes.
			const next = await serve(messages);
			const after = await serve(messages);
			console.log(
				[
					`first pass roles: ${roles(first).join(",")}`,
					`rebuild pass roles: ${roles(rebuild).join(",")}`,
					`next pass roles: ${roles(next).join(",")}`,
					`pass after that roles: ${roles(after).join(",")}`,
					...lines.filter((line) =>
						/HARD fold|injected m\[0\]|transform completed|served check|history cut/.test(
							line,
						),
					),
				].join("\n"),
			);
			expect(roles(rebuild).length).toBeLessThan(roles(first).length);
			expect(next).toEqual(rebuild);
		} finally {
			closeQuietly(db);
		}
	}, 120_000);
});
