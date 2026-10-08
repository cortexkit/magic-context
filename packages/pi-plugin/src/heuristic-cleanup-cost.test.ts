import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { runHeuristicCostFixture } from "./__tests__/heuristic-cost-fixture";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { NATIVE_TOOL_REMOVAL_MARKER } from "./native-replay-pi";
import * as nativeReplayState from "./native-replay-state-pi";
import {
	authorizePiToolRemoval,
	preparePiToolRemovalMeasurements,
} from "./native-replay-state-pi";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

describe("heuristic cleanup cost", () => {
	let fixture: ReturnType<typeof runHeuristicCostFixture>;
	beforeAll(() => {
		fixture = runHeuristicCostFixture();
		rmSync(fixture.root, { recursive: true, force: true });
	}, 30_000);

	it("preserves baseline served bytes, every tag row and the frozen replay envelope", () => {
		expect(fixture.result.droppedTools).toBe(48);
		expect(fixture.result.droppedInjections).toBe(10);
		expect(fixture.result.deduplicatedTools).toBe(0);
		// Captured from the unoptimized implementation on this same synthetic
		// fixture, not derived from the current algorithm's expected output.
		expect(fixture.hashes).toEqual({
			wire: "dababe9fb0e5588781555ed7f6728e316572d12fc4edb9867b86fa16adb066b4",
			tags: "cdbc566f2e0f69db95dfa9b78f45d7b8e49298bb31936497ee27515a3efff284",
			replay:
				"51977c05a45a936d134559ddf733eb3af8c09ee9c9a07e2dafb6e2bdd767b03c",
		});
	});

	it("merges native removal markers once before measuring 130 visible tool arcs", () => {
		expect(fixture.steps.nativeDocumentWrites?.calls).toBe(1);
		expect(fixture.steps.measureReclaim?.calls).toBe(130);
		expect(fixture.steps.dropTargets?.calls).toBe(48);
		expect(fixture.autocommitDocumentWrites).toBe(0);
		expect(fixture.transactions).toBe(3);
		// The full snapshot is shared with Channel-1 accounting. Heuristics do
		// not re-read it for each tool or perform any per-drop tag query.
		expect(fixture.steps.tagQueries?.calls).toBe(1);
	});

	it("retains per-call fail-closed authorization when the preparation write fails", () => {
		const db = createTestDb();
		try {
			const saved = new Map<string, string>();
			const args = {
				db,
				sessionId: "batch-failure",
				callIds: ["a", "b"],
				saved,
				canApply: true,
			};
			db.exec(
				"CREATE TRIGGER reject_native BEFORE UPDATE OF trailing_blank_decisions ON session_meta BEGIN SELECT RAISE(ABORT, 'rejected'); END",
			);
			preparePiToolRemovalMeasurements(args);
			expect([...saved]).toEqual([]);
			expect([...getNativeReplayState(db, args.sessionId).toolInputs]).toEqual(
				[],
			);
			expect(authorizePiToolRemoval({ ...args, callId: "a" })).toBe("defer");
			db.exec("DROP TRIGGER reject_native");
			preparePiToolRemovalMeasurements({ ...args, canApply: false });
			expect([...saved]).toEqual([]);
			preparePiToolRemovalMeasurements(args);
			expect([...saved]).toEqual([
				["a", NATIVE_TOOL_REMOVAL_MARKER],
				["b", NATIVE_TOOL_REMOVAL_MARKER],
			]);
			expect([...getNativeReplayState(db, args.sessionId).toolInputs]).toEqual([
				...saved,
			]);
		} finally {
			db.close();
		}
	});

	it("wires bulk marker preparation into the Pi context execute pass", async () => {
		const db = createTestDb();
		const fake = createFakePi();
		const sessionId = "cost-context-wiring";
		const prepare = spyOn(
			nativeReplayState,
			"preparePiToolRemovalMeasurements",
		);
		try {
			registerPiContextHandler(fake.pi as never, {
				db,
				heuristics: {},
				scheduler: { executeThresholdPercentage: 80 },
			});
			const messages = [
				userMessage("start", 0),
				...Array.from({ length: 22 }, (_, i) => [
					assistantToolCall(
						`call-${i}`,
						"ctx_note",
						{ action: `note-${i}` },
						i * 2 + 1,
					),
					toolResultMessage(`call-${i}`, "output ".repeat(100), i * 2 + 2),
				]).flat(),
				userMessage("continue", 50),
			];
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<unknown>;
			await handler({ messages: messages as never[] }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				model: {
					id: "cost-fixture",
					api: "anthropic-messages",
					provider: "anthropic",
					contextWindow: 100_000,
				},
				getContextUsage: () => ({
					percent: 90,
					tokens: 90_000,
					contextWindow: 100_000,
				}),
			} as never);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(prepare.mock.calls[0]?.[0].callIds).toEqual(
				Array.from({ length: 22 }, (_, i) => `call-${i}`),
			);
			expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(22);
		} finally {
			prepare.mockRestore();
			clearContextHandlerSession(sessionId);
			db.close();
		}
	});
});
