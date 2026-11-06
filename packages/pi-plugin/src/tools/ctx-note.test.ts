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
import { Value } from "typebox/value";

import { createTestDb, fakeContext } from "../test-utils.test";
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
			).toThrow("Error: 'content' must be a string.");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects non-string content and preserves omitted or string content", () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
			for (const content of [null, 1, false, [], {}]) {
				expect(() => tool.prepareArguments?.({ content })).toThrow(
					"Error: 'content' must be a string.",
				);
			}
			for (const args of [
				{},
				{ content: undefined },
				{ content: "null" },
				{ content: "正文" },
			]) {
				expect(tool.prepareArguments?.(args)).toBe(args);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects invalid raw IDs before conversion without changing notes", async () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
			const prepareArguments = tool.prepareArguments;
			if (!prepareArguments) throw new Error("prepareArguments is missing");
			const ctx = fakeContext("ses-fraction-note") as never;
			const signal = new AbortController().signal;
			const seed = await tool.execute(
				"seed",
				{ action: "write", content: "原有笔记", note_ids: [] },
				signal,
				undefined,
				ctx,
			);
			expect(seed.isError).not.toBe(true);
			const before = db.prepare("SELECT * FROM notes ORDER BY id").all();
			expect(before).toHaveLength(1);
			for (const action of ["write", "read", "update", "dismiss"] as const) {
				for (const note_ids of [
					null,
					"3",
					[null],
					["3"],
					[1.5],
					["1.5"],
					[0],
					[-3],
					[1e20],
					[Number.MAX_SAFE_INTEGER + 1],
				]) {
					const raw = { action, content: "修改内容", note_ids };
					let converted = false;
					expect(() => {
						const prepared = prepareArguments(raw);
						converted = true;
						Value.Convert(tool.parameters, prepared);
					}).toThrow(
						"Error: 'note_ids' must be an array of positive note IDs.",
					);
					expect(converted).toBe(false);
					expect(db.prepare("SELECT * FROM notes ORDER BY id").all()).toEqual(
						before,
					);
				}
			}
			for (const note_ids of [[], [1], [Number.MAX_SAFE_INTEGER], undefined]) {
				const args = { action: "read", content: "", note_ids };
				expect(prepareArguments(args)).toBe(args);
			}
			const missing = { action: "read", content: "" };
			expect(prepareArguments(missing)).toBe(missing);
			for (const note_ids of [[], [1]]) {
				const args = prepareArguments({
					action: "read",
					content: "",
					note_ids,
				});
				const result = await tool.execute(
					"read-valid",
					args,
					signal,
					undefined,
					ctx,
				);
				expect(result.isError).not.toBe(true);
			}
			const base = { action: "read", content: "" };
			expect(
				Value.Check(tool.parameters, { action: "read", note_ids: [] }),
			).toBe(false);
			expect(
				Value.Check(tool.parameters, {
					...base,
					content: undefined,
					note_ids: [],
				}),
			).toBe(false);
			for (const ids of [[], [1], [Number.MAX_SAFE_INTEGER]])
				expect(Value.Check(tool.parameters, { ...base, note_ids: ids })).toBe(
					true,
				);
			for (const ids of [[0], [Number.MAX_SAFE_INTEGER + 1], Array(51).fill(1)])
				expect(Value.Check(tool.parameters, { ...base, note_ids: ids })).toBe(
					false,
				);
			const write = await tool.execute(
				"write-null",
				prepareArguments({ action: "write", content: "null", note_ids: [] }),
				signal,
				undefined,
				ctx,
			);
			expect(write.isError).not.toBe(true);
			expect(db.prepare("SELECT * FROM notes ORDER BY id").all()).toHaveLength(
				2,
			);
			expect(
				db.prepare("SELECT content FROM notes ORDER BY id DESC LIMIT 1").get(),
			).toEqual({ content: "null" });
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
