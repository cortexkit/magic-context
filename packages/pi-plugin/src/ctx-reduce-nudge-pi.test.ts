import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getChannel1NudgeState,
	getChannel2NudgeClaim,
	getChannel2NudgeClaimedAt,
	getChannel2NudgeState,
	getOldestActiveUnprotectedToolTags,
	insertTag,
	setChannel1NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { countRealPiUserMessages } from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";

type ReminderCopyGolden = {
	schema: number;
	cases: Array<{
		id: string;
		channel: "channel1" | "channel2";
		level?: "gentle" | "firm" | "urgent";
		reclaimable_tool_outputs: number;
		reclaimable_tokens: number;
		sticky?: boolean;
		hint: Array<{ tag_number: number; tool_name: string | null }>;
		expected: string;
	}>;
};

const reminderCopyGolden = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../../../crates/mc-module/testdata/ctx-reduce-nudge-copy-golden.json",
		),
		"utf8",
	),
) as ReminderCopyGolden;

function reclaimableToolOutputParts(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		key: `tool-output-${index}`,
		contentHash: `hash-${index}`,
		kind: "toolOutput" as const,
		tokens: 1,
		uTokens: 1,
		tagNumber: index + 1,
		tagStatus: "active",
		protected: false,
		queuedForDrop: false,
	}));
}

function channel2BaselineFields(baselineU: number, baselineT: number) {
	return {
		baselineU,
		baselineT,
		turnDeltaU: 0,
		turnDeltaT: 0,
		usableWindow: 128_000,
		realUserTurnCount: 1,
		baselineGeneration: 1,
		computedAt: 1,
		evaluable: true,
		generationInvalidated: false,
		baselineParts: [],
		contentSignature: "fixture",
	};
}

afterEach(() => {
	mock.restore();
});

