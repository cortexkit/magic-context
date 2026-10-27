/**
 * Pi `ctx_note` glance coverage.
 *
 * The read reply is one row per note (`#id · age · title`), ready smart notes
 * first, then pending, then plain notes newest first, with `· stale` on rows
 * untouched for 30 days. `note_ids` returns full bodies in the order given.
 * The write reply carries the active-tray line.
 *
 * The same fixture is pinned on the OpenCode leg
 * (`packages/plugin/src/tools/ctx-note/render.test.ts`) and the Rust facade
 * (`crates/mc-module/src/lib.rs`), so a format change on one leg without the
 * others goes red.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { addNote } from "@magic-context/core/features/magic-context/storage";
import { Value } from "typebox/value";

import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxNoteTool } from "./ctx-note";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
	// Nothing global to reset — each test owns its in-memory database.
});

async function callNote(args: {
	db: ReturnType<typeof createTestDb>;
	sessionId?: string;
	cwd?: string;
	params: Record<string, unknown>;
}) {
	const tool = createCtxNoteTool({ db: args.db, dreamerEnabled: true });
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
	return {
		result,
		text: (result.content[0] as { text: string }).text,
		isError: result.isError === true,
	};
}

/** Insert a note with explicit timestamps so age and stale markers are
 *  deterministic. `addNote` stamps `Date.now()`, which cannot express a
 *  40-day-old row. */
