import { afterEach, expect, spyOn, test } from "bun:test";
import {
	decodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { readPiIdentityFoldGuards } from "@magic-context/core/features/magic-context/pi-identity-fold-guards";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import { saveSourceContent } from "@magic-context/core/features/magic-context/storage-source";
import {
	insertTag,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import { __test as decisions } from "@magic-context/core/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as logger from "@magic-context/core/shared/logger";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import { piMessageEntryFingerprint } from "./pi-message-identity";
import { readPiIdentityRebuilds } from "./pi-tag-identity-repair";
import {
	capturePiServedArray,
	clearPiServedArraySession,
} from "./served-array-ledger";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

afterEach(() => {
	resetLkgSlotsForTest();
	decisions.reset();
});

for (const kind of ["tool", "message"] as const) {
	for (const evidence of ["cached", "missing"] as const) {
		test(`issue 650 recovery: ${kind} ${evidence} keeps active survivor and defers its recovered drop`, async () => {
			const db = createTestDb();
			const sessionId = `repair-${kind}-${evidence}`;
			const repairLog = spyOn(logger, "sessionLog");
			try {
				const source = userMessage("ordinary source", 1);
				const call = assistantToolCall(
					"call",
					"codemode",
					{ code: "console.log(1)" },
					20,
				);
				(call as { content: unknown[] }).content.unshift({
					type: "thinking",
					thinking: "signed",
					thinkingSignature: "sig",
				});
				const input =
					kind === "tool"
						? [
								userMessage("first"),
								call,
								toolResultMessage("call", "1", 21),
								userMessage("next", 22),
							]
						: [source, assistantMessage("prior", 2), userMessage("next", 3)];
				const ids =
					kind === "tool"
						? ["first", "real", "result", "next"]
						: ["real", "prior", "next"];
				const old = kind === "tool" ? 8 : 20;
				const newest = kind === "tool" ? 154 : 440;
				const fp = piMessageEntryFingerprint(source);
				insertTag(
					db,
					sessionId,
					kind === "tool" ? "call" : "real:p0",
					kind,
					100,
					old,
					0,
					null,
					0,
					kind === "tool" ? "real" : null,
					kind === "message" ? fp : null,
				);
				updateTagStatus(db, sessionId, old, "dropped");
				insertTag(
					db,
					sessionId,
					kind === "tool" ? "call" : "pi-msg-0-1-user:p0",
					kind,
					100,
					newest,
					0,
					null,
					0,
					kind === "tool" ? "pi-msg-1-20-assistant" : null,
					kind === "message" ? fp : null,
				);
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				if (kind === "message")
					for (const number of [old, newest])
						saveSourceContent(db, sessionId, number, "ordinary source");
				let cachedBytes: string | undefined;
				if (evidence === "cached") {
					const cached = structuredClone(input);
					if (kind === "tool") {
						(cached[0] as { content: unknown }).content = "§155§ first";
						(cached[2] as { content: { text: string }[] }).content[0]!.text =
							"§154§ 1";
						(cached[3] as { content: unknown }).content = "§156§ next";
					} else {
						(cached[0] as { content: unknown }).content =
							"§440§ ordinary source";
						(cached[1] as { content: { text: string }[] }).content[0]!.text =
							"§441§ prior";
						(cached[2] as { content: unknown }).content = "§442§ next";
					}
					capturePiServedArray(sessionId, cached, {
						servedTagNumbers: [old, newest],
					});
					cachedBytes = JSON.stringify(cached);
				} else {
					capturePiServedArray(sessionId, [], {
						servedTagNumbers: [old, newest],
					});
					clearPiServedArraySession(sessionId);
				}
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
				const ctx = fakeContext(sessionId, process.cwd(), ids, input);
				const handler = fake.handlers.get("context")!;
				const pass = async () =>
					(await handler(
						{ messages: structuredClone(input) } as never,
						ctx as never,
					)) as { messages: unknown[] };
				const first = await pass();
				const bytes = JSON.stringify(first.messages);
				expect(bytes).toContain(`§${newest}§`);
				expect(bytes).not.toContain(`[dropped §${newest}§]`);
				expect(
					db
						.prepare("SELECT tag_number,status FROM tags WHERE type = ?")
						.all(kind),
				).toContainEqual({ tag_number: newest, status: "active" });
				expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([
					newest,
				]);
				const decision = decisions.getPendingPi(sessionId);
				const repairLines = repairLog.mock.calls.filter(([, line]) =>
					String(line).includes(
						"tag identity repair without last-served evidence",
					),
				);
				expect(repairLines).toHaveLength(evidence === "missing" ? 1 : 0);
				if (cachedBytes !== undefined) {
					expect(bytes).toBe(cachedBytes);
					expect(decision?.materializeReason).not.toBe("tag_identity_repair");
				}
				if (evidence === "missing") {
					expect(decision?.decision).toBe("execute");
					expect(decision?.materializeReason).toBe("tag_identity_repair");
					expect(readPiIdentityRebuilds(db, sessionId)).toEqual([]);
				}
				const defer = await pass();
				expect(JSON.stringify(defer.messages)).toBe(bytes);
				expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([
					newest,
				]);
				// The spent repair's once-guard lives in the identity fold-guard row,
				// not in the shared content-decision ledger the strip decisions use.
				const guardEntries = [...getPiContentDecisions(db, sessionId)].filter(
					(entry) =>
						decodePiContentDecision(entry)?.[0] === "tag-identity-repair-once",
				);
				expect(guardEntries).toHaveLength(0);
				expect(readPiIdentityFoldGuards(db, sessionId).size).toBe(1);
				// Ordinary cleanup may prune deleted message choices, but must not
				// erase the spent repair guard and enable another identity rebuild.
				expect(
					freezePiContentDecision(db, sessionId, "reminder-strip", "not-a-tag"),
				).toBe(true);
				expect(readPiIdentityFoldGuards(db, sessionId).size).toBe(1);
				signalPiPendingMaterialization(sessionId);
				const execute = await pass();
				expect(JSON.stringify(execute.messages)).not.toBe(bytes);
				expect(
					db
						.prepare("SELECT status FROM tags WHERE tag_number = ?")
						.get(newest),
				).toEqual({ status: "dropped" });
				expect(getPendingOps(db, sessionId)).toEqual([]);
				// A faulty writer reintroducing the same identity cannot buy repeated
				// rebuilds. This first asserted that the pass then refuses under the
				// once guard; no identity conflict may refuse more than one turn, so
				// the pass now serves, with no second repair.
				insertTag(
					db,
					sessionId,
					kind === "tool" ? "call" : "pi-msg-0-1-user:p0",
					kind,
					100,
					newest + 100,
					0,
					null,
					0,
					kind === "tool" ? "pi-msg-1-20-assistant" : null,
					kind === "message" ? fp : null,
				);
				clearPiServedArraySession(sessionId);
				resetLkgSlotsForTest();
				const repairsBefore = repairLines.length;
				for (let n = 0; n < 2; n++) {
					const again = await pass();
					expect(JSON.stringify(again.messages)).toBe(
						JSON.stringify(execute.messages),
					);
					expect(decisions.getPendingPi(sessionId)?.materializeReason).not.toBe(
						"tag_identity_repair",
					);
				}
				expect(
					repairLog.mock.calls.filter(([, line]) =>
						String(line).includes(
							"tag identity repair without last-served evidence",
						),
					),
				).toHaveLength(repairsBefore);
			} finally {
				repairLog.mockRestore();
				clearContextHandlerSession(sessionId);
				clearPiServedArraySession(sessionId);
				db.close();
			}
		});
	}
}

test("issue 650 recovery: a timestamp-less orphan cannot enable probes for unrelated calls", () => {
	const db = createTestDb();
	try {
		insertTag(
			db,
			"guard-cost",
			"orphan",
			"tool",
			1,
			1,
			0,
			null,
			0,
			"pi-msg-0-assistant",
		);
		const prepare = db.prepare.bind(db);
		let guardPrepares = 0;
		const spy = spyOn(db, "prepare").mockImplementation((sql) => {
			if (sql.includes("SELECT tool_owner_message_id AS owner"))
				guardPrepares++;
			return prepare(sql);
		});
		for (let n = 0; n < 10; n++)
			__test.guardPiToolAllocations(
				db,
				"guard-cost",
				[assistantToolCall("unrelated", "bash", {}, 20)],
				() => "real",
			);
		expect(guardPrepares).toBe(0);
		// Reported, no longer refused: the pass logs it and allocates.
		for (let n = 0; n < 2; n++)
			expect(
				__test.guardPiToolAllocations(
					db,
					"guard-cost",
					[assistantToolCall("orphan", "bash", {}, 20)],
					() => "real",
				),
			).toEqual([{ kind: "tool", id: "real/orphan" }]);
		expect(guardPrepares).toBe(1);
		spy.mockRestore();
	} finally {
		db.close();
	}
});
