import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCompartments,
	replaceSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { buildMagicContextBlock } from "./system-prompt";
import { createTestDb } from "./test-utils.test";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("buildMagicContextBlock", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no memories, session history, or docs exist (guidance off)", () => {
		const db = createTestDb();
		try {
			// includeGuidance: false isolates the data-block behavior; with
			// guidance enabled the block is never null because guidance is
			// always present.
			expect(
				buildMagicContextBlock({
					db,
					cwd: tempDir("pi-empty-"),
					sessionId: "ses-empty",
					memoryEnabled: true,
					injectDocs: true,
					includeGuidance: false,
				}),
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT render project-memory in the system prompt — memories live inside <session-history> in message[0]", () => {
		// OpenCode parity: project-scoped memories are emitted INSIDE the
		// `<session-history>` block via `buildCompartmentBlock(compartments, facts,
		// memoryBlock, …)` — NOT in the system prompt. Putting them here too
		// would duplicate the same memory entries on the wire.
		const db = createTestDb();
		const cwd = tempDir("pi-memory-");
		try {
			insertMemory(db, {
				projectPath: resolveProjectIdentity(cwd),
				category: "WORKFLOW_RULES",
				content: "Always run Pi plugin tests from packages/pi-plugin.",
				sourceType: "user",
			});

			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-memory",
				memoryEnabled: true,
				injectDocs: false,
				includeGuidance: false,
			});

			// With memoryEnabled but no docs/no guidance, the data block is empty —
			// memories no longer get rendered here. injectSessionHistoryIntoPi
			// (called from pi.on("context", ...)) is responsible for emitting them
			// inside the <session-history> block in message[0].
			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("renders project-docs when ARCHITECTURE.md and STRUCTURE.md are present", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-docs-");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, "ARCHITECTURE.md"),
			"# Architecture\nRuntime map",
			"utf-8",
		);
		writeFileSync(
			join(cwd, "STRUCTURE.md"),
			"# Structure\nPackage map",
			"utf-8",
		);
		try {
			const block = buildMagicContextBlock({
				db,
				cwd,
				memoryEnabled: false,
				injectDocs: true,
				includeGuidance: false,
			});

			expect(block).toContain("<project-docs>");
			expect(block).toContain("<ARCHITECTURE.md>");
			expect(block).toContain("Runtime map");
			expect(block).toContain("<STRUCTURE.md>");
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT render session-history in the system prompt — that block is injected into message[0] instead", () => {
		// session-history must live exactly once on the wire. We inject it into
		// message[0] from `pi.on("context", ...)` (via injectSessionHistoryIntoPi)
		// because that's the only place that can also trim already-compartmentalized
		// raw history out of the message array. Including it ALSO in the system
		// prompt block here would put the same XML on the wire twice. This test
		// pins down the parity contract: with only compartments+facts available
		// (no memory, no docs), buildMagicContextBlock returns null because there's
		// no system-prompt-side content to inject.
		const db = createTestDb();
		try {
			appendCompartments(db, "ses-history", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "Setup",
					content: "Configured Pi historian.",
				},
			]);
			replaceSessionFacts(db, "ses-history", [
				{
					category: "CONSTRAINTS",
					content: "Do not spawn pi subprocesses in tests.",
				},
			]);

			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-history-"),
				sessionId: "ses-history",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: false,
			});

			// No memory, no docs, no guidance → null (session-history is NOT
			// emitted here, only memories/docs/guidance).
			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("memoryBudgetChars option is now a no-op for the system-prompt block (memories live in <session-history>)", () => {
		// Kept as an assertion that future regressions don't accidentally
		// re-introduce memory rendering in the system prompt block. The
		// memoryBudgetChars trimming logic that used to live here was moved
		// alongside memory injection itself — into prepareCompartmentInjection,
		// which has its own budget via injectionBudgetTokens.
		const db = createTestDb();
		const cwd = tempDir("pi-memory-budget-");
		const projectPath = resolveProjectIdentity(cwd);
		try {
			insertMemory(db, {
				projectPath,
				category: "CONSTRAINTS",
				content: "should not appear in system prompt",
				sourceType: "user",
			});

			const block = buildMagicContextBlock({
				db,
				cwd,
				memoryEnabled: true,
				injectDocs: false,
				memoryBudgetChars: 40,
				includeGuidance: false,
			});

			// Even with memory data in the DB, the system-prompt block stays empty.
			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("includes ## Magic Context guidance by default even when no data exists", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-"),
				sessionId: "ses-guidance",
				memoryEnabled: true,
				injectDocs: true,
				// includeGuidance default is true
			});

			expect(block).not.toBeNull();
			expect(block).toContain("## Magic Context");
			// Must explain ctx_search/ctx_memory/ctx_note so agent knows how to use them
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
			// No data block when nothing to render
			expect(block).not.toContain("<magic-context>");
		} finally {
			closeQuietly(db);
		}
	});

	it("concatenates guidance and data block when both present", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-combo-");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, "ARCHITECTURE.md"),
			"# Architecture\nPi loads at process start.",
			"utf-8",
		);
		try {
			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-combo",
				memoryEnabled: false,
				injectDocs: true,
				includeGuidance: true,
			});

			expect(block).not.toBeNull();
			// Guidance comes first, then data block
			const guidanceIdx = block?.indexOf("## Magic Context") ?? -1;
			const dataIdx = block?.indexOf("<magic-context>") ?? -1;
			expect(guidanceIdx).toBeGreaterThanOrEqual(0);
			expect(dataIdx).toBeGreaterThanOrEqual(0);
			expect(guidanceIdx).toBeLessThan(dataIdx);
			expect(block).toContain("Pi loads at process start.");
		} finally {
			closeQuietly(db);
		}
	});

	it("emits no-reduce guidance variant when ctxReduceEnabled is false", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-noreduce-"),
				sessionId: "ses-noreduce",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				ctxReduceEnabled: false,
			});

			expect(block).not.toBeNull();
			expect(block).toContain("## Magic Context");
			// No-reduce variant must NOT mention §N§ tag system or ctx_reduce
			expect(block).not.toContain("§N§");
			expect(block).not.toContain("ctx_reduce");
			// But it MUST still teach the other ctx_* tools
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
		} finally {
			closeQuietly(db);
		}
	});

	it("includes §N§ tag explanation when ctxReduceEnabled is true (default)", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-reduce-"),
				sessionId: "ses-reduce",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				ctxReduceEnabled: true,
				protectedTags: 25,
			});

			expect(block).not.toBeNull();
			// With ctx_reduce_enabled the agent needs to know what §N§ means
			expect(block).toContain("§N§");
			expect(block).toContain("ctx_reduce");
			// protected_tags value flows through to "Last 25 tags are protected"
			expect(block).toContain("25");
		} finally {
			closeQuietly(db);
		}
	});
});
