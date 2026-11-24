import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getTagsBySession,
	queuePendingOp,
	setPendingPiCompactionMarkerState,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	__test,
	awaitInFlightHistorians,
	clearContextHandlerSession,
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
	hasPendingMaterialization,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemHashChange,
} from "./context-handler";
import { signalPiDeferredCompactionMarkerDrain } from "./index";
import {
	injectM0M1Pi,
	materializeM0PiWithRetry,
} from "./inject-compartments-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const model = {
	id: "deepseek-v4.1-flash-free",
	name: "ride-evidence",
	provider: "test",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 4096,
};

// Each arm uses the same identities and serializer, but independent durable state.
// Small tool results keep automatic age reclaim from masking the queued drop.
export function rideHarness(inject = true, scenario?: "floor" | "small") {
	const db = createTestDb();
	const id = "ses-deferred-ride-evidence";
	const fake = createFakePi();
	let releaseHistorian: (() => void) | undefined;
	let historianRuns = 0;
	const historianWait = new Promise<void>((resolve) => {
		releaseHistorian = resolve;
	});
	const runner = {
		harness: "pi",
		run: async (options: { userMessage: string }) => {
			historianRuns++;
			await historianWait;
			const range = /Messages (\d+)-(\d+):/.exec(options.userMessage);
			if (!range)
				throw new Error("Historian prompt did not specify its message range");
			return {
				ok: true,
				assistantText: `<compartment start="${range[1]}" end="${range[2]}" title="Autonomous work"><p1>Completed the earlier work and verified the files.</p1></compartment>`,
				durationMs: 1,
			};
		},
	} as unknown as SubagentRunner;
	const register = () =>
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			scheduler: { executeThresholdPercentage: scenario ? 75 : 65 },
			historian:
				scenario === "floor"
					? {
							runner,
							model: "test/historian",
							historianChunkTokens: 10_000,
							executeThresholdPercentage: 75,
							memoryEnabled: false,
							twoPass: false,
						}
					: undefined,
			injection: inject
				? {
						injectionBudgetTokens: 40_000,
						historyBudgetTokens: 30_000,
						memoryEnabled: false,
						injectDocs: false,
						temporalAwareness: false,
					}
				: undefined,
		});
	register();
	let systemPrompt = "Fixed system prompt.";
	updateSessionMeta(db, id, {
		systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex"),
	});
	const raw = [
		userMessage("baseline request", 1),
		assistantMessage("baseline response", 2),
	];
	for (let i = 0; i < 16; i++) {
		raw.push(
			userMessage(`request ${i}`, 3 + i * 4),
			assistantToolCall(
				`call-${i}`,
				"Read",
				{ path: `file-${i}.txt` },
				4 + i * 4,
			),
			toolResultMessage(
				`call-${i}`,
				`File ${i}: preserving the content and order matters.\n`.repeat(10),
				5 + i * 4,
			),
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
	if (scenario === "floor") {
		for (let i = 2; i < raw.length; i++) {
			const message = raw[i];
			if (!message) continue;
			if (message.role === "user")
				Object.assign(message, {
					content:
						i === 2
							? "Implement the long autonomous task"
							: "<system-reminder>Continue working</system-reminder>",
				});
			if (
				message.role === "assistant" &&
				!(message as { content: { type: string }[] }).content.some(
					(p) => p.type === "toolCall",
				)
			)
				Object.assign(message, {
					content: [
						{
							type: "text",
							text: `Work phase ${i}: inspected and verified code. `.repeat(
								400,
							),
						},
					],
				});
		}
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
	return {
		db,
		id,
		get historianRuns() {
			return historianRuns;
		},
		async finishHistorian() {
			releaseHistorian?.();
			await awaitInFlightHistorians(id);
		},
		restart() {
			clearContextHandlerSession(id);
			register();
		},
		appendTurn(meaningful: boolean) {
			const timestamp = raw.length + 1000;
			raw.push(
				userMessage(
					meaningful
						? `New human instruction ${timestamp}`
						: "<system-reminder>Continue working</system-reminder>",
					timestamp,
				),
				Object.assign(
					assistantMessage(`Work continuation ${timestamp}`, timestamp + 1),
					{ api: model.api, provider: model.provider, model: model.id },
				),
			);
		},
		setSystemPrompt(prompt: string) {
			systemPrompt = prompt;
			const hash = createHash("sha256").update(prompt).digest("hex");
			updateSessionMeta(db, id, { systemPromptHash: hash });
			signalPiSystemHashChange(id, hash);
		},
		async pass(percent = 64) {
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
				getSystemPrompt: () => systemPrompt,
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
			return structuredClone(
				convertMessages(
					model as never,
					{
						systemPrompt,
						messages: result.messages,
					} as never,
					{ supportsDeveloperRole: false } as never,
				),
			);
		},
		publish(lines = 20) {
			appendCompartments(db, id, [
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 6,
					startMessageId: "entry-2",
					endMessageId: "entry-5",
					title: "Fresh publication",
					content: "Newly published facts about the first file.\n".repeat(
						lines,
					),
					p1: "Newly published facts about the first file.\n".repeat(lines),
				},
			]);
			signalPiDeferredHistoryRefresh(id);
			signalPiDeferredMaterialization(id);
		},
		queue() {
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
			db.close();
		},
	};
}

function firstDifference(previous: unknown[], next: unknown[]) {
	const index = previous.findIndex(
		(message, i) => JSON.stringify(message) !== JSON.stringify(next[i]),
	);
	return index < 0 && previous.length === next.length
		? null
		: index < 0
			? previous.length
			: index;
}

test("Pi wrapup serves the new summary and cut once without a pressure-backstop fold", async () => {
	const h = rideHarness();
	try {
		const before = await h.pass(40);
		expect(JSON.stringify(before)).toContain("File 0: preserving the content");
		expect(JSON.stringify(before)).not.toContain("Newly published facts");
		// The new summary is large enough that a normal rebuild would fold it into the baseline.
		h.publish(200);
		signalPiPendingMaterialization(h.id, "user_wrapup");
		const after = await h.pass(40);
		expect(JSON.stringify(after)).toContain("Newly published facts");
		expect(JSON.stringify(after)).not.toContain(
			"File 0: preserving the content",
		);
		expect(JSON.stringify(after)).toContain("File 1: preserving the content");
		expect(firstDifference(before, after)).toBe(2);
		expect(hasPendingMaterialization(h.id)).toBe(false);
		expect(JSON.stringify(await h.pass(40))).toBe(JSON.stringify(after));
	} finally {
		h.close();
	}
});

test("Pi wrapup keeps its grant when a soft refresh serves the old history head", async () => {
	const h = rideHarness();
	let writes = 0;
	let race = false;
	const restore = __test.setInjectM0M1PiForTests((state, ...args) =>
		injectM0M1Pi(
			{
				...state,
				beforeCacheCommitForTest: () => {
					if (!race || writes++ !== 0) return;
					h.db
						.query(
							"UPDATE session_meta SET cached_m0_materialized_at = cached_m0_materialized_at + 1 WHERE session_id = ?",
						)
						.run(h.id);
				},
			},
			...args,
		),
	);
	try {
		const before = JSON.stringify(await h.pass(40));
		h.publish();
		signalPiPendingMaterialization(h.id, "user_wrapup");
		race = true;
		expect(JSON.stringify(await h.pass(40))).toBe(before);
		expect(writes).toBe(1);
		expect(hasPendingMaterialization(h.id)).toBe(true);
		const after = JSON.stringify(await h.pass(40));
		expect(after).toContain("Newly published facts");
		expect(hasPendingMaterialization(h.id)).toBe(false);
		expect(JSON.stringify(await h.pass(40))).toBe(after);
	} finally {
		restore();
		h.close();
	}
});

test.each([
	"fold",
	"m[1]",
] as const)("Pi wrapup spends its grant when the replayed %s already covers the publication", async (writer) => {
	const h = rideHarness();
	let writes = 0;
	let restore: (() => void) | undefined;
	try {
		await h.pass(40);
		h.publish();
		if (writer === "m[1]") {
			signalPiPendingMaterialization(h.id, "user_flush");
			expect(JSON.stringify(await h.pass(40))).toContain(
				"Newly published facts",
			);
			await h.pass(40);
			await h.pass(40);
		}
		signalPiPendingMaterialization(h.id, "user_wrapup");
		restore = __test.setInjectM0M1PiForTests((state, ...args) =>
			injectM0M1Pi(
				{
					...state,
					beforeCacheCommitForTest: () => {
						if (writes++ !== 0) return;
						if (writer === "fold") {
							const fold = materializeM0PiWithRetry(state, h.db);
							expect(fold.m0).toContain("Newly published facts");
						} else {
							h.db
								.query(
									"UPDATE session_meta SET cached_m0_materialized_at = cached_m0_materialized_at + 1 WHERE session_id = ?",
								)
								.run(h.id);
						}
					},
				},
				...args,
			),
		);

		const served = JSON.stringify(await h.pass(40));
		expect(writes).toBe(1);
		expect(served).toContain("Newly published facts");
		expect(hasPendingMaterialization(h.id)).toBe(false);
		h.queue();
		expect(JSON.stringify(await h.pass(40))).toBe(served);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
	} finally {
		restore?.();
		h.close();
	}
});

type Kind = "publication" | "noop" | "marker-retry" | "flush";
async function differential(kind: Kind, queue: boolean) {
	const h = rideHarness();
	try {
		const previous = await h.pass(40);
		if (kind === "publication") h.publish();
		else if (kind === "marker-retry") {
			setPendingPiCompactionMarkerState(h.db, h.id, {
				firstKeptEntryId: "entry-2",
				endMessageId: "entry-1",
				ordinal: 2,
				tokensBefore: 0,
				summary: "Already rendered baseline",
				publishedAt: 1,
			});
			// This is the same rehydration helper used on startup; fakeContext has
			// getBranch but no appendCompaction, so journal application must retry.
			signalPiDeferredCompactionMarkerDrain(h.id);
		} else if (kind === "flush") {
			signalPiHistoryRefresh(h.id);
			// A system-origin request may precede the user's command. Both causes
			// must survive even though the first remains the diagnostic log label.
			signalPiPendingMaterialization(h.id, "system_hash");
			signalPiPendingMaterialization(h.id, "user_flush");
		} else {
			signalPiDeferredHistoryRefresh(h.id);
			signalPiDeferredMaterialization(h.id);
		}
		if (queue) h.queue();
		const next = await h.pass();
		const pending = getPendingOps(h.db, h.id).length;
		const warm = await h.pass();
		const markerPending =
			getPendingPiCompactionMarkerState(h.db, h.id) !== null;
		const historyPending = consumeDeferredHistoryRefresh(h.id);
		const materializationPending = consumeDeferredMaterialization(h.id);
		return {
			previous,
			next,
			warm,
			pending,
			markerPending,
			historyPending,
			materializationPending,
		};
	} finally {
		h.close();
	}
}

test("genuine publication admits a drop after m[1], then replays identical warm bytes", async () => {
	const withheld = await differential("publication", false);
	const applied = await differential("publication", true);
	expect(applied.previous).toEqual(withheld.previous);
	expect(firstDifference(withheld.previous, withheld.next)).toBe(2);
	expect(firstDifference(applied.previous, applied.next)).toBe(2);
	expect(firstDifference(withheld.next, applied.next)).toBeGreaterThan(2);
	expect(applied.next[1]).toEqual(applied.previous[1]);
	expect(applied.pending).toBe(0);
	expect(applied.warm).toEqual(applied.next);
	expect(withheld.warm).toEqual(withheld.next);
	expect(applied.historyPending || applied.materializationPending).toBe(false);
});

test("no-op deferred flags withhold the drop and preserve the exact served request", async () => {
	const result = await differential("noop", true);
	expect(result.next).toEqual(result.previous);
	expect(result.warm).toEqual(result.previous);
	expect(result.pending).toBe(1);
	expect(result.historyPending || result.materializationPending).toBe(false);
});

test("rehydrated marker retry withholds drops without stranding the durable marker", async () => {
	const result = await differential("marker-retry", true);
	expect(result.next).toEqual(result.previous);
	expect(result.warm).toEqual(result.previous);
	expect(result.pending).toBe(1);
	expect(result.markerPending).toBe(true);
	expect(result.historyPending || result.materializationPending).toBe(false);
});

test("a marker-only retry does not consume publication flags raised after preflight", async () => {
	const h = rideHarness();
	let release: (() => void) | undefined;
	try {
		await h.pass(40);
		setPendingPiCompactionMarkerState(h.db, h.id, {
			firstKeptEntryId: "entry-2",
			endMessageId: "entry-1",
			ordinal: 2,
			tokensBefore: 0,
			summary: "Already rendered baseline",
			publishedAt: 1,
		});
		release = __test.setMutationGateObserverForTests(() => {
			signalPiDeferredHistoryRefresh(h.id);
			signalPiDeferredMaterialization(h.id);
		});
		await h.pass();
		expect(consumeDeferredHistoryRefresh(h.id)).toBe(true);
		expect(consumeDeferredMaterialization(h.id)).toBe(true);
	} finally {
		release?.();
		h.close();
	}
});

test("a true user flush admits drops even when the served head is unchanged", async () => {
	const withheld = await differential("flush", false);
	const applied = await differential("flush", true);
	expect(applied.previous).toEqual(withheld.previous);
	expect(withheld.next).toEqual(withheld.previous);
	expect(firstDifference(applied.previous, applied.next)).toBe(13);
	expect(applied.next.slice(0, 3)).toEqual(applied.previous.slice(0, 3));
	expect(applied.pending).toBe(0);
	expect(applied.warm).toEqual(applied.next);
});

for (const inject of [true, false]) {
	test(`served system-byte changes admit drops with injection=${inject}`, async () => {
		const h = rideHarness(inject);
		try {
			const previous = await h.pass(40);
			h.queue();
			h.setSystemPrompt("Fixed system prompt.");
			expect(await h.pass()).toEqual(previous);
			expect(getPendingOps(h.db, h.id)).toHaveLength(1);
			h.setSystemPrompt("Actually changed system instructions.");
			const next = await h.pass();
			expect(firstDifference(previous, next)).toBe(0);
			expect(getPendingOps(h.db, h.id)).toHaveLength(0);
			expect(await h.pass()).toEqual(next);
		} finally {
			h.close();
		}
	});
}

for (const rebuild of ["publication", "force", "flush"] as const) {
	test(`a withheld drop stays live until the next ${rebuild} pass`, async () => {
		const h = rideHarness();
		try {
			const previous = await h.pass(40);
			h.queue();
			signalPiDeferredHistoryRefresh(h.id);
			signalPiDeferredMaterialization(h.id);
			expect(await h.pass()).toEqual(previous);
			expect(getPendingOps(h.db, h.id)).toHaveLength(1);
			if (rebuild === "publication") h.publish();
			if (rebuild === "flush") {
				signalPiHistoryRefresh(h.id);
				signalPiPendingMaterialization(h.id);
			}
			const next = await h.pass(rebuild === "force" ? 86 : 64);
			expect(next).not.toEqual(previous);
			expect(getPendingOps(h.db, h.id)).toHaveLength(0);
			expect(await h.pass()).toEqual(next);
		} finally {
			h.close();
		}
	});
}
