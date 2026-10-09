import { expect, it, mock, spyOn } from "bun:test";
import {
	countHistorianRuns,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// This test uses the real Pi historian path: the mocked subagent returns a
// valid compartment, then the runner records its attempt in historian_runs.
it("issue 634: recorded historian run count increments after a real invocation", async () => {
	const db = createTestDb();
	const sessionId = "ses-issue-634-fire-counter";
	const logs: string[] = [];
	spyOn(logger, "sessionLog").mockImplementation((_id, ...parts) => {
		logs.push(parts.map(String).join(" "));
	});
	const runner = {
		harness: "pi",
		run: mock(async () => ({
			ok: true as const,
			assistantText:
				'<compartment start="1" end="2" title="History"><p1>Completed work.</p1></compartment>',
			durationMs: 1,
		})),
	} as unknown as SubagentRunner;
	try {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			piStableIdScheme: 1,
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			historian: {
				runner,
				model: "test/historian",
				historianChunkTokens: 20_000,
				executeThresholdPercentage: 80,
				protectedTags: 0,
			},
		});
		const messages = Array.from({ length: 12 }, (_, index) =>
			index % 2 === 0
				? userMessage(`user ${index}`, index + 1)
				: assistantMessage(`assistant ${index}`, index + 1),
		);
		const handler = fake.handlers.get("context") as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		await handler(
			{ messages },
			{
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index + 1}`),
					messages,
				),
				getContextUsage: () => ({
					tokens: 85_000,
					percent: 85,
					contextWindow: 100_000,
				}),
			},
		);
		await awaitInFlightHistorians();
		expect(runner.run, logs.join("\n")).toHaveBeenCalledTimes(1);
		expect(countHistorianRuns(db, sessionId)).toBe(1);
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		mock.restore();
	}
});
