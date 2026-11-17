import { afterEach, describe, expect, test } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { clearWindowGeometryLogForTest } from "@magic-context/core/shared/window-geometry";
import { persistPiPressureFromMessageEnd } from "./index";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import {
	clearPiLiveUsageClassification,
	computePiPressure,
	extractAssistantUsage,
	isPiLiveUsageRawBranchEstimate,
	piMessageAnchorsLiveUsage,
} from "./pi-pressure";
import { assistantMessage, createTestDb } from "./test-utils.test";

// Oh My Pi's antigravity-cli catalog row for agy's default model
// (pi-catalog compat/rules/providers/antigravity-cli.kdl, 18.22.0).
const MODEL = {
	provider: "antigravity-cli",
	id: "gemini-4-carbon",
	contextWindow: 1_048_576,
	maxTokens: 262_144,
};

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A tool-call step as Oh My Pi's antigravity-cli provider records it
 * (step-writer.ts `usage(contextTokens)` without turn totals): agy's
 * `usage_update.used` in `contextTokens`, every other counter zero.
 */
function agyToolUseStep(contextTokens: number) {
	return assistantMessage("", 10, {
		api: "antigravity-acp",
		provider: MODEL.provider,
		model: MODEL.id,
		content: [
			{ type: "toolCall", id: "agy_1", name: "read", arguments: { path: "a" } },
		],
		stopReason: "toolUse",
		usage: { ...zeroUsage, contextTokens },
	});
}

afterEach(() => clearWindowGeometryLogForTest());

describe("Oh My Pi contextTokens-only usage (issue 939)", () => {
	test("a contextTokens-only tool-call step is a provider reading", () => {
		const usage = extractAssistantUsage(agyToolUseStep(115_737));
		expect(usage?.contextTokens).toBe(115_737);
		expect(computePiPressure(usage, 1_048_576)).toEqual({
			inputTokens: 115_737,
			percentage: (115_737 / 1_048_576) * 100,
		});
	});

	test("the prompt counters win whenever they give a reading", () => {
		// An agy turn end carries the turn's counters summed over all its steps
		// next to contextTokens; Cursor and Google split generations do the same.
		// contextTokens includes the reply's output, so it is never preferred.
		expect(
			computePiPressure(
				{
					input: 2_000,
					cacheRead: 118_000,
					cacheWrite: 0,
					output: 900,
					totalTokens: 120_900,
					contextTokens: 121_400,
				},
				1_048_576,
			)?.inputTokens,
		).toBe(120_000);
	});

	test("a contextTokens value that is zero, negative or not finite gives no reading", () => {
		for (const contextTokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				computePiPressure({ ...zeroUsage, contextTokens }, 1_048_576),
			).toBeNull();
		}
	});

	test("a contextTokens-only reply anchors Pi's live figure after a compaction", () => {
		const earlier = {
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { ...zeroUsage, input: 900_000, totalTokens: 900_000 },
			},
		};
		expect(piMessageAnchorsLiveUsage(agyToolUseStep(115_737))).toBe(true);
		expect(piMessageAnchorsLiveUsage(agyToolUseStep(0))).toBe(false);
		expect(
			isPiLiveUsageRawBranchEstimate([earlier, { type: "compaction" }]),
		).toBe(true);
		expect(
			isPiLiveUsageRawBranchEstimate([
				earlier,
				{ type: "compaction" },
				{ type: "message", message: agyToolUseStep(115_737) },
			]),
		).toBe(false);
	});

	test("message_end replaces the pre-compaction peak with the step's reading", async () => {
		const db = createTestDb();
		const sessionId = "ses-issue-939-agy";
		try {
			updateSessionMeta(db, sessionId, {
				lastInputTokens: 900_000,
				lastContextPercentage: 85.8,
				lastUsageContextLimit: 1_048_576,
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: agyToolUseStep(115_737),
				piContextWindow: MODEL.contextWindow,
				piContextWindowSource: "observed",
				piModel: MODEL,
				// Pi's own figure re-estimates the whole raw branch after the
				// compaction, so it must not stand in for the provider reading.
				piTokens: 950_000,
				piTokensIsRawBranchEstimate: true,
			});
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(115_737);
			expect(meta.lastUsageContextLimit).toBe(1_048_576);
		} finally {
			clearPiLiveUsageClassification(sessionId);
			closeQuietly(db);
		}
	});
});

describe("antigravity-cli window geometry (issue 939)", () => {
	test("keeps the full window, like google-antigravity", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: MODEL.contextWindow,
				model: MODEL,
			}),
		).toBe(1_048_576);
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 1_000_000,
				model: {
					provider: "antigravity-cli",
					id: "claude-opus-5-5",
					contextWindow: 1_000_000,
					maxTokens: 128_000,
				},
			}),
		).toBe(1_000_000);
	});
});
