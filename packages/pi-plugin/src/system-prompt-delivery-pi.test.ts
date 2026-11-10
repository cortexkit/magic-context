import { expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
	signalPiSystemHashChange,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	heavyReasoningUsage,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

let count = 0;
async function fixture() {
	const sessionId = `pi-system-delivery-${++count}`;
	const db = createTestDb();
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		piStableIdScheme: 1,
		lastResponseTime: Date.now(),
		cacheTtl: "never",
	});
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => [
			{ name: "read", description: "Read", parameters: { type: "object" } },
		],
		getActiveTools: () => ["read"],
	});
	registerPiContextHandler(fake.pi as never, {
		db,
		tagger: createTagger(),
		protectedTokens: 4000,
		injection: {
			injectionBudgetTokens: 1000,
			memoryEnabled: false,
			injectDocs: false,
		},
		protectedTools: { read: 0 },
		heuristics: { keepReasoningTokens: 2000 },
		scheduler: { executeThresholdPercentage: 65 },
	});
	let model = "claude-opus-5-5";
	const extra = (content: unknown[]) => ({
		provider: "anthropic",
		model,
		api: "anthropic-messages",
		content,
	});
	const source: PiMessage[] = [
		userMessage("earlier task", 1),
		assistantMessage(
			"",
			2,
			extra([
				{
					type: "toolCall",
					id: "old-call",
					name: "read",
					arguments: { path: "old.ts" },
				},
			]),
		),
		toolResultMessage("old-call", "historical result", 3),
		userMessage("current task", 40),
	];
	const ids = ["old-prompt", "old-answer", "old-result", "prompt"];
	for (let i = 0; i < 12; i++) {
		source.splice(
			source.length - 1,
			0,
			assistantMessage(
				"",
				10 + i * 2,
				extra([
					{
						type: "toolCall",
						id: `old-call-${i}`,
						name: "read",
						arguments: { path: `old-${i}.ts` },
					},
				]),
			),
			toolResultMessage(`old-call-${i}`, "earlier result", 11 + i * 2),
		);
		ids.splice(ids.length - 1, 0, `old-tool-${i}`, `old-tool-result-${i}`);
	}
	const pair = () => {
		const meta = getOrCreateSessionMeta(db, sessionId);
		return `${meta.cachedM0Bytes}\u0000${meta.cachedM1Bytes}`;
	};
	const serve = async (text = "base instruction", date = "2026-10-13") => {
		const prompt = processSystemPromptForCache({
			db,
			sessionId,
			systemPrompt: `${text}\n<plugin-env>\n  Date: ${date}\n</plugin-env>`,
			isCacheBusting: false,
		});
		if (prompt.hashChanged)
			signalPiSystemHashChange(sessionId, prompt.currentHash);
		const messages = structuredClone(source);
		const parentId = ids.at(-1) ?? null;
		const branch: unknown[] = ids.map((id, index) => ({
			type: "message",
			id,
			message: messages[index],
		}));
		const ctx = {
			...fakeContext(sessionId, process.cwd(), [...ids], messages),
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => parentId,
				getBranch: () => branch,
			},
			getSystemPrompt: () => prompt.systemPrompt,
			model: {
				provider: "anthropic",
				id: model,
				api: "anthropic-messages",
				contextWindow: 200000,
			},
			getContextUsage: () => ({
				tokens: 20000,
				percent: 10,
				contextWindow: 200000,
			}),
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler was not registered");
		const served = (await handler({ messages } as never, ctx as never)) as {
			messages: unknown[];
		};
		return {
			...served,
			prompt,
			accept: async (finish = "toolUse") => {
				const message = {
					role: "assistant",
					timestamp: Date.now() + 1,
					provider: "anthropic",
					model,
					stopReason: finish,
					usage: { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0 },
				};
				branch.push({
					type: "message",
					id: `response-${message.timestamp}`,
					parentId,
					message,
				});
				return persistPiPressureFromMessageEnd({
					db,
					sessionId,
					piContextWindow: 200000,
					message,
				});
			},
		};
	};
	// A heavy signed step: the bounded hold keeps the turn's prefix while
	// usage stays below the cap (65% + 10).
	const hold = () => {
		source.push(
			assistantMessage("", 50, {
				...extra([
					{
						type: "thinking",
						thinking: "active plan",
						thinkingSignature: "kept-signature",
					},
					{
						type: "toolCall",
						id: "active-call",
						name: "read",
						arguments: { path: "current.ts" },
					},
				]),
				usage: heavyReasoningUsage(),
			}),
			toolResultMessage("active-call", "current result ".repeat(8000), 51),
		);
		ids.push("thinking", "result");
	};
	const wake = () => {
		source.push(userMessage("continue", 60));
		ids.push("wake");
	};
	return {
		db,
		sessionId,
		source,
		ids,
		serve,
		hold,
		wake,
		pair,
		model: (value: string) => {
			model = value;
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			clearPiSystemPromptSession(sessionId);
			db.close();
		},
	};
}

