import { afterEach, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import {
	clearContextHandlerSession,
	__test as contextInternals,
	registerPiContextHandler,
} from "./context-handler";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// The signed-thinking fit retry copies the pass input just before the pipeline
// runs; it used to copy it earlier in the handler, before the pipeline
// arguments were built. This witness captures the messages array at that
// earlier point (the test hook that runs just before it) and checks that every
// copy the pass keeps is byte-identical to that capture, and that every pass
// that keeps a held signed turn, and so may retry, has its copy.

afterEach(() => {
	_resetHarnessForTesting();
	setHarness("pi");
	__setPiHarnessKindForTesting(undefined);
});

function rng(seed: number) {
	let state = (seed * 2654435761) >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 4294967296;
	};
}

for (const harness of ["pi", "omp"] as const)
	it(`${harness}: the fit copies equal the input as it stood at the old copy point`, async () => {
		_resetHarnessForTesting();
		const db = createTestDb();
		if (harness === "omp") {
			_resetHarnessForTesting();
			setHarness("omp");
			__setPiHarnessKindForTesting("omp");
		}
		const sessionId = `signed-fit-review-${harness}`;
		const model = "claude-opus-5-5";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "13h",
		});
		const fake = createFakePi();
		Object.assign(fake.pi, {
			getAllTools: () => [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
			getActiveTools: () => ["read"],
		});
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTokens: 4000,
			injection: {
				injectionBudgetTokens: 1000,
				memoryEnabled: false,
				injectDocs: false,
			},
			heuristics: { keepReasoningTokens: 10000 },
			scheduler: { executeThresholdPercentage: 65 },
		});
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("Pi context handler was not registered");

		let current: unknown[] = [];
		let atOldCopyPoint: string | null = null;
		const observations: Array<{
			held: boolean;
			kept: boolean;
			thinking: string | null;
			reclaim: string | undefined;
			atOldCopyPoint: string | null;
		}> = [];
		let pipelineRuns = 0;
		const rerunPasses: number[] = [];
		const restoreRuns = contextInternals.setPipelineResultObserverForTests(
			() => {
				pipelineRuns++;
			},
		);
		const restoreHook = contextInternals.setBeforePipelineForTests(async () => {
			atOldCopyPoint = JSON.stringify(current);
		});
		const restoreObserver =
			contextInternals.setThinkingFitInputObserverForTests((o) =>
				observations.push({
					held: o.held,
					kept: o.strictThinkingKept,
					thinking:
						o.thinkingCopy === null ? null : JSON.stringify(o.thinkingCopy),
					reclaim:
						o.fitReclaimCopy === undefined
							? undefined
							: JSON.stringify(o.fitReclaimCopy),
					atOldCopyPoint,
				}),
			);

		const source: unknown[] = [];
		const ids: string[] = [];
		let counter = 0;
		const reasoningKey = harness === "omp" ? "reasoningTokens" : "reasoning";
		const random = rng(harness === "pi" ? 4242 : 4243);
		const user = () => {
			counter++;
			source.push(userMessage(`Request ${counter}: continue.`, counter));
			ids.push(`user-${counter}`);
		};
		const step = (heavy: boolean, output: string) => {
			counter++;
			const reasoning = heavy ? 1_800 : 120;
			source.push(
				assistantMessage("", counter, {
					provider: "anthropic",
					model,
					api: "anthropic-messages",
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: reasoning,
						[reasoningKey]: reasoning,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: reasoning,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					content: [
						{
							type: "thinking",
							thinking: heavy
								? "Heavy reasoning. ".repeat(400)
								: `Thought ${counter}.`,
							thinkingSignature: `sig-${counter}`,
						},
						{
							type: "toolCall",
							id: `call-${counter}`,
							name: "read",
							arguments: { path: `file-${counter}.ts` },
						},
					],
				}),
				{
					role: "toolResult",
					toolCallId: `call-${counter}`,
					toolName: "read",
					content: [{ type: "text", text: output }],
					isError: false,
					timestamp: counter,
				},
			);
			ids.push(`asst-${counter}`, `result-${counter}`);
		};

		try {
			user();
			for (let pass = 0; pass < 30; pass++) {
				if (random() < 0.2) user();
				step(
					random() < 0.65,
					random() < 0.2
						? "LARGE FIT RESULT ".repeat(30_000)
						: `Small result ${pass}`,
				);
				const percent =
					[30, 55, 66, 70, 74, 96][Math.floor(random() * 6)] ?? 30;
				const messages = structuredClone(source);
				current = messages;
				atOldCopyPoint = null;
				pipelineRuns = 0;
				const ctx = {
					...fakeContext(sessionId, process.cwd(), [...ids], messages as never),
					hasUI: random() < 0.5,
					getSystemPrompt: () => "Read files for the task.",
					model: {
						provider: "anthropic",
						id: model,
						api: "anthropic-messages",
						contextWindow: 100000,
					},
					getContextUsage: () => ({
						tokens: percent * 1000,
						percent,
						contextWindow: 100000,
					}),
				};
				await handler({ messages } as never, ctx as never).catch(
					() => undefined,
				);
				await new Promise((resolve) => setImmediate(resolve));
				if (pipelineRuns > 1) rerunPasses.push(pass);
			}
			console.log(
				`signed-fit review ${harness}: passes=${observations.length} held=${observations.filter((o) => o.held).length} kept=${observations.filter((o) => o.kept).length} thinkingCopies=${observations.filter((o) => o.thinking !== null).length} reclaimCopies=${observations.filter((o) => o.reclaim !== undefined).length} passesThatReranThePipeline=${rerunPasses.length}`,
			);
			expect(observations.some((o) => o.kept)).toBe(true);
			for (const o of observations) {
				expect(o.atOldCopyPoint).not.toBeNull();
				if (o.thinking !== null) expect(o.thinking).toBe(o.atOldCopyPoint);
				if (o.reclaim !== undefined) expect(o.reclaim).toBe(o.atOldCopyPoint);
				// The retry runs only when the pipeline kept a held signed turn.
				if (o.kept) expect(o.held).toBe(true);
				// The copy used to exist on every prefix-bound pass where Oh My Pi
				// runs, or where Pi keeps a fit-reclaim copy; a kept turn there
				// must still have it.
				if (o.kept && (harness === "omp" || o.reclaim !== undefined))
					expect(o.thinking).not.toBeNull();
			}
		} finally {
			restoreObserver();
			restoreRuns();
			restoreHook();
			clearContextHandlerSession(sessionId);
			db.close();
		}
	}, 90_000);
