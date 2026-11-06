import { expect, it } from "bun:test";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	removePendingOp,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	getNativeToolInputs,
	saveNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { handlePiCloneSessionStart } from "./clone-inheritance";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	piDropBranchIds,
	reconcilePiDropBranches,
	trackPiDropLeaf,
} from "./drop-branches-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

function seed(db: ReturnType<typeof createTestDb>, session: string) {
	for (let tag = 1; tag <= 4; tag++)
		db.prepare(
			"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size, drop_mode, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, 100, 'truncated', ?)",
		).run(
			session,
			tag === 2 ? "call" : `root:p${tag}`,
			tag === 2 ? "tool" : "message",
			tag === 4 ? "dropped" : "active",
			tag,
			tag === 2 ? "root" : null,
		);
}

it("preserves ancestor and legacy drops, restores native inputs, and rolls back provenance atomically", () => {
	const db = createTestDb();
	const session = "journal";
	try {
		seed(db, session);
		trackPiDropLeaf(db, session, "root");
		queuePendingOp(db, session, 1, "drop");
		trackPiDropLeaf(db, session, "abandoned");
		updateTagStatus(db, session, 1, "dropped");
		removePendingOp(db, session, 1);
		expect(() =>
			db
				.transaction(() => {
					updateTagStatus(db, session, 2, "dropped");
					throw new Error("rollback");
				})
				.immediate(),
		).toThrow("rollback");
		expect(reconcilePiDropBranches(db, session, new Set(["root"]), true)).toBe(
			0,
		);
		updateTagStatus(db, session, 2, "dropped");
		queuePendingOp(db, session, 3, "drop");
		saveNativeToolInputs(
			db,
			session,
			new Map([
				["call", '{"dropped":true}'],
				["unrelated", '{"path":"keep"}'],
			]),
		);
		expect(reconcilePiDropBranches(db, session, new Set(["root"]), false)).toBe(
			0,
		);
		expect(reconcilePiDropBranches(db, session, null, true)).toBe(0);
		expect(getPendingOps(db, session)).toHaveLength(1);
		expect(reconcilePiDropBranches(db, session, new Set(["root"]), true)).toBe(
			1,
		);
		expect(getTagsBySession(db, session).map((tag) => tag.status)).toEqual([
			"dropped",
			"active",
			"active",
			"dropped",
		]);
		expect(getPendingOps(db, session)).toEqual([]);
		expect(getNativeToolInputs(db, session)).toEqual(
			new Map([["unrelated", '{"path":"keep"}']]),
		);
		expect(reconcilePiDropBranches(db, session, new Set(["root"]), true)).toBe(
			0,
		);
	} finally {
		db.close();
	}
});

it("carries drop provenance into a Pi or OMP fork without modifying the parent", async () => {
	const db = createTestDb();
	const source = "00000000-0000-4000-8000-000000000001";
	try {
		seed(db, source);
		trackPiDropLeaf(db, source, "abandoned");
		updateTagStatus(db, source, 2, "dropped");
		queuePendingOp(db, source, 3, "drop");
		const entries = [
			{
				type: "message",
				id: "root",
				parentId: null,
				message: { role: "user", content: "kept" },
			},
		];
		const logs: string[] = [];
		const result = await handlePiCloneSessionStart(
			{ reason: "startup" },
			{
				sessionManager: {
					getSessionId: () => "child",
					getHeader: () => ({ parentSession: source }),
					getBranch: () => entries,
				},
			},
			{
				db,
				signalPendingMarker: () => {},
				writeLog: (message) => logs.push(message),
			},
		);
		expect(logs.filter((line) => line.includes("failed"))).toEqual([]);
		expect(result?.kind).toBe("migrated");
		expect(getPendingOps(db, "child")).toHaveLength(1);
		expect(
			reconcilePiDropBranches(db, "child", piDropBranchIds(entries), false),
		).toBe(0);
		expect(
			getTagsBySession(db, "child").find((tag) => tag.tagNumber === 2)?.status,
		).toBe("dropped");
		expect(
			reconcilePiDropBranches(db, "child", piDropBranchIds(entries), true),
		).toBe(1);
		expect(getPendingOps(db, "child")).toEqual([]);
		expect(getPendingOps(db, source)).toHaveLength(1);
		expect(
			getTagsBySession(db, source).find((tag) => tag.tagNumber === 2)?.status,
		).toBe("dropped");
		expect(
			piDropBranchIds([{ id: "partial", parentId: "missing" }]),
		).toBeNull();
	} finally {
		db.close();
	}
});

it("restores off-branch drops and discards queued drops only on an existing rebuild", async () => {
	const db = createTestDb();
	const session = "branch-drops";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10000 },
	});
	const handler = fake.handlers.get("context")!;
	const raw = [
		userMessage("earlier request", 1),
		assistantToolCall("call", "Read", {}, 2),
		toolResultMessage("call", "ORIGINAL_TOOL_OUTPUT", 3),
		assistantMessage("before reduction", 4),
		userMessage("reduce now", 5),
	];
	let count = raw.length;
	const ctx = () => {
		const messages = raw
			.slice(0, count)
			.map((message) => structuredClone(message));
		const context = fakeContext(
			session,
			process.cwd(),
			messages.map((_, i) => `e${i}`),
			messages,
		);
		Object.assign(context.sessionManager, {
			getLeafId: () => `e${count - 1}`,
			getBranch: () =>
				messages.map((message, i) => ({
					type: "message",
					id: `e${i}`,
					parentId: i ? `e${i - 1}` : null,
					message,
				})),
		});
		return { messages, context };
	};
	const pass = async () => {
		const { messages, context } = ctx();
		return JSON.stringify(
			await handler({ messages } as never, context as never),
		);
	};
	try {
		await pass();
		const tags = getTagsBySession(db, session);
		const tool = tags.find((tag) => tag.type === "tool")!;
		const text = tags.find((tag) => tag.type === "message")!;
		expect(tool).toBeDefined();
		const toolEvent = fake.handlers.get("tool_call");
		const { context } = ctx();
		await toolEvent?.({ toolName: "ctx_reduce" } as never, context as never);
		// Observe both a direct tag-status update and a queued drop operation.
		updateTagStatus(db, session, tool.tagNumber, "dropped");
		queuePendingOp(db, session, text.tagNumber, "drop");
		const dropped = await pass();
		expect(dropped).not.toContain("ORIGINAL_TOOL_OUTPUT");
		count = 4;
		const deferred = await pass();
		expect(deferred).not.toContain("ORIGINAL_TOOL_OUTPUT");
		expect(JSON.parse(deferred).messages.slice(0, 4)).toEqual(
			JSON.parse(dropped).messages.slice(0, 4),
		);
		expect(await pass()).toBe(deferred);
		expect(
			getTagsBySession(db, session).find(
				(tag) => tag.tagNumber === tool.tagNumber,
			)?.status,
		).toBe("dropped");
		expect(getPendingOps(db, session)).toHaveLength(1);
		signalPiPendingMaterialization(session, "user_flush");
		const rebuilt = await pass();
		expect(rebuilt).toContain("ORIGINAL_TOOL_OUTPUT");
		expect(
			getTagsBySession(db, session).find(
				(tag) => tag.tagNumber === tool.tagNumber,
			)?.status,
		).toBe("active");
		expect(getPendingOps(db, session)).toEqual([]);
		expect(await pass()).toBe(rebuilt);
	} finally {
		clearContextHandlerSession(session);
		db.close();
	}
});
