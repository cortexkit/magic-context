import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoryById,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getMemoryMutationsForRender } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxMemoryTool } from "./ctx-memory";

describe("createCtxMemoryTool", () => {
	it("rejects list for primary agents and allows it for dreamer agents", async () => {
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

			const ctx = fakeContext("ses-memory") as never;
			const primaryResult = await primary.execute(
				"call-1",
				{ action: "list" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const dreamerResult = await dreamer.execute(
				"call-2",
				{ action: "list" },
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
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});

			const result = await dreamer.execute(
				"call-list",
				{ action: "list" },
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

			// Fresh canonical inserted; both sources superseded → archived.
			expect(result.isError).toBeUndefined();
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

	it("keeps dreamer able to curate archived memories during merge", async () => {
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
			expect(result.content[0]?.text).toContain(
				`canonical memory [ID: ${archived.id}]`,
			);
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
});

describe("Pi ctx_memory provenance", () => {
	it("advances a migrated legacy baseline only for a distinct session", async () => {
		const db = createTestDb();
		try {
			let sessionId = "pi-session-a";
			const tool = createCtxMemoryTool({
				db,
				resolveProjectIdentity: () => "git:project",
			});
			const ctx = {
				cwd: "/repo",
				sessionManager: { getSessionId: () => sessionId },
			} as never;
			const write = () =>
				tool.execute(
					"call-write",
					{
						action: "write",
						category: "CONSTRAINTS",
						content: "Migrated Pi fact",
					},
					new AbortController().signal,
					() => undefined,
					ctx,
				);

			await write();
			const memory = db
				.prepare<unknown[], { id: number }>("SELECT id FROM memories")
				.get();
			expect(memory).toBeDefined();
			db.prepare("UPDATE memories SET seen_count = 10 WHERE id = ?").run(
				memory?.id,
			);

			await write();
			expect(getMemoryById(db, memory?.id ?? -1)?.seenCount).toBe(10);
			sessionId = "pi-session-b";
			await write();
			expect(getMemoryById(db, memory?.id ?? -1)?.seenCount).toBe(11);
		} finally {
			closeQuietly(db);
		}
	});

	it("preserves content-bound evidence when memories merge", async () => {
		const db = createTestDb();
		try {
			const tool = createCtxMemoryTool({
				db,
				resolveProjectIdentity: () => "git:project",
			});
			const ctx = {
				cwd: "/repo",
				sessionManager: { getSessionId: () => "pi-session" },
			} as never;
			await tool.execute(
				"call-1",
				{ action: "write", category: "CONSTRAINTS", content: "First phrasing" },
				new AbortController().signal,
				() => undefined,
				ctx,
			);
			await tool.execute(
				"call-2",
				{
					action: "write",
					category: "CONSTRAINTS",
					content: "Second phrasing",
				},
				new AbortController().signal,
				() => undefined,
				ctx,
			);
			const ids = db
				.prepare<unknown[], { id: number }>(
					"SELECT id FROM memories ORDER BY id",
				)
				.all()
				.map((row) => row.id);

			await tool.execute(
				"call-3",
				{
					action: "merge",
					ids,
					category: "CONSTRAINTS",
					content: "Canonical phrasing",
				},
				new AbortController().signal,
				() => undefined,
				ctx,
			);

			const canonical = db
				.prepare<unknown[], { id: number }>(
					"SELECT id FROM memories WHERE content = 'Canonical phrasing'",
				)
				.get();
			expect(canonical).toBeDefined();
			expect(
				db
					.prepare(
						`SELECT content_hash, source_message_id, source_type
						   FROM memory_evidence WHERE memory_id = ? ORDER BY observed_at`,
					)
					.all(canonical?.id),
			).toEqual([
				{
					content_hash: expect.any(String),
					source_message_id: null,
					source_type: "agent",
				},
				{
					content_hash: expect.any(String),
					source_message_id: null,
					source_type: "agent",
				},
				{
					content_hash: expect.any(String),
					source_message_id: null,
					source_type: "agent",
				},
			]);
		} finally {
			closeQuietly(db);
		}
	});
});
