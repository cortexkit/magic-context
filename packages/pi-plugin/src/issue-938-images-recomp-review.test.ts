/**
 * Review witnesses for two Pi changes: tool results that carry images now count
 * each image at the per-image token cost, and `/ctx-recomp` stages a compaction
 * marker even when its rebuilt history reaches the newest message of the branch.
 *
 * Each witness states a cache contract and fails on this code. They are skipped
 * so the suite stays green; the review report under
 * .cortexkit/internal-docs/audits/ describes each one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	addProcessedImageStrippedIds,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { readExecuteReclaimState } from "@magic-context/core/hooks/magic-context/execute-reclaim";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import { stagePiRecompMarker } from "./pi-recomp-marker";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const model = {
	id: "deepseek-v4.1-flash-free",
	name: "issue-938-review",
	provider: "test",
	api: "openai-completions",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 100_000,
	maxTokens: 4096,
};

const SYSTEM_PROMPT = "Fixed system prompt.";

function image() {
	return {
		type: "image" as const,
		mimeType: "image/png",
		data: "iVBORw0KGgo".repeat(100),
	};
}

/**
 * A primary Pi session whose tool result for `call-2` carries a caption and
 * `images` images. The processed-image strip already froze that result, so
 * every request carries "[image stripped]" text in place of each image.
 * Execute threshold 75%, no summarizer configured, no protected tags.
 */
function strippedImageSession(images: number) {
	const db = createTestDb();
	const id = "ses-938-review-stripped-image";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		scheduler: { executeThresholdPercentage: 75 },
		injection: {
			injectionBudgetTokens: 40_000,
			historyBudgetTokens: 30_000,
			memoryEnabled: false,
			injectDocs: false,
			temporalAwareness: false,
		},
	});
	updateSessionMeta(db, id, {
		systemPromptHash: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
	});
	const raw: PiMessage[] = [
		userMessage("baseline request", 1),
		assistantMessage("baseline response", 2),
	];
	for (let i = 0; i < 16; i++) {
		const result = toolResultMessage(
			`call-${i}`,
			`File ${i}: preserving the content and order matters.\n`.repeat(10),
			5 + i * 4,
		);
		if (i === 2)
			Object.assign(result, {
				toolName: "generate_image",
				content: [
					{ type: "text", text: "Generated image saved to out/cat.png" },
					...Array.from({ length: images }, image),
				],
			});
		raw.push(
			userMessage(`request ${i}`, 3 + i * 4),
			assistantToolCall(
				`call-${i}`,
				i === 2 ? "generate_image" : "Read",
				{ path: `file-${i}.txt` },
				4 + i * 4,
			),
			result,
			assistantMessage(`answer ${i}`, 6 + i * 4),
		);
	}
	for (const message of raw) {
		if (message.role === "assistant")
			Object.assign(message, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
	}
	appendCompartments(db, id, [
		{
			sequence: 0,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "entry-0",
			endMessageId: "entry-1",
			title: "Baseline",
			content: "Existing history facts.\n".repeat(500),
			p1: "Existing history facts.\n".repeat(500),
		},
	]);
	// call-2's result is raw[12], entry-12: frozen by an earlier rebuild.
	expect(addProcessedImageStrippedIds(db, id, ["entry-12"])).toBe(true);
	return {
		db,
		id,
		async pass(percent: number) {
			updateSessionMeta(db, id, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: percent,
				lastInputTokens: percent * 1000,
			});
			const messages = structuredClone(raw);
			const ctx = {
				...fakeContext(
					id,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				model,
				getSystemPrompt: () => SYSTEM_PROMPT,
				getContextUsage: () => ({
					tokens: percent * 1000,
					percent,
					contextWindow: 100_000,
				}),
			};
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler was not registered");
			const result = (await handler({ messages } as never, ctx as never)) as
				| { messages: unknown[] }
				| undefined;
			if (!result) throw new Error("handler did not return messages");
			return JSON.stringify(result.messages);
		},
		queueImageDrop() {
			const tag = getTagsBySession(db, id).find(
				(t) =>
					t.type === "tool" &&
					t.status === "active" &&
					t.messageId === "call-2",
			);
			if (!tag) throw new Error("No active tool result for call-2");
			queuePendingOp(db, id, tag.tagNumber, "drop");
		},
		close() {
			clearContextHandlerSession(id);
			closeQuietly(db);
		},
	};
}

describe("issue 938 review: image accounting and the execute-pass bound", () => {
	// Invariant 4: the execute pass's queued-work bound counts only what the
	// drain can remove. A result whose images the strip already replaced with
	// "[image stripped]" frees a caption and three markers when dropped, about
	// twenty tokens, far below 2% of a 100,000-token window. Its stored
	// token_count still includes three images at 1,200 tokens each, because
	// tagging reads the host's unstripped result before the strip replays.
	// Skipped: fails on this code; passes with tag-transcript.ts as of v0.49.63.
	test.skip("WITNESS F1: a queued drop of an already-stripped image result does not justify an execute rebuild", async () => {
		const h = strippedImageSession(3);
		let rebuilds = 0;
		const restore = __test.setPipelineResultObserverForTests(
			(sessionId, result) => {
				if (sessionId === h.id && result.bustedThisPass) rebuilds++;
			},
		);
		try {
			const warm = await h.pass(40);
			expect(warm).toContain("[image stripped]");
			expect(warm).not.toContain("iVBORw0KGgo");
			const initialRebuilds = rebuilds;
			h.queueImageDrop();
			// First execute pass with only this drop queued: it must hold.
			expect(await h.pass(76)).toBe(warm);
			expect(rebuilds).toBe(initialRebuilds);
			expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(1);
		} finally {
			restore();
			h.close();
		}
	});
});