describe("maybeChannel1ReminderForToolResult", () => {
	const SESSION = "ses-ch1";

	it("matches the shared copy golden for every Pi-rendered band", () => {
		expect(reminderCopyGolden.schema).toBe(1);
		const rendered: Array<{ id: string; text: string }> = [];
		for (const reminder of reminderCopyGolden.cases) {
			const db = createTestDb();
			const sessionId = `ses-copy-${reminder.id}`;
			const hints = reminder.hint.map(({ tag_number, tool_name }) => ({
				tagNumber: tag_number,
				toolName: tool_name,
			}));
			if (reminder.channel === "channel1") {
				const [baselineU, baselineT] =
					reminder.level === "gentle"
						? [reminder.reclaimable_tokens, 400_000]
						: reminder.level === "firm"
							? [reminder.reclaimable_tokens, 200_000]
							: [reminder.reclaimable_tokens, 120_000];
				setPiChannel1Baseline(sessionId, {
					...channel2BaselineFields(baselineU, baselineT),
					reducedSinceRefresh: false,
					baselineParts: reclaimableToolOutputParts(
						reminder.reclaimable_tool_outputs,
					),
					oldestReclaimableToolTags: hints,
				});
				if (reminder.sticky) {
					setChannel1NudgeState(db, sessionId, {
						level: reminder.level ?? "firm",
						ordinal: 1,
					});
				}
				const block = maybeChannel1ReminderForToolResult({
					db,
					sessionId,
					toolName: "bash",
					content: [{ type: "text", text: "tool output" }],
				});
				expect(block?.text, reminder.id).toBe(reminder.expected);
				rendered.push({ id: reminder.id, text: block?.text ?? "" });
			} else {
				setChannel2NudgeState(db, sessionId, "pending");
				setPiChannel1Baseline(sessionId, {
					...channel2BaselineFields(reminder.reclaimable_tokens, 100_000),
					reducedSinceRefresh: false,
					baselineParts: reclaimableToolOutputParts(
						reminder.reclaimable_tool_outputs,
					),
					oldestReclaimableToolTags: hints,
				});
				let text = "";
				expect(
					maybeDeliverChannel2Pi(
						{ sendMessage: (message) => (text = message.content) },
						db,
						sessionId,
					),
				).toBe(true);
				expect(text, reminder.id).toBe(reminder.expected);
				rendered.push({ id: reminder.id, text });
			}
			clearPiChannel1State(sessionId);
		}

		for (const reminder of rendered) {
			expect(
				reminder.text,
				`${reminder.id} must not expose a denominator`,
			).not.toContain("of ~");
			expect(
				reminder.text,
				`${reminder.id} must not expose session capacity`,
			).not.toContain("of this session");
			expect(
				reminder.text.match(/~\d+(?:\.\d+)?k\b/g) ?? [],
				`${reminder.id} must expose only the reclaimable token mass`,
			).toHaveLength(1);
			expect(
				reminder.text,
				`${reminder.id} must not expose a percentage`,
			).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
			expect(
				reminder.text,
				`${reminder.id} must not expose context capacity`,
			).not.toMatch(/\bwindow\b/i);
		}
	});

	function seedBaseline(tailTokens: number): void {
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(tailTokens, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("returns null when no baseline exists (subagent / off)", () => {
		const db = createTestDb();
		clearPiChannel1State(SESSION);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(80_000) }],
		});
		expect(block).toBeNull();
	});

	it("fires a system-reminder block when the rendered-tail ratio warrants it", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block).not.toBeNull();
		expect(block?.type).toBe("text");
		expect(block?.text).toContain("<system-reminder>");
		expect(block?.text).toContain(
			"Housekeeping backlog: spent tool outputs (~90k tokens) are reclaimable",
		);
		clearPiChannel1State(SESSION);
	});

	it("includes oldest reclaimable hints from the baseline", () => {
		const db = createTestDb();
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 123, toolName: "read" }],
		});
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block?.text).toContain("oldest reclaimable: §123§ read.");
		clearPiChannel1State(SESSION);
	});

	it("uses the shared hint selection to skip control-plane and tiny outputs", () => {
		const db = createTestDb();
		const tag = (tagNumber: number, toolName: string, tokenCount: number) =>
			insertTag(
				db,
				SESSION,
				`msg-${tagNumber}`,
				"tool",
				9000,
				tagNumber,
				0,
				toolName,
				0,
				null,
				null,
				{
					tokenCount,
					inputTokenCount: 0,
					reasoningTokenCount: 0,
				},
			);
		tag(1, "work", 900);
		tag(2, "board", 900);
		tag(3, "bash", 40);
		tag(4, "bash", 2300);
		tag(5, "bash", 1800);
		tag(6, "aft_search", 900);
		tag(7, "read", 900);
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: getOldestActiveUnprotectedToolTags(
				db,
				SESSION,
			),
		});

		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});

		expect(block?.text).toContain(
			"oldest reclaimable: §4§ bash · §5§ bash · §6§ aft_search · §7§ read.",
		);
		expect(block?.text).not.toContain("§1§ work");
		expect(block?.text).not.toContain("§2§ board");
		clearPiChannel1State(SESSION);
	});

	it("omits the Pi reminder hint when only control-plane candidates remain", () => {
		const db = createTestDb();
		for (const [tagNumber, toolName] of [
			[1, "work"],
			[2, "board"],
			[3, "ask"],
			[4, "ctx_search"],
			[5, "bash_kill"],
			[6, "todoread"],
		] as const) {
			insertTag(
				db,
				SESSION,
				`msg-${tagNumber}`,
				"tool",
				9000,
				tagNumber,
				0,
				toolName,
				0,
				null,
				null,
				{
					tokenCount: 900,
					inputTokenCount: 0,
					reasoningTokenCount: 0,
				},
			);
		}
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: getOldestActiveUnprotectedToolTags(
				db,
				SESSION,
			),
		});

		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});

		expect(block?.text).not.toContain("oldest reclaimable");
		clearPiChannel1State(SESSION);
	});

	it("gives an applying drop pass one fire-free baseline before resuming", () => {
		const db = createTestDb();
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			agentDropsAppliedThisPass: true,
			oldestReclaimableToolTags: [],
		});
		const applyingPass = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "output on applying pass" }],
		});
		expect(applyingPass).toBeNull();

		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(90_000, 120_000),
			reducedSinceRefresh: false,
			agentDropsAppliedThisPass: false,
			oldestReclaimableToolTags: [],
		});
		const nextPass = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "output on next pass" }],
		});
		expect(nextPass?.text).toContain(
			"Housekeeping backlog: spent tool outputs (~90k tokens)",
		);
		clearPiChannel1State(SESSION);
	});

	it("clears both the persisted level and ordinal when a collapse resets the cycle", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		expect(
			maybeChannel1ReminderForToolResult({
				db,
				sessionId: SESSION,
				toolName: "bash",
				content: [{ type: "text", text: "first output" }],
			}),
		).not.toBeNull();
		expect(getChannel1NudgeState(db, SESSION)).toEqual({
			level: "urgent",
			ordinal: 1,
		});

		seedBaseline(10_000);
		expect(
			maybeChannel1ReminderForToolResult({
				db,
				sessionId: SESSION,
				toolName: "bash",
				content: [{ type: "text", text: "post-collapse output" }],
			}),
		).toBeNull();
		expect(getChannel1NudgeState(db, SESSION)).toEqual({
			level: "",
			ordinal: 0,
		});
		clearPiChannel1State(SESSION);
	});

	it("suppresses on a ctx_reduce tool result and marks reduced", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "ctx_reduce",
			content: [{ type: "text", text: "dropped 5 tags" }],
		});
		expect(block).toBeNull();
		// After a reduce, a subsequent tool result is also suppressed this turn.
		const next = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "more output" }],
		});
		expect(next).toBeNull();
		clearPiChannel1State(SESSION);
	});

	it("is idempotent — does not double-append to a result already carrying the marker", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "out <system-reminder> already here" }],
		});
		expect(block).toBeNull();
		clearPiChannel1State(SESSION);
	});

	it("uses real user turns for sticky refires, expiration, and escalation", () => {
		const db = createTestDb();
		const baseline = (
			baselineU: number,
			baselineT: number,
			realUserTurnCount: number,
		) => ({
			...channel2BaselineFields(baselineU, baselineT),
			realUserTurnCount,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		const realUserTurns = (
			messages: readonly unknown[],
			syntheticLeadingCount = 0,
		) =>
			countRealPiUserMessages({
				messages,
				tags: [],
				protectedTags: 0,
				syntheticLeadingCount,
			});
		const realTurn = { role: "user", content: "continue" };
		const sameTurnWithSyntheticRows = [
			{ role: "user", content: "m0 head" },
			{ role: "user", content: "m1 head" },
			realTurn,
		];
		const firstTurnCount = realUserTurns([realTurn]);
		const sameTurnCount = realUserTurns(sameTurnWithSyntheticRows, 2);
		expect(sameTurnCount).toBe(firstTurnCount);

		setPiChannel1Baseline(SESSION, baseline(50_000, 120_000, firstTurnCount));
		const first = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "first output" }],
		});
		expect(first?.text).toContain(
			"Housekeeping: spent tool outputs (~50k tokens)",
		);
		expect(
			db
				.prepare(
					"SELECT last_nudge_level FROM session_meta WHERE session_id = ?",
				)
				.get(SESSION),
		).toEqual({ last_nudge_level: '{"level":"firm","ordinal":1}' });

		// Live repro: m0/m1 are two synthetic user rows in the same real turn.
		setPiChannel1Baseline(SESSION, baseline(80_000, 180_000, sameTurnCount));
		const sticky = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "second output" }],
		});
		expect(sticky?.text).toContain(
			"Reminder: spent tool outputs (~80k tokens) are still reclaimable",
		);
		expect(sticky?.text).not.toContain("of this session");

		const threeRealTurnsLater = [
			{ role: "user", content: "m0 head" },
			{ role: "user", content: "m1 head" },
			...Array.from({ length: 4 }, (_, index) => ({
				role: "user",
				content: `real turn ${index}`,
			})),
		];
		setPiChannel1Baseline(
			SESSION,
			baseline(110_000, 240_000, realUserTurns(threeRealTurnsLater, 2)),
		);
		const expired = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "third output" }],
		});
		expect(expired?.text).toContain(
			"Housekeeping: spent tool outputs (~110k tokens)",
		);
		expect(expired?.text).not.toContain("Reminder: spent tool outputs");

		setPiChannel1Baseline(SESSION, baseline(120_000, 180_000, 4));
		const escalation = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "fourth output" }],
		});
		expect(escalation?.text).toContain(
			"Housekeeping backlog: spent tool outputs (~120k tokens)",
		);
		expect(escalation?.text).not.toContain("Reminder: spent tool outputs");
		clearPiChannel1State(SESSION);
	});

	it("expires a legacy raw ordinal before writing the real-user counter", () => {
		const db = createTestDb();
		setPiChannel1Baseline(SESSION, {
			...channel2BaselineFields(80_000, 180_000),
			realUserTurnCount: 1,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		// The first delivery creates the session row; replace only the persisted
		// ordinal with a legacy raw-message value before the re-evaluation.
		maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "seed output" }],
		});
		db.prepare(
			"UPDATE session_meta SET last_nudge_undropped = ?, last_nudge_level = ? WHERE session_id = ?",
		).run(50_000, '{"level":"firm","ordinal":160750}', SESSION);
		expect(getChannel1NudgeState(db, SESSION)).toEqual({
			level: "firm",
			ordinal: 160_750,
		});

		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "legacy output" }],
		});
		expect(block?.text).toContain(
			"Housekeeping: spent tool outputs (~80k tokens)",
		);
		expect(block?.text).not.toContain("Reminder: spent tool outputs");
		expect(
			db
				.prepare(
					"SELECT last_nudge_level FROM session_meta WHERE session_id = ?",
				)
				.get(SESSION),
		).toEqual({ last_nudge_level: '{"level":"firm","ordinal":1}' });
		clearPiChannel1State(SESSION);
	});
});

