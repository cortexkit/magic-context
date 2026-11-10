/**
 * Issue 889 on Pi. A pass in provider-overflow recovery that cannot reclaim
 * enough must not send a request over its limit: the 95% line of the model's
 * usable window while a historian run is still summarizing older history, and
 * the whole usable window once none is. Pi otherwise refuses only a request
 * whose byte count proves it is over the whole context window; dense text
 * (many tokens per byte) passes that check while its token count is far over
 * the window. Pi never arms recovery by itself when the person switches to a
 * smaller model (OpenCode does), so a provider overflow is the recovery tested
 * here.
 */

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	getOverflowState,
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import {
	__test,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { resolvePiWindowGeometry } from "./pi-context-limit";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";
import { tokenizePiMessages } from "./tokenize-pi-messages";

beforeEach(() => {
	_resetHarnessForTesting();
	setHarness("pi");
});
afterEach(_resetHarnessForTesting);

const sessionId = "issue-889-pi-recovery";
const modelKey = "mock/mock";
const model = { provider: "mock", id: "mock", contextWindow: 100_000 };

const STILL_SUMMARIZING =
	"Magic Context is still summarizing older history so this conversation fits the model's context window. Send your message again to continue.";
const NOTHING_LEFT =
	"This conversation no longer fits the model's context window, and Magic Context has no more older history it can summarize. Switch to a model with a larger context window to continue.";

/** Deterministic random words: several tokens per word, under four bytes per token. */
function denseText(seed: number, words: number): string {
	let state = seed;
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		state = (state * 1103515245 + 12345) % 2147483648;
		out.push(state.toString(36));
	}
	return out.join(" ");
}

/** A request for the records, `turns` long dense records, and a short prompt. */
function records(turns: number) {
	const messages = [userMessage("Review the records", 1)];
	for (let i = 0; i < turns; i++)
		messages.push(
			assistantMessage(`Record ${i}: ${denseText(i + 1, 2_500)}`, i + 2),
		);
	messages.push(userMessage("Continue", turns + 2));
	return messages;
}

/** One dense prompt of `words` words. */
function prompt(words: number) {
	return [userMessage(`Please review: ${denseText(7, words)}`, 1)];
}

function fixture(
	messages: ReturnType<typeof records>,
	options: { untrustedEnvelope?: boolean } = {},
) {
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	// Without the host's tool registry the fit envelope cannot be measured,
	// so it is untrusted.
	const pi = options.untrustedEnvelope
		? fake.pi
		: {
				...fake.pi,
				getAllTools: () => [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object" },
					},
				],
			};
	registerPiContextHandler(pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("missing context handler");
	return {
		db,
		async run(tokens: number) {
			const ids = messages.map((_, i) => `entry-${i}`);
			const base = fakeContext(sessionId, process.cwd(), ids, messages);
			const branch = base.sessionManager.getBranch().map((entry, i) => ({
				...entry,
				parentId: i ? `entry-${i - 1}` : null,
			}));
			const ctx = {
				...base,
				sessionManager: {
					...base.sessionManager,
					getBranch: () => branch,
					getEntry: (id: string) => branch.find((entry) => entry.id === id),
					getLeafId: () => branch.at(-1)?.id,
				},
				model,
				getSystemPrompt: () => "You are a helpful assistant.",
				getContextUsage: () => ({
					tokens,
					percent: (tokens / model.contextWindow) * 100,
					contextWindow: model.contextWindow,
				}),
			};
			recordPiLiveModel(sessionId, modelKey);
			return (await handler(
				{ messages: [...messages] } as never,
				ctx as never,
			)) as {
				messages: unknown[];
			};
		},
		close() {
			clearContextHandlerSession(sessionId);
			resetEmergencyRecoveryRegistryForTest();
			db.close();
		},
	};
}

const geometry = () => {
	const usableHard =
		resolvePiWindowGeometry({ rawContextWindow: model.contextWindow, model })
			?.usableHard ?? 0;
	return { usableHard, line: Math.floor((usableHard * 95) / 100) };
};

/** Words for a dense prompt whose own count is about `target` tokens. */
function wordsForTokens(target: number): number {
	const count = (words: number) => {
		const counts = tokenizePiMessages(prompt(words) as never);
		return counts.conversation + counts.toolCall;
	};
	const low = count(4_000);
	const high = count(8_000);
	return Math.round(4_000 + ((target - low) * 4_000) / (high - low));
}

/** Serve one pass; returns its message tokens or the refusal. */
async function serve(f: ReturnType<typeof fixture>) {
	try {
		const result = await f.run(40_000);
		const counts = tokenizePiMessages(result.messages as never);
		return {
			served: counts.conversation + counts.toolCall,
			refusal: undefined,
		};
	} catch (error) {
		return { served: undefined, refusal: error };
	}
}

/** A first pass, then the provider rejects the next request as too long. */
async function armProviderOverflow(f: ReturnType<typeof fixture>) {
	await f.run(40_000);
	recordOverflowDetected(
		f.db,
		sessionId,
		undefined,
		modelKey,
		"provider_overflow",
	);
}