function insertNoteAt(
	db: ReturnType<typeof createTestDb>,
	args: {
		type?: "session" | "smart";
		status?: string;
		content: string;
		sessionId?: string | null;
		projectPath?: string | null;
		surfaceCondition?: string | null;
		createdAt: number;
		updatedAt: number;
	},
): number {
	const row = db
		.prepare(
			`INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.get(
			args.type ?? "session",
			args.status ?? "active",
			args.content,
			args.sessionId ?? "ses-note-1",
			args.projectPath ?? null,
			args.surfaceCondition ?? null,
			args.createdAt,
			args.updatedAt,
		) as { id: number };
	return row.id;
}

describe("Pi ctx_note glance", () => {
	it("renders the shared five-note fixture byte-for-byte", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const now = Date.now();
		insertNoteAt(db, {
			type: "smart",
			status: "ready",
			content: "Ready smart item",
			projectPath: projectIdentity,
			surfaceCondition: "condition",
			createdAt: now - 5 * DAY,
			updatedAt: now - 5 * DAY,
		});
		insertNoteAt(db, {
			type: "smart",
			status: "pending",
			content: "Parked smart item",
			projectPath: projectIdentity,
			surfaceCondition: "condition",
			createdAt: now - 2 * DAY,
			updatedAt: now - 2 * DAY,
		});
		insertNoteAt(db, {
			content: "Fresh plain item",
			createdAt: now,
			updatedAt: now,
		});
		insertNoteAt(db, {
			content: "Two-day-old plain item",
			createdAt: now - 2 * DAY,
			updatedAt: now - 2 * DAY,
		});
		insertNoteAt(db, {
			content: "Forty-day-old plain item",
			createdAt: now - 40 * DAY,
			updatedAt: now - 40 * DAY,
		});

		const { text } = await callNote({ db, params: { action: "read" } });

		expect(text).toBe(
			"## Notes\n\n" +
				"#1 · 5d · Ready smart item · ready\n" +
				"#2 · 2d · Parked smart item · pending\n" +
				"#3 · 0m · Fresh plain item\n" +
				"#4 · 2d · Two-day-old plain item\n" +
				"#5 · 5w · Forty-day-old plain item · stale\n\n" +
				'To dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])',
		);
	});

	it("clips a long title to 80 characters and keeps only the first line", async () => {
		const db = createTestDb();
		const now = Date.now();
		insertNoteAt(db, {
			content: `${"x".repeat(90)}\nsecond line`,
			createdAt: now,
			updatedAt: now,
		});

		const { text } = await callNote({ db, params: { action: "read" } });

		expect(text).toContain(`#1 · 0m · ${"x".repeat(80)}…`);
		expect(text).not.toContain("second line");
	});

	it("pages the glance with a one-line footer", async () => {
		const db = createTestDb();
		const now = Date.now();
		for (let index = 0; index < 30; index += 1) {
			insertNoteAt(db, {
				content: `note ${index}`,
				createdAt: now - index * 60_000,
				updatedAt: now - index * 60_000,
			});
		}

		const first = await callNote({ db, params: { action: "read" } });
		expect(first.text).toContain("#1 · 0m · note 0");
		expect(first.text).toContain("#25 · 24m · note 24");
		expect(first.text).not.toContain("note 25\n");
		expect(first.text).toContain(
			'Showing 25 of 30 — 5 older: ctx_note(action="read", offset=25)',
		);

		const second = await callNote({
			db,
			params: { action: "read", offset: 25 },
		});
		expect(second.text).toContain("note 25");
		expect(second.text).toContain("note 29");
		expect(second.text).not.toContain("older: ctx_note");
	});

	it("returns full bodies in the order the ids were given and hides foreign ids", async () => {
		const db = createTestDb();
		const now = Date.now();
		insertNoteAt(db, { content: "first body", createdAt: now, updatedAt: now });
		insertNoteAt(db, {
			content: "second body",
			createdAt: now,
			updatedAt: now,
		});
		insertNoteAt(db, {
			content: "foreign body",
			sessionId: "ses-foreign",
			createdAt: now,
			updatedAt: now,
		});

		const { text } = await callNote({
			db,
			params: { action: "read", note_ids: [2, 1, 3, 999] },
		});

		expect(text).toBe(
			"## Notes by ID\n\n" +
				"- **#2** · 0m · active: second body\n\n" +
				"- **#1** · 0m · active: first body\n\n" +
				"- Note #3: not_found\n\n" +
				"- Note #999: not_found\n\n" +
				'To dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])',
		);
		expect(text).not.toContain("foreign body");
	});

	it("carries the anchor and the condition on a full body", async () => {
		const db = createTestDb();
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const now = Date.now();
		const id = insertNoteAt(db, {
			type: "smart",
			status: "ready",
			content: "Ship the release",
			projectPath: projectIdentity,
			surfaceCondition: "when the tag exists",
			createdAt: now,
			updatedAt: now,
		});
		db.prepare(
			"UPDATE notes SET anchor_ordinal = ?, ready_reason = ? WHERE id = ?",
		).run(512, "tag v2 exists", id);

		const { text } = await callNote({
			db,
			params: { action: "read", note_ids: [id] },
		});

		expect(text).toContain(
			"- **#1** · 0m · ready: Ship the release ↳ @msg 512",
		);
		expect(text).toContain("Condition met: tag v2 exists");
	});

	it("appends the active-tray line to the write reply", async () => {
		const db = createTestDb();
		const now = Date.now();
		insertNoteAt(db, {
			content: "older tray item",
			createdAt: now - 2 * DAY,
			updatedAt: now - 2 * DAY,
		});

		const { text } = await callNote({
			db,
			params: { action: "write", content: "new tray item" },
		});

		expect(text).toBe("Saved session note #2. 2 active, oldest 2d.");
	});

	it("keeps the write reply a single line when the tray is empty", async () => {
		const db = createTestDb();

		const { text } = await callNote({
			db,
			params: { action: "write", content: "first note" },
		});

		expect(text).toBe("Saved session note #1. 1 active, oldest 0m.");
	});

	it("keeps the empty-read reply unchanged", async () => {
		const db = createTestDb();

		const { text } = await callNote({ db, params: { action: "read" } });

		expect(text).toBe("## Notes\n\nNo session notes or smart notes.");
	});

	it("still lists a note written through the tool", async () => {
		const db = createTestDb();
		addNote(db, "session", {
			sessionId: "ses-note-1",
			content: "Remember the docs.",
		});

		const { text } = await callNote({ db, params: { action: "read" } });

		expect(text).toContain("#1 · 0m · Remember the docs.");
	});

	describe("issue 793 required provider schema", () => {
		it("advertises action, content and note_ids as required", () => {
			// Argument-dropping providers (InferenceNet via OpenRouter) only
			// emit required properties, so the key arguments must be required
			// for the calls to arrive complete. `filter` stays optional: a
			// read without it still renders the default mixed view.
			const tool = createCtxNoteTool({ db: createTestDb() });
			const schema = tool.parameters as unknown as { required?: string[] };
			expect([...(schema.required ?? [])].sort()).toEqual([
				"action",
				"content",
				"note_ids",
			]);
		});

		it("accepts an empty note_ids list at the provider-schema level", () => {
			// Without this, a model that correctly sends note_ids: [] on write
			// is rejected by host schema validation before the handler runs.
			const tool = createCtxNoteTool({ db: createTestDb() });
			expect(
				Value.Check(tool.parameters, {
					action: "write",
					content: "x",
					note_ids: [],
				}),
			).toBe(true);
		});

		it("write succeeds with an empty note_ids list", async () => {
			const db = createTestDb();
			const { isError, text } = await callNote({
				db,
				params: { action: "write", content: "Empty ids note", note_ids: [] },
			});

			expect(isError).toBe(false);
			expect(text).toContain("Saved session note #1");
		});

		it("plain read with an empty note_ids list validates and lists notes", async () => {
			const db = createTestDb();
			await callNote({
				db,
				params: { action: "write", content: "Listed plain-read note" },
			});
			const tool = createCtxNoteTool({ db });
			const params = { action: "read", content: "", note_ids: [] as number[] };
			expect(Value.Check(tool.parameters, params)).toBe(true);
			const { isError, text } = await callNote({ db, params });

			expect(isError).toBe(false);
			expect(text).toContain("Listed plain-read note");
		});

		it("read with a note id validates and returns the full body", async () => {
			const db = createTestDb();
			await callNote({
				db,
				params: { action: "write", content: "Targeted full-body note" },
			});
			const tool = createCtxNoteTool({ db });
			const params = { action: "read", content: "", note_ids: [1] };
			expect(Value.Check(tool.parameters, params)).toBe(true);
			const { isError, text } = await callNote({ db, params });

			expect(isError).toBe(false);
			expect(text).toContain("Targeted full-body note");
		});

		it("read and dismiss succeed with empty content filler", async () => {
			const db = createTestDb();
			await callNote({
				db,
				params: { action: "write", content: "Dismissable note" },
			});
			const read = await callNote({
				db,
				params: { action: "read", content: "" },
			});
			expect(read.isError).toBe(false);
			expect(read.text).toContain("Dismissable note");
			const dismiss = await callNote({
				db,
				params: { action: "dismiss", note_ids: [1], content: "" },
			});
			expect(dismiss.isError).toBe(false);
			expect(dismiss.text).toContain("Note #1 dismissed.");
		});

		it("update accepts empty content when a surface condition is given", async () => {
			const db = createTestDb();
			await callNote({
				db,
				params: {
					action: "write",
					content: "Condition-only update target",
					surface_condition: "When the release lands",
				},
			});
			const { isError, text } = await callNote({
				db,
				params: {
					action: "update",
					note_ids: [1],
					content: "",
					surface_condition: "When the hotfix lands",
				},
			});

			expect(isError).toBe(false);
			expect(text).toContain("Updated note #1");
			expect(text).toContain("When the hotfix lands");
		});

		it("still rejects content missing where the action needs it", async () => {
			const db = createTestDb();
			const write = await callNote({
				db,
				params: { action: "write", content: "", note_ids: [] },
			});
			expect(write.isError).toBe(true);
			expect(write.text).toContain(
				"'content' is required when action is 'write'.",
			);
			const dismiss = await callNote({
				db,
				params: { action: "dismiss", note_ids: [] },
			});
			expect(dismiss.isError).toBe(true);
			expect(dismiss.text).toContain(
				"'note_ids' must contain 1 to 50 positive integer ids when action is 'dismiss'.",
			);
		});
	});
});
