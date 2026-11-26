import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { FULL_PARAMETER_DESCRIPTIONS } from "@magic-context/core/tools/parameter-descriptions";
import { createTestDb } from "../test-utils.test";
import { createCtxMemoryListTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxSearchTool } from "./ctx-search";

type Properties = Record<string, { description?: string }>;

// Pi's own TypeBox schemas carry parameter descriptions too; they must say the
// same thing as the shared full preset, which registration layers on top. These
// fields previously claimed that `sources: []` searches nothing, that the default
// note read equals `filter: "active"`, and that note reads take any number of ids;
// none of that is what the runtime does (issue 575).
describe("Pi host-local parameter descriptions match the shared full preset", () => {
	it("ctx_search sources", () => {
		const db = createTestDb();
		try {
			const properties = createCtxSearchTool({ db }).parameters
				.properties as Properties;
			expect(properties.sources?.description).toBe(
				FULL_PARAMETER_DESCRIPTIONS.ctx_search.sources,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("ctx_note filter and note_ids", () => {
		const db = createTestDb();
		try {
			const properties = createCtxNoteTool({ db }).parameters
				.properties as Properties;
			expect(properties.filter?.description).toBe(
				FULL_PARAMETER_DESCRIPTIONS.ctx_note.filter,
			);
			expect(properties.note_ids?.description).toBe(
				FULL_PARAMETER_DESCRIPTIONS.ctx_note.note_ids,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("ctx_memory_list category is an optional list filter", () => {
		const db = createTestDb();
		try {
			const properties = createCtxMemoryListTool({ db }).parameters
				.properties as Properties;
			expect(properties.category?.description).toBe(
				"Filter listed memories to this category (optional).",
			);
		} finally {
			closeQuietly(db);
		}
	});
});
