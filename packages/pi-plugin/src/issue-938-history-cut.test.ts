// Pi history cut and history-head failures, driven through the real context
// handler (issue 938). A Pi session whose newest summary ends on a message the
// context event does not carry (a failed reply Pi hid before retrying) must
// still cut the summarized messages, even when the event also holds a host
// compaction summary. A pass whose history head cannot be inserted must not go
// out without head and cut.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
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
const IMAGE_BYTES = 20_000;
const LIVE_PROMPT = "make one more";

// One turn: a prompt, a tool call, its result carrying an image, an answer.
function turn(n: number, parentId: string | null): Entry[] {
	const t = T0 + n * 10_000;
	const at = (offset: number) => new Date(t + offset).toISOString();
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
				api: "google-generative-ai",
				provider: "google",
				model: "gemini-3.8-flash",
				usage: {},
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
				content: [
					{ type: "text", text: `generated image ${n}` },
					{
						type: "image",
						data: "A".repeat(IMAGE_BYTES),
						mimeType: "image/png",
					},
				],
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
				api: "google-generative-ai",
				provider: "google",
				model: "gemini-3.8-flash",
				usage: {},
				stopReason: "stop",
				timestamp: t + 3,
			},
		},
	];
}

/**
 * The branch Pi returns and the context it builds from it: kept turns, an
 * optional host compaction entry (whose summary message leads the context),
 * the live prompt, and a failed reply that a `context_edit` hides from the
 * context before Pi retries.
 */
function hostSession(withCompaction: boolean) {
	const branch: Entry[] = [];
	let parent: string | null = null;
	for (let n = 0; n < TURNS; n++) {
		const next = turn(n, parent);
		branch.push(...next);
		parent = next.at(-1)?.id ?? parent;
	}
	const tLate = T0 + TURNS * 10_000;
	let summaryMessage: Record<string, unknown> | undefined;
	if (withCompaction) {
		const summary =
			"[Deterministic compaction recovery checkpoint]\nOlder context was reduced without another provider request.";
		branch.push({
			type: "compaction",
			id: "cmp1",
			parentId: parent,
			timestamp: new Date(tLate).toISOString(),
			summary,
			firstKeptEntryId: "u0",
			tokensBefore: 900_000,
			details: { schema: "senpi.compaction.deterministic-fallback.v1" },
			fromHook: true,
		});
		parent = "cmp1";
		summaryMessage = {
			role: "compactionSummary",
			summary,
			tokensBefore: 900_000,
			timestamp: tLate,
		};
	}
	branch.push({
		type: "message",
		id: "u-new",
		parentId: parent,
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
			errorMessage: "413 status code (no body)",
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
	const messages = summaryMessage ? [summaryMessage, ...visible] : visible;
	return { branch, messages };
}

function imageBytes(messages: Served): number {
	let total = 0;
	for (const message of messages) {
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content)
			if ((part as { type?: string })?.type === "image")
				total += String((part as { data?: string }).data ?? "").length;
	}
	return total;
}

function roles(messages: Served): string[] {
	return messages.map((message) => String(message.role));
}

/** Store one compartment covering the branch through `endMessageId`. */
function seedSummary(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	branch: Entry[],
	endMessageId: string,
) {
	const raw = convertEntriesToRawMessages(branch as never);
	const end = raw.find((message) => message.id === endMessageId);
	if (!end) throw new Error(`no raw message ${endMessageId}`);
	appendCompartments(db, sessionId, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: end.ordinal,
			startMessageId: raw[0]?.id ?? "",
			endMessageId,
			title: "Everything",
			content: "Summary.",
			p1: "Summary.",
		},
	]);
	updateSessionMeta(db, sessionId, {
		lastResponseTime: Date.now(),
		cacheTtl: "59m",
		piStableIdScheme: 1,
	});
}