const sessionDirs: string[] = [];

function physicalContext(
	sessionManager: SessionManager,
	contextTokens: number,
) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: 100_000,
		},
		sessionManager,
		getContextUsage: () => ({
			tokens: contextTokens,
			percent: contextTokens / 1_000,
			contextWindow: 100_000,
		}),
	};
}

/**
 * Pi runs extension commands at once, even while a turn streams
 * (agent-session.js: "execute immediately, even during streaming"), and a full
 * `/ctx-recomp` covers every message of the branch it reads. Run during a turn,
 * its newest summary therefore ends inside that turn: on the prompt itself
 * while the first reply streams, or on a tool result between steps. With a
 * tool call still open, the recomp stops before that call, so the summary ends
 * on the prompt and the call is already on the branch it reads.
 */
async function midTurnRecomp(
	boundary: "prompt" | "tool-result" | "open-tool-call",
) {
	const sessionDir = join(tmpdir(), `mc-938-review-${crypto.randomUUID()}`);
	sessionDirs.push(sessionDir);
	const sessionId = `ses-938-review-mid-turn-${boundary}`;
	const sessionManager = SessionManager.create(process.cwd(), sessionDir, {
		id: sessionId,
	});
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		scheduler: { executeThresholdPercentage: 65 },
		injection: { injectionBudgetTokens: 10_000, temporalAwareness: false },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] }>;
	const pass = async (contextTokens: number) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: contextTokens / 1_000,
			lastInputTokens: contextTokens,
		});
		const input = structuredClone(
			sessionManager.buildSessionContext().messages,
		) as unknown[];
		return (
			await handler(
				{ messages: input },
				physicalContext(sessionManager, contextTokens),
			)
		).messages;
	};
	const base = Date.UTC(2026, 0, 1);
	const at = (n: number) => base + n * 60_000;
	try {
		const ids: string[] = [];
		for (let ordinal = 1; ordinal <= 10; ordinal++) {
			ids.push(
				sessionManager.appendMessage(
					(ordinal % 2 === 1
						? userMessage(
								`older request ${ordinal} ${"u".repeat(400)}`,
								at(ordinal),
							)
						: assistantMessage(
								`older answer ${ordinal} ${"a".repeat(400)}`,
								at(ordinal),
							)) as never,
				),
			);
		}
		const prompt = "LIVE PROMPT: refactor the parser module";
		ids.push(
			sessionManager.appendMessage(userMessage(prompt, at(11)) as never),
		);
		let endMessage = 11;
		let endMessageId = ids[10] as string;
		if (boundary === "tool-result") {
			sessionManager.appendMessage(
				assistantToolCall(
					"call-live",
					"Read",
					{ path: "parser.ts" },
					at(12),
				) as never,
			);
			const resultId = sessionManager.appendMessage(
				toolResultMessage(
					"call-live",
					"export function parse() {}",
					at(13),
				) as never,
			);
			endMessage = 13;
			endMessageId = `synth-user-${resultId}`;
		}
		if (boundary === "open-tool-call")
			sessionManager.appendMessage(
				assistantToolCall(
					"call-live",
					"Read",
					{ path: "parser.ts" },
					at(12),
				) as never,
			);
		// A first request before the recomp publishes.
		await pass(10_000);

		// The recomp's rebuilt history covers the whole branch it read.
		appendCompartments(db, sessionId, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage,
				startMessageId: ids[0] as string,
				endMessageId,
				title: "Rebuilt history",
				content: `Rebuilt history ${"c".repeat(800)}`,
			},
		]);
		stagePiRecompMarker({
			db,
			sessionId,
			branchEntries: sessionManager.getBranch(),
		});
		signalPiDeferredHistoryRefresh(sessionId);
		signalPiDeferredMaterialization(sessionId);

		// The turn goes on: what the recomp's snapshot did not include.
		if (boundary === "open-tool-call")
			sessionManager.appendMessage(
				toolResultMessage(
					"call-live",
					"export function parse() {}",
					at(13),
				) as never,
			);
		sessionManager.appendMessage(
			assistantMessage("Refactoring the parser now.", at(14)) as never,
		);
		const rebuild = await pass(70_000);

		// The next turn: only its new prompt may be appended.
		sessionManager.appendMessage(userMessage("next prompt", at(15)) as never);
		const next = await pass(10_000);
		return { prompt, rebuild, next };
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
}

describe("issue 938 review: the recomp marker of a summary that ends inside a turn", () => {
	// Two contracts meet here. The history cut keeps the prompt of the turn a
	// summary ends inside, so the model sees the prompt it is answering. And a
	// pass after a rebuild, without rebuild permission, sends the rebuild's
	// bytes plus new messages. The staged marker trims Pi's branch at the first
	// entry after the summary, which hides that prompt from every later pass.
	// Skipped: every variant fails on this code; each name says since when.
	const variants = {
		prompt: "new since v0.49.63: staged before its kept entry exists",
		"tool-result": "new since v0.49.63: staged before its kept entry exists",
		"open-tool-call": "fails in v0.49.63 too: the open call is the kept entry",
	} as const;
	for (const [boundary, reason] of Object.entries(variants) as Array<
		[keyof typeof variants, string]
	>) {
		test.skip(`WITNESS F2 (${boundary}; ${reason}): the pass after the marker lands keeps the rebuild's bytes and the turn's prompt`, async () => {
			try {
				const { prompt, rebuild, next } = await midTurnRecomp(boundary);
				expect(JSON.stringify(rebuild)).toContain(prompt);
				expect(JSON.stringify(next)).toContain(prompt);
				expect(next.slice(0, -1)).toEqual(rebuild);
			} finally {
				for (const dir of sessionDirs.splice(0))
					rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
