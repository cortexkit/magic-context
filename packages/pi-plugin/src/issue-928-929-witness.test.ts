/**
 * Witness tests for issues 928 and 929 on Pi.
 *
 * A test whose comment says it failed before the fix covers a changed rule;
 * the others pin behaviour that was already correct.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
	clearEmergencyRecovery,
	getOrCreateSessionMeta,
	getOverflowState,
	recordOverflowDetected,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import { readPiProvenFloorRecord } from "./pi-proven-floor";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const PROVIDER = "gateway";
const NARROW = "deepseek-v4.1-flash";
const OTHER = "gpt-6-luna";
const NARROW_KEY = `${PROVIDER}/${NARROW}`;
const LIMIT_ERROR =
	"This model's maximum context length is 198000 tokens. However, your messages resulted in 205000 tokens.";

/** Persist an accepted NARROW reply the way Pi's message_end handler does. */
async function acceptedReply(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	input: number,
	window: { size: number; source: "observed" | "catalog" },
): Promise<void> {
	const { persistPiPressureFromMessageEnd } = await import("./index");
	await persistPiPressureFromMessageEnd({
		db,
		sessionId,
		message: assistantMessage("done", 1, {
			provider: PROVIDER,
			model: NARROW,
			usage: { input, output: 100, cacheRead: 0, cacheWrite: 0 },
		}),
		piContextWindow: window.size,
		piContextWindowSource: window.source,
		piModel: { provider: PROVIDER, id: NARROW },
	});
}

function refuseNarrowRequest(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
): void {
	const result = handlePiProviderFailure({
		db,
		sessionId,
		message: {
			role: "assistant",
			provider: PROVIDER,
			model: NARROW,
			errorMessage: LIMIT_ERROR,
		},
	});
	expect(result.kind).toBe("overflow");
}

describe("issue 928 on Pi: Pi's message_end handler", () => {
	it("step 1 (confirmed): a provider limit error records a model-keyed limit and zeroes the proven floor", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-step1";
		try {
			await acceptedReply(db, sessionId, 127_062, {
				size: 400_000,
				source: "observed",
			});
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(127_062);

			refuseNarrowRequest(db, sessionId);

			const raw = getOverflowState(db, sessionId);
			expect(raw.detectedContextLimit).toBe(198_000);
			expect(raw.detectedContextLimitModelKey).toBe(NARROW_KEY);
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	// Failed before the fix: the reading was bounded by the wall the detected
	// limit itself capped, so it was set aside as possible turn-aggregate usage
	// before the clear could run.
	for (const source of ["observed", "catalog"] as const) {
		it(`step 2: an accepted request above a model-keyed detected limit clears it and is recorded as usage (${source} window)`, async () => {
			const db = createTestDb();
			const sessionId = `ses-928-pi-step2-${source}`;
			try {
				recordOverflowDetected(db, sessionId, 198_000, NARROW_KEY);
				clearEmergencyRecovery(db, sessionId);

				await acceptedReply(db, sessionId, 253_659, {
					size: 400_000,
					source,
				});

				expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(0);
				const meta = getOrCreateSessionMeta(db, sessionId);
				expect(meta.lastInputTokens).toBe(253_659);
				expect(meta.observedSafeInputTokens).toBe(253_659);
				expect(meta.lastUsageContextLimit).toBe(400_000);
			} finally {
				closeQuietly(db);
			}
		});
	}

	it("a reading above Pi's wall without the limit is still set aside as possible turn-aggregate usage, and the limit stays", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-aggregate";
		try {
			recordOverflowDetected(db, sessionId, 198_000, NARROW_KEY);
			clearEmergencyRecovery(db, sessionId);

			await acceptedReply(db, sessionId, 520_000, {
				size: 400_000,
				source: "observed",
			});

			expect(
				getOverflowState(db, sessionId, NARROW_KEY).detectedContextLimit,
			).toBe(198_000);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(0);
			expect(meta.observedSafeInputTokens).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("secondary variant (confirmed, by design): an accepted request below the detected limit leaves it in place", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-below";
		try {
			recordOverflowDetected(db, sessionId, 198_000, NARROW_KEY);
			clearEmergencyRecovery(db, sessionId);

			await acceptedReply(db, sessionId, 150_000, {
				size: 400_000,
				source: "observed",
			});

			expect(
				getOverflowState(db, sessionId, NARROW_KEY).detectedContextLimit,
			).toBe(198_000);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.observedSafeInputTokens).toBe(150_000);
			expect(meta.lastUsageContextLimit).toBe(198_000);
		} finally {
			closeQuietly(db);
		}
	});
});

function registerHandler(db: ReturnType<typeof createTestDb>) {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
	});
	return fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: never[] }>;
}

function passOn(sessionId: string, modelID: string, contextWindow = 100_000) {
	return {
		...fakeContext(sessionId),
		model: { provider: PROVIDER, id: modelID },
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow }),
	} as never;
}

