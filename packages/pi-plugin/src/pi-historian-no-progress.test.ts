import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getHistorianFailureState,
	getOrCreateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as validation from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { createDefaultBoundarySnapshotForTests } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { runPiHistorian } from "./pi-historian-runner";
import { createTestDb } from "./test-utils.test";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups.length = 0;
});

function message(ordinal: number): RawMessage {
	return {
		ordinal,
		id: `m${ordinal}`,
		role: ordinal % 2 ? "user" : "assistant",
		parts: [
			{
				type: "text",
				text: `Message ${ordinal}: investigate the historian retry behavior.`,
			},
		],
	};
}

async function fixture() {
	const db = createTestDb();
	const sessionId = `pi-no-progress-${crypto.randomUUID()}`;
	const messages = Array.from({ length: 24 }, (_, index) => message(index + 1));
	const provider = { readMessages: () => messages };
	const unregister = setRawMessageProvider(sessionId, provider);
	cleanups.push(() => db.close(), unregister);
	expect(acquireCompartmentLease(db, sessionId, "test-holder")).not.toBeNull();
	let publishEnd: number | undefined;
	const run = mock(async () => ({
		ok: true as const,
		assistantText: "historian output",
		durationMs: 1,
	}));
	// Pi currently cannot discard every validated compartment. Inject the
	// no-progress outcome at validation so its defensive runner guard is exercised.
	const validate = spyOn(
		validation,
		"validateHistorianOutput",
	).mockImplementation((_text, _session, chunk, _prior, sequenceOffset) => ({
		ok: true,
		compartments:
			publishEnd === undefined
				? []
				: [
						{
							sessionId,
							sequence: sequenceOffset,
							startMessage: chunk.startIndex,
							endMessage: publishEnd,
							startMessageId: `m${chunk.startIndex}`,
							endMessageId: `m${publishEnd}`,
							title: "History",
							content: "Investigated the retry behavior.",
						},
					],
		facts: [],
	}));
	cleanups.push(() => validate.mockRestore());
	const pass = async (
		percentage = 80,
		manual = false,
		end?: number,
		direct = false,
	) => {
		const decision = checkCompartmentTrigger(
			db,
			sessionId,
			getOrCreateSessionMeta(db, sessionId),
			{ percentage, inputTokens: percentage * 1000, contextLimit: 100_000 },
			0,
			65,
			100_000,
		);
		if (!decision.shouldFire && !manual && !direct) return;
		publishEnd = end;
		await runPiHistorian({
			db,
			sessionId,
			provider,
			directory: process.cwd(),
			runner: { harness: "pi", run } as unknown as SubagentRunner,
			historianModel: "test/model",
			historianContextLimit: 200_000,
			historianChunkTokens: 20_000,
			memoryEnabled: false,
			boundarySnapshot: {
				...createDefaultBoundarySnapshotForTests(sessionId),
				usagePercentage: percentage,
			},
			compartmentLeaseHolderId: "test-holder",
			forceDrainQuota: manual,
		});
	};
	return { db, sessionId, messages, run, pass };
}

describe("Pi historian no-progress history wait", () => {
	it("makes one model call across unchanged trigger passes, then retries after a new message", async () => {
		const { db, sessionId, messages, run, pass } = await fixture();
		await pass();
		expect(getHistorianFailureState(db, sessionId).lastError).toContain(
			"did not advance",
		);
		await pass();
		expect(run).toHaveBeenCalledTimes(1);
		expect(getHistorianFailureState(db, sessionId).failureCount).toBe(1);
		messages.push(message(25));
		await pass();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("allows the force band once on an unchanged failed window", async () => {
		const { run, pass } = await fixture();
		await pass();
		await pass(85);
		expect(run).toHaveBeenCalledTimes(2);
		await pass(85);
		await pass(95, false, undefined, true);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("allows an emergency start once even when it bypasses the trigger", async () => {
		const { run, pass } = await fixture();
		await pass();
		await pass(95, false, undefined, true);
		expect(run).toHaveBeenCalledTimes(2);
		await pass(95, false, undefined, true);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("allows manual publication and clears the history wait after commit", async () => {
		const { db, sessionId, run, pass } = await fixture();
		await pass();
		await pass(80, true, 2);
		expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(2);
		await pass(80, false, 14);
		expect(run).toHaveBeenCalledTimes(3);
		expect(getCompartments(db, sessionId).at(-1)?.endMessage).toBe(14);
		expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
	});
});