describe("maybeDeliverChannel2Pi", () => {
	const SESSION = "ses-ch2-pi";

	it("no-ops when no pending intent exists", () => {
		const db = createTestDb();
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});

	/** A baseline whose measurement still satisfies the full Channel-2 trigger. */
	function armStrongBaseline(sessionId: string): void {
		setPiChannel1Baseline(sessionId, {
			...channel2BaselineFields(75_000, 100_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("regression: queues the model-visible ceiling nudge for the next real turn", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		let capturedContent = "";
		let capturedDeliverAs = "";
		let capturedDisplay: boolean | undefined;
		let capturedCustomType = "";
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: (message, options) => {
					capturedContent = message.content;
					capturedDisplay = message.display;
					capturedCustomType = message.customType;
					capturedDeliverAs = options?.deliverAs ?? "";
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(true);
		expect(capturedDeliverAs).toBe("nextTurn");
		// Hidden from the Pi TUI as synthetic context but still model-visible.
		expect(capturedDisplay).toBe(false);
		expect(capturedCustomType).toBe("magic-context:ceiling-nudge");
		expect(capturedContent).toContain("<system-reminder>");
		expect(capturedContent).toContain(
			"Routine housekeeping: spent tool outputs (~75k tokens) are reclaimable — make a ctx_reduce pass at a natural stopping point.",
		);
		expect(capturedContent).toContain("oldest reclaimable");
		expect(getChannel2NudgeState(db, SESSION)).toBe("delivered");
	});

	it("does NOT deliver and leaves pending when no baseline measurement exists", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-unknown";
		setChannel2NudgeState(db, session, "pending");
		clearPiChannel1State(session);
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		// An unknown U/T baseline must neither consume the cycle cap nor cancel
		// the intent; a later agent_end with a real measurement decides.
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("pending");
	});

	it("holds pending when the baseline generation was invalidated", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-invalidated";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);
		const baseline = getPiChannel1Baseline(session);
		if (!baseline) throw new Error("missing test baseline");
		baseline.evaluable = false;
		baseline.generationInvalidated = true;
		let sent = 0;

		const delivered = maybeDeliverChannel2Pi(
			{ sendMessage: () => sent++ },
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("pending");
	});

	it("cancels (re-armable) when typed T growth leaves the fourth band", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-typed-delta";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);
		maybeChannel1ReminderForToolResult({
			db,
			sessionId: session,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(40_000) }],
		});
		let sent = 0;

		const delivered = maybeDeliverChannel2Pi(
			{ sendMessage: () => sent++ },
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("cancels (re-armable) when the full trigger predicate no longer holds", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-stale";
		setChannel2NudgeState(db, session, "pending");
		// The 50k floor holds, but severity is only 0.50, below the fourth band.
		setPiChannel1Baseline(session, {
			...channel2BaselineFields(50_000, 100_000),
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		// Cancelled to '' (re-armable), NOT 'delivered' — cap preserved.
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("reverts to pending on send failure (cap not burned)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, SESSION)).toBe("pending");
	});

	it("refuses a foreign revert attempt against a live claim", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-foreign-revert";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					// A sibling acquired a fresh lease after this delivery attempt lost
					// its own claim. Its claim must not be returned to pending here.
					db.prepare(
						"UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ?",
					).run(Date.now(), "foreign-claim-token", session);
					throw new Error("transient");
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeClaim(db, session)).toMatchObject({
			state: "claimed",
			claimToken: "foreign-claim-token",
		});
	});

	it("returns false and leaves the claim healable when claimed→pending CAS throws", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-revert-throw";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const originalPrepare = db.prepare.bind(db);
		(db as unknown as { prepare: typeof db.prepare }).prepare = (
			sql: string,
		) => {
			const statement = originalPrepare(sql);
			if (
				sql ===
				"UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?"
			) {
				return {
					...statement,
					run: (...args: unknown[]) => {
						if (
							args[0] === "pending" &&
							args[1] === 0 &&
							args[2] === "" &&
							args[3] === session
						) {
							throw new Error("SQLITE_BUSY: database is locked");
						}
						return statement.run(
							...(args as [unknown, unknown, unknown, unknown, unknown]),
						);
					},
				} as typeof statement;
			}
			return statement;
		};

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("claimed");
		expect(getChannel2NudgeClaimedAt(db, session)).toBeGreaterThan(0);
	});

	it("preserves a sibling's delivered lease when token confirmation is lost", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-duplicate";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					db.prepare(
						"UPDATE session_meta SET channel2_nudge_state = 'delivered', channel2_nudge_claimed_at = 0 WHERE session_id = ?",
					).run(session);
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("delivered");
		expect(
			sessionLog.mock.calls.some(
				(call) =>
					call[0] === session &&
					typeof call[1] === "string" &&
					call[1].includes("claim confirmation was not ours"),
			),
		).toBe(true);
	});

	it("does not re-deliver before a tail-cycle reset", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "delivered");
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});
});

describe("Channel 2 delivery wiring (regression)", () => {
	// The helper is well-tested above, but the bug it guards against is that
	// `index.ts` never CALLED it — Pi recorded `pending` and never delivered.
	// Assert the agent_end handler actually invokes the delivery.
	const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

	it("index.ts imports maybeDeliverChannel2Pi", () => {
		expect(INDEX_SRC).toContain("maybeDeliverChannel2Pi");
	});

	it("the agent_end handler calls maybeDeliverChannel2Pi", () => {
		const handler = INDEX_SRC.match(/pi\.on\("agent_end",[\s\S]*?\n\s*\}\);/);
		expect(handler).not.toBeNull();
		expect(handler?.[0] ?? "").toContain(
			"maybeDeliverChannel2Pi(pi, db, sessionId)",
		);
	});
});
