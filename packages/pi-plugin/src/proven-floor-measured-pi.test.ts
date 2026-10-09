import { describe, expect, it } from "bun:test";
import { createScheduler } from "@magic-context/core/features/magic-context/scheduler";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { buildStatusViewFor } from "@magic-context/core/shared/status-view";
import { checkLocalStatusSource } from "@magic-context/core/shared/status-view-check";
import {
	buildPiStatusDetail,
	statusViewSourceFromPiDetail,
} from "./dialogs/status-dialog";
import { persistPiPressureFromMessageEnd } from "./index";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import { resolvePiProvenInputFloor } from "./pi-proven-floor";
import { assistantMessage, createTestDb, fakeContext } from "./test-utils.test";

const MODEL = { provider: "cursor", id: "grok-4.7", contextWindow: 256_000 };
const KEY = "cursor/grok-4.7";
const reply = (input: number, extra: Record<string, unknown> = {}) =>
	assistantMessage("accepted", 2, {
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input, output: 100, totalTokens: input + 100 },
		...extra,
	});

function poison(db: ReturnType<typeof createTestDb>, sessionId: string) {
	updateSessionMeta(db, sessionId, {
		observedSafeInputTokens: 8_732_692,
		lastInputTokens: 834_492,
		lastUsageContextLimit: 8_732_692,
		lastContextPercentage: (834_492 / 8_732_692) * 100,
	});
	db.prepare(
		"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
	).run(
		JSON.stringify({
			piProvenInputFloor: { modelKey: KEY, tokens: 8_732_692 },
			unrelatedCalibration: { ratio: 11.522659235 },
		}),
		sessionId,
	);
}