describe("issue 928 on Pi: the context handler's model-change reset", () => {
	it("step 4 (refuted on Pi): switching away from the narrow model clears its limit, even when its only request was refused", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-switch";
		try {
			const handler = registerHandler(db);
			recordPiLiveModel(sessionId, NARROW_KEY);
			await handler(
				{ messages: [userMessage("first", 1)] as never[] },
				passOn(sessionId, NARROW),
			);
			refuseNarrowRequest(db, sessionId);
			// Recovery ends on the next pass that fits and keeps the limit.
			clearEmergencyRecovery(db, sessionId);
			expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(
				198_000,
			);

			await handler(
				{ messages: [userMessage("on the other model", 2)] as never[] },
				passOn(sessionId, OTHER),
			);

			expect(getOverflowState(db, sessionId).detectedContextLimit).toBe(0);
			expect(
				getOverflowState(db, sessionId).detectedContextLimitModelKey,
			).toBeNull();
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	// Failed before the fix: the pass read the limit and the recovery flag from
	// a copy of the session row taken before the model-change reset, and neither
	// is checked against the model. It capped the window at 198,000, bumped to
	// 95% for the previous model's recovery, and in this harness refused the turn.
	it("the switch pass itself neither caps its window with the previous model's limit nor runs that model's overflow recovery", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-switch-pass";
		const log = spyOn(loggerModule, "sessionLog");
		try {
			const handler = registerHandler(db);
			recordPiLiveModel(sessionId, NARROW_KEY);
			await handler(
				{ messages: [userMessage("first", 1)] as never[] },
				passOn(sessionId, NARROW, 400_000),
			);
			refuseNarrowRequest(db, sessionId);
			expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(true);
			log.mockClear();

			await handler(
				{ messages: [userMessage("on the other model", 2)] as never[] },
				passOn(sessionId, OTHER, 400_000),
			);

			const lines = log.mock.calls.map(([, text]) => String(text));
			expect(
				lines.some((line) => line.includes("bumping percentage to 95%")),
			).toBe(false);
			const pressure = lines.filter((line) =>
				line.startsWith("transform: usage="),
			);
			expect(pressure.length).toBeGreaterThan(0);
			expect(pressure.every((line) => line.includes("limit=400000"))).toBe(
				true,
			);
			const overflow = getOverflowState(db, sessionId);
			expect(overflow.detectedContextLimit).toBe(0);
			expect(overflow.needsEmergencyRecovery).toBe(false);
		} finally {
			log.mockRestore();
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("step 3 (confirmed, by design): a restart keeps the limit for the model that owns it", async () => {
		const db = createTestDb();
		const sessionId = "ses-928-pi-restart";
		try {
			let handler = registerHandler(db);
			recordPiLiveModel(sessionId, NARROW_KEY);
			await handler(
				{ messages: [userMessage("first", 1)] as never[] },
				passOn(sessionId, NARROW),
			);
			refuseNarrowRequest(db, sessionId);
			clearEmergencyRecovery(db, sessionId);
			updateSessionMeta(db, sessionId, {
				lastContextPercentage: 40,
				lastInputTokens: 80_000,
			});

			// Dropping the in-process session state stands in for a restart.
			clearContextHandlerSession(sessionId);
			handler = registerHandler(db);
			await handler(
				{ messages: [userMessage("after restart", 2)] as never[] },
				passOn(sessionId, NARROW),
			);

			expect(
				getOverflowState(db, sessionId, NARROW_KEY).detectedContextLimit,
			).toBe(198_000);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});

describe("window precedence on Pi: detected limit, proven floor and Pi's window", () => {
	it("a detected limit caps Pi's window and the floor is not applied; without it the floor lifts only a catalog window", () => {
		const model = { provider: PROVIDER, id: NARROW };
		const usable = (
			rawContextWindow: number,
			rawContextWindowSource: "observed" | "catalog",
			detectedContextLimit?: number,
		) =>
			resolvePiUsableContextLimit({
				rawContextWindow,
				rawContextWindowSource,
				model,
				detectedContextLimit,
				provenInputTokens: 245_000,
			});

		// Detected limit present: it caps the window; the floor is ignored.
		expect(usable(400_000, "observed", 198_000)).toBe(198_000);
		expect(usable(400_000, "catalog", 198_000)).toBe(198_000);
		expect(usable(128_000, "catalog", 198_000)).toBe(128_000);
		// No detected limit: a floor above the window lifts a catalog window...
		expect(usable(128_000, "catalog")).toBe(245_000);
		// ...but not the window Pi observes from its runtime, which is trusted.
		expect(usable(128_000, "observed")).toBe(128_000);
		// A floor below the window changes nothing.
		expect(usable(400_000, "catalog")).toBe(400_000);
	});
});

describe("issue 929 on Pi: the proven floor has no route identity", () => {
	it("a floor proven on one route is recorded against the provider/model key only, and that model's limit error zeroes it", async () => {
		const db = createTestDb();
		const sessionId = "ses-929-pi";
		try {
			await acceptedReply(db, sessionId, 245_165, {
				size: 128_000,
				source: "catalog",
			});
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(245_165);
			expect(readPiProvenFloorRecord(db, sessionId)).toEqual({
				modelKey: NARROW_KEY,
				tokens: 245_165,
			});
			expect(getOrCreateSessionMeta(db, sessionId).lastUsageContextLimit).toBe(
				245_165,
			);

			refuseNarrowRequest(db, sessionId);

			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
			expect(
				getOverflowState(db, sessionId, NARROW_KEY).detectedContextLimit,
			).toBe(198_000);
		} finally {
			closeQuietly(db);
		}
	});
});
