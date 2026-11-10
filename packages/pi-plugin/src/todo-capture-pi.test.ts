import { beforeEach, describe, expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	capturePiTodowriteArgsIfCompatible,
	capturePiTodowriteMessageIfCompatible,
} from "./index";
import { assistantToolCall, createTestDb } from "./test-utils.test";
import {
	__resetTodoSnapshotsForTests,
	getTodoSnapshot,
	renderTodowriteCall,
} from "./tools/todo-view-pi";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

beforeEach(() => {
	__resetTodoSnapshotsForTests();
});

describe("Pi todowrite capture compatibility", () => {
	it("tool_execution_start capture seeds the render cache for compatible payloads", () => {
		const db = createTestDb();
		try {
			const captured = capturePiTodowriteArgsIfCompatible({
				db,
				sessionId: "ses-args-cache",
				todos: [{ content: "Build", status: "in_progress" }],
				todowriteEnabled: true,
				persist: true,
				toolCallId: "call-cache",
			});

			expect(captured).toBe(true);
			expect(
				renderTodowriteCall({}, identityTheme, {
					toolCallId: "call-cache",
				} as never).render(80)[0],
			).toContain("Todos — 1 active");
		} finally {
			closeQuietly(db);
		}
	});

	it("tool_execution_start capture ignores foreign status values", () => {
		const db = createTestDb();
		const previousState =
			'[{"content":"Keep","status":"pending","priority":"medium"}]';
		let overlayUpdates = 0;
		try {
			updateSessionMeta(db, "ses-args", { lastTodoState: previousState });

			const captured = capturePiTodowriteArgsIfCompatible({
				db,
				sessionId: "ses-args",
				todos: [{ content: "Foreign", status: "done" }],
				todowriteEnabled: true,
				todoOverlay: { update: () => overlayUpdates++ },
				persist: true,
				toolCallId: "call-foreign",
			});

			expect(captured).toBe(false);
			expect(getOrCreateSessionMeta(db, "ses-args").lastTodoState).toBe(
				previousState,
			);
			expect(getTodoSnapshot("ses-args").todos).toEqual([]);
			expect(overlayUpdates).toBe(0);
			expect(
				renderTodowriteCall({}, identityTheme, {
					toolCallId: "call-foreign",
				} as never).render(80)[0],
			).toContain("Todos — 0 active");
		} finally {
			closeQuietly(db);
		}
	});

	it("message_end capture ignores foreign status values", () => {
		const db = createTestDb();
		const previousState =
			'[{"content":"Keep","status":"pending","priority":"medium"}]';
		let overlayUpdates = 0;
		try {
			updateSessionMeta(db, "ses-message-status", {
				lastTodoState: previousState,
			});

			const captured = capturePiTodowriteMessageIfCompatible({
				db,
				sessionId: "ses-message-status",
				message: assistantToolCall("call-1", "todowrite", {
					todos: [{ content: "Foreign", status: "done" }],
				}),
				todowriteEnabled: true,
				todoOverlay: { update: () => overlayUpdates++ },
				persist: true,
			});

			expect(captured).toBe(false);
			expect(
				getOrCreateSessionMeta(db, "ses-message-status").lastTodoState,
			).toBe(previousState);
			expect(getTodoSnapshot("ses-message-status").todos).toEqual([]);
			expect(overlayUpdates).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("message_end capture ignores absent or non-array todos", () => {
		const db = createTestDb();
		const previousState =
			'[{"content":"Keep","status":"pending","priority":"medium"}]';
		let overlayUpdates = 0;
		try {
			updateSessionMeta(db, "ses-message-shape", {
				lastTodoState: previousState,
			});

			expect(
				capturePiTodowriteMessageIfCompatible({
					db,
					sessionId: "ses-message-shape",
					message: assistantToolCall("call-1", "todowrite", {}),
					todowriteEnabled: true,
					todoOverlay: { update: () => overlayUpdates++ },
					persist: true,
				}),
			).toBe(false);
			expect(
				capturePiTodowriteMessageIfCompatible({
					db,
					sessionId: "ses-message-shape",
					message: assistantToolCall("call-2", "todowrite", {
						todos: { content: "Not an array", status: "pending" },
					}),
					todowriteEnabled: true,
					todoOverlay: { update: () => overlayUpdates++ },
					persist: true,
				}),
			).toBe(false);

			expect(
				getOrCreateSessionMeta(db, "ses-message-shape").lastTodoState,
			).toBe(previousState);
			expect(getTodoSnapshot("ses-message-shape").todos).toEqual([]);
			expect(overlayUpdates).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("capture ignores priorities outside Pi's todowrite enum", () => {
		// The shared normalizer keeps any priority string, as OpenCode does, but
		// Pi's own todowrite refuses this call, so the snapshot must not change.
		const db = createTestDb();
		const previousState =
			'[{"content":"Keep","status":"pending","priority":"medium"}]';
		const todos = [
			{ content: "Hotfix", status: "pending", priority: "urgent" },
		];
		let overlayUpdates = 0;
		try {
			updateSessionMeta(db, "ses-priority", { lastTodoState: previousState });

			expect(
				capturePiTodowriteArgsIfCompatible({
					db,
					sessionId: "ses-priority",
					todos,
					todowriteEnabled: true,
					todoOverlay: { update: () => overlayUpdates++ },
					persist: true,
					toolCallId: "call-priority",
				}),
			).toBe(false);
			expect(
				capturePiTodowriteMessageIfCompatible({
					db,
					sessionId: "ses-priority",
					message: assistantToolCall("call-1", "todowrite", { todos }),
					todowriteEnabled: true,
					todoOverlay: { update: () => overlayUpdates++ },
					persist: true,
				}),
			).toBe(false);

			expect(getOrCreateSessionMeta(db, "ses-priority").lastTodoState).toBe(
				previousState,
			);
			expect(getTodoSnapshot("ses-priority").todos).toEqual([]);
			expect(overlayUpdates).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("message_end capture preserves interop for compatible foreign todowrite payloads", () => {
		const db = createTestDb();
		let overlayUpdates = 0;
		const todos = [{ content: "Interop", status: "pending", priority: "high" }];
		try {
			const captured = capturePiTodowriteMessageIfCompatible({
				db,
				sessionId: "ses-message-valid",
				message: assistantToolCall("call-1", "todowrite", { todos }),
				todowriteEnabled: true,
				todoOverlay: { update: () => overlayUpdates++ },
				persist: true,
			});

			expect(captured).toBe(true);
			expect(
				getOrCreateSessionMeta(db, "ses-message-valid").lastTodoState,
			).toBe('[{"content":"Interop","status":"pending","priority":"high"}]');
			expect(getTodoSnapshot("ses-message-valid").todos).toEqual(todos);
			expect(overlayUpdates).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
});
