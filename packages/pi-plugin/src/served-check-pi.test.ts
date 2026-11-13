// The served check through Pi's guarded context hook: an ordinary turn logs
// nothing, a last-good replay of the request before it logs nothing, a replay
// that serves a drop the request before it did not carry is a mixed replay,
// and a compaction-off fold that re-renders the head is a change without
// rebuild permission (compaction-off has none) in front of the earlier turn's
// signed thinking, which the fold strips.
import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { markTagDropped } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { bumpEpochsForWorkspaceMembers } from "@magic-context/core/features/magic-context/workspaces";
import { getServedCheckCountersForTest } from "@magic-context/core/hooks/magic-context/served-check";
import * as loggerModule from "@magic-context/core/shared/logger";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type Handler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: unknown[] } | undefined>;

const EVENT =
	/^served check: (a pass without|a replay differed|a change in front|content changed)/;

async function withEvents<T>(
	run: () => Promise<T>,
): Promise<{ value: T; events: string[] }> {
	const lines: string[] = [];
	const spy = spyOn(loggerModule, "sessionLog").mockImplementation(
		(_id, message) => {
			lines.push(String(message));
		},
	);
	try {
		const value = await run();
		return { value, events: lines.filter((line) => EVENT.test(line)) };
	} finally {
		spy.mockRestore();
	}
}

