import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	closeDatabase,
	openDatabase,
} from "../../plugin/src/features/magic-context/storage-db";
import {
	clearTransformDecisionSession,
	__test as decisionLog,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "../../plugin/src/features/magic-context/transform-decision-log";
import { prepareContextDatabase } from "./prepare-context-db";
import { createE2ETempDir } from "./temp-dir";
import { decisionMatchesTurn } from "./transform-decision-turn";

test("Pi decision attribution follows the durable assistant when binding happens after the turn", async () => {
	const data = createE2ETempDir("decision-turn-");
	const session = "delayed-pi-decision";
	const turn = { start: 100, end: 200, assistantEntryIds: ["reply"] };
	const rows: Array<{ message_id: string; ts_ms: number }> = [];
	try {
		prepareContextDatabase(data);
		const db = openDatabase(join(data, "cortexkit/magic-context/context.db"));
		if (!db) throw new Error("isolated decision database unavailable");
		decisionLog.setWriterForTests((_path, row) => {
			rows.push({ message_id: row.messageId, ts_ms: row.tsMs });
		});
		// The producer's diagnostic clock is not the test process's turn boundary.
		recordPendingPiTransformDecision(
			session,
			{
				tsMs: 50,
				decision: "defer",
				materialized: false,
				materializeReason: null,
				systemHashPrev: null,
				systemHashNew: null,
				m0ModelKeyPrev: null,
				m0ModelKeyNew: null,
				emergency: false,
				droppedTokens: 0,
				droppedCount: 1,
				inputTokens: 10_000,
				bustedThisPass: true,
			},
			"prior",
		);
		const prior = {
			id: "prior",
			type: "message",
			message: { role: "assistant" },
		};
		expect(
			schedulePiTransformDecisionResolve({
				db,
				sessionId: session,
				branchEntries: [prior],
			}),
		).toBe(false);
		expect(rows).toEqual([]);
		// Only a later context pass can see the assistant reply added to the branch.
		expect(
			schedulePiTransformDecisionResolve({
				db,
				sessionId: session,
				branchEntries: [
					prior,
					{ id: "reply", type: "message", message: { role: "assistant" } },
				],
			}),
		).toBe(true);
		expect(rows).toEqual([]);
		await decisionLog.waitForWrites(session);
		expect(rows).toEqual([{ message_id: "reply", ts_ms: 50 }]);
		expect(rows.some((row) => decisionMatchesTurn(row, turn))).toBe(true);
		expect(
			rows.some((row) =>
				decisionMatchesTurn(row, {
					...turn,
					assistantEntryIds: ["another-reply"],
				}),
			),
		).toBe(false);
	} finally {
		clearTransformDecisionSession(session);
		decisionLog.setWriterForTests(null);
		await closeDatabase();
		rmSync(data, { recursive: true, force: true });
	}
});

test("Pi requires the matching assistant even if another row has the same timestamp", () => {
	const row = { message_id: "other", ts_ms: 150 };
	expect(
		decisionMatchesTurn(row, {
			start: 100,
			end: 200,
			assistantEntryIds: ["reply"],
		}),
	).toBe(false);
	expect(
		decisionMatchesTurn(row, { start: 100, end: 200, assistantEntryIds: [] }),
	).toBe(false);
	expect(decisionMatchesTurn(row, { start: 100, end: 200 })).toBe(true);
});