describe("Pi/OMP provider-measured input floor", () => {
	it("token mode overrides percentage even with the reported inflated denominator", () => {
		const db = createTestDb();
		try {
			const meta = getOrCreateSessionMeta(db, "ses-token-design");
			meta.lastResponseTime = Date.now();
			const scheduler = createScheduler({
				executeThresholdPercentage: 80,
				executeThresholdTokens: { default: 200_000 },
			});
			expect(
				scheduler.shouldExecute(
					meta,
					{ inputTokens: 834_492, percentage: (834_492 / 8_732_692) * 100 },
					Date.now(),
					undefined,
					KEY,
					8_732_692,
				),
			).toBe("execute");
			// Tokens wins, not OR: 160k exceeds 80% of 192k, but is below the
			// 200k token override clamped to 172800 (90% of the usable window).
			expect(
				scheduler.shouldExecute(
					meta,
					{ inputTokens: 160_000, percentage: (160_000 / 192_000) * 100 },
					Date.now(),
					undefined,
					KEY,
					192_000,
				),
			).toBe("defer");
		} finally {
			closeQuietly(db);
		}
	});
	it("repairs the reporter's 8.7M latch from accepted 757872 then 1328370 inputs", async () => {
		const db = createTestDb();
		const sessionId = "ses-reporter-measured-floor";
		const branch = [{ type: "message", message: reply(757_872) }];
		try {
			poison(db, sessionId);
			const recovered = resolvePiProvenInputFloor({
				db,
				sessionId,
				modelKey: KEY,
				readBranch: () => branch,
			});
			expect(recovered).toBe(757_872);
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(757_872);
			for (const input of [757_872, 1_328_370]) {
				await persistPiPressureFromMessageEnd({
					db,
					sessionId,
					message: reply(input),
					piModel: MODEL,
					piContextWindow: MODEL.contextWindow,
					piContextWindowSource: "catalog",
				});
				const meta = getOrCreateSessionMeta(db, sessionId);
				expect(meta.observedSafeInputTokens).toBe(input);
				expect(meta.lastInputTokens).toBe(input);
				expect(meta.lastUsageContextLimit).toBe(input);
				expect(meta.lastContextPercentage).toBe(100);
				const scheduler = createScheduler({ executeThresholdPercentage: 80 });
				expect(
					scheduler.shouldExecute(
						meta,
						{ inputTokens: input, percentage: 100 },
						Date.now(),
						sessionId,
						KEY,
						input,
					),
				).toBe("execute");
			}
			const state = JSON.parse(
				(
					db
						.prepare(
							"SELECT deferred_execute_state FROM session_meta WHERE session_id = ?",
						)
						.get(sessionId) as { deferred_execute_state: string }
				).deferred_execute_state,
			);
			expect(state.unrelatedCalibration).toEqual({ ratio: 11.522659235 });
		} finally {
			closeQuietly(db);
		}
	});

	it("does not promote a persisted percentage denominator or live estimate to proof", async () => {
		const db = createTestDb();
		const sessionId = "ses-estimates-not-proof";
		try {
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: reply(757_872),
				piModel: MODEL,
				piContextWindow: MODEL.contextWindow,
				piContextWindowSource: "catalog",
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: { role: "toolResult" },
				piTokens: 8_732_692,
				piModel: MODEL,
				piContextWindow: MODEL.contextWindow,
				piContextWindowSource: "catalog",
			});
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(757_872);
			expect(
				resolvePiUsableContextLimit({
					model: MODEL,
					provenInputTokens: 757_872,
					persistedInputTokens: 834_492,
					persistedPercentage: (834_492 / 8_732_692) * 100,
				}),
			).toBe(757_872);
		} finally {
			closeQuietly(db);
		}
	});

	it("failed assistant usage cannot prove accepted capacity", async () => {
		const db = createTestDb();
		const sessionId = "ses-failed-not-proof";
		try {
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: reply(757_872),
				piModel: MODEL,
				piContextWindow: MODEL.contextWindow,
				piContextWindowSource: "catalog",
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: reply(8_732_692, {
					stopReason: "error",
					errorMessage: "quota exhausted",
				}),
				piModel: MODEL,
				piContextWindow: MODEL.contextWindow,
				piContextWindowSource: "catalog",
			});
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(757_872);
		} finally {
			closeQuietly(db);
		}
	});

	it("upgrade ignores failed usage, other models and branch estimates; missing evidence clears the latch", () => {
		const db = createTestDb();
		const sessionId = "ses-legacy-floor-evidence";
		try {
			poison(db, sessionId);
			const branch = [
				{ type: "message", message: reply(757_872) },
				{
					type: "message",
					message: reply(8_732_692, { stopReason: "aborted" }),
				},
				{ type: "message", message: reply(8_732_692, { model: "other" }) },
				{ type: "snapshot", usage: { contextTokens: 8_732_692 } },
			];
			expect(
				resolvePiProvenInputFloor({
					db,
					sessionId,
					modelKey: KEY,
					readBranch: () => branch,
				}),
			).toBe(757_872);
			poison(db, sessionId);
			expect(resolvePiProvenInputFloor({ db, sessionId, modelKey: KEY })).toBe(
				0,
			);
			expect(
				getOrCreateSessionMeta(db, sessionId).observedSafeInputTokens,
			).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("ctx-status repairs a legacy latch and names its measured denominator and source", () => {
		const db = createTestDb();
		const sessionId = "ses-status-measured-floor";
		try {
			poison(db, sessionId);
			const messages = [reply(757_872), reply(1_328_370)];
			const ctx = {
				...fakeContext(sessionId, process.cwd(), ["a", "b"], messages),
				model: MODEL,
				getContextUsage: () => ({
					contextWindow: MODEL.contextWindow,
					tokens: 834_492,
					percent: 0,
				}),
			};
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{ db, projectIdentity: "test" },
				sessionId,
			);
			expect(detail.contextLimit).toBe(1_328_370);
			const view = buildStatusViewFor(
				checkLocalStatusSource(statusViewSourceFromPiDetail(detail)),
				{ version: "test" },
			);
			const rows = view.sections.flatMap((section) => section.rows);
			expect(rows).toContainEqual({
				label: "Denominator",
				value: "1328370 tokens",
				tone: "muted",
			});
			expect(
				rows.find((row) => row.label === "Window source")?.value,
			).toContain("provider-measured");
		} finally {
			closeQuietly(db);
		}
	});
});