function logged(log: ReturnType<typeof spyOn>, text: string): string[] {
	return log.mock.calls
		.map(([, line]) => String(line))
		.filter((line) => line.includes(text));
}

it("refuses a recovery request over the whole window when no historian run can summarize more (issue 889)", async () => {
	const f = fixture(records(16));
	const log = spyOn(logger, "sessionLog");
	try {
		await armProviderOverflow(f);
		const { served, refusal } = await serve(f);
		if (served !== undefined)
			console.log(
				`ISSUE889_PI sent a recovery request of about ${served} message tokens; window ${geometry().usableHard}`,
			);
		expect(served).toBeUndefined();
		expect(refusal).toBeInstanceOf(EmergencyFailClosedError);
		// Nothing is left to summarize, so the notice does not ask to send again.
		expect((refusal as Error).message).toBe(NOTHING_LEFT);
		expect(logged(log, "recovery request still over the window")[0]).toContain(
			"against the whole window",
		);
		const overflow = getOverflowState(f.db, sessionId);
		expect(overflow.needsEmergencyRecovery).toBe(true);
		expect(overflow.emergencyRecoveryOrigin).toBe("provider_overflow");
	} finally {
		log.mockRestore();
		f.close();
	}
});

it("holds a recovery request to the 95% line while a historian run is in flight, and continues recovery on the next turn", async () => {
	const { usableHard, line } = geometry();
	// Between the 95% line and the window: it fits, but a run in flight can
	// still bring it under the line.
	const f = fixture(
		prompt(wordsForTokens(line + Math.floor((usableHard - line) / 3))),
	);
	const log = spyOn(logger, "sessionLog");
	let restoreHistorian: (() => void) | undefined;
	try {
		await armProviderOverflow(f);
		restoreHistorian = __test.setInFlightHistorianForTests(
			sessionId,
			Promise.resolve(),
		);
		const first = await serve(f);
		expect(first.served).toBeUndefined();
		expect(first.refusal).toBeInstanceOf(EmergencyFailClosedError);
		expect((first.refusal as Error).message).toBe(STILL_SUMMARIZING);
		const refusedAt = Number(
			logged(log, "recovery request still over the window")[0]?.match(
				/about (\d+) tokens against the 95% line/,
			)?.[1],
		);
		expect(refusedAt).toBeGreaterThan(line);
		expect(refusedAt).toBeLessThanOrEqual(usableHard);
		// The refusal leaves recovery armed, so the next turn is a recovery pass.
		expect(getOverflowState(f.db, sessionId).needsEmergencyRecovery).toBe(true);

		// The run finished without bringing the request under the line, and
		// none is in flight now: the request fits the window, so it is sent and
		// recovery ends.
		restoreHistorian();
		restoreHistorian = undefined;
		log.mockClear();
		const second = await serve(f);
		expect(second.refusal).toBeUndefined();
		expect(second.served ?? 0).toBeGreaterThan(line);
		expect(logged(log, "recovery request admitted")).toHaveLength(1);
		expect(getOverflowState(f.db, sessionId).needsEmergencyRecovery).toBe(
			false,
		);
	} finally {
		restoreHistorian?.();
		log.mockRestore();
		f.close();
	}
});

it("sends a provider-overflow recovery request that fits under the 95% line, and ends recovery", async () => {
	const f = fixture(records(3));
	const log = spyOn(logger, "sessionLog");
	try {
		await armProviderOverflow(f);
		const { served, refusal } = await serve(f);
		expect(refusal).toBeUndefined();
		expect(served ?? 0).toBeGreaterThan(0);
		expect(served ?? Number.POSITIVE_INFINITY).toBeLessThan(
			geometry().usableHard * 0.95,
		);
		expect(logged(log, "recovery request admitted")).toHaveLength(1);
		expect(getOverflowState(f.db, sessionId).needsEmergencyRecovery).toBe(
			false,
		);
	} finally {
		log.mockRestore();
		f.close();
	}
});

it("says once that it cannot count a recovery request when the fit envelope is untrusted, and keeps recovery armed", async () => {
	const f = fixture(records(3), { untrustedEnvelope: true });
	const log = spyOn(logger, "sessionLog");
	try {
		await armProviderOverflow(f);
		for (let turn = 0; turn < 2; turn++) {
			const { refusal } = await serve(f);
			// Only the byte-count check applies, and this request passes it.
			expect(refusal).toBeUndefined();
			// Nothing proved the request fits, so recovery is not ended; the
			// next turn is a recovery pass again.
			expect(getOverflowState(f.db, sessionId).needsEmergencyRecovery).toBe(
				true,
			);
		}
		expect(logged(log, "recovery request admitted")).toHaveLength(0);
		expect(
			logged(
				log,
				"recovery request not counted: the fit envelope is untrusted",
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		f.close();
	}
});
