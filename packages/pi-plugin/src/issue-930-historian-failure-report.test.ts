/**
 * Issue 930 on Pi and Oh My Pi: the same refusal wording as OpenCode when a
 * pass at 95% runs out of time waiting for its historian run, and the same
 * early warning when summary runs keep failing. Both texts come from the
 * shared historian-failure-report module.
 */

import { expect, spyOn, test } from "bun:test";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import {
	getHistorianFailureState,
	incrementHistorianFailure,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { recordHistorianRun } from "@magic-context/core/features/magic-context/storage-historian-runs";
import { formatHistorianClockTime } from "@magic-context/core/hooks/magic-context/historian-failure-report";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { sendCtxStatusMessage } from "./commands/pi-command-utils";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiHistorianAlertState,
	runPiHistorian,
} from "./pi-historian-runner";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const EARLIER_RUN_ERROR =
	"Historian returned invalid compartment output: Compartment range 202-280 does not map to raw session lines 407-432";
const ACTIONS =
	"What to do: run /ctx-status for detail; change the historian model or its fallback models in magic-context.jsonc; or run /ctx-recomp to rebuild the history.";
const WARNING_HEADING = "## Magic Context — History summaries keep failing";
/** A historian answer whose range lies outside any chunk these tests read. */
const UNMAPPABLE_OUTPUT =
	'<compartment start="900" end="950" title="Elsewhere"><p1>Not this chunk.</p1></compartment>';

