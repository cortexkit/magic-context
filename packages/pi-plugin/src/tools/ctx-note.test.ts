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

	it("正文拒绝非字符串，缺失及字符串保持原样", () => {
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

	it("小数编号不能修改已有笔记", async () => {
		const db = createTestDb();
		try {
			const tool = createCtxNoteTool({ db });
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
			for (const action of ["read", "update", "dismiss"] as const) {
				for (const id of [1.5, "1.5"]) {
					const raw = { action, content: "修改内容", note_ids: [id] };
					const prepared = tool.prepareArguments?.(raw) ?? raw;
					const converted = (
						typeof id === "number"
							? Value.Convert(tool.parameters, prepared)
							: prepared
					) as { action: typeof action; content: string; note_ids: number[] };
					expect(converted.note_ids[0]).toBe(id);
					expect(Value.Check(tool.parameters, converted)).toBe(
						typeof id === "number",
					);
					const result = await tool.execute(
						"fraction",
						converted,
						signal,
						undefined,
						ctx,
					);
					expect(result.isError).toBe(true);
					expect(result.content[0]?.text).toContain("integer");
					expect(db.prepare("SELECT * FROM notes ORDER BY id").all()).toEqual(
						before,
					);
				}
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
				"write-filler",
				{ action: "write", content: "无关编号", note_ids: [1.5] },
				signal,
				undefined,
				ctx,
			);
			expect(write.isError).not.toBe(true);
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