test("Pi: ordinary turns and a plain replay log nothing; a replay with a drop the last request lacked is mixed", async () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-served-check-"));
	const path = join(root, "context.db");
	const db = createTestDb(path);
	const locker = new Database(path);
	const sessionId = "pi-served-check-replay";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10000 },
		scheduler: { executeThresholdPercentage: 75 },
	});
	const handler = fake.handlers.get("context") as Handler;
	const replayLogs: string[] = [];
	const restoreLogs = __test.setLkgRecoveryLogObserverForTests((line) =>
		replayLogs.push(line),
	);
	const raw: PiMessage[] = [userMessage("start", 1)];
	const model = {
		provider: "anthropic",
		id: "claude-sonnet-4",
		api: "anthropic-messages",
		contextWindow: 1000000,
		maxTokens: 10000,
	};
	const turn = (n: number) => {
		raw.push(
			assistantToolCall(`call-${n}`, "Read", { path: `file-${n}` }, 10 * n),
			toolResultMessage(`call-${n}`, "result ".repeat(400), 10 * n + 1),
			userMessage(`next ${n}`, 10 * n + 2),
		);
	};
	const pass = async (busy = false, failTagWrites = false) => {
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastInputTokens: 10_000,
			lastContextPercentage: 10,
		});
		const messages = structuredClone(raw);
		const ctx = fakeContext(
			sessionId,
			root,
			messages.map((m) => `entry-${m.timestamp}`),
			messages,
		);
		Object.assign(ctx, {
			getSystemPrompt: () => "Complete synthetic system.",
			model,
			getContextUsage: () => ({
				tokens: 100_000,
				percent: 10,
				contextWindow: 1000000,
			}),
		});
		if (failTagWrites)
			// The pass fails late, as a busy writer makes it, while it tags the
			// turn's new messages; Pi replays the saved request with the drops
			// committed since.
			db.exec(
				"CREATE TEMP TRIGGER busy_tag BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
			);
		if (busy) {
			// Another connection holds SQLite's writer for the whole pass.
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
		}
		try {
			return await withEvents(() =>
				handler({ messages: messages as never[] }, ctx as never),
			);
		} finally {
			if (failTagWrites) db.exec("DROP TRIGGER IF EXISTS temp.busy_tag");
			if (busy) {
				locker.exec("ROLLBACK");
				db.exec("PRAGMA busy_timeout=5000");
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	try {
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
		expect((await pass()).events).toEqual([]);
		for (let n = 1; n <= 3; n++) {
			turn(n);
			expect((await pass()).events).toEqual([]);
		}
		expect(getServedCheckCountersForTest(sessionId)).toMatchObject({
			unknown: 1,
			appendOnly: 3,
		});

		turn(4);
		const plain = await pass(true);
		expect(replayLogs.join("\n")).toContain("LKG replay served");
		expect(plain.events).toEqual([]);

		// Another process's pass committed a drop of the first tool output,
		// which this process never served.
		const tool = getTagsBySession(db, sessionId).find(
			(tag) => tag.type === "tool" && tag.status === "active",
		);
		if (!tool) throw new Error("no tool output was tagged");
		markTagDropped(db, sessionId, tool.tagNumber);
		replayLogs.length = 0;
		turn(5);
		const mixed = await pass(false, true);
		expect(replayLogs.join("\n")).toContain("TRANSIENT STORAGE FAILURE");
		expect(replayLogs.join("\n")).toContain("LKG replay served");
		const replayEvent = mixed.events.find((line) =>
			line.startsWith(
				"served check: a replay differed from the request served before it ",
			),
		);
		expect(replayEvent).toContain("host=pi");
		// The drop also replaced the call's arguments, which tier 1 reads only
		// shallowly: the full check names that edit as a same-shape change.
		expect(
			mixed.events
				.filter((line) => line !== replayEvent)
				.every((line) =>
					line.startsWith("served check: content changed with the same shape "),
				),
		).toBe(true);
	} finally {
		restoreLogs();
		clearContextHandlerSession(sessionId);
		closeQuietly(locker);
		closeQuietly(db);
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("Pi compaction-off: a memory edit's fold is a change without rebuild permission in front of the earlier turn's signed thinking", async () => {
	const xdg = createTestTempDirFromPath(join(tmpdir(), "pi-served-check-off-"));
	const originalXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = xdg;
	const db = createTestDb();
	const sessionId = "pi-served-check-off";
	try {
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const fake = createFakePi();
		registerPiContextHandler(
			fake.pi as never,
			{
				db,
				tagger: createTagger(),
				compactionOff: true,
				injection: {
					injectionBudgetTokens: 2000,
					memoryEnabled: true,
					injectDocs: false,
				},
				scheduler: { executeThresholdPercentage: 65 },
			} as never,
		);
		const handler = fake.handlers.get("context") as Handler;
		const source: PiMessage[] = [userMessage("task", 1)];
		const ids = ["task"];
		const MODEL = "claude-opus-5-5";
		const step = (n: number) => {
			source.push(
				assistantMessage("", 10 + 2 * n, {
					provider: "anthropic",
					model: MODEL,
					api: "anthropic-messages",
					content: [
						{
							type: "thinking",
							thinking: `thought ${n}`,
							thinkingSignature: `sig-${n}`,
						},
						{
							type: "toolCall",
							id: `call-${n}`,
							name: "read",
							arguments: { path: `${n}.ts` },
						},
					],
				}),
				toolResultMessage(`call-${n}`, `result ${n}`, 11 + 2 * n),
			);
			ids.push(`step-${n}`, `result-${n}`);
		};
		const pass = () => {
			const messages = structuredClone(source);
			const ctx = {
				...fakeContext(sessionId, process.cwd(), [...ids], messages),
				model: {
					provider: "anthropic",
					id: MODEL,
					api: "anthropic-messages",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 20_000,
					percent: 10,
					contextWindow: 200_000,
				}),
			};
			return withEvents(() => handler({ messages } as never, ctx as never));
		};
		expect((await pass()).events).toEqual([]);
		step(1);
		expect((await pass()).events).toEqual([]);
		step(2);
		expect((await pass()).events).toEqual([]);
		source.push(userMessage("next task", 100));
		ids.push("user-next");
		const identity = (
			db
				.prepare(
					"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { id: string }
		).id;
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: "keep functions small",
			importance: 90,
		});
		bumpEpochsForWorkspaceMembers(db, identity);
		const { events } = await pass();
		expect(
			events.some(
				(line) =>
					line.startsWith(
						"served check: a pass without rebuild permission changed served messages first_index=0 ",
					) && line.includes("host=pi"),
			),
		).toBe(true);
		expect(
			events.some(
				(line) =>
					line.startsWith(
						"served check: a change in front of kept signed thinking on a prefix-bound model first_index=0 ",
					) && line.includes("thinking_stripped=true"),
			),
		).toBe(true);
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdg;
		rmSync(xdg, { recursive: true, force: true });
	}
}, 60_000);
