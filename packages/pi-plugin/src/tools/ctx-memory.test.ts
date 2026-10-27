import { describe, expect, it } from "bun:test";
import { writeTaskStateJson } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoryById,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getMemoryMutationsForRender } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { Value } from "typebox/value";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxMemoryListTool, createCtxMemoryTool } from "./ctx-memory";

describe("createCtxMemoryTool", () => {
	it("advertises list only through the separate dreamer tool", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const list = createCtxMemoryListTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
			});

			expect(primary.parameters.properties).not.toHaveProperty("superseded_by");
			expect(dreamer.parameters.properties).toHaveProperty("superseded_by");
			expect(
				JSON.stringify(primary.parameters.properties.action),
			).not.toContain("list");
			expect(
				JSON.stringify(dreamer.parameters.properties.action),
			).not.toContain("list");
			expect(Object.keys(list.parameters.properties).sort()).toEqual([
				"category",
				"limit",
			]);

			const ctx = fakeContext("ses-memory") as never;
			const primaryResult = await primary.execute(
				"call-1",
				{ action: "list" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const dreamerResult = await list.execute(
				"call-2",
				{},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(primaryResult.isError).toBe(true);
			expect(primaryResult.content[0]?.text).toBe(
				"Error: Action 'list' is not allowed in this context.",
			);
			expect(dreamerResult.isError).toBeUndefined();
			expect(dreamerResult.content[0]?.text).toBe("No active memories found.");
		} finally {
			closeQuietly(db);
		}
	});

	it("advertises limit only where the list action can run (issue 575)", () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const list = createCtxMemoryListTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
			});

			expect(primary.parameters.properties).not.toHaveProperty("limit");
			expect(dreamer.parameters.properties).toHaveProperty("limit");
			expect(list.parameters.properties).toHaveProperty("limit");
			// A replayed older primary call that still carries `limit` must stay
			// valid: the schema tolerates unknown fields rather than rejecting them.
			// The replayed call carries the now-required action-irrelevant filler
			// a provider would send (issue 793); `get` still ignores it.
			expect(primary.parameters.additionalProperties).toBe(true);
			expect(
				Value.Check(primary.parameters, {
					action: "get",
					ids: [1],
					content: "",
					category: "PROJECT_RULES",
					limit: 5,
				}),
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("unwraps an imitated reduced get call", async () => {
		const db = createTestDb();
		try {
			const tool = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const memory = insertMemory(db, {
				projectPath: resolveProjectIdentity((ctx as { cwd: string }).cwd),
				category: "CONSTRAINTS",
				content: "Run the focused test suite.",
			});

			const plain = await tool.execute(
				"call-plain",
				{ action: "get", ids: [memory.id] },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const imitated = await tool.execute(
				"call-imitated",
				{
					reduced: true,
					summary: JSON.stringify({ action: "get", ids: [memory.id] }),
				},
				new AbortController().signal,
				undefined,
				ctx,
			);
			const decorated = await tool.execute(
				"call-decorated",
				{
					action: "get",
					ids: [memory.id],
					reduced: true,
					summary: JSON.stringify({ action: "archive", ids: [memory.id] }),
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(imitated).toEqual(plain);
			expect(decorated).toEqual(plain);
		} finally {
			closeQuietly(db);
		}
	});

	it("formats list output with a header and verification column", async () => {
		const db = createTestDb();
		try {
			const ctx = fakeContext("ses-memory") as never;
			const projectIdentity = resolveProjectIdentity(
				(ctx as { cwd: string }).cwd,
			);
			insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use the shared formatter.",
			});
			const dreamer = createCtxMemoryListTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
			});

			const result = await dreamer.execute(
				"call-list",
				{},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ID | CATEGORY");
			expect(text).toContain("VERIFY");
			expect(text).toContain("Use the shared formatter.");
		} finally {
			closeQuietly(db);
		}
	});

	// Like OpenCode, Pi applies automated edits immediately to stored memories, but
	// keeps them out of the prompt until its next full memory rebuild.
	it("applies dreamer update, merge and archive directly without log rows or fragments", async () => {
		const db = createTestDb();
		try {
			const ctx = fakeContext("ses-dreamer-routed") as never;
			const projectIdentity = resolveProjectIdentity(
				(ctx as { cwd: string }).cwd,
			);
			const first = insertMemory(db, {
				projectPath: projectIdentity,
				category: "ARCHITECTURE",
				content: "Dreamer target one.",
			});
			const second = insertMemory(db, {
				projectPath: projectIdentity,
				category: "ARCHITECTURE",
				content: "Dreamer target two.",
			});
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const run = async (params: Record<string, unknown>) => {
				const result = await dreamer.execute(
					"call",
					params as never,
					new AbortController().signal,
					undefined,
					ctx,
				);
				expect(result.isError).toBeUndefined();
				return result.content[0]?.text ?? "";
			};
			const before = db
				.prepare(
					"SELECT id, content, status, revision FROM memories ORDER BY id",
				)
				.all();
			expect(
				await run({ action: "update", ids: [first.id], content: "Rewritten." }),
			).toContain("Updated memory");
			expect(
				await run({
					action: "merge",
					ids: [first.id, second.id],
					content: "Merged.",
				}),
			).toContain("Merged memories");
			const successor = insertMemory(db, {
				projectPath: projectIdentity,
				category: "ARCHITECTURE",
				content: "Surviving fact.",
			});
			expect(
				await run({
					action: "archive",
					ids: [
						(
							db
								.prepare("SELECT id FROM memories WHERE content='Merged.'")
								.get() as { id: number }
						).id,
					],
					superseded_by: successor.id,
				}),
			).toContain("Archived memory");
			expect(
				db
					.prepare(
						"SELECT id, content, status, revision FROM memories ORDER BY id",
					)
					.all(),
			).not.toEqual(before);
			expect(
				db
					.prepare(
						"SELECT writer, operation FROM memory_tool_proposals ORDER BY id",
					)
					.all(),
			).toEqual([]);
			expect(
				await run({
					action: "write",
					category: "ARCHITECTURE",
					content: "A dreamer-written fact.",
				}),
			).toContain("Saved memory");
			const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
			expect(count("SELECT COUNT(*) AS n FROM memory_mutation_log")).toBe(0);
			expect(count("SELECT COUNT(*) AS n FROM memory_agent_fragments")).toBe(0);
			expect(
				count(
					"SELECT COUNT(*) AS n FROM memories WHERE source_type = 'dreamer' AND content = 'A dreamer-written fact.'",
				),
			).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("refuses a dreamer mutation outside the persisted curate category scope", async () => {
		const db = createTestDb();
		try {
			const ctx = fakeContext("ses-curate-category-scope") as never;
			const projectIdentity = resolveProjectIdentity(
				(ctx as { cwd: string }).cwd,
			);
			insertMemory(db, {
				projectPath: projectIdentity,
				category: "PROJECT_RULES",
				content: "Keep Pi curation category-scoped.",
			});
			const architecture = insertMemory(db, {
				projectPath: projectIdentity,
				category: "ARCHITECTURE",
				content: "The Pi facade delegates to the shared task runner.",
			});
			writeTaskStateJson(
				db,
				projectIdentity,
				"curate",
				JSON.stringify({
					curate: { cursor: 0, activeCategory: "PROJECT_RULES" },
				}),
			);
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});

			const result = await dreamer.execute(
				"call-out-of-scope",
				{
					action: "update",
					ids: [architecture.id],
					content: "The Pi facade and shared task runner rotate together.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("outside the scoped category");
			expect(getMemoryById(db, architecture.id)?.content).toBe(
				"The Pi facade delegates to the shared task runner.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("allows a primary agent to archive (no longer dreamer-only)", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;

			// write a memory as the primary agent, then archive it as the same
			// primary agent — archive replaced the old `delete` alias and is no
			// longer gated behind allowDreamerActions.
			const written = await primary.execute(
				"call-w",
				{ action: "write", category: "ARCHITECTURE", content: "Stale fact." },
				new AbortController().signal,
				undefined,
				ctx,
			);
			expect(written.isError).toBeUndefined();
			const idMatch = written.content[0]?.text?.match(/ID:\s*(\d+)/);
			const id = idMatch ? Number(idMatch[1]) : Number.NaN;
			expect(Number.isInteger(id)).toBe(true);

			const archived = await primary.execute(
				"call-a",
				{ action: "archive", ids: [id] },
				new AbortController().signal,
				undefined,
				ctx,
			);
			expect(archived.isError).toBeUndefined();
			expect(archived.content[0]?.text).toContain("Archived memory");
		} finally {
			closeQuietly(db);
		}
	});

	// Primary-agent edits share OpenCode's applier: each one writes undo history
	// and exactly one fragment for the session that made it, which that session's
	// next busting m[1] shows.
	it("routes primary write, update, merge and archive through the shared applier", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-routed") as never;
			const run = async (params: Record<string, unknown>) => {
				const result = await primary.execute(
					"call",
					params as never,
					new AbortController().signal,
					undefined,
					ctx,
				);
				expect(result.isError).toBeUndefined();
				return Number(result.content[0]?.text?.match(/ID:\s*(\d+)/)?.[1]);
			};
			const first = await run({
				action: "write",
				category: "ARCHITECTURE",
				content: "First routed fact.",
			});
			const second = await run({
				action: "write",
				category: "ARCHITECTURE",
				content: "Second routed fact.",
			});
			await run({
				action: "update",
				ids: [first],
				content: "First fact, edited.",
			});
			const merged = await run({
				action: "merge",
				ids: [first, second],
				content: "Both facts, merged.",
			});
			await run({ action: "archive", ids: [merged] });
			const fragments = db
				.prepare(
					"SELECT session_id, lines FROM memory_agent_fragments ORDER BY id",
				)
				.all() as Array<{ session_id: string; lines: string }>;
			expect(fragments.map((fragment) => fragment.session_id)).toEqual(
				Array(5).fill("ses-routed"),
			);
			expect(fragments[2]?.lines).toBe(
				`  <updated id="${first}" category="ARCHITECTURE">First fact, edited.</updated>`,
			);
			expect(fragments[4]?.lines).toBe(`  <removed id="${merged}"/>`);
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as {
						n: number;
					}
				).n,
			).toBeGreaterThanOrEqual(4);
		} finally {
			closeQuietly(db);
		}
	});

	it("refuses a curate user-profile archive without a surviving successor", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-curate-safety") as never;
			const projectIdentity = resolveProjectIdentity(
				(ctx as { cwd: string }).cwd,
			);
			const memory = insertMemory(db, {
				projectPath: projectIdentity,
				category: "PROJECT_RULES",
				content:
					"Always run the cache-bust analyzer before drawing conclusions.",
			});

			const result = await dreamer.execute(
				"call-curate-archive",
				{
					action: "archive",
					ids: [memory.id],
					reason: "Redundant with global user profile directive U2.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("Skipped archive");
			expect(getMemoryById(db, memory.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects updating a foreign workspace memory even when the category is shared", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const foreign = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "Old foreign shared constraint.",
			});

			const result = await primary.execute(
				"call-u",
				{
					action: "update",
					ids: [foreign.id],
					content: "Updated foreign shared constraint.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreign.id} was not found.`,
			);
			expect(getMemoryById(db, foreign.id)?.content).toBe(
				"Old foreign shared constraint.",
			);
			expect(
				getMemoryMutationsForRender(db, "git:foreign", 0, [foreign.id]),
			).toHaveLength(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects archiving a foreign workspace memory even when the category is shared", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const foreign = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "Foreign shared constraint.",
			});

			const result = await primary.execute(
				"call-a",
				{ action: "archive", ids: [foreign.id] },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreign.id} was not found.`,
			);
			expect(getMemoryById(db, foreign.id)?.status).toBe("active");
			expect(
				getMemoryMutationsForRender(db, "git:foreign", 0, [foreign.id]),
			).toHaveLength(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("REFUSES to archive a foreign memory in a NON-shared category (P0 parity)", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			// Workspace shares only CONSTRAINTS; a foreign ARCHITECTURE memory is
			// invisible in the render and must not be mutable by the tool either.
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const foreignHidden = insertMemory(db, {
				projectPath: "git:foreign",
				category: "ARCHITECTURE",
				content: "Foreign architecture detail not shared.",
			});

			const result = await primary.execute(
				"call-block",
				{ action: "archive", ids: [foreignHidden.id] },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(String(result)).not.toContain("Archived memory");
			expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects archiving a foreign memory in a SHARED category", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const foreignShared = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "Foreign constraint shared with this project.",
			});

			const result = await primary.execute(
				"call-ok",
				{ action: "archive", ids: [foreignShared.id] },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreignShared.id} was not found.`,
			);
			expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects a primary-agent merge that includes another project's memory", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;

			// One memory in THIS project's identity (resolved from ctx.cwd) and
			// one under a foreign project path. Cross-identity merge is a
			// dreamer-only capability; a primary agent must get the same opaque
			// "not found" reply update/archive use (no existence oracle).
			const written = await primary.execute(
				"call-w",
				{
					action: "write",
					category: "CONSTRAINTS",
					content: "Use bun for scripts.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);
			expect(written.isError).toBeUndefined();
			const idMatch = written.content[0]?.text?.match(/ID:\s*(\d+)/);
			const ownId = idMatch ? Number(idMatch[1]) : Number.NaN;
			expect(Number.isInteger(ownId)).toBe(true);

			const foreign = insertMemory(db, {
				projectPath: "/repo/other-project",
				category: "CONSTRAINTS",
				content: "Use bun for build scripts.",
			});

			const result = await primary.execute(
				"call-m",
				{
					action: "merge",
					ids: [ownId, foreign.id],
					content: "Use bun for all scripts in this repository.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreign.id} was not found.`,
			);
			expect(getMemoryById(db, ownId)?.status).toBe("active");
			expect(getMemoryById(db, foreign.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("REFUSES a PRIMARY merge pulling in a foreign NON-shared-category memory (P0 parity)", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			// Workspace shares only CONSTRAINTS; a foreign ARCHITECTURE memory is
			// invisible in the render and must not be mergeable by a primary agent.
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const own = insertMemory(db, {
				projectPath: ownIdentity,
				category: "ARCHITECTURE",
				content: "Own architecture detail A.",
			});
			const foreignHidden = insertMemory(db, {
				projectPath: "git:foreign",
				category: "ARCHITECTURE", // foreign, NON-shared category
				content: "Foreign architecture not shared with this project.",
			});

			const result = await primary.execute(
				"call-block",
				{
					action: "merge",
					ids: [own.id, foreignHidden.id],
					content: "Merged architecture detail.",
					category: "ARCHITECTURE",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			// Primary agents get the opaque "not found" reply (no existence oracle).
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreignHidden.id} was not found.`,
			);
			expect(getMemoryById(db, own.id)?.status).toBe("active");
			expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects a PRIMARY merge of a foreign SHARED-category memory", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const own = insertMemory(db, {
				projectPath: ownIdentity,
				category: "CONSTRAINTS",
				content: "Own constraint A.",
			});
			const foreignShared = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS", // shared
				content: "Foreign constraint shared with this project.",
			});

			const result = await primary.execute(
				"call-ok",
				{
					action: "merge",
					ids: [own.id, foreignShared.id],
					content: "Merged shared constraint.",
					category: "CONSTRAINTS",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreignShared.id} was not found.`,
			);
			expect(getMemoryById(db, own.id)?.status).toBe("active");
			expect(getMemoryById(db, foreignShared.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("REFUSES a DREAMER merge of a foreign NON-shared-category memory INSIDE a workspace (D1 parity)", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-dreamer") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			// The dreamer keeps cross-project merge OUTSIDE a workspace, but INSIDE
			// a workspace the per-category sharing policy is the user's privacy
			// boundary it must honor too.
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const own = insertMemory(db, {
				projectPath: ownIdentity,
				category: "ARCHITECTURE",
				content: "Own architecture detail D1.",
			});
			const foreignHidden = insertMemory(db, {
				projectPath: "git:foreign",
				category: "ARCHITECTURE", // foreign, NON-shared
				content: "Foreign architecture not shared with this workspace member.",
			});

			const result = await dreamer.execute(
				"call-d1-block",
				{
					action: "merge",
					ids: [own.id, foreignHidden.id],
					content: "Merged architecture detail D1.",
					category: "ARCHITECTURE",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				`Error: Memory with ID ${foreignHidden.id} is in a category not shared with this workspace member and cannot be merged.`,
			);
			expect(getMemoryById(db, own.id)?.status).toBe("active");
			expect(getMemoryById(db, foreignHidden.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("REJECTS merging memories from DIFFERENT categories (structural guard parity)", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-dreamer") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			const arch = insertMemory(db, {
				projectPath: ownIdentity,
				category: "ARCHITECTURE",
				content: "Execute threshold capped at 80% for headroom.",
			});
			const cfg = insertMemory(db, {
				projectPath: ownIdentity,
				category: "CONFIG_VALUES",
				content: "execute_threshold_percentage accepts 20-80 scalar or map.",
			});

			const result = await dreamer.execute(
				"call-xcat",
				{
					action: "merge",
					ids: [arch.id, cfg.id],
					content: "Execute threshold stuff.",
					category: "CONFIG_VALUES",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("different categories");
			expect(getMemoryById(db, arch.id)?.status).toBe("active");
			expect(getMemoryById(db, cfg.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("REFUSES a DREAMER merge when workspace share_categories is malformed", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-dreamer") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, 'not-json');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const own = insertMemory(db, {
				projectPath: ownIdentity,
				category: "CONSTRAINTS",
				content: "Own constraint malformed policy.",
			});
			const foreign = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "Foreign constraint hidden by malformed policy.",
			});

			const result = await dreamer.execute(
				"call-d1-malformed",
				{
					action: "merge",
					ids: [own.id, foreign.id],
					content: "Merged malformed policy constraint.",
					category: "CONSTRAINTS",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(
				"not shared with this workspace member",
			);
			expect(getMemoryById(db, own.id)?.status).toBe("active");
			expect(getMemoryById(db, foreign.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("ALLOWS a DREAMER merge of a foreign SHARED-category memory INSIDE a workspace (D1 parity)", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-dreamer") as never;
			const ownIdentity = resolveProjectIdentity((ctx as { cwd: string }).cwd);
			db.exec(`
				INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
				       (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			const own = insertMemory(db, {
				projectPath: ownIdentity,
				category: "CONSTRAINTS",
				content: "Own constraint D1.",
			});
			const foreignShared = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS", // shared
				content: "Foreign constraint shared with the workspace.",
			});

			const result = await dreamer.execute(
				"call-d1-ok",
				{
					action: "merge",
					ids: [own.id, foreignShared.id],
					content: "Merged shared constraint D1.",
					category: "CONSTRAINTS",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			// The category is shared, so the dreamer can consolidate both projects' memories.
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("Merged memories");
			expect(getMemoryById(db, own.id)?.status).toBe("archived");
			expect(getMemoryById(db, foreignShared.id)?.status).toBe("archived");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects malformed ids and duplicate merge ids for primary agents", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const projectIdentity = resolveProjectIdentity(process.cwd());
			const first = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for scripts.",
			});
			const second = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for tests.",
			});

			const malformedArchive = await primary.execute(
				"call-a",
				{ action: "archive", ids: [first.id, second.id + 0.5] },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const malformedUpdate = await primary.execute(
				"call-u",
				{ action: "update", ids: [first.id + 0.5], content: "Use pnpm." },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const duplicateMerge = await primary.execute(
				"call-m",
				{ action: "merge", ids: [first.id, first.id], content: "Use bun." },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(malformedArchive.isError).toBe(true);
			expect(malformedArchive.content[0]?.text).toContain("integer memory ID");
			expect(malformedUpdate.isError).toBe(true);
			expect(malformedUpdate.content[0]?.text).toContain("integer memory ID");
			expect(duplicateMerge.isError).toBe(true);
			expect(duplicateMerge.content[0]?.text).toContain("distinct memory IDs");
			expect(getMemoryById(db, first.id)?.status).toBe("active");
			expect(getMemoryById(db, second.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects archived memories for primary update and merge", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const projectIdentity = resolveProjectIdentity(process.cwd());
			const archived = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for scripts.",
			});
			const active = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for tests.",
			});
			db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(
				archived.id,
			);

			const update = await primary.execute(
				"call-u",
				{ action: "update", ids: [archived.id], content: "Use pnpm." },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const merge = await primary.execute(
				"call-m",
				{ action: "merge", ids: [archived.id, active.id], content: "Use bun." },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(update.isError).toBe(true);
			expect(update.content[0]?.text).toContain("restore it before updating");
			expect(merge.isError).toBe(true);
			expect(merge.content[0]?.text).toContain("restore it before merging");
			expect(getMemoryById(db, archived.id)?.status).toBe("archived");
			expect(getMemoryById(db, active.id)?.status).toBe("active");
		} finally {
			closeQuietly(db);
		}
	});

	it("rejects archived memories for primary archive too", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;
			const projectIdentity = resolveProjectIdentity(process.cwd());
			const archived = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for scripts.",
			});
			db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(
				archived.id,
			);

			const archivedAgain = await primary.execute(
				"call-a",
				{ action: "archive", ids: [archived.id] },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(archivedAgain.isError).toBe(true);
			expect(archivedAgain.content[0]?.text).toContain(
				"restore it before archiving",
			);
			expect(getMemoryById(db, archived.id)?.status).toBe("archived");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps dreamer able to apply a merge that restores an archived canonical memory", async () => {
		const db = createTestDb();
		try {
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});
			const ctx = fakeContext("ses-dreamer") as never;
			const projectIdentity = resolveProjectIdentity(process.cwd());
			const archived = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for scripts.",
			});
			const active = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "Use bun for tests.",
			});
			db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(
				archived.id,
			);

			const result = await dreamer.execute(
				"call-m",
				{
					action: "merge",
					ids: [archived.id, active.id],
					content: "Use bun for scripts.",
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("Merged memories");
			expect(getMemoryById(db, archived.id)?.status).toBe("active");
			expect(getMemoryById(db, active.id)?.status).toBe("archived");
		} finally {
			closeQuietly(db);
		}
	});

	describe("get action", () => {
		it("returns an own-project memory by id", async () => {
			const db = createTestDb();
			try {
				const ctx = fakeContext("ses-get") as never;
				const projectIdentity = resolveProjectIdentity(
					(ctx as { cwd: string }).cwd,
				);
				const memory = insertMemory(db, {
					projectPath: projectIdentity,
					category: "CONSTRAINTS",
					content: "Use the shared formatter.",
				});
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});

				const result = await primary.execute(
					"call-get",
					{ action: "get", ids: [memory.id] },
					new AbortController().signal,
					undefined,
					ctx,
				);

				expect(result.isError).toBeUndefined();
				const text = result.content[0]?.text ?? "";
				expect(text).toContain(`Found 1 active memory`);
				expect(text).toContain(String(memory.id));
				expect(text).toContain("Use the shared formatter.");
			} finally {
				closeQuietly(db);
			}
		});

		it("labels archived rows with their status instead of hiding them", async () => {
			const db = createTestDb();
			try {
				const ctx = fakeContext("ses-get-archived") as never;
				const projectIdentity = resolveProjectIdentity(
					(ctx as { cwd: string }).cwd,
				);
				const memory = insertMemory(db, {
					projectPath: projectIdentity,
					category: "KNOWN_ISSUES",
					content: "Retired issue the user just referenced.",
				});
				db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(
					memory.id,
				);
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});

				const result = await primary.execute(
					"call-get-archived",
					{ action: "get", ids: [memory.id] },
					new AbortController().signal,
					undefined,
					ctx,
				);

				const text = result.content[0]?.text ?? "";
				expect(text).toContain(String(memory.id));
				expect(text).toContain("archived");
				expect(text).toContain("Retired issue the user just referenced.");
			} finally {
				closeQuietly(db);
			}
		});

		it("reports a foreign non-shared-category memory as not visible (no existence oracle)", async () => {
			const db = createTestDb();
			try {
				const ctx = fakeContext("ses-get-foreign") as never;
				const ownIdentity = resolveProjectIdentity(
					(ctx as { cwd: string }).cwd,
				);
				// Construct a workspace that shares only CONSTRAINTS so the
				// foreign ARCHITECTURE memory is not visible from the own side.
				db.exec(`
					INSERT INTO workspaces (id, name, created_at, updated_at, share_categories)
					VALUES (1, 'ws', 1, 1, '["CONSTRAINTS"]');
					INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
					VALUES (1, '${ownIdentity}', 'Own', '${ownIdentity}', 1),
					       (1, 'git:foreign', 'Foreign', '/foreign', 1);
				`);
				const foreign = insertMemory(db, {
					projectPath: "git:foreign",
					category: "ARCHITECTURE",
					content: "Foreign architecture hidden by the share policy.",
				});
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});

				const result = await primary.execute(
					"call-get-foreign",
					{ action: "get", ids: [foreign.id] },
					new AbortController().signal,
					undefined,
					ctx,
				);

				const text = result.content[0]?.text ?? "";
				expect(text).toContain(
					`id ${foreign.id}: not found or not visible from this project`,
				);
				expect(text).not.toContain(
					"Foreign architecture hidden by the share policy.",
				);
			} finally {
				closeQuietly(db);
			}
		});

		it("rejects >20 ids with a clear error", async () => {
			const db = createTestDb();
			try {
				const ctx = fakeContext("ses-get-many") as never;
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ids = Array.from({ length: 21 }, (_, i) => i + 1);

				const result = await primary.execute(
					"call-get-many",
					{ action: "get", ids },
					new AbortController().signal,
					undefined,
					ctx,
				);

				expect(result.isError).toBe(true);
				expect(result.content[0]?.text).toContain("at most 20");
			} finally {
				closeQuietly(db);
			}
		});

		it("returns a per-id report mixing hits and misses in call order", async () => {
			const db = createTestDb();
			try {
				const ctx = fakeContext("ses-get-mixed") as never;
				const projectIdentity = resolveProjectIdentity(
					(ctx as { cwd: string }).cwd,
				);
				const own = insertMemory(db, {
					projectPath: projectIdentity,
					category: "CONSTRAINTS",
					content: "Own constraint present.",
				});
				const missing = 999_999;
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});

				const result = await primary.execute(
					"call-get-mixed",
					{ action: "get", ids: [own.id, missing] },
					new AbortController().signal,
					undefined,
					ctx,
				);

				const text = result.content[0]?.text ?? "";
				expect(text).toContain(String(own.id));
				expect(text).toContain("Own constraint present.");
				expect(text).toContain(
					`id ${missing}: not found or not visible from this project`,
				);
			} finally {
				closeQuietly(db);
			}
		});
	});

	describe("required-all filler", () => {
		const textOf = (result: { content: Array<{ text?: string }> }) =>
			result.content[0]?.text ?? "";

		const runWrite = async (args: Record<string, unknown>) => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const result = await tool.execute(
					"call-write",
					args,
					new AbortController().signal,
					undefined,
					fakeContext("ses-memory") as never,
				);
				return textOf(result);
			} finally {
				closeQuietly(db);
			}
		};

		it("write ignores ids/limit/reason filler, including ids:[0]", async () => {
			const cleanArgs = {
				action: "write",
				category: "PROJECT_RULES",
				content: "Same standalone fact.",
			};
			const clean = await runWrite(cleanArgs);
			const filler = await runWrite({
				...cleanArgs,
				ids: [1],
				limit: 0,
				reason: "",
			});
			const zeroIds = await runWrite({
				...cleanArgs,
				ids: [0],
				limit: 0,
				reason: "",
			});
			expect(filler).toBe(clean);
			expect(zeroIds).toBe(clean);
			expect(clean).toContain("Saved memory [ID:");
		});

		it("archive with empty reason and unused-field filler matches a clean archive", async () => {
			const run = async (archiveArgs: Record<string, unknown>) => {
				const db = createTestDb();
				try {
					const tool = createCtxMemoryTool({
						db,
						memoryEnabled: true,
						embeddingEnabled: false,
						allowDreamerActions: false,
					});
					const ctx = fakeContext("ses-memory") as never;
					await tool.execute(
						"call-write",
						{
							action: "write",
							category: "PROJECT_RULES",
							content: "Archive this fact.",
						},
						new AbortController().signal,
						undefined,
						ctx,
					);
					const result = await tool.execute(
						"call-archive",
						archiveArgs,
						new AbortController().signal,
						undefined,
						ctx,
					);
					return textOf(result);
				} finally {
					closeQuietly(db);
				}
			};
			const clean = await run({ action: "archive", ids: [1] });
			const filler = await run({
				action: "archive",
				ids: [1],
				content: "",
				category: "PROJECT_RULES",
				limit: 0,
				reason: "",
			});
			expect(filler).toBe(clean);
			expect(clean).toContain("Archived");
		});

		it("update/get/merge ignore unused-field filler and match the clean call", async () => {
			const seed = async () => {
				const db = createTestDb();
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				for (const content of ["Original fact.", "Duplicate fact to merge."]) {
					await tool.execute(
						"call-write",
						{ action: "write", category: "PROJECT_RULES", content },
						new AbortController().signal,
						undefined,
						ctx,
					);
				}
				return { db, tool, ctx };
			};
			const execute = async (
				fixture: Awaited<ReturnType<typeof seed>>,
				args: Record<string, unknown>,
			) =>
				textOf(
					await fixture.tool.execute(
						"call-filler",
						args,
						new AbortController().signal,
						undefined,
						fixture.ctx,
					),
				);

			const updateCleanDb = await seed();
			const updateFillerDb = await seed();
			const getCleanDb = await seed();
			const getFillerDb = await seed();
			const mergeCleanDb = await seed();
			const mergeFillerDb = await seed();
			try {
				const updateClean = await execute(updateCleanDb, {
					action: "update",
					ids: [1],
					content: "Updated fact.",
					category: "ARCHITECTURE",
				});
				const updateFiller = await execute(updateFillerDb, {
					action: "update",
					ids: [1],
					content: "Updated fact.",
					category: "ARCHITECTURE",
					limit: 0,
					reason: "",
				});
				const getClean = await execute(getCleanDb, { action: "get", ids: [1] });
				const getFiller = await execute(getFillerDb, {
					action: "get",
					ids: [1],
					content: "",
					category: "PROJECT_RULES",
					limit: 0,
					reason: "",
				});
				const mergeClean = await execute(mergeCleanDb, {
					action: "merge",
					ids: [1, 2],
					content: "Merged standalone fact.",
				});
				const mergeFiller = await execute(mergeFillerDb, {
					action: "merge",
					ids: [1, 2],
					content: "Merged standalone fact.",
					category: "PROJECT_RULES",
					limit: 0,
					reason: "",
				});
				const stamp = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;
				expect(updateFiller).toBe(updateClean);
				expect(updateClean).toContain("in ARCHITECTURE");
				expect(getFiller.replace(stamp, "<ts>")).toBe(
					getClean.replace(stamp, "<ts>"),
				);
				expect(mergeFiller).toBe(mergeClean);
			} finally {
				for (const fixture of [
					updateCleanDb,
					updateFillerDb,
					getCleanDb,
					getFillerDb,
					mergeCleanDb,
					mergeFillerDb,
				]) {
					closeQuietly(fixture.db);
				}
			}
		});

		it("keeps unused ids and category filler inert under an active dreamer category scope", async () => {
			const run = async (action: "write" | "get" | "list", filler: boolean) => {
				const db = createTestDb();
				try {
					const ctx = fakeContext("ses-memory") as never;
					const projectIdentity = resolveProjectIdentity(
						(ctx as { cwd: string }).cwd,
					);
					const projectRule = insertMemory(db, {
						projectPath: projectIdentity,
						category: "PROJECT_RULES",
						content: "Different scoped fact.",
					});
					const architecture = insertMemory(db, {
						projectPath: projectIdentity,
						category: "ARCHITECTURE",
						content: "Scoped architecture fact.",
					});
					writeTaskStateJson(
						db,
						projectIdentity,
						"curate",
						JSON.stringify({
							curate: { cursor: 0, activeCategory: "ARCHITECTURE" },
						}),
					);
					const tool = createCtxMemoryTool({
						db,
						memoryEnabled: true,
						embeddingEnabled: false,
						allowDreamerActions: true,
					});
					const args =
						action === "write"
							? {
									action,
									category: "ARCHITECTURE",
									content: "New scoped architecture fact.",
									...(filler
										? { ids: [projectRule.id], limit: 0, reason: "" }
										: {}),
								}
							: action === "get"
								? {
										action,
										ids: [architecture.id],
										...(filler
											? {
													content: "",
													category: "PROJECT_RULES",
													limit: 0,
													reason: "",
												}
											: {}),
									}
								: {
										action,
										category: "ARCHITECTURE",
										...(filler
											? {
													ids: [projectRule.id],
													content: "",
													limit: 0,
													reason: "",
													superseded_by: 0,
												}
											: {}),
									};
					const result = await tool.execute(
						"call-scope-filler",
						args,
						new AbortController().signal,
						undefined,
						ctx,
					);
					return textOf(result);
				} finally {
					closeQuietly(db);
				}
			};
			const stamp = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;
			const clean = {
				write: await run("write", false),
				get: (await run("get", false)).replace(stamp, "<ts>"),
				list: (await run("list", false)).replace(stamp, "<ts>"),
			};
			const filler = {
				write: await run("write", true),
				get: (await run("get", true)).replace(stamp, "<ts>"),
				list: (await run("list", true)).replace(stamp, "<ts>"),
			};

			expect(filler).toEqual(clean);
			expect(clean.write).toContain("Saved memory");
			expect(clean.get).toContain("Scoped architecture fact");
			expect(clean.list).toContain("Scoped architecture fact");
		});

		it("list treats limit 0 as the default and filler ids do not bypass the dreamer-only gate", async () => {
			const db = createTestDb();
			try {
				const projectIdentity = resolveProjectIdentity(process.cwd());
				for (const label of ["one", "two", "three"]) {
					insertMemory(db, {
						projectPath: projectIdentity,
						category: "PROJECT_RULES",
						content: `List filler ${label}.`,
					});
				}
				const dreamer = createCtxMemoryListTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
				});
				const primary = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const clean = await dreamer.execute(
					"call-list-clean",
					{},
					new AbortController().signal,
					undefined,
					ctx,
				);
				const filler = await dreamer.execute(
					"call-list-filler",
					{
						ids: [1],
						content: "",
						category: "PROJECT_RULES",
						limit: 0,
						reason: "",
						superseded_by: 0,
					} as never,
					new AbortController().signal,
					undefined,
					ctx,
				);
				const primaryFiller = await primary.execute(
					"call-list-primary",
					{
						action: "list",
						ids: [1],
						content: "",
						category: "PROJECT_RULES",
						limit: 0,
						reason: "",
						superseded_by: 0,
					},
					new AbortController().signal,
					undefined,
					ctx,
				);
				expect(textOf(filler)).toBe(textOf(clean));
				expect(textOf(clean)).toContain("Found 3 active memories");
				expect(primaryFiller.isError).toBe(true);
				expect(textOf(primaryFiller)).toBe(
					"Error: Action 'list' is not allowed in this context.",
				);
			} finally {
				closeQuietly(db);
			}
		});
	});
	describe("issue 793 required provider schema", () => {
		const textOf793 = (result: { content: Array<{ text?: string }> }) =>
			result.content[0]?.text ?? "";

		const requiredOf = (allowDreamerActions: boolean): string[] => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions,
				});
				const schema = tool.parameters as unknown as { required?: string[] };
				return [...(schema.required ?? [])].sort();
			} finally {
				closeQuietly(db);
			}
		};

		it("advertises action, content, category and ids as required", () => {
			// Argument-dropping providers (InferenceNet via OpenRouter) only
			// emit required properties, so the key arguments must be required
			// for the calls to arrive complete. `reason` stays optional.
			expect(requiredOf(false)).toEqual([
				"action",
				"category",
				"content",
				"ids",
			]);
			expect(requiredOf(true)).toEqual([
				"action",
				"category",
				"content",
				"ids",
			]);
		});

		it("accepts an empty ids list at the provider-schema level", () => {
			// ctx_memory ids carries no minimum: a model that correctly sends
			// ids: [] on write must pass host schema validation.
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				expect(
					Value.Check(tool.parameters, {
						action: "write",
						content: "x",
						category: "PROJECT_RULES",
						ids: [],
					}),
				).toBe(true);
			} finally {
				closeQuietly(db);
			}
		});

		it("archive with empty content and any category validates and archives", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				await tool.execute(
					"call-seed",
					{
						action: "write",
						category: "PROJECT_RULES",
						content: "Archivable filler fact.",
					},
					signal,
					undefined,
					ctx,
				);
				const params = {
					action: "archive",
					ids: [1],
					content: "",
					category: "CONSTRAINTS",
				};
				expect(Value.Check(tool.parameters, params)).toBe(true);
				const archived = textOf793(
					await tool.execute(
						"call-archive-filler",
						params,
						signal,
						undefined,
						ctx,
					),
				);
				expect(archived).toContain("Archived memory [ID: 1]");
			} finally {
				closeQuietly(db);
			}
		});

		it("write succeeds with an empty ids list and still rejects empty content", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				const written = textOf793(
					await tool.execute(
						"call-write-filler",
						{
							action: "write",
							category: "PROJECT_RULES",
							content: "Filler ids fact.",
							ids: [],
						},
						signal,
						undefined,
						ctx,
					),
				);
				expect(written).toContain("Saved memory [ID:");
				const empty = textOf793(
					await tool.execute(
						"call-write-empty",
						{
							action: "write",
							category: "PROJECT_RULES",
							content: "",
							ids: [],
						},
						signal,
						undefined,
						ctx,
					),
				);
				expect(empty).toBe(
					"Error: 'content' is required when action is 'write'.",
				);
			} finally {
				closeQuietly(db);
			}
		});

		it("get succeeds with content/category filler and still rejects empty ids", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				await tool.execute(
					"call-seed",
					{ action: "write", category: "PROJECT_RULES", content: "Seed fact." },
					signal,
					undefined,
					ctx,
				);
				const filler = textOf793(
					await tool.execute(
						"call-get-filler",
						{ action: "get", ids: [1], content: "", category: "PROJECT_RULES" },
						signal,
						undefined,
						ctx,
					),
				);
				expect(filler).toContain("Seed fact.");
				const empty = textOf793(
					await tool.execute(
						"call-get-empty",
						{ action: "get", ids: [], content: "", category: "PROJECT_RULES" },
						signal,
						undefined,
						ctx,
					),
				);
				expect(empty).toBe(
					"Error: 'ids' must contain at least one integer memory ID when action is 'get'.",
				);
			} finally {
				closeQuietly(db);
			}
		});

		it("archive succeeds with content/category filler", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				await tool.execute(
					"call-seed",
					{ action: "write", category: "PROJECT_RULES", content: "Seed fact." },
					signal,
					undefined,
					ctx,
				);
				const filler = textOf793(
					await tool.execute(
						"call-archive-filler",
						{
							action: "archive",
							ids: [1],
							content: "",
							category: "PROJECT_RULES",
						},
						signal,
						undefined,
						ctx,
					),
				);
				expect(filler).toContain("Archived memory [ID: 1]");
			} finally {
				closeQuietly(db);
			}
		});

		it("update keeps the category callers send back and changes it when they send another", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				await tool.execute(
					"call-seed",
					{
						action: "write",
						category: "PROJECT_RULES",
						content: "Recategorizable fact.",
					},
					signal,
					undefined,
					ctx,
				);
				const call = async (args: Parameters<typeof tool.execute>[1]) =>
					textOf793(
						await tool.execute("call-793-update", args, signal, undefined, ctx),
					);
				expect(
					await call({
						action: "update",
						ids: [1],
						category: "PROJECT_RULES",
						content: "Same category fact.",
					}),
				).toContain("in PROJECT_RULES");
				expect(getMemoryById(db, 1)?.category).toBe("PROJECT_RULES");
				expect(
					await call({
						action: "update",
						ids: [1],
						category: "CONSTRAINTS",
						content: "Moved category fact.",
					}),
				).toContain("in CONSTRAINTS");
				expect(getMemoryById(db, 1)?.category).toBe("CONSTRAINTS");
				expect(
					await call({
						action: "update",
						ids: [1],
						category: "CONSTRAINTS",
						content: "",
					}),
				).toBe("Error: 'content' is required when action is 'update'.");
			} finally {
				closeQuietly(db);
			}
		});

		it("merge keeps the sent source category and still rejects empty content", async () => {
			const db = createTestDb();
			try {
				const tool = createCtxMemoryTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					allowDreamerActions: false,
				});
				const ctx = fakeContext("ses-memory") as never;
				const signal = new AbortController().signal;
				for (const content of ["First merge fact.", "Second merge fact."]) {
					await tool.execute(
						"call-seed",
						{ action: "write", category: "PROJECT_RULES", content },
						signal,
						undefined,
						ctx,
					);
				}
				const merged = textOf793(
					await tool.execute(
						"call-merge-filler",
						{
							action: "merge",
							ids: [1, 2],
							category: "PROJECT_RULES",
							content: "Merged filler fact.",
						},
						signal,
						undefined,
						ctx,
					),
				);
				expect(merged).toContain("in PROJECT_RULES");
				const empty = textOf793(
					await tool.execute(
						"call-merge-empty",
						{
							action: "merge",
							ids: [1, 2],
							category: "PROJECT_RULES",
							content: "",
						},
						signal,
						undefined,
						ctx,
					),
				);
				expect(empty).toBe(
					"Error: 'content' is required when action is 'merge'.",
				);
			} finally {
				closeQuietly(db);
			}
		});
	});
});
