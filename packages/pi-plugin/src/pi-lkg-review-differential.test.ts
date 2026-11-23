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
import { __test as decisions } from "@magic-context/core/features/magic-context/transform-decision-log";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Compare complete handler outputs rather than token estimates.
// 40 trials of 12 full context passes take 22-28 s on CI's Linux runners, too
// close to bun's default 30 s per-test timeout, so the budget is set explicitly.
// The test checks the outputs, not the speed.
test("REVIEW differential: 480 complete Pi requests with recovery and restart", async () => {
	let state = 0xa6319b27;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
	const records: unknown[] = [];
	const root = join(tmpdir(), "magic-context/pi-lkg-review/differential");
	mkdirSync(root, { recursive: true });
	for (let trial = 0; trial < 40; trial++) {
		const path = join(root, `trial-${trial}.db`);
		rmSync(path, { force: true });
		const db = createTestDb(path);
		const locker = new Database(path);
		// Message indexing can finish on a worker after a context pass returns.
		// Let only the locker wait for that writer; the handler still uses zero
		// busy timeout below and must serve its LKG replay while this lock is held.
		locker.exec("PRAGMA busy_timeout=5000");
		const sessionId = `pi-independent-${trial}`;
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
		const handler = fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] } | undefined>;
		const provider = trial % 4 === 0 ? "openai-codex" : "anthropic";
		const model = provider === "anthropic" ? "claude-opus-5-5" : "gpt-5.6-sol";
		const signed = provider === "anthropic" && random() < 0.8;
		const unresolved = trial % 5 === 1;
		const restart = random() < 0.5;
		const freeze = random() < 0.5;
		const raw = [userMessage("original head", 1)];
		for (let arc = 0; arc < 3; arc++) {
			const assistant = assistantToolCall(
				`call-${arc}`,
				"Read",
				{
					path: `file-${arc}`,
					padding: "arg ".repeat(10 + Math.floor(random() * 300)),
				},
				2 + arc * 3,
			);
			if (signed)
				(assistant.content as unknown[]).unshift({
					type: "thinking",
					thinking: `signed thought ${arc}`,
					thinkingSignature: `proof-${arc}`,
				});
			raw.push(
				assistant,
				toolResultMessage(
					`call-${arc}`,
					"result ".repeat(100 + Math.floor(random() * 900)),
					3 + arc * 3,
				),
				userMessage(`continue ${arc}`, 4 + arc * 3),
			);
		}
		let gate: unknown;
		const restoreGate = __test.setMutationGateObserverForTests((value) => {
			gate = value;
		});
		const logs: string[] = [];
		const restoreLogs = __test.setLkgRecoveryLogObserverForTests((line) =>
			logs.push(line),
		);
		const pass = async (turn: number, input = raw, busy = false) => {
			const percent = turn === 0 ? 10 : random() < 0.5 ? 40 : 76;
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastInputTokens: percent * 1000,
				lastContextPercentage: percent,
			});
			const messages = structuredClone(input);
			const ctx = fakeContext(
				sessionId,
				"/synthetic/pi-review",
				messages.map((m) => `entry-${m.timestamp}`),
				messages,
			);
			if (unresolved) {
				const branch = ctx.sessionManager.getBranch();
				ctx.sessionManager.getBranch = () =>
					branch.filter((entry) => entry.message.role !== "assistant");
			}
			Object.assign(ctx, {
				getSystemPrompt: () => "Complete independent synthetic system.",
				model: {
					provider,
					id: model,
					api:
						provider === "anthropic"
							? "anthropic-messages"
							: "openai-codex-responses",
					contextWindow: 1000000,
					maxTokens: 10000,
				},
				getContextUsage: () => ({
					tokens: percent * 10000,
					percent,
					contextWindow: 1000000,
				}),
			});
			gate = undefined;
			const logStart = logs.length;
			if (busy) {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				expect(locker.inTransaction).toBe(true);
			}
			try {
				const result = await handler(
					{ messages: messages as never[] },
					ctx as never,
				);
				expect(result).toBeDefined();
				records.push(
					structuredClone({
						trial,
						turn,
						signed,
						unresolved,
						restart,
						freeze,
						percent,
						messages: result?.messages,
						gate,
						reason: decisions.getPendingPi(sessionId)?.lkgFrozenReleaseReason,
						replay: logs
							.slice(logStart)
							.some((line) => line.includes("LKG replay served")),
					}),
				);
				if (busy)
					expect(logs.slice(logStart).join("\n")).toContain(
						"LKG replay served",
					);
			} finally {
				if (locker.inTransaction) locker.exec("ROLLBACK");
				db.exec("PRAGMA busy_timeout=5000");
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		};
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			await pass(0, [raw[0]]);
			if (freeze) signalPiPendingMaterialization(sessionId);
			await pass(1);
			await pass(2, raw, true);
			const tools = getTagsBySession(db, sessionId).filter(
				(tag) => tag.type === "tool" && tag.status === "active",
			);
			const tool = tools[Math.floor(random() * tools.length)];
			if (tool) queuePendingOp(db, sessionId, tool.tagNumber, "drop");
			if (restart) clearContextHandlerSession(sessionId);
			else raw[0] = userMessage("edited head", 1);
			updateSessionMeta(db, sessionId, {
				lastTodoState: JSON.stringify([
					{
						id: "todo-1",
						content: "Independent todo",
						status: "pending",
						priority: "medium",
					},
				]),
			});
			await pass(3);
			await pass(4);
			signalPiPendingMaterialization(sessionId);
			await pass(5);
			raw.push(userMessage("new user tail", 20));
			await pass(6);
			await pass(7, raw, true);
			if (random() < 0.5) clearContextHandlerSession(sessionId);
			else raw[0] = userMessage("edited again", 1);
			await pass(8);
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "Independent publication",
					content: "U: original head\nA: answer",
					p1: "U: original head\nA: answer",
				},
			]);
			signalPiDeferredHistoryRefresh(sessionId);
			await pass(9);
			await pass(10);
			await pass(11);
		} finally {
			restoreGate();
			restoreLogs();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			locker.close();
			db.close();
		}
	}
	expect(records).toHaveLength(480);
	if (process.env.MC_PI_REVIEW_RECORD)
		writeFileSync(process.env.MC_PI_REVIEW_RECORD, JSON.stringify(records));
}, 120_000);
