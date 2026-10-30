import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { __test as decisions } from "@magic-context/core/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type Handler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: unknown[] } | undefined>;

for (const failure of [
	"drop batch",
	"admission",
	"unchanged restart",
	"frozen restart",
] as const) {
	test(`Pi LKG ${failure}: release shares permission and defer replays all frozen decisions`, async () => {
		const unchangedRecovery = failure.endsWith("restart");
		const root = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-release-"));
		const path = join(root, "context.db");
		const db = createTestDb(path);
		const locker = new Database(path);
		const sessionId = `pi-lkg-release-${failure}`;
		const fake = createFakePi();
		Object.assign(fake.pi, { getAllTools: () => [] });
		registerPiContextHandler(fake.pi as never, {
			db,
			todowriteEnabled: true,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10000 },
			scheduler: { executeThresholdPercentage: 75 },
		});
		const handler = fake.handlers.get("context") as Handler;
		const served: Record<string, unknown[]> = {};
		let gate: unknown;
		const restoreGate = __test.setMutationGateObserverForTests((value) => {
			gate = value;
		});
		const recoveryLogs: string[] = [];
		const restoreLogs = __test.setLkgRecoveryLogObserverForTests((line) =>
			recoveryLogs.push(line),
		);
		const raw = [
			userMessage("original head", 1),
			assistantMessage("signed answer", 2, {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					{
						type: "thinking",
						thinking: "prefix bound thought",
						thinkingSignature: "proof",
					},
					{ type: "text", text: "signed answer" },
				],
			}),
			userMessage("continue", 3),
			...Array.from({ length: 4 }, (_, i) => [
				assistantToolCall(
					`call-${i}`,
					"Read",
					{ path: `file-${i}`, padding: "x".repeat(1000) },
					4 + i * 2,
				),
				toolResultMessage(`call-${i}`, "result ".repeat(1000), 5 + i * 2),
			]).flat(),
			userMessage("latest turn", 20),
		];
		if (failure === "unchanged restart")
			Object.assign(raw[1], {
				content: [{ type: "text", text: "signed answer" }],
			});
		const pass = async (name: string, input = raw, percent = 10) => {
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastInputTokens: percent * 1000,
				lastContextPercentage: percent,
			});
			const messages = structuredClone(input);
			const ctx = fakeContext(
				sessionId,
				root,
				messages.map((m) => `entry-${m.timestamp}`),
				messages,
			);
			Object.assign(ctx, {
				getSystemPrompt: () => "Complete synthetic system.",
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					api: "anthropic-messages",
					contextWindow: 1000000,
					maxTokens: 10000,
				},
				getContextUsage: () => ({
					tokens: percent * 10000,
					percent,
					contextWindow: 1000000,
				}),
			});
			const result = await handler(
				{ messages: messages as never[] },
				ctx as never,
			);
			expect(result).toBeDefined();
			served[name] = structuredClone(result?.messages ?? []);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return result?.messages ?? [];
		};
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			await pass("seed", [userMessage("original head", 1)]);
			await pass("baseline");
			if (failure === "frozen restart") {
				signalPiPendingMaterialization(sessionId);
				await pass("baseline", raw, 76);
				expect(JSON.stringify(served.baseline)).not.toContain(
					"prefix bound thought",
				);
			}
			if (failure === "drop batch") {
				const tools = getTagsBySession(db, sessionId).filter(
					(tag) => tag.type === "tool",
				);
				expect(tools).toHaveLength(4);
				for (const [index, tag] of tools.entries()) {
					queuePendingOp(db, sessionId, tag.tagNumber, "drop");
					if (index !== 0) continue;
					// Stale entries fill the first 64-operation chunk, so the
					// second real drop fails after the first chunk has been planned.
					for (let offset = 0; offset < 63; offset++) {
						const number = 100_000 + offset;
						db.prepare(
							"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES(?,?,?,'message','compacted',1)",
						).run(sessionId, number, `stale-${number}`);
						queuePendingOp(db, sessionId, number, "drop");
					}
				}
				db.exec(
					`CREATE TEMP TRIGGER busy_drop BEFORE UPDATE OF status ON tags WHEN NEW.tag_number=${tools[1].tagNumber} AND NEW.status='dropped' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
				);
				signalPiPendingMaterialization(sessionId);
				await pass("replay", raw, 76);
				expect(
					getTagsBySession(db, sessionId).filter(
						(tag) => tag.type === "tool" && tag.status === "dropped",
					),
				).toHaveLength(0);
				// Permissions, queue deletions and drops commit together. A failed
				// transaction cannot serve its edited tool calls/results, even when no
				// reasoning blocks need omission. Replay only the last-served request.
				expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(0);
				expect(served.replay).toEqual(served.baseline);
				db.exec("DROP TRIGGER busy_drop");
			} else {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				// Do not perform the pass helper's metadata write while another connection holds the writer.
				const messages = structuredClone(raw);
				const ctx = fakeContext(
					sessionId,
					root,
					messages.map((m) => `entry-${m.timestamp}`),
					messages,
				);
				Object.assign(ctx, {
					getSystemPrompt: () => "Complete synthetic system.",
					model: {
						provider: "anthropic",
						id: "claude-opus-5-5",
						api: "anthropic-messages",
						contextWindow: 1000000,
						maxTokens: 10000,
					},
				});
				const result = await handler(
					{ messages: messages as never[] },
					ctx as never,
				);
				served.replay = structuredClone(result?.messages ?? []);
				locker.exec("ROLLBACK");
				db.exec("PRAGMA busy_timeout=5000");
				expect(served.replay).toEqual(served.baseline);
				if (failure === "admission") {
					const tool = getTagsBySession(db, sessionId).find(
						(tag) => tag.type === "tool",
					);
					if (!tool) throw new Error("Expected queued recovery rider");
					queuePendingOp(db, sessionId, tool.tagNumber, "drop");
				}
			}
			expect(recoveryLogs.join("\n")).toContain("LKG replay served");
			// Editing the original user message prevents replaying the saved request:
			// its input no longer matches the history supplied by Pi.
			const rebuiltRaw = unchangedRecovery
				? raw
				: [userMessage("edited head", 1), ...raw.slice(1)];
			if (unchangedRecovery) {
				updateSessionMeta(db, sessionId, {
					lastTodoState: JSON.stringify([
						{
							id: "todo-1",
							content: "Do not inject on unchanged replay",
							status: "pending",
							priority: "medium",
						},
					]),
				});
				clearContextHandlerSession(sessionId);
			}
			const released = await pass("release", rebuiltRaw, 76);
			if (failure.endsWith("drop batch")) {
				// The permitted rebuild retries all rolled-back permissions and drops.
				expect(
					getTagsBySession(db, sessionId).filter(
						(tag) => tag.type === "tool" && tag.status === "dropped",
					),
				).toHaveLength(4);
				expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(4);
			}
			const releaseGate = gate;
			expect(decisions.getPendingPi(sessionId)?.lkgFrozenReleaseReason).toBe(
				unchangedRecovery
					? "lkg_restart_rebuild"
					: "lkg_recovery_input_rebuild",
			);
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "Published later",
					content: "U: original head\nA: signed answer",
					p1: "U: original head\nA: signed answer",
				},
			]);
			signalPiDeferredHistoryRefresh(sessionId);
			const deferred = await pass("defer", rebuiltRaw, 40);
			const repeated = await pass("repeat", rebuiltRaw, 40);
			if (process.env.MC_LKG_RELEASE_RECORD) {
				mkdirSync(process.env.MC_LKG_RELEASE_RECORD, { recursive: true });
				writeFileSync(
					join(
						process.env.MC_LKG_RELEASE_RECORD,
						`${failure.replace(" ", "-")}.json`,
					),
					JSON.stringify(
						{ served, releaseGate, deferGate: gate, recoveryLogs },
						null,
						2,
					),
				);
			}
			expect(JSON.stringify(released)).not.toContain("prefix bound thought");
			if (unchangedRecovery)
				expect(JSON.stringify(released)).toBe(JSON.stringify(served.replay));
			else
				expect(
					getTagsBySession(db, sessionId).find(
						(tag) => tag.messageId === "call-0",
					)?.status,
				).toBe("dropped");
			expect(JSON.stringify(deferred)).toBe(JSON.stringify(released));
			expect(JSON.stringify(repeated)).toBe(JSON.stringify(released));
			expect(releaseGate).toMatchObject({
				shouldApplyPendingOps: !unchangedRecovery,
				shouldRunHeuristics: !unchangedRecovery,
				shouldRunReasoningCleanup: !unchangedRecovery,
			});
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			restoreGate();
			restoreLogs();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			locker.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("Pi ordinary passes: seeded execute/defer replay without recovery", async () => {
	const records: unknown[] = [];
	let randomState = 0x51c0ffee;
	const random = () => {
		randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
		return randomState / 0x100000000;
	};
	for (let trial = 0; trial < 12; trial++) {
		const db = createTestDb();
		const sessionId = `pi-ordinary-${trial}`;
		const fake = createFakePi();
		Object.assign(fake.pi, { getAllTools: () => [] });
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10000 },
		});
		const handler = fake.handlers.get("context") as Handler;
		const provider = trial % 2 ? "anthropic" : "openai-codex";
		const model = trial % 2 ? "claude-opus-5-5" : "gpt-5.6-sol";
		const raw = [userMessage("original head", 1)];
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			for (let turn = 0; turn < 12; turn++) {
				if (turn > 0) {
					const timestamp = turn * 4;
					const reply = assistantToolCall(
						`call-${turn}`,
						"Read",
						{
							path: `file-${Math.floor(random() * 4)}`,
							padding: "arg ".repeat(Math.floor(random() * 200)),
						},
						timestamp,
					);
					if (trial % 2 && random() < 0.5)
						(reply.content as unknown[]).unshift({
							type: "thinking",
							thinking: `thought ${turn}`,
							thinkingSignature: `proof-${turn}`,
						});
					raw.push(
						reply,
						toolResultMessage(
							`call-${turn}`,
							"result ".repeat(1 + Math.floor(random() * 500)),
							timestamp + 1,
						),
						userMessage(`continue ${turn}`, timestamp + 2),
					);
				}
				const percentage = random() < 0.5 ? 40 : 76;
				updateSessionMeta(db, sessionId, {
					lastResponseTime: Date.now(),
					cacheTtl: "59m",
					lastInputTokens: percentage * 1000,
					lastContextPercentage: percentage,
				});
				if (random() < 0.4) signalPiPendingMaterialization(sessionId);
				if (random() < 0.4) {
					const tools = getTagsBySession(db, sessionId).filter(
						(tag) => tag.type === "tool" && tag.status === "active",
					);
					const tool = tools[Math.floor(random() * tools.length)];
					if (tool) queuePendingOp(db, sessionId, tool.tagNumber, "drop");
				}
				const messages = structuredClone(raw);
				const ctx = fakeContext(
					sessionId,
					"/synthetic/pi-project",
					messages.map((m) => `entry-${m.timestamp}`),
					messages,
				);
				Object.assign(ctx, {
					getSystemPrompt: () => "Complete synthetic system.",
					model: {
						provider,
						id: model,
						contextWindow: 1000000,
						maxTokens: 10000,
					},
					getContextUsage: () => ({
						tokens: percentage * 10000,
						percent: percentage,
						contextWindow: 1000000,
					}),
				});
				const result = await handler(
					{ messages: messages as never[] },
					ctx as never,
				);
				expect(result).toBeDefined();
				expect(
					decisions.getPendingPi(sessionId)?.lkgFrozenReleaseReason,
				).toBeUndefined();
				records.push(structuredClone(result?.messages));
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		} finally {
			clearContextHandlerSession(sessionId);
			db.close();
		}
	}
	if (process.env.MC_LKG_RELEASE_RECORD) {
		mkdirSync(process.env.MC_LKG_RELEASE_RECORD, { recursive: true });
		writeFileSync(
			join(process.env.MC_LKG_RELEASE_RECORD, "no-recovery.json"),
			JSON.stringify(records),
		);
	}
});
