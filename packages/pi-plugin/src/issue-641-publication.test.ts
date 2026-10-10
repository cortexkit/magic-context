import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	__test as decisions,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";
import { createPiLkgCoordinator } from "./pi-lkg";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	__test as ledger,
} from "./served-array-ledger";
import { createTestDb } from "./test-utils.test";

// Publication tests advance the same monotonic clock without waiting 25 seconds.
test("expired deferred publication cannot flush LKG, served capture or a transform decision", async () => {
	const { dir: root, cleanup } = createTestTempDir("mc641-publication-");
	const db = openDatabase(join(root, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	const callbacks: (() => void)[] = [];
	const coordinator = createPiLkgCoordinator(db, (callback) =>
		callbacks.push(callback),
	);
	let written = 0;
	decisions.setWriterForTests(() => {
		written++;
	});
	const raw = [{ role: "user", content: "§1§ managed", timestamp: 1 }];
	const sessionId = "deadline-publication";
	try {
		const snapshot = coordinator.beginPass({
			sessionId,
			messages: raw,
			entryIds: ["u"],
			modelKey: "test/model",
			providerKey: "test",
		});
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: raw,
			outputEntryIds: ["u"],
			cacheBusting: false,
			assertCurrentPass: budget.assert,
		});
		capturePiServedArray(sessionId, raw, {
			storageDir: root,
			assertCurrentPass: budget.assert,
		});
		recordPendingPiTransformDecision(
			sessionId,
			{
				tsMs: 1,
				decision: "execute",
				materialized: true,
				materializeReason: "first_render",
				systemHashPrev: null,
				systemHashNew: null,
				m0ModelKeyPrev: null,
				m0ModelKeyNew: null,
				emergency: false,
				droppedTokens: 0,
				droppedCount: 0,
				inputTokens: 10,
				bustedThisPass: true,
			},
			null,
			budget.assert,
		);
		expect(
			schedulePiTransformDecisionResolve({
				db,
				sessionId,
				branchEntries: [
					{ type: "message", id: "a", message: { role: "assistant" } },
				],
				assertCurrentPass: budget.assert,
			}),
		).toBe(true);
		expect(callbacks).toHaveLength(1);
		now = 32000;
		callbacks[0]();
		flushPiServedArrayLedger();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(getSlot(sessionId)).toBeUndefined();
		expect(existsSync(getPiServedArrayLedgerPath(sessionId, root))).toBe(false);
		expect(written).toBe(0);
	} finally {
		decisions.reset();
		ledger.reset();
		resetLkgSlotsForTest();
		db.close();
		cleanup();
	}
});

test("serialization stalled past deadline does not replace LKG or advance served tags", () => {
	const db = createTestDb();
	let now = 0;
	const budget = new PiContextBudget(0, () => now);
	const coordinator = createPiLkgCoordinator(db);
	const input = [{ role: "user", content: "raw", timestamp: 1 }];
	const output = [
		{
			role: "user",
			content: {
				toJSON: () => {
					now = 32000;
					return "§99§ never served";
				},
			},
			timestamp: 1,
		},
	];
	const sessionId = "stalled-publication";
	try {
		const snapshot = coordinator.beginPass({
			sessionId,
			messages: input,
			entryIds: ["u"],
			modelKey: "test/model",
			providerKey: "test",
		});
		expect(() =>
			coordinator.captureAppliedPass({
				snapshot,
				outputMessages: output,
				outputEntryIds: ["u"],
				cacheBusting: false,
				assertCurrentPass: budget.assert,
			}),
		).toThrow();
		expect(getSlot(sessionId)).toBeUndefined();
		now = 0;
		expect(() =>
			capturePiServedArray(sessionId, output, {
				assertCurrentPass: budget.assert,
			}),
		).toThrow();
		expect(getPiServedTagNumbers(sessionId).size).toBe(0);
	} finally {
		ledger.reset();
		resetLkgSlotsForTest();
		db.close();
	}
});
