/**
 * Witness for the overflow recovery refusal (issue 889) on Pi. A recovery
 * request that fits the model's window but sits above 95% of it, with nothing
 * older left to summarize (the newest prompt alone fills the window), is
 * refused on every turn: each refusal arms the recovery flag again, so the
 * session cannot continue. At commit d49181bb78 the same request was sent, and
 * it fit; at commit 121dd7acd7 this test fails.
 */

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	getOverflowState,
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { resolvePiWindowGeometry } from "./pi-context-limit";
import {
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

const sessionId = "issue-889-pi-review-wedge";
const modelKey = "mock/mock";
const model = { provider: "mock", id: "mock", contextWindow: 100_000 };

/**
 * Deterministic random words: several tokens per word, under four bytes per
 * token, so Pi's byte-count proof of an over-window request does not apply and
 * only the recovery line decides (as in issue-889-recovery-admission.test.ts).
 */
function denseText(words: number): string {
	let state = 7;
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		state = (state * 1103515245 + 12345) % 2147483648;
		out.push(state.toString(36));
	}
	return out.join(" ");
}

const geometry = () => {
	const usableHard =
		resolvePiWindowGeometry({ rawContextWindow: model.contextWindow, model })
			?.usableHard ?? 0;
	return { usableHard, line: Math.floor((usableHard * 95) / 100) };
};

function promptTokens(words: number): number {
	const counts = tokenizePiMessages([
		userMessage(`Please review: ${denseText(words)}`, 1),
	] as never);
	return counts.conversation + counts.toolCall;
}

/** Words for a prompt whose own count is about `target` tokens. */
function wordsForTokens(target: number): number {
	const low = promptTokens(4_000);
	const high = promptTokens(8_000);
	return Math.round(4_000 + ((target - low) * 4_000) / (high - low));
}

it("a fitting recovery request with nothing left to summarize is not refused on every turn (Pi)", async () => {
	const { usableHard, line } = geometry();
	const words = wordsForTokens(line + Math.floor((usableHard - line) / 3));
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const fake = createFakePi();
	const pi = {
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
	const messages = [userMessage(`Please review: ${denseText(words)}`, 1)];
	const run = async (tokens: number) => {
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
	};
	const log = spyOn(logger, "sessionLog");
	const TURNS = 4;
	let refused = 0;
	let sentTokens: number | undefined;
	const refusedCounts: number[] = [];
	try {
		// A first pass, then the provider rejects the next request as too long.
		await run(60_000);
		recordOverflowDetected(
			db,
			sessionId,
			undefined,
			modelKey,
			"provider_overflow",
		);
		for (let turn = 0; turn < TURNS; turn++) {
			log.mockClear();
			try {
				const result = await run(96_000);
				const counts = tokenizePiMessages(result.messages as never);
				sentTokens = counts.conversation + counts.toolCall;
				break;
			} catch {
				refused += 1;
				for (const [, line] of log.mock.calls) {
					const match = String(line).match(
						/recovery request still over the window: about (\d+) tokens/,
					);
					if (match) refusedCounts.push(Number(match[1]));
				}
			}
		}
		console.log(
			`ISSUE889_REVIEW_PI wedge: refusedTurns=${refused} of ${TURNS} refusedCounts=${refusedCounts.join(",")} line=${line} usableHard=${usableHard} sentTokens=${sentTokens} latch=${getOverflowState(db, sessionId).needsEmergencyRecovery}`,
		);
		// Every refused request fits the window it was refused for.
		for (const tokens of refusedCounts) {
			expect(tokens).toBeGreaterThan(line);
			expect(tokens).toBeLessThanOrEqual(usableHard);
		}
		expect(refused).toBeLessThan(TURNS);
	} finally {
		log.mockRestore();
		clearContextHandlerSession(sessionId);
		resetEmergencyRecoveryRegistryForTest();
		db.close();
	}
});