test("issue 930: a Pi pass whose wait for the historian runs out is refused with the shared wording", async () => {
	const db = createTestDb();
	const sessionId = "issue-930-pi-refusal";
	const originalTimer = globalThis.setTimeout;
	// Let the real work-clock wait run out without spending its 21 s: only
	// the wait's own timer is that long.
	const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
		...args: Parameters<typeof setTimeout>
	) => {
		if (typeof args[1] === "number" && args[1] > 19_000 && args[1] <= 21_000)
			args[1] = 5;
		return originalTimer(...args);
	}) as typeof setTimeout);
	let finish!: () => void;
	const historian = new Promise<void>((resolve) => {
		finish = resolve;
	});
	// The earlier run failed validation and ended 80 s ago; 20 s later the
	// run this pass waits for started on messages 407-443.
	const earlierFailureAt = Date.now() - 80_000;
	incrementHistorianFailure(db, sessionId, EARLIER_RUN_ERROR);
	db.prepare(
		"UPDATE session_meta SET historian_last_failure_at = ? WHERE session_id = ?",
	).run(earlierFailureAt, sessionId);
	const earlierRunId = recordHistorianRun(db, {
		sessionId,
		harness: "pi",
		runKind: "incremental",
		status: "failed",
		failureReason: EARLIER_RUN_ERROR,
	});
	db.prepare("UPDATE historian_runs SET created_at = ? WHERE id = ?").run(
		earlierFailureAt,
		earlierRunId,
	);
	const restore = __test.setInFlightHistorianForTests(sessionId, historian, {
		startedAt: Date.now() - 60_000,
		chunk: { start: 407, end: 443 },
	});
	try {
		const fake = createFakePi();
		const entries: unknown[] = [];
		registerPiContextHandler(
			{
				...fake.pi,
				appendEntry: (_type: string, data: unknown) => entries.push(data),
			} as never,
			{ db },
		);
		let aborted = false;
		const raw = [userMessage("must not send without a summary", 1)];
		const ctx = {
			...fakeContext(sessionId, process.cwd(), ["u"], raw),
			getContextUsage: () => ({
				tokens: 96_000,
				percent: 96,
				contextWindow: 100_000,
			}),
			abort: () => {
				aborted = true;
			},
		};
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		await handler({ messages: raw } as never, ctx as never);

		expect(aborted).toBe(true);
		const refusal = entries
			.map((entry) => (entry as { message?: unknown }).message)
			.find(
				(message): message is string =>
					typeof message === "string" &&
					message.startsWith("This turn was not sent"),
			);
		if (!refusal) throw new Error(`no refusal in ${JSON.stringify(entries)}`);
		const earlier = formatHistorianClockTime(earlierFailureAt);
		// The wait had the rest of the 21 s work clock.
		expect(refusal).toMatch(
			/^This turn was not sent: context is at 96% of the window, and Magic Context waited 2\d s for a history summary that did not finish in time\. /,
		);
		expect(refusal).toMatch(
			/ The summary of messages 407-443 is still running after 6\d s\. /,
		);
		expect(refusal).toContain(
			` The previous run failed at ${earlier}: ${EARLIER_RUN_ERROR}. Summary runs failed in a row: 1, since ${earlier}. ${ACTIONS} (stage=emergency historian `,
		);
		expect(refusal).not.toContain("407-443 failed");
	} finally {
		finish();
		restore();
		timers.mockRestore();
		await new Promise<void>((resolve) => setImmediate(resolve));
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

function rawMessages(count: number): RawMessage[] {
	return Array.from({ length: count }, (_, index) => {
		const ordinal = index + 1;
		return {
			ordinal,
			id: `m${ordinal}`,
			role: ordinal % 2 === 1 ? "user" : "assistant",
			parts: [{ type: "text", text: `Pi message ${ordinal}` }],
		};
	});
}

function boundarySnapshot(sessionId: string): ProtectedTailBoundarySnapshot {
	return {
		sessionId,
		mode: "pi-trigger",
		offset: 1,
		offsetMessageId: "m1",
		protectedTailStart: 6,
		protectedTailStartMessageId: "m6",
		eligibleEndOrdinal: 6,
		eligibleEndMessageId: "m5",
		rawMessageCountAtTrigger: 12,
		rawLastMessageIdAtTrigger: "m12",
		N: 1000,
		usagePercentage: 80,
		usageInputTokens: 8000,
		usageSource: "live",
		contextLimit: 10_000,
		executeThresholdPercentage: 65,
		triggerBudget: 1000,
		priorBoundaryOrdinal: 6,
		migrationFloorActive: false,
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "test:issue-930-pi",
		createdAt: 1,
		rawRangeFingerprint: "",
		trueRawEligibleTokens: 1000,
		summaryRemovedEligibleTokens: 1000,
		oversizeAtomicUnit: false,
		boundaryReason: "test",
	};
}

test("issue 930: the Pi historian shows the shared early warning at the 3rd failed run in a row, not at the 2nd or 4th", async () => {
	const db = createTestDb();
	const sessionId = "issue-930-pi-warning";
	const holderId = "issue-930-pi-warning";
	expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
	updateSessionMeta(db, sessionId, {
		lastContextPercentage: 82,
		lastInputTokens: 82_000,
	});
	const notices: string[] = [];
	const runner = {
		harness: "pi",
		run: async () => ({
			ok: true,
			assistantText: UNMAPPABLE_OUTPUT,
			durationMs: 1,
		}),
	} as unknown as SubagentRunner;
	const run = () =>
		runPiHistorian({
			db,
			sessionId,
			directory: process.cwd(),
			provider: { readMessages: () => rawMessages(12) },
			runner,
			historianModel: "test/model",
			historianChunkTokens: 20_000,
			historianContextLimit: 200_000,
			producerContextLimits: new Map([["test/model", 200_000]]),
			boundarySnapshot: boundarySnapshot(sessionId),
			compartmentLeaseHolderId: holderId,
			forceDrainQuota: true,
			notifyIssue: (message) => {
				notices.push(message);
			},
		});
	const warnings = () =>
		notices.filter((notice) => notice.startsWith(WARNING_HEADING));
	try {
		await run();
		await run();
		expect(getHistorianFailureState(db, sessionId).failureCount).toBe(2);
		expect(warnings()).toEqual([]);

		await run();
		const state = getHistorianFailureState(db, sessionId);
		expect(state.failureCount).toBe(3);
		const firstFailedRunEnded = (
			db
				.prepare(
					"SELECT created_at FROM historian_runs WHERE session_id = ? AND status = 'failed' ORDER BY id LIMIT 1",
				)
				.get(sessionId) as { created_at: number }
		).created_at;
		expect(warnings()).toEqual([
			[
				WARNING_HEADING,
				"",
				`Summary runs failed in a row: 3, since ${formatHistorianClockTime(firstFailedRunEnded)}. Last chunk: messages 1-5. Last error: ${state.lastError}. Now context is at 82% of the window; at 95% a turn waits for a summary and is not sent if none finishes in time.`,
				"",
				ACTIONS,
			].join("\n"),
		]);

		await run();
		expect(getHistorianFailureState(db, sessionId).failureCount).toBe(4);
		expect(warnings()).toHaveLength(1);
	} finally {
		clearPiHistorianAlertState(sessionId);
		closeQuietly(db);
	}
});

test("issue 930: the Pi status notice the warning uses touches no prompt bytes", async () => {
	const db = createTestDb();
	const sessionId = "issue-930-pi-warning-bytes";
	try {
		const fake = createFakePi();
		const entries: unknown[] = [];
		const pi = {
			...fake.pi,
			appendEntry: (_type: string, data: unknown) => entries.push(data),
		};
		registerPiContextHandler(pi as never, { db, protectedTags: 0 });
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const conversation = () => [
			userMessage("Summarize why the history keeps failing.", 1),
			assistantMessage("Looking at the historian runs now.", 2),
			userMessage("continue", 3),
		];
		const pass = async (): Promise<string> => {
			const messages = conversation();
			const result = await handler(
				{ messages } as never,
				fakeContext(
					sessionId,
					process.cwd(),
					["u1", "a1", "u2"],
					messages,
				) as never,
			);
			return JSON.stringify(result ?? { messages });
		};

		await pass();
		const withoutWarning = await pass();
		// The call the Pi historian's notifyIssue makes for every notice,
		// the repeated-failure warning included (spawnPiHistorianRun).
		sendCtxStatusMessage(pi as never, {
			title: "Magic Context",
			text: `${WARNING_HEADING}\n\nSummary runs failed in a row: 3.\n\n${ACTIONS}`,
			level: "warning",
		});
		expect(JSON.stringify(entries)).toContain("keep failing");
		const withWarning = await pass();

		expect(withWarning).toBe(withoutWarning);
		expect(withWarning).not.toContain("keep failing");
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});
