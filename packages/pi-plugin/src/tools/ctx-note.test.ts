/**
 * Pi `ctx_note` argument-preparation coverage.
 *
 * pi 1.5 validates tool arguments with @earendil-works/pi-schema, which coerces
 * loosely typed arguments before validation: a required string sent as null
 * becomes the string "null" and would be stored as the note body.
 * `prepareArguments` runs before validation and before execute(), so a raw null
 * is rejected there and the model gets an error tool result instead.
 */

import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { createTestDb } from "../test-utils.test";
import { createCtxNoteTool } from "./ctx-note";

describe("createCtxNoteTool prepareArguments", () => {
	it("throws when content is null", () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
			expect(() =>
				tool.prepareArguments?.({
					action: "write",
					content: null,
					note_ids: [],
				}),
			).toThrow("Error: 'content' must be a string, not null.");
		} finally {
			closeQuietly(db);
		}
	});

	it('passes the literal string "null" through unchanged', () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
			const args = {
				action: "write",
				content: "null",
				note_ids: [],
			};
			expect(tool.prepareArguments?.(args)).toBe(args);
		} finally {
			closeQuietly(db);
		}
	});

	it("passes a note body through unchanged", () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
			const args = {
				action: "write",
				content: "note text",
				note_ids: [],
			};
			expect(tool.prepareArguments?.(args)).toBe(args);
		} finally {
			closeQuietly(db);
		}
	});
});
