import { describe, expect, it } from "bun:test";
import { replaceAllCompartmentState } from "@magic-context/core/features/magic-context/compartment-storage";
import { enqueueDream } from "@magic-context/core/features/magic-context/dreamer/queue";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { registerCtxDreamCommand } from "./ctx-dream";
import { registerCtxFlushCommand } from "./ctx-flush";
import { registerCtxRecompCommand } from "./ctx-recomp";
import { registerCtxStatusCommand } from "./ctx-status";

type Handler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface SentMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
	options?: { triggerTurn?: boolean };
}

interface MockCommandContext {
	cwd: string;
	hasUI?: boolean;
	ui: {
		custom: (factory: unknown, options?: unknown) => Promise<unknown>;
		setStatus?: (key: string, text: string) => void;
	};
	model?: { provider: string; id: string };
	sessionManager: {
		getSessionId: () => string | undefined;
		getBranch?: () => unknown[];
	};
	getContextUsage: () => {
		contextWindow: number;
		tokens: number;
		percent: number;
	};
}

function createDb() {
	const db = new Database(":memory:");
	initializeDatabase(db);
	return db;
}

function createMockPi() {
	const handlers = new Map<string, Handler>();
	const sent: SentMessage[] = [];
	return {
		pi: {
			registerCommand(name: string, options: { handler: Handler }) {
				handlers.set(name, options.handler);
			},
			registerMessageRenderer() {},
			sendMessage(
				message: SentMessage["message"],
				options?: SentMessage["options"],
			) {
				sent.push({ message, options });
			},
		},
		handlers,
		sent,
	};
}

function createCtx(sessionId = "ses-1"): MockCommandContext {
	const customCalls: Array<{ factory: unknown; options: unknown }> = [];
	const entries = Array.from({ length: 12 }, (_, index) => ({
		id: `m${index + 1}`,
		type: "message",
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message ${index + 1}`,
		},
	}));
	return {
		cwd: "/tmp/project",
		hasUI: false,
		ui: {
			async custom(factory: unknown, options?: unknown) {
				customCalls.push({ factory, options });
				return undefined;
			},
			setStatus() {},
		},
		model: { provider: "anthropic", id: "claude" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		getContextUsage: () => ({
			contextWindow: 100_000,
			tokens: 1_000,
			percent: 1,
		}),
	};
}

describe("Pi Magic Context commands", () => {
	it("registers /ctx-status and opens a UI overlay when UI is available", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();
		const customCalls: Array<{ factory: unknown; options: unknown }> = [];
		const ctx = {
			...createCtx(),
			hasUI: true,
			ui: {
				async custom(factory: unknown, options?: unknown) {
					customCalls.push({ factory, options });
					return undefined;
				},
			},
		};

		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-status")?.("", ctx);

		expect(sent).toHaveLength(0);
		expect(customCalls).toHaveLength(1);
		expect(customCalls[0]?.options).toMatchObject({ overlay: true });
	});

	it("falls back to non-turn custom status message without UI", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-status")?.("", createCtx());

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("## Magic Status");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("registers /ctx-flush and materializes queued pending ops", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();

		registerCtxFlushCommand(pi as never, { db });
		await handlers.get("ctx-flush")?.("", createCtx());

		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("Flushed 1 pending ops");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("registers /ctx-dream and reports existing or new queue state", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project",
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-dream")?.("", createCtx());

		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("/ctx-dream");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
		expect(enqueueDream(db, "/tmp/project", "manual")).toBeNull();
	});

	it("registers /ctx-recomp and requires confirmation before running", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		let runnerCalled = false;

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async () => {
					runnerCalled = true;
					return { ok: true, assistantText: "[]", cost: 0, durationMs: 1 };
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 32_000,
			memoryEnabled: false,
			autoPromote: false,
		});
		await handlers.get("ctx-recomp")?.("", createCtx());

		expect(runnerCalled).toBe(false);
		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("Confirmation Required");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("passes configured historian chunk budget into /ctx-recomp execution", async () => {
		const db = createDb();
		replaceAllCompartmentState(
			db,
			"ses-budget",
			[
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "old",
					content: "old",
				},
			],
			[],
		);
		const { pi, handlers } = createMockPi();
		let promptText = "";

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async (args) => {
					promptText = args.userMessage;
					return { ok: true, assistantText: "[]", cost: 0, durationMs: 1 };
				},
			},
			historianModel: "anthropic/claude",
			historianChunkTokens: 20,
			memoryEnabled: false,
			autoPromote: false,
		});

		const ctx = createCtx("ses-budget");
		await handlers.get("ctx-recomp")?.("", ctx);
		await handlers.get("ctx-recomp")?.("", ctx);

		expect(promptText).toContain("[1] U: message 1");
		expect(promptText).not.toContain("[2] A: message 2");
	});
});
