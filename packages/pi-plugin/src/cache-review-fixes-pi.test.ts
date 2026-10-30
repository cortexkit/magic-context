import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import {
	getTagsBySession,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage-tags";
import * as applyOperations from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { buildPersistedDropTargets } from "@magic-context/core/shared/tag-transcript";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import { authorizePiToolRemoval } from "./native-replay-state-pi";
import { flushPiServedArrayLedger } from "./served-array-ledger";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";
import {
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

test("attribution projection reuse invalidates on branch prefix content and snapshot changes", () => {
	const db = createTestDb();
	try {
		const insert = db.prepare(
			`INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size)
			VALUES ('projection-cache', ?, ?, 'message', 'active', 10)`,
		);
		for (let number = 1; number <= 1000; number++)
			insert.run(number, `entry-${number}:p0`);
		let reads = 0;
		const tags = getTagsBySession(db, "projection-cache").map(
			(row) =>
				new Proxy(row, {
					get(target, key, receiver) {
						if (key === "tagNumber") reads++;
						return Reflect.get(target, key, receiver);
					},
				}),
		);
		let branch = "entry-1000";
		const part = { type: "text", text: "The visible tail." };
		const input = {
			messages: [{ role: "user", content: [part], timestamp: 1001 }],
			stableId: () => branch,
			tags,
			tagCacheKey: {},
			protectedTagNumbers: new Set<number>(),
		};
		expect(measurePiTailHygiene(input).parts[0]?.tagNumber).toBe(1000);
		const changeAndCheck = (change: () => void, expected: number) => {
			reads = 0;
			measurePiTailHygiene(input);
			expect(reads).toBeLessThan(1000);
			change();
			reads = 0;
			const measured = measurePiTailHygiene(input);
			expect(reads).toBeGreaterThanOrEqual(1000);
			expect(measured.parts[0]?.tagNumber).toBe(expected);
			expect(measured).toEqual(
				measurePiTailHygiene({ ...input, tagCacheKey: undefined }),
			);
		};
		changeAndCheck(() => {
			branch = "entry-1";
		}, 1);
		changeAndCheck(() => {
			part.text = "§7§ A different visible prefix.";
		}, 7);
		changeAndCheck(() => {
			part.text = "§7§ An in-place edit with the same prefix.";
		}, 7);
		changeAndCheck(() => {
			part.text = "The visible prefix was removed.";
		}, 1);
		changeAndCheck(() => {
			input.tags = [...tags];
		}, 1);
	} finally {
		db.close();
	}
});

test("attribution projection follows in-place orphan call identity changes", () => {
	const db = createTestDb();
	try {
		db.exec(`INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size)
			VALUES ('projection-calls', 0, 'entry-0:p0', 'message', 'active', 10),
			('projection-calls', 1, 'first', 'tool', 'dropped', 10),
			('projection-calls', 2, 'second', 'tool', 'dropped', 10),
			('projection-calls', 3, 'entry-2:p0', 'message', 'active', 10)`);
		const call = { type: "toolCall", id: "first", name: "Read", arguments: {} };
		const result = {
			role: "toolResult",
			toolCallId: "first",
			content: [{ type: "text", text: "The visible output." }],
		};
		const input = {
			messages: [
				{ role: "assistant", content: [call] },
				result,
				{ role: "user", content: "Continue." },
			],
			stableId: (_message: unknown, index: number) => `entry-${index}`,
			tags: getTagsBySession(db, "projection-calls"),
			tagCacheKey: {},
			protectedTagNumbers: new Set<number>(),
		};
		const outputTag = () =>
			measurePiTailHygiene(input).parts.find(
				(part) => part.kind === "toolOutput",
			)?.tagNumber;
		expect(outputTag()).toBe(1);
		call.id = "second";
		result.toolCallId = "second";
		expect(outputTag()).toBe(2);
		expect(measurePiTailHygiene(input)).toEqual(
			measurePiTailHygiene({ ...input, tagCacheKey: undefined }),
		);
	} finally {
		db.close();
	}
});

test("handler rolls back successful removal preparation when flushed rendering fails", async () => {
	const { dir: root, cleanup } = createTestTempDir("pi-render-rollback-");
	const priorDataHome = process.env.XDG_DATA_HOME;
	const priorConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	const db = createTestDb(join(root, "context.db"));
	const sessionId = "pi-render-rollback";
	const fake = createFakePi();
	const original = [
		...Array.from({ length: 3 }, (_, index) => [
			assistantToolCall(
				`call-${index}`,
				"Read",
				{ path: `${index}` },
				index * 2,
			),
			toolResultMessage(
				`call-${index}`,
				`bulky-output-${index}`,
				index * 2 + 1,
			),
		]).flat(),
		userMessage("Continue.", 7),
	];
	const ids = original.map((_, index) => `entry-${index}`);
	registerPiContextHandler(fake.pi as never, { db, protectedTags: 0 });
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] } | undefined>;
	const pass = () => {
		const messages = structuredClone(original);
		const ctx = fakeContext(sessionId, root, ids, messages);
		Object.assign(ctx, {
			getSystemPrompt: () => "Keep the same prepared system prompt.",
			model: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				contextWindow: 272000,
				maxTokens: 68000,
			},
		});
		return handler({ messages: messages as never[] }, ctx as never);
	};
	const render = applyOperations.applyFlushedStatuses;
	let replaySpy: ReturnType<typeof spyOn> | undefined;
	try {
		expect(await pass()).toBeDefined();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await flushPiServedArrayLedger();
		const saved = getInMemorySlot(sessionId);
		if (!saved?.piOutputEntryIds)
			throw new Error("healthy LKG was not prepared");
		const tools = getTagsBySession(db, sessionId).filter(
			(tag) => tag.type === "tool",
		);
		expect(tools).toHaveLength(3);
		for (const tag of tools) {
			if (tag.id === undefined) throw new Error("stored tool row has no ID");
			updateTagStatus(db, sessionId, tag.id, "dropped");
		}
		db.prepare(
			"UPDATE tags SET drop_mode='full' WHERE session_id=? AND type='tool'",
		).run(sessionId);
		expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(0);
		let interrupted = false;
		let firstRendered = false;
		let prepared: string[] = [];
		let renderingTransaction = false;
		replaySpy = spyOn(
			applyOperations,
			"applyFlushedStatuses",
		).mockImplementation((...args) => {
			if (!interrupted) {
				interrupted = true;
				prepared = [...getNativeReplayState(db, sessionId).toolInputs.keys()];
				renderingTransaction = db.inTransaction;
				const first = args[2].get(tools[0]?.tagNumber ?? -1);
				const middle = args[2].get(tools[1]?.tagNumber ?? -1);
				if (!first?.drop || !middle) throw new Error("replay targets missing");
				const drop = first.drop.bind(first);
				first.drop = () => {
					const result = drop();
					firstRendered = true;
					return result;
				};
				middle.drop = () => {
					throw new Error("injected post-preparation render failure");
				};
			}
			return render(...args);
		});
		signalPiPendingMaterialization(sessionId);
		await expect(pass()).rejects.toThrow(
			"injected post-preparation render failure",
		);
		expect(interrupted).toBe(true);
		expect(prepared).toEqual(["call-0", "call-1", "call-2"]);
		expect(firstRendered).toBe(true);
		expect(getNativeReplayState(db, sessionId).toolInputs.size).toBe(0);
		expect(renderingTransaction).toBe(true);

		// Build the recovery oracle from the healthy saved bytes, with no permission
		// to authorize new removals. An uncommitted full drop retains both its tool
		// call and corresponding result, rather than removing either one.
		const expected = createPiTranscript(
			JSON.parse(saved.jsonPrefix),
			sessionId,
			saved.piOutputEntryIds.map((id) => id ?? undefined),
			{ authorizeToolRemoval: () => false },
		);
		const rows = getTagsBySession(db, sessionId).filter(
			(tag) => tag.status === "dropped",
		);
		render(sessionId, db, buildPersistedDropTargets(expected, rows), rows);
		expected.commit();
		expected.finalizeToolRemovals();
		const restoredInputs = getNativeReplayState(db, sessionId).toolInputs;
		const recovered = createPiTranscript(
			JSON.parse(saved.jsonPrefix),
			sessionId,
			saved.piOutputEntryIds.map((id) => id ?? undefined),
			{
				authorizeToolRemoval: (callId) =>
					authorizePiToolRemoval({
						db,
						sessionId,
						callId,
						saved: restoredInputs,
						canApply: false,
					}),
			},
		);
		render(sessionId, db, buildPersistedDropTargets(recovered, rows), rows);
		recovered.commit();
		recovered.finalizeToolRemovals();
		expect(JSON.stringify(recovered.getOutputMessages())).toBe(
			JSON.stringify(expected.getOutputMessages()),
		);
		for (const tag of tools)
			expect(JSON.stringify(recovered.getOutputMessages())).toContain(
				`[dropped §${tag.tagNumber}§]`,
			);
	} finally {
		replaySpy?.mockRestore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
		if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = priorDataHome;
		if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = priorConfigHome;
		cleanup();
	}
});