it("Pi: already_delivered_system_change_does_not_hard_after_signed_head_hold", async () => {
	const f = await fixture();
	try {
		await (await f.serve()).accept("stop");
		f.hold();
		const baseline = await f.serve();
		await baseline.accept();
		const prefix = f.pair();
		const target = getTagsBySession(f.db, f.sessionId)
			.sort((a, b) => a.tagNumber - b.tagNumber)
			.find((tag) => tag.type === "tool");
		expect(target).toBeDefined();
		if (!target) throw new Error("historical drop target was not tagged");
		queuePendingOp(f.db, f.sessionId, target.tagNumber, "drop");
		const held = await f.serve("genuine changed instruction");
		expect(f.pair()).toBe(prefix);
		// The held turn's signed thinking is invalid behind the new prompt, which
		// already loses the provider cache: the thinking is stripped, and the
		// queued drop rides this request instead of buying a rewrite of its own
		// later. The head stays as the hold prepared it, delivered with the new
		// prompt.
		expect(JSON.stringify(held.messages)).not.toContain("active plan");
		expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
		expect(JSON.stringify(held.messages)).toContain("[dropped");
		const hash = held.prompt.currentHash;
		expect(
			getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash,
		).not.toBe(hash);
		await held.accept();
		expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(
			hash,
		);
		await (await f.serve("genuine changed instruction")).accept();
		f.wake();
		const wake = await f.serve("genuine changed instruction");
		// The delivered change folds nothing later; the landed drop replays.
		expect(f.pair()).toBe(prefix);
		expect(JSON.stringify(wake.messages)).toContain("[dropped");
		signalPiPendingMaterialization(f.sessionId, "user_flush");
		const flushed = await f.serve("genuine changed instruction");
		expect(getPendingOps(f.db, f.sessionId)).toHaveLength(0);
		expect(JSON.stringify(flushed.messages)).toContain("[dropped");
		const after = await f.serve("genuine changed instruction");
		expect(after.messages).toEqual(flushed.messages);
	} finally {
		f.close();
	}
}, 60_000);

for (const finish of ["aborted", "error", "unaccepted"]) {
	it(`Pi: ${finish} system request does not acknowledge`, async () => {
		const f = await fixture();
		try {
			await (await f.serve()).accept("stop");
			f.hold();
			await (await f.serve()).accept();
			const before = getOrCreateSessionMeta(
				f.db,
				f.sessionId,
			).cachedM0SystemHash;
			const held = await f.serve("genuine changed instruction");
			if (finish !== "unaccepted") await held.accept(finish);
			expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(
				before,
			);
			f.wake();
			await f.serve("genuine changed instruction");
			expect(
				getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash,
			).not.toBe(before);
		} finally {
			f.close();
		}
	}, 60_000);
}

it("Pi: plugin_env_date_only_change_stays_frozen_through_signed_head_hold", async () => {
	const f = await fixture();
	try {
		await (await f.serve()).accept("stop");
		f.hold();
		const before = await f.serve();
		await before.accept();
		const prefix = f.pair();
		const after = await f.serve("base instruction", "2026-10-14");
		expect(after.prompt.systemPrompt).toBe(before.prompt.systemPrompt);
		expect(after.prompt.currentHash).toBe(before.prompt.currentHash);
		expect(f.pair()).toBe(prefix);
	} finally {
		f.close();
	}
}, 60_000);

for (const [input, patch] of [
	["model", { cachedM0ModelKey: "anthropic/claude-opus-5-4" }],
	["renderer", { cachedM0UpgradeState: "previous-renderer" }],
	["workspace", { cachedM0ProjectIdentity: "previous-project" }],
] as const) {
	it(`Pi: delivered system identity cannot waive a simultaneous ${input} change`, async () => {
		const f = await fixture();
		try {
			await (await f.serve()).accept("stop");
			f.hold();
			await (await f.serve()).accept();
			updateSessionMeta(f.db, f.sessionId, patch);
			const held = await f.serve("changed instruction");
			await held.accept();
			const field =
				input === "model"
					? "cachedM0ModelKey"
					: input === "renderer"
						? "cachedM0UpgradeState"
						: "cachedM0ProjectIdentity";
			expect(getOrCreateSessionMeta(f.db, f.sessionId)[field]).toBe(
				Object.values(patch)[0],
			);
			f.wake();
			await f.serve("changed instruction");
			expect(getOrCreateSessionMeta(f.db, f.sessionId)[field]).not.toBe(
				Object.values(patch)[0],
			);
		} finally {
			f.close();
		}
	}, 60_000);
}

it("Pi: an unheld system edit folds on the first request", async () => {
	const f = await fixture();
	try {
		await (await f.serve()).accept("stop");
		const changed = await f.serve("changed instruction");
		expect(getOrCreateSessionMeta(f.db, f.sessionId).cachedM0SystemHash).toBe(
			changed.prompt.currentHash,
		);
	} finally {
		f.close();
	}
}, 60_000);
