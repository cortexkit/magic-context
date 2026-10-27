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

/** A Pi context handler over an in-memory store, on the given harness. */
function piSession(name: string, harness: "pi" | "omp", model: string) {
	_resetHarnessForTesting();
	const db = createTestDb();
	if (harness === "omp") {
		_resetHarnessForTesting();
		setHarness("omp");
		__setPiHarnessKindForTesting("omp");
	}
	const sessionId = `signed-fit-input-${harness}-${name}`;
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
	const source: unknown[] = [];
	const ids: string[] = [];
	let counter = 0;
	const reasoningKey = harness === "omp" ? "reasoningTokens" : "reasoning";
	return {
		source,
		user() {
			counter++;
			source.push(userMessage(`Request ${counter}: continue.`, counter));
			ids.push(`user-${counter}`);
		},
		step(options: { heavy: boolean; output: string }) {
			counter++;
			const callId = `call-${counter}`;
			const reasoning = options.heavy ? 1_800 : 120;
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
							thinking: options.heavy
								? "Heavy reasoning. ".repeat(400)
								: `Thought ${counter}.`,
							thinkingSignature: `sig-${counter}`,
						},
						{
							type: "toolCall",
							id: callId,
							name: "read",
							arguments: { path: `file-${counter}.ts` },
						},
					],
				}),
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: options.output }],
					isError: false,
					timestamp: counter,
				},
			);
			ids.push(`asst-${counter}`, `result-${counter}`);
		},
		/** One pass over a fresh copy of the history; returns that event's messages. */
		async pass(percent: number, hasUI: boolean) {
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), [...ids], messages as never),
				hasUI,
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
			const expected = JSON.stringify(messages);
			let error: unknown;
			try {
				await handler({ messages } as never, ctx as never);
			} catch (caught) {
				// Over-window passes may be refused; the copies are taken before that.
				error = caught;
			}
			await new Promise((resolve) => setImmediate(resolve));
			return { messages, expected, error };
		},
		cleanup() {
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

type Observation = {
	held: boolean;
	strictThinkingKept: boolean;
	thinkingCopy: string | null;
	fitReclaimCopy: string | undefined;
	sharedCopy: boolean;
	expected: string;
};

for (const harness of ["pi", "omp"] as const)
	it(`${harness}: a pass that keeps a held signed turn always has a thinking-fit copy equal to its input`, async () => {
		const s = piSession("superset", harness, "claude-opus-5-5");
		const random = rng(harness === "pi" ? 798 : 799);
		let expected = "";
		const observations: Observation[] = [];
		const restore = contextInternals.setThinkingFitInputObserverForTests(
			(observation) => {
				observations.push({
					held: observation.held,
					strictThinkingKept: observation.strictThinkingKept,
					thinkingCopy:
						observation.thinkingCopy === null
							? null
							: JSON.stringify(observation.thinkingCopy),
					fitReclaimCopy:
						observation.fitReclaimCopy === undefined
							? undefined
							: JSON.stringify(observation.fitReclaimCopy),
					sharedCopy:
						observation.thinkingCopy !== null &&
						observation.thinkingCopy === observation.fitReclaimCopy,
					expected,
				});
			},
		);
		try {
			s.user();
			for (let pass = 0; pass < 40; pass++) {
				if (random() < 0.15) s.user();
				s.step({
					heavy: random() < 0.6,
					output:
						random() < 0.15
							? "LARGE FIT RESULT ".repeat(30_000)
							: `Small result ${pass}`,
				});
				const percent =
					[20, 50, 66, 70, 74, 80, 96][Math.floor(random() * 7)] ?? 20;
				const hasUI = random() < 0.5;
				// The observer runs inside the pass; `expected` is the input as handed over.
				expected = JSON.stringify(s.source);
				const run = await s.pass(percent, hasUI);
				expect(run.expected).toBe(expected);
			}
			// The retry needs strictThinkingKept, which needs this pass's hold.
			for (const o of observations)
				if (o.strictThinkingKept) expect(o.held).toBe(true);
			// A held pass takes the copy wherever the retry may use one: always on
			// Oh My Pi, and on Pi when the pass also keeps a fit-reclaim copy.
			const retryPossible = observations.filter(
				(o) => o.held && (harness === "omp" || o.fitReclaimCopy !== undefined),
			);
			for (const o of retryPossible) {
				expect(o.thinkingCopy).not.toBeNull();
				expect(o.thinkingCopy).toBe(o.expected);
			}
			// Where both copies exist they are one copy, as before.
			for (const o of observations)
				if (o.thinkingCopy !== null && o.fitReclaimCopy !== undefined)
					expect(o.sharedCopy).toBe(true);
			// The fit-reclaim copy is the unchanged input too.
			for (const o of observations)
				if (o.fitReclaimCopy !== undefined)
					expect(o.fitReclaimCopy).toBe(o.expected);
			// An unheld pass never takes the thinking copy.
			for (const o of observations)
				if (!o.held) expect(o.thinkingCopy).toBeNull();
			// Make sure the run had both kinds of pass.
			expect(retryPossible.length).toBeGreaterThan(3);
			expect(observations.filter((o) => !o.held).length).toBeGreaterThan(3);
			expect(observations.some((o) => o.strictThinkingKept)).toBe(true);
		} finally {
			restore();
			s.cleanup();
		}
	}, 60_000);

it("omp: a prefix-bound thinking session that is not held never copies its input", async () => {
	const s = piSession("unheld", "omp", "claude-opus-5-5");
	const seen: Array<{ held: boolean; copied: boolean }> = [];
	const restore = contextInternals.setThinkingFitInputObserverForTests((o) =>
		seen.push({
			held: o.held,
			copied: o.thinkingCopy !== null || o.fitReclaimCopy !== undefined,
		}),
	);
	try {
		s.user();
		for (let pass = 0; pass < 8; pass++) {
			// Light reasoning only: the bounded hold never engages.
			s.step({ heavy: false, output: `Result ${pass}` });
			await s.pass(40, true);
		}
		expect(seen).toHaveLength(8);
		expect(seen.every((o) => !o.held && !o.copied)).toBe(true);
	} finally {
		restore();
		s.cleanup();
	}
}, 30_000);