/** Register the real handler once; each call runs one pass on a fresh clone, as Pi clones its context. */
function createHost(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	branch: Entry[],
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
		getSystemPrompt: () => "You are an image agent.",
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
	const sessionId = `i938-${name}`;
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

describe("Pi history cut when the boundary message is missing from the context", () => {
	test("a host compaction summary in the context no longer stops the cut; the live prompt stays", async () => {
		captureSessionLog();
		const sessionId = session("6a");
		const db = createTestDb();
		try {
			const { branch, messages } = hostSession(true);
			seedSummary(db, sessionId, branch, "a-err");
			const serve = createHost(db, sessionId, branch);
			const served = await serve(messages);
			// The history head, then the live prompt. Every summarized turn, with
			// its image, is gone, and so is the host's summary before them, as the
			// id lookup would cut it.
			expect(roles(served)).toEqual(["user", "user", "user"]);
			expect(served[2]?.content).toBe(LIVE_PROMPT);
			expect(imageBytes(served)).toBe(0);
			// A later pass in the same state replays the same request.
			expect(await serve(messages)).toEqual(served);
		} finally {
			closeQuietly(db);
		}
	}, 120_000);

	test("a summary that ends inside the live turn keeps the live prompt", async () => {
		captureSessionLog();
		const sessionId = session("6b");
		const db = createTestDb();
		try {
			const { branch, messages } = hostSession(false);
			seedSummary(db, sessionId, branch, "a-err");
			const serve = createHost(db, sessionId, branch);
			const served = await serve(messages);
			expect(roles(served)).toEqual(["user", "user", "user"]);
			expect(served[2]?.content).toBe(LIVE_PROMPT);
			expect(imageBytes(served)).toBe(0);
		} finally {
			closeQuietly(db);
		}
	}, 120_000);

	test("a boundary found by id cuts exactly as before", async () => {
		captureSessionLog();
		const sessionId = session("6c");
		const db = createTestDb();
		try {
			const { branch, messages } = hostSession(true);
			seedSummary(db, sessionId, branch, "f39");
			const serve = createHost(db, sessionId, branch);
			const served = await serve(messages);
			// The id lookup removes everything up to the boundary, the host summary
			// included, and keeps exactly the event messages after it.
			const boundaryIndex = messages.findIndex(
				(message) =>
					message.role === "assistant" &&
					JSON.stringify(message.content).includes("here is image 39"),
			);
			expect(boundaryIndex).toBe(messages.length - 2);
			expect(roles(served)).toEqual(["user", "user", "user"]);
			expect(served.slice(2)).toEqual(messages.slice(boundaryIndex + 1));
			// Printed so a run against the code before the branch-position fallback
			// changed can be compared with a run after it: a boundary found by id
			// must produce the same digest in both.
			console.log(
				`id-found request sha256=${createHash("sha256").update(JSON.stringify(served)).digest("hex")}`,
			);
			expect(await serve(messages)).toEqual(served);
		} finally {
			closeQuietly(db);
		}
	}, 120_000);
});

describe("Pi history head insertion failure", () => {
	function failInjection() {
		return contextHandlerInternals.setInjectM0M1PiForTests(() => {
			throw new Error("simulated injection failure");
		});
	}

	test("refuses the turn instead of sending the session without head and cut", async () => {
		captureSessionLog();
		const sessionId = session("inject-refuse");
		const db = createTestDb();
		const restore = failInjection();
		try {
			const { branch, messages } = hostSession(false);
			seedSummary(db, sessionId, branch, "f20");
			const serve = createHost(db, sessionId, branch);
			const outcome = await serve(messages).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok)
				expect(outcome.error).toMatchObject({
					name: "PiDegradedPassError",
					site: "m0-m1-injection-degradation",
				});
		} finally {
			restore();
			closeQuietly(db);
		}
	}, 120_000);

	test("replays the last good request when one exists", async () => {
		captureSessionLog();
		const recoveryLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
				recoveryLines.push(line),
			);
		const sessionId = session("inject-replay");
		const db = createTestDb();
		try {
			const { branch, messages } = hostSession(false);
			// A summary through the last answer leaves a small request that fits
			// when it is replayed.
			seedSummary(db, sessionId, branch, "f39");
			const serve = createHost(db, sessionId, branch);
			const good = await serve(messages);
			expect(roles(good)).toEqual(["user", "user", "user"]);
			const restore = failInjection();
			try {
				const replayed = await serve(messages);
				expect(replayed).toEqual(good);
			} finally {
				restore();
			}
			expect(recoveryLines.join("\n")).toContain("LKG replay served");
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	}, 120_000);
});
