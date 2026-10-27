/**
 * Pi `ctx_note` smart-note coverage.
 *
 * Pin the parity-critical behaviors against OpenCode's
 * `packages/plugin/src/tools/ctx-note/tools.ts`:
 *
 *   1. `surface_condition` arg accepted on write/update for smart notes
 *   2. `filter` parameter (active/pending/ready/dismissed/all) on read
 *   3. Update path supports both content and surface_condition
 *   4. Read renders both session notes and ready smart notes (🔔 marker)
 *   5. Smart-note writes rejected when dreamer is disabled
 */

import { afterEach, describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { indexMessagesAfterOrdinal } from "@magic-context/core/features/magic-context/message-index";
import {
	__wakePlaneTest,
	WAKE_PLANE_CAPABILITY,
} from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import {
	addNote,
	getNotes,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";

import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxSearchTool } from "./ctx-search";

afterEach(() => {
	__wakePlaneTest.reset();
});

async function callNote(args: {
	db: ReturnType<typeof createTestDb>;
	dreamerEnabled?: boolean;
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	sessionId?: string;
	cwd?: string;
	params: Record<string, unknown>;
}) {
	const tool = createCtxNoteTool({
		db: args.db,
		dreamerEnabled: args.dreamerEnabled,
		resolveDreamerEnabled: args.resolveDreamerEnabled,
	});
	const result = await tool.execute(
		"call-1",
		args.params,
		new AbortController().signal,
		undefined,
		fakeContext(
			args.sessionId ?? "ses-note-1",
			args.cwd ?? process.cwd(),
		) as never,
	);
	const text = (result.content[0] as { text: string }).text;
	return { result, text, isError: result.isError === true };
}

describe("Pi ctx_note smart notes", () => {
	it("declares one id field and pins its schema", () => {
		const tool = createCtxNoteTool({ db: createTestDb() });
		const properties = (
			tool.parameters as { properties: Record<string, unknown> }
		).properties;
		// A second scalar id field is what made required-all tool surfaces fail
		// every call with filler in both (issue 460).
		expect(properties.note_id).toBeUndefined();
		expect(JSON.parse(JSON.stringify(properties.note_ids))).toEqual({
			type: "array",
			items: {
				type: "integer",
				minimum: 1,
				maximum: Number.MAX_SAFE_INTEGER,
			},
			maxItems: 50,
			description:
				"Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
		});
	});

	it("matches OpenCode's default empty-read string", async () => {
		const db = createTestDb();
		const { isError, text } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read" },
		});

		expect(isError).toBe(false);
		expect(text).toBe("## Notes\n\nNo session notes or smart notes.");
	});

	it("rejects smart-note write when dreamer is disabled", async () => {
		const db = createTestDb();
		const { isError, text } = await callNote({
			db,
			dreamerEnabled: false,
			params: {
				action: "write",
				content: "Revisit caching after PR #42 merges",
				surface_condition: "When PR #42 is merged in this repo",
			},
		});
		expect(isError).toBe(true);
		expect(text.toLowerCase()).toContain("dreamer");

		// No smart note was created.
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const notes = getNotes(db, { projectPath: projectIdentity, type: "smart" });
		expect(notes).toHaveLength(0);
	});

	it("creates a smart note in pending state when dreamer is enabled", async () => {
		const db = createTestDb();
		const { isError, text } = await callNote({
			db,
			dreamerEnabled: true,
			params: {
				action: "write",
				content: "Revisit caching after PR #42 merges",
				surface_condition: "When PR #42 is merged in this repo",
			},
		});
		expect(isError).toBe(false);
		expect(text.toLowerCase()).toContain("smart");

		const projectIdentity = resolveProjectIdentity(process.cwd());
		const notes = getNotes(db, {
			projectPath: projectIdentity,
			type: "smart",
		});
		expect(notes).toHaveLength(1);
		expect(notes[0].status).toBe("pending");
		expect(notes[0].surfaceCondition).toBe(
			"When PR #42 is merged in this repo",
		);
		expect(notes[0].content).toBe("Revisit caching after PR #42 merges");
	});

	it("stores surface_condition as a regular note only when the wake plane is present", async () => {
		const db = createTestDb();
		for (const status of ["present", "absent", "unknown"] as const) {
			__wakePlaneTest.reset();
			__wakePlaneTest.setCatalogProbe(async () => {
				if (status === "unknown") throw new Error("daemon unavailable");
				return status === "present"
					? [
							{
								module_id: "scheduled-wakes",
								roles: [],
								control_ops: [WAKE_PLANE_CAPABILITY],
							},
						]
					: [{ module_id: "other-module", roles: [], control_ops: [] }];
			});
			const content = `Wake-plane ${status}`;
			const { text } = await callNote({
				db,
				dreamerEnabled: true,
				params: {
					action: "write",
					content,
					surface_condition: "When the scheduled operation completes",
				},
			});

			if (status === "present") {
				expect(text).toContain(
					"wake plane active — create a scheduled wake instead; stored as a plain note.",
				);
				expect(
					getNotes(db, { sessionId: "ses-note-1", type: "session" }),
				).toContainEqual(expect.objectContaining({ content }));
			} else {
				expect(text).toContain("Created smart note");
				expect(
					getNotes(db, {
						projectPath: resolveProjectIdentity(process.cwd()),
						type: "smart",
					}),
				).toContainEqual(expect.objectContaining({ content }));
			}
		}
	});

	it("matches OpenCode compilation statuses and reply suffixes", async () => {
		const db = createTestDb();
		const common = { db, dreamerEnabled: true, cwd: process.cwd() };

		const plain = await callNote({
			...common,
			params: {
				action: "write",
				content: "Follow up on the pull request.",
				surface_condition: "When PR #42 is merged",
			},
		});
		const compiled = await callNote({
			...common,
			params: {
				action: "write",
				content: "Read the generated artifact.",
				surface_condition: "when path /tmp/pi-ctx-note-future-artifact exists",
			},
		});
		const refused = await callNote({
			...common,
			params: {
				action: "write",
				content: "Never inspect key material.",
				surface_condition: "when path /tmp/project-binding-key exists",
			},
		});

		expect(plain.text).toBe(
			"Created smart note #1. Dreamer will evaluate the condition during nightly runs:\n- Content: Follow up on the pull request.\n- Condition: When PR #42 is merged",
		);
		expect(compiled.text).toContain("- Retina provider: local-fs");
		expect(refused.text).toContain("- Retina compile refused: fenced path");
		const projectIdentity = resolveProjectIdentity(process.cwd());
		expect(
			getNotes(db, { projectPath: projectIdentity, type: "smart" }).map(
				(note) => ({
					status: note.compileStatus,
					provider: note.compiledProvider,
				}),
			),
		).toEqual([
			{ status: "plain", provider: null },
			{ status: "compiled", provider: "local-fs" },
			{ status: "refused", provider: null },
		]);
	});

	it("resolves smart-note enablement from the invocation cwd", async () => {
		const db = createTestDb();
		const { isError, text } = await callNote({
			db,
			dreamerEnabled: false,
			resolveDreamerEnabled: (ctx) => ctx.cwd === "/tmp/project-b",
			cwd: "/tmp/project-b",
			params: {
				action: "write",
				content: "Follow up when the release tag exists",
				surface_condition: "When release tag v1.2.3 exists",
			},
		});

		expect(isError).toBe(false);
		expect(text.toLowerCase()).toContain("smart");
	});

	it("stores sessionId on smart notes so note search renders same-session @msg anchors", async () => {
		const db = createTestDb();
		const sessionId = "ses-smart-anchor";
		indexMessagesAfterOrdinal(
			db,
			sessionId,
			[
				{
					id: "m1",
					ordinal: 1,
					role: "user",
					parts: [
						{ type: "text", text: "Please remember the release follow-up." },
					],
				},
			],
			0,
		);

		const { isError } = await callNote({
			db,
			dreamerEnabled: true,
			sessionId,
			params: {
				action: "write",
				content: "Release follow-up parked for tag v1.2.3",
				surface_condition: "When tag v1.2.3 exists",
			},
		});
		expect(isError).toBe(false);

		const projectIdentity = resolveProjectIdentity(process.cwd());
		const notes = getNotes(db, { projectPath: projectIdentity, type: "smart" });
		expect(notes).toHaveLength(1);
		expect(notes[0].sessionId).toBe(sessionId);
		expect(notes[0].anchorOrdinal).toBe(1);

		const search = createCtxSearchTool({ db });
		const result = await search.execute(
			"search-1",
			{ query: "release follow-up", sources: ["note"] },
			new AbortController().signal,
			undefined,
			fakeContext(sessionId, process.cwd()) as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("@msg 1");
		expect(text).toContain("Use ctx_expand(start=N-10, end=N)");
	});

	it("creates a session note (no surface_condition) regardless of dreamer flag", async () => {
		const db = createTestDb();
		const { isError } = await callNote({
			db,
			dreamerEnabled: false,
			params: {
				action: "write",
				content: "Don't forget to update CHANGELOG before release",
			},
		});
		expect(isError).toBe(false);

		const sessionNotes = getNotes(db, {
			sessionId: "ses-note-1",
			type: "session",
		});
		expect(sessionNotes).toHaveLength(1);
		expect(sessionNotes[0].content).toBe(
			"Don't forget to update CHANGELOG before release",
		);
	});

	it("dismisses note_ids in one transaction and reports each outcome", async () => {
		const db = createTestDb();
		addNote(db, "session", {
			sessionId: "ses-a",
			content: "Owned note one",
		});
		addNote(db, "session", {
			sessionId: "ses-b",
			content: "Foreign note",
		});
		addNote(db, "session", {
			sessionId: "ses-a",
			content: "Owned note two",
		});
		await callNote({
			db,
			sessionId: "ses-a",
			params: { action: "dismiss", note_ids: [3] },
		});

		const result = await callNote({
			db,
			sessionId: "ses-a",
			params: { action: "dismiss", note_ids: [1, 2, 3, 999] },
		});

		expect(result.isError).toBe(false);
		expect(result.text).toBe(
			"Dismissed 1 of 4 notes.\n" +
				"- Note #1: dismissed\n" +
				"- Note #2: not_found\n" +
				"- Note #3: already_dismissed\n" +
				"- Note #999: not_found",
		);
		expect(
			getNotes(db, { type: "session" }).map((note) => ({
				id: note.id,
				status: note.status,
			})),
		).toEqual([
			{ id: 1, status: "dismissed" },
			{ id: 2, status: "active" },
			{ id: 3, status: "dismissed" },
		]);
	});

	it("ignores note_ids on write, reads owned ids, and hides foreign ids as missing", async () => {
		// Required-all tool surfaces make the model fill every declared
		// property on write; read uses IDs intentionally and must not disclose
		// whether an inaccessible ID exists.
		const db = createTestDb();
		const writeWithFiller = await callNote({
			db,
			params: {
				action: "write",
				content: "Filler-tolerant note",
				note_ids: [1],
			},
		});
		addNote(db, "session", {
			sessionId: "ses-foreign",
			content: "Foreign note body",
		});
		const targetedRead = await callNote({
			db,
			params: { action: "read", note_ids: [1, 2, 999] },
		});
		const updateTwo = await callNote({
			db,
			params: { action: "update", note_ids: [1, 2], content: "two ids" },
		});
		const updateNone = await callNote({
			db,
			params: { action: "update", content: "no ids" },
		});
		const dismissNone = await callNote({ db, params: { action: "dismiss" } });

		expect(writeWithFiller.isError).toBe(false);
		expect(writeWithFiller.text).toContain("Saved session note #1");
		expect(targetedRead.isError).toBe(false);
		expect(targetedRead.text).toContain("Filler-tolerant note");
		expect(targetedRead.text).toContain("- Note #2: not_found");
		expect(targetedRead.text).toContain("- Note #999: not_found");
		expect(targetedRead.text).not.toContain("Foreign note body");
		expect(updateTwo.isError).toBe(true);
		expect(updateTwo.text).toContain(
			"exactly one positive integer id when action is 'update'",
		);
		expect(updateNone.isError).toBe(true);
		expect(updateNone.text).toContain(
			"exactly one positive integer id when action is 'update'",
		);
		expect(dismissNone.isError).toBe(true);
		expect(dismissNone.text).toContain(
			"1 to 50 positive integer ids when action is 'dismiss'",
		);
	});

	it("read with filter='active' is STRICTER than default — does not include pending smart notes", async () => {
		// The default glance shows every smart note, ready or still parked, so the
		// agent sees the whole tray in one listing (the ratified ctx_note
		// description: ready smart notes first, then pending, then plain notes).
		// `filter='active'` is the narrower view: active status only, both types.
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());

		// Active session note + active smart note (pending status, has surface_condition).
		addNote(db, "smart", {
			content: "Active smart note (not yet ready)",
			projectPath: projectIdentity,
			surfaceCondition: "Some condition",
		});
		addNote(db, "session", {
			content: "Active session note",
			sessionId: "ses-note-1",
		});

		// Default read shows the session note AND the parked smart note.
		const { text: defaultText } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read" },
		});
		expect(defaultText).toContain("Active session note");
		expect(defaultText).toContain(
			"Active smart note (not yet ready) · pending",
		);

		// Explicit filter='active' returns only active-status notes, so the
		// pending smart note drops out.
		const { text: activeText } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read", filter: "active" },
		});
		expect(activeText).toContain("Active session note");
		expect(activeText).not.toContain("Active smart note");
	});

	it("read with filter='pending' returns only unsurfaced smart notes", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());

		// Seed: one pending smart note + one session note.
		addNote(db, "smart", {
			content: "Pending smart note",
			projectPath: projectIdentity,
			surfaceCondition: "When dreamer says so",
		});
		addNote(db, "session", {
			content: "Active session note",
			sessionId: "ses-note-1",
		});

		const { text } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read", filter: "pending" },
		});
		expect(text).toContain("Pending smart note");
		// Pending filter must NOT return active session notes.
		expect(text).not.toContain("Active session note");
	});

	it("read with filter='all' returns both session and smart notes", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		addNote(db, "smart", {
			content: "Smart x",
			projectPath: projectIdentity,
			surfaceCondition: "When y",
		});
		addNote(db, "session", {
			content: "Session y",
			sessionId: "ses-note-1",
		});

		const { text } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read", filter: "all" },
		});
		expect(text).toContain("Smart x");
		expect(text).toContain("Session y");
	});

	it("update path accepts new surface_condition for an existing smart note", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const created = addNote(db, "smart", {
			content: "Original content",
			projectPath: projectIdentity,
			surfaceCondition: "Original condition",
		});

		const { isError, text } = await callNote({
			db,
			dreamerEnabled: true,
			params: {
				action: "update",
				note_ids: [created.id],
				surface_condition: "New condition",
			},
		});
		expect(isError).toBe(false);
		expect(text.toLowerCase()).toContain("updated");

		const updated = getNotes(db, {
			projectPath: projectIdentity,
			type: "smart",
		});
		expect(updated).toHaveLength(1);
		expect(updated[0].surfaceCondition).toBe("New condition");
		// Content unchanged when only surface_condition is updated.
		expect(updated[0].content).toBe("Original content");
	});

	it("update path accepts new content for an existing smart note", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const created = addNote(db, "smart", {
			content: "Old content",
			projectPath: projectIdentity,
			surfaceCondition: "Some condition",
		});

		const { isError } = await callNote({
			db,
			dreamerEnabled: true,
			params: {
				action: "update",
				note_ids: [created.id],
				content: "New content",
			},
		});
		expect(isError).toBe(false);

		const updated = getNotes(db, {
			projectPath: projectIdentity,
			type: "smart",
		});
		expect(updated[0].content).toBe("New content");
		expect(updated[0].surfaceCondition).toBe("Some condition");
	});

	it("rejects dismissing another session's session note", async () => {
		const db = createTestDb();
		const created = addNote(db, "session", {
			content: "Other session note",
			sessionId: "ses-other",
		});

		const { isError, text } = await callNote({
			db,
			sessionId: "ses-note-1",
			params: { action: "dismiss", note_ids: [created.id] },
		});

		expect(isError).toBe(true);
		expect(text).toContain("not found in your session/project");
		expect(
			getNotes(db, { sessionId: "ses-other", type: "session" })[0].status,
		).toBe("active");
	});

	it("rejects updating another project's smart note", async () => {
		const db = createTestDb();
		const otherProject = resolveProjectIdentity("/tmp");
		const created = addNote(db, "smart", {
			content: "Other project smart note",
			projectPath: otherProject,
			surfaceCondition: "When /tmp is ready",
		});

		const { isError, text } = await callNote({
			db,
			dreamerEnabled: true,
			params: {
				action: "update",
				note_ids: [created.id],
				content: "Hijacked smart note",
			},
		});

		expect(isError).toBe(true);
		expect(text).toContain("not found in your session/project");
		expect(
			getNotes(db, { projectPath: otherProject, type: "smart" })[0].content,
		).toBe("Other project smart note");
	});

	it("read default (no filter) shows ready smart notes alongside session notes", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const smart = addNote(db, "smart", {
			content: "Smart that's ready",
			projectPath: projectIdentity,
			surfaceCondition: "Always",
		});
		// Manually mark ready (mimicking what dreamer would do).
		updateNote(
			db,
			smart.id,
			{
				status: "ready",
				readyReason: "Condition satisfied at test time",
			},
			{ sessionId: "ses-note-1", projectPath: projectIdentity },
		);
		addNote(db, "session", {
			content: "Active session note",
			sessionId: "ses-note-1",
		});

		const { text } = await callNote({
			db,
			dreamerEnabled: true,
			params: { action: "read" },
		});
		// Default read includes both ready smart notes AND active session notes,
		// with the ready smart note listed first and marked `· ready`.
		expect(text).toContain("Smart that's ready");
		expect(text).toContain("Active session note");
		expect(text).toContain("· ready");
		expect(text.indexOf("Smart that's ready")).toBeLessThan(
			text.indexOf("Active session note"),
		);
	});
});
