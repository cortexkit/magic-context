import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	archiveMemory,
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getCompartments,
	getOrCreateSessionMeta,
	queueMemoryMutation,
	setProjectState,
} from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	insertUserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { COMPARTMENT_RENDER_EPOCH } from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	renderM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("workspace memory sharing", () => {
	it("filters foreign categories consistently in Pi m[0] and status counts", () => {
		const db = createTestDb();
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-share-"));
		try {
			db.exec(`
				INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
				VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			insertMemory(db, {
				projectPath: "git:own",
				category: "NAMING",
				content: "own naming remains visible",
			});
			const shared = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "foreign constraint is shared",
			});
			db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(
				shared.id,
			);
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "NAMING",
				content: "foreign naming is hidden",
			});
			const state = {
				sessionId: "pi-share",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("own naming remains visible");
			expect(m0).toContain("foreign constraint is shared");
			expect(m0).not.toContain("foreign naming is hidden");

			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(state, db, messages);
			expect(result.memoryCount).toBe(2);
			expect(textOf(messages[0])).toContain("foreign constraint is shared");
			expect(textOf(messages[0])).not.toContain("foreign naming is hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not render foreign memories when share_categories is malformed", () => {
		const db = createTestDb();
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-share-malformed-"));
		try {
			db.exec(`
				INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
				VALUES (1, 'ws', 'not-json', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			insertMemory(db, {
				projectPath: "git:own",
				category: "CONSTRAINTS",
				content: "own malformed Pi memory remains visible",
			});
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "foreign malformed Pi memory is hidden",
			});
			const state = {
				sessionId: "pi-share-malformed",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("own malformed Pi memory remains visible");
			expect(m0).not.toContain("foreign malformed Pi memory is hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A compartment ending on a folded-toolResult boundary carries
		// endMessageId = `synth-user-<realToolResultEntryId>`. The live array has
		// no message with that synthetic id — only the real toolResult (entry id
		// "tr-real"). Pre-fix, the cutoff never matched and NOTHING was trimmed
		// (history duplicated -> overflow). The fix strips the prefix and matches
		// the real toolResult, then the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		// toolResult "tr-real" (cutoff) + its paired assistant "call-a" (orphan
		// sweep) are removed; the later turn + keep survive.
		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment and user-profile snapshots without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-frozen-cp-profile-"));
		try {
			const state = piState("ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			insertUserMemory(db, "old profile memory", []);
			const frozenCompartments = getCompartments(db, state.sessionId);
			const frozenUserProfile = getActiveUserMemories(db);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);
			insertUserMemory(db, "new profile memory", []);

			const m0 = renderM0Pi(
				state,
				db,
				"",
				1,
				[],
				frozenCompartments,
				frozenUserProfile,
			);
			const m1 = renderM1Pi(state, db, {
				maxCompartmentSeq: 1,
				maxMemoryId: 0,
				maxMutationId: 0,
				maxMemoryMutationId: 0,
				projectMemoryEpoch: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).toContain("old profile memory");
			expect(m0).not.toContain("new compartment body");
			expect(m0).not.toContain("new profile memory");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
			expect(m1).not.toContain("old profile memory");
		} finally {
			closeQuietly(db);
		}
	});
});

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("injectM0M1Pi memory feature gate", () => {
	it("does NOT render project memories into m[0]/m[1] when memoryEnabled=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memgate-"));
		try {
			const base = piState("ses-pi-memgate", cwd);
			// A compartment (history) MUST still render — only memory is gated.
			appendCompartments(db, base.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			insertMemory(db, {
				projectPath: base.projectIdentity,
				category: "ARCHITECTURE",
				content: "project memory must not leak when disabled",
				sourceType: "historian",
			});
			insertUserMemory(db, "profile baseline must not leak", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			// memoryEnabled=false suppresses every memory-derived surface while
			// retaining compartment history.
			const disabledState = {
				...base,
				memoryEnabled: false,
				mural: {
					enabled: true,
					supportsVision: true,
					dataUrl: "data:image/png;base64,cHJvZmlsZS1tdXJhbA==",
				},
			};
			const off = [userMessage("hello", 10)];
			injectM0M1Pi(disabledState, db, off as never, undefined, true);
			const offM0 = textOf(off[0] as never);
			expect(offM0).not.toContain("project memory must not leak when disabled");
			expect(offM0).not.toContain("<project-memory");
			expect(offM0).not.toContain("<user-profile>");
			expect(offM0).not.toContain("profile baseline must not leak");
			expect(offM0).not.toContain("<memory-mural>");
			expect((off[0] as { content: unknown[] }).content).toHaveLength(1);
			expect(offM0).toContain("compartment body present");

			// A fresh global profile version can request m[1] work, but its delta
			// must remain absent while the memory surface is disabled.
			insertUserMemory(db, "profile delta must not leak", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 2 });
			const refreshed = [userMessage("again", 11)];
			injectM0M1Pi(disabledState, db, refreshed as never, undefined, true);
			const offM1 = textOf(refreshed[1] as never);
			expect(offM1).not.toContain("<new-user-profile>");
			expect(offM1).not.toContain("profile delta must not leak");

			// Control: a fresh session with memoryEnabled left on DOES render it,
			// proving the gate (not some other filter) is responsible.
			const onState = piState("ses-pi-memgate-on", cwd);
			appendCompartments(db, onState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			const on = [userMessage("hello", 10)];
			injectM0M1Pi(onState, db, on as never, undefined, true);
			expect(textOf(on[0] as never)).toContain(
				"project memory must not leak when disabled",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the system-hash HARD path for a memory-on to memory-off transition", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memory-off-transition-"));
		try {
			const state = piState("ses-pi-memgate-transition", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "transition project fact",
			});
			insertUserMemory(db, "transition profile fact", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			const on = [userMessage("before", 10)];
			injectM0M1Pi(
				{
					...state,
					memoryEnabled: true,
					hardSignals: {
						systemHash: "memory-guidance-on",
						modelKey: "test/model",
					},
				},
				db,
				on as never,
				undefined,
				true,
			);
			expect(textOf(on[0] as never)).toContain("transition profile fact");

			const offState = {
				...state,
				memoryEnabled: false,
				hardSignals: {
					systemHash: "memory-guidance-off",
					modelKey: "test/model",
				},
			};
			const off = [userMessage("after", 11)];
			const transition = injectM0M1Pi(
				offState,
				db,
				off as never,
				undefined,
				true,
			);
			expect(transition.m0Materialized).toBe(true);
			expect(textOf(off[0] as never)).not.toContain("transition profile fact");

			const defer = [userMessage("still off", 12)];
			const replay = injectM0M1Pi(offState, db, defer as never);
			expect(replay.m0Materialized).toBe(false);
			expect(textOf(defer[0] as never)).not.toContain(
				"transition profile fact",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("keeps the memory-on m[0]/m[1] shape byte-identical", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-memory-on-shape-"));
		try {
			const state = piState("ses-pi-memgate-shape", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "memory-on project fact",
			});
			insertUserMemory(db, "memory-on profile fact", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			const defaultRender = materializeM0Pi(state, db);
			const explicitlyEnabledRender = materializeM0Pi(
				{ ...state, memoryEnabled: true },
				db,
			);
			expect(explicitlyEnabledRender.m0).toBe(defaultRender.m0);
			expect(explicitlyEnabledRender.m1).toBe(defaultRender.m1);
			expect(defaultRender.m0).toContain("memory-on profile fact");
			expect(defaultRender.m0).toContain("memory-on project fact");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi", () => {
	it("keeps project memory but removes compartment rendering and trim in compaction-off mode", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compaction-off-"));
		try {
			const offState = {
				...piState("ses-pi-compaction-off", cwd),
				compactionOff: true,
			};
			appendCompartments(db, offState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-entry",
					endMessageId: "old-entry",
					title: "old history",
					content: "compartment-only history must stay off the wire",
				},
			]);
			insertMemory(db, {
				projectPath: offState.projectIdentity,
				category: "ARCHITECTURE",
				content: "compaction-off memory survives",
				sourceType: "historian",
			});
			const messages = [
				userMessage("raw history stays visible", 10),
				userMessage("live tail", 11),
			];
			const result = injectM0M1Pi(offState, db, messages as never, [
				"old-entry",
				"live-entry",
			]);

			expect(textOf(messages[0] as never)).toContain(
				"compaction-off memory survives",
			);
			expect(textOf(messages[0] as never)).not.toContain("<session-history>");
			expect(textOf(messages[0] as never)).not.toContain(
				"compartment-only history must stay off the wire",
			);
			expect(result.skippedVisibleMessages).toBe(0);
			expect(textOf(messages.at(-1) as never)).toBe("live tail");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState("ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("gates project docs block and hash with injectDocs=false", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-docs-gate-"));
		try {
			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# PI_FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
			);
			writeFileSync(
				join(cwd, "STRUCTURE.md"),
				"# PI_FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
			);
			const state = { ...piState("ses-pi-docs-off", cwd), injectDocs: false };

			const first = [userMessage("hello", 10)];
			const firstResult = injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			expect(firstResult.m0Materialized).toBe(true);
			expect(firstM0).not.toContain("<project-docs>");
			expect(firstM0).not.toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(firstM0).not.toContain("PI_FLAG_OFF_STRUCTURE_DOCS");
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0ProjectDocsHash,
			).toBe("");
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});

			const second = [userMessage("hello again", 11)];
			const secondResult = injectM0M1Pi(
				state,
				db,
				second as never,
				undefined,
				false,
			);

			expect(secondResult.m0Materialized).toBe(false);
			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);

			const enabledState = piState("ses-pi-docs-on", cwd);
			const enabled = [userMessage("hello docs", 12)];
			injectM0M1Pi(enabledState, db, enabled as never);
			expect(textOf(enabled[0] as never)).toContain("<project-docs>");
			expect(textOf(enabled[0] as never)).toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(textOf(enabled[0] as never)).toContain(
				"PI_FLAG_OFF_STRUCTURE_DOCS",
			);
			expect(
				mustMaterializePi({ ...enabledState, injectDocs: false }, db),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-render-epoch-"));
		try {
			const state = piState("ses-pi-render-epoch", cwd);
			injectM0M1Pi(state, db, [userMessage("first", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				Buffer.from("<session-history>legacy renderer bytes</session-history>"),
				"pi-m0m1-v2:ready",
				state.sessionId,
			);

			expect(mustMaterializePi(state, db)).toMatchObject({
				value: true,
				reason: "compartment_render_epoch",
			});
			const foldedMessages = [userMessage("same", 11)];
			const folded = injectM0M1Pi(state, db, foldedMessages as never);
			const foldedM0 = textOf(foldedMessages[0] as never);
			const foldedM1 = textOf(foldedMessages[1] as never);
			const replay1 = [userMessage("same", 11)];
			const replay2 = [userMessage("same", 11)];
			const replayResult1 = injectM0M1Pi(state, db, replay1 as never);
			const replayResult2 = injectM0M1Pi(state, db, replay2 as never);

			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("compartment_render_epoch");
			expect(replayResult1.m0Materialized).toBe(false);
			expect(replayResult2.m0Materialized).toBe(false);
			expect(textOf(replay1[0] as never)).toBe(foldedM0);
			expect(textOf(replay2[0] as never)).toBe(foldedM0);
			expect(textOf(replay1[1] as never)).toBe(foldedM1);
			expect(textOf(replay2[1] as never)).toBe(foldedM1);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).toContain(COMPARTMENT_RENDER_EPOCH);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a LEGACY compartment appears (upgrade_state HARD flip)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			// A LEGACY compartment (no p1 tier → legacy=1) flips upgrade_state
			// "ready"→"legacy", which is a genuine HARD trigger (the session now
			// needs /ctx-session-upgrade). This is NOT the new-compartment path — a
			// v2 compartment (with p1) is a SOFT m[1] delta and does NOT re-
			// materialize m[0] (see the SOFT-delta test below). Asserting the legacy
			// HARD path here keeps the upgrade-detection contract pinned.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			// m[0] re-materialized and now carries the compartment heading; the
			// body is present because the U: line keeps the legacy row at P3.
			expect(textOf(second[0] as never)).toContain("## 1-1 · Setup");
			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("SOFT pass: new v2 compartment surfaces in m[1] WITHOUT re-materializing m[0], raw messages trimmed", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-soft-delta-"));
		try {
			const state = piState("ses-pi-soft-delta", cwd);
			// First v2 compartment (p1 present → legacy=0, upgrade_state stays
			// "ready"). Materialize the m[0] baseline.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "U: first turn\nfirst compartment body",
					p1: "U: first turn\nfirst compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = textOf(firstPass[0] as never);
			expect(baselineM0).toContain("first compartment body");

			// Historian publishes a SECOND v2 compartment (the delta). This is the
			// exact scenario the taxonomy fix targets: it MUST ride m[1], not fold
			// m[0].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "U: second turn\nsecond compartment body",
					p1: "U: second turn\nsecond compartment body",
				},
			]);

			// Cache-busting pass (history refresh): recomputeM1ThisPass=true.
			const secondPass = [
				userMessage("covered-0", 10), // entry-0 → already baseline
				userMessage("covered-1", 11), // entry-1 → new compartment, must trim
				userMessage("keep", 12), // live tail → must survive
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);

			// (a) m[0] NOT re-materialized — SOFT, not HARD.
			expect(r1.m0Materialized).toBe(false);
			// (b) m[0] bytes byte-identical to the baseline (the whole point of the
			// split: the stable prefix stays cached).
			const m0 = textOf(secondPass[0] as never);
			expect(m0).toBe(baselineM0);
			expect(m0).not.toContain("second compartment body");
			// (c) new compartment surfaces in m[1].
			expect(textOf(secondPass[1] as never)).toContain(
				"second compartment body",
			);
			// (d) raw messages through the new compartment boundary (entry-1) are
			// trimmed (no duplication) while the live tail survives.
			expect(r1.skippedVisibleMessages).toBe(2);
			expect(textOf(secondPass[secondPass.length - 1] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-marker-"));
		try {
			const state = piState("ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, second as never);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(textOf(second[0] as never)).toContain("<session-history>");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps legacy cached max seq 0 when a real seq-0 compartment exists", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-real-"));
		try {
			const state = piState("ses-pi-legacy-zero-real", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Seq Zero",
					content: "U: first turn\nseq zero body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);

			// Legacy rows persisted 0 both for empty snapshots and for a real seq-0
			// baseline. With a compartment present, 0 is unambiguous and must remain
			// the cached watermark, not be reinterpreted as the empty -1 sentinel.
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never, ["entry-0"]);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toContain("seq zero body");
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes legacy cached max seq 0 to empty only with zero compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-legacy-zero-empty-"));
		try {
			const state = piState("ses-pi-legacy-zero-empty", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
			).run(state.sessionId);

			expect(getCompartments(db, state.sessionId)).toHaveLength(0);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-partial-marker-"));
		try {
			const state = piState("ses-pi-partial-marker", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes instead of reusing cached m[0] when compartment boundary is NULL", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-boundary-"));
		try {
			const state = piState("ses-pi-null-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Boundary",
					content: "U: boundary turn\nboundary body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const messages = [userMessage("covered", 10), userMessage("keep", 11)];
			const result = injectM0M1Pi(state, db, messages as never, [
				"entry-0",
				"keep",
			]);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("reuses cached m[0] (no rematerialize loop) when the compartment is legitimately boundaryless", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-boundary-"));
		try {
			const state = piState("ses-pi-empty-boundary", cwd);
			// A compartment with EMPTY end_message_id is a legitimate state (schema
			// default ''; OpenCode degrades to no-trim). Materialize persists a null
			// boundary for it — which must NOT then be treated as stale-cache and
			// force a rematerialize every pass.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "",
					endMessageId: "",
					title: "Boundaryless",
					content: "U: turn\nbody",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never, []);

			// Cached boundary is null (the compartment has no usable end id), and the
			// LIVE snapshot is also boundaryless → cache is valid, not stale.
			expect(mustMaterializePi(state, db).value).toBe(false);

			// And a second injection pass reuses the cache (no materialize) and
			// degrades to no-trim rather than looping.
			const pass1Messages = [userMessage("hello", 10)];
			const result1 = injectM0M1Pi(state, db, pass1Messages as never, []);
			expect(result1.m0Materialized).toBe(false);
			expect(result1.skippedVisibleMessages).toBe(0);

			const pass2Messages = [userMessage("hello", 10)];
			const result2 = injectM0M1Pi(state, db, pass2Messages as never, []);
			expect(result2.m0Materialized).toBe(false);
			expect(result2.m0Reason).toBeNull();

			// Cache-stability invariant: a boundaryless session must render
			// BYTE-IDENTICAL m[0]/m[1] across consecutive reuse passes (no
			// materialize-vs-reuse oscillation). Compare the actual injected
			// synthetic-prefix text, not just the materialized flag.
			expect(textOf(pass2Messages[0] as never)).toBe(
				textOf(pass1Messages[0] as never),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState("ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const { m0, snapshotMarkers } = materializeM0PiWithRetry(state, db);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-frozen-boundary-"));
		try {
			const state = piState("ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(state, db, messages as never, [
				"old-end",
				"too-far",
				"keep",
			]);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE error exposes only SQLITE_BUSY code", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-code-"));
		try {
			const state = piState("ses-pi-begin-busy-code", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy Code",
					content: "U: busy code turn\nbusy code fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					const error = new Error("writer unavailable") as Error & {
						code: string;
					};
					error.code = "SQLITE_BUSY";
					throw error;
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain(
				"busy code fallback body",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-"));
		try {
			const state = piState("ses-pi-begin-busy", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain(
				"no new content since last materialization",
			);
			expect(textOf(messages[1] as never)).not.toContain("busy fallback body");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-identical m[1] on defer and surfaces additive memory on next cache-busting pass", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-additive-stable-"));
		try {
			const state = piState("ses-pi-m1-additive-stable", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Large baseline memory. ".repeat(300),
				sourceType: "historian",
			});
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const initialM1 = textOf(first[1] as never);

			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "New additive memory appears only after a bust.",
				sourceType: "agent",
			});

			const deferOne = [userMessage("defer one", 11)];
			injectM0M1Pi(state, db, deferOne as never, undefined, false);
			const deferTwo = [userMessage("defer two", 12)];
			injectM0M1Pi(state, db, deferTwo as never, undefined, false);

			expect(textOf(deferOne[1] as never)).toBe(initialM1);
			expect(textOf(deferTwo[1] as never)).toBe(initialM1);
			expect(initialM1).not.toContain("New additive memory");

			const bust = [userMessage("bust", 13)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			expect(textOf(bust[1] as never)).toContain("<new-memories>");
			expect(textOf(bust[1] as never)).toContain(
				"New additive memory appears only after a bust.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("renders archive removals for m0-resident memory only on cache-busting pass and replays them on defer", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-archive-delta-"));
		try {
			const state = piState("ses-pi-m1-archive-delta", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "large baseline",
					content: "baseline ".repeat(300),
				},
			]);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Baseline memory to remove from m0. ".repeat(300),
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			db.transaction(() => {
				archiveMemory(db, memory.id);
				queueMemoryMutation(db, {
					projectPath: state.projectIdentity,
					mutationType: "archive",
					targetMemoryId: memory.id,
					queuedAt: 10,
				});
			})();

			const defer = [userMessage("defer", 11)];
			injectM0M1Pi(state, db, defer as never, undefined, false);
			expect(textOf(defer[1] as never)).not.toContain("<memory-updates>");

			const bust = [userMessage("bust", 12)];
			injectM0M1Pi(state, db, bust as never, undefined, true);
			const m1 = textOf(bust[1] as never);
			expect(m1).toContain("<memory-updates>");
			expect(m1).toContain(
				"These memories changed since the snapshot below — trust these:",
			);
			expect(m1).toContain(`<removed id="${memory.id}"/>`);

			const deferAfterBust = [userMessage("defer after bust", 13)];
			injectM0M1Pi(state, db, deferAfterBust as never, undefined, false);
			expect(textOf(deferAfterBust[1] as never)).toBe(m1);
		} finally {
			closeQuietly(db);
		}
	});

	it("force-renders an eligible supersede replacement that predates the m0 marker", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-forced-supersede-"));
		try {
			const state = piState("ses-pi-m1-forced-supersede", cwd);
			const replacement = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Replacement content must render in the delta.",
			});
			const source = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Baseline source memory.",
			});
			const markers = {
				maxCompartmentSeq: -1,
				maxMemoryId: source.id,
				maxMutationId: 0,
				maxMemoryMutationId: 0,
				projectMemoryEpoch: 0,
				workspaceFingerprint: null,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: Date.now(),
				upgradeState: "",
				compartmentRenderEpoch: null,
				lastBaselineEndMessageId: null,
				systemHash: "",
				modelKey: "",
				projectIdentity: state.projectIdentity,
				muralEnabled: false,
				renderBudgetIdentity: "",
			};

			db.prepare(
				"UPDATE memories SET status = 'archived', superseded_by_memory_id = ? WHERE id = ?",
			).run(replacement.id, source.id);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "superseded",
				targetMemoryId: source.id,
				supersededById: replacement.id,
				queuedAt: markers.materializedAt + 1,
			});

			const m1 = renderM1Pi(state, db, markers, [source.id]);
			expect(m1).toContain(
				`<superseded id="${source.id}" by="${replacement.id}"/>`,
			);
			expect(m1).toContain("Replacement content must render in the delta.");
			expect(m1).not.toContain(`<removed id="${source.id}"/>`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("skips memory mutation deltas for memories trimmed out of m0", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-trimmed-delta-"));
		try {
			const state = {
				...piState("ses-pi-m1-trimmed-delta", cwd),
				injectionBudgetTokens: 1,
			};
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "This memory is too large for a one-token m0 budget.",
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: memory.id,
				newContent: "Updated but not resident.",
				queuedAt: 10,
			});

			const bust = [userMessage("bust", 11)];
			injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
			expect(textOf(bust[1] as never)).not.toContain(
				"Updated but not resident.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("reconcile rematerialization advances the memory mutation cursor and omits memory-updates", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-reconcile-delta-"));
		try {
			const state = piState("ses-pi-m1-reconcile-delta", cwd);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Old baseline content.",
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			db.prepare(
				"UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
			).run("Reconciled content.", "reconciled-hash", Date.now(), memory.id);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: memory.id,
				newContent: "Reconciled content.",
				queuedAt: 10,
			});
			setProjectState(db, state.projectIdentity, { projectMemoryEpoch: 1 });

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(result.m0Materialized).toBe(true);
			expect(textOf(bust[0] as never)).toContain("Reconciled content.");
			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rolls back and replays a sibling cached m1 on marker mismatch", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS rejects byte-different m[0] even when non-doc markers match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-bytes-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-bytes", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);
			const siblingM0 = Buffer.from(
				`<session-history>${"byte mismatch ".repeat(300)}</session-history>`,
				"utf8",
			);
			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						siblingM0,
						Buffer.from("sibling cached pi m1 byte mismatch", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(siblingM0.toString("utf8"));
			expect(textOf(bust[1] as never)).toBe(
				"sibling cached pi m1 byte mismatch",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});

	it("soft m1 refresh CAS treats docs-hash-only marker drift as a match", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-soft-cas-docs-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-soft-cas-docs", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			const baselineM0 = textOf(first[0] as never);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi docs-hash-only CAS delta memory",
				sourceType: "agent",
			});
			let changedDocsMarker = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !changedDocsMarker) {
					changedDocsMarker = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_project_docs_hash = ? WHERE session_id = ?",
					).run("docs-only-marker-drift", state.sessionId);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(changedDocsMarker).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[0] as never)).toBe(baselineM0);
			expect(textOf(bust[1] as never)).toContain(
				"Pi docs-hash-only CAS delta memory",
			);
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (OpenCode parity)", () => {
	it("renders <project-memory> as a SIBLING after </session-history>, not nested inside it", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState("ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "The widget service owns rendering.",
				sourceType: "historian",
			});

			const m0 = renderM0Pi(state, db);

			// The <session-history> wrapper must close BEFORE <project-memory>
			// opens — they are siblings (matches OpenCode renderM0). A nested
			// layout (project-memory inside session-history) is the bug this
			// guards against: it would put different bytes on the wire than
			// OpenCode for identical state.
			const historyClose = m0.indexOf("</session-history>");
			const memoryOpen = m0.indexOf("<project-memory>");
			expect(historyClose).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(historyClose);
			expect(m0).toContain("<ARCHITECTURE>\n#");
			expect(m0).not.toContain("<memory id=");
			// Compartment body lives INSIDE <session-history>; memory does NOT.
			const historyBlock = m0.slice(
				m0.indexOf("<session-history>"),
				historyClose,
			);
			expect(historyBlock).toContain("Compacted setup");
			expect(historyBlock).not.toContain("widget service");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi binds maxMemoryId watermark to the rendered memory set", () => {
		// Regression for the round-7 HIGH: the persisted maxMemoryId watermark must
		// equal the max id of the memories actually rendered into m[0]. If it were
		// read separately (lower), a memory present in m[0] could also satisfy
		// "id > watermark" and render again in m[1] — duplicated across the split.
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-watermark-"));
		try {
			const state = piState("ses-pi-watermark", cwd);
			for (const content of [
				"The widget service owns rendering.",
				"Orders flow through an async queue.",
				"Sessions use stateless JWT.",
			]) {
				insertMemory(db, {
					projectPath: state.projectIdentity,
					category: "ARCHITECTURE",
					content,
					sourceType: "historian",
				});
			}
			const maxId = getMemoriesByProject(db, state.projectIdentity, [
				"active",
				"permanent",
			]).reduce((m, x) => (x.id > m ? x.id : m), 0);

			const { snapshotMarkers } = materializeM0Pi(state, db);

			expect(maxId).toBeGreaterThan(0);
			expect(snapshotMarkers.maxMemoryId).toBe(maxId);
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD fold binds memory expiry cutoff and materializedAt to one timestamp", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-d16c-"));
		try {
			const state = piState("ses-pi-d16c", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "KNOWN_ISSUES",
				content: "Pi D16c expiry-gap memory",
				expiresAt: 10_500,
			});
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi D16c permanent anchor",
			});

			const realNow = Date.now;
			const foldAt = 10_000;
			let nowCalls = 0;
			Date.now = () => {
				nowCalls += 1;
				return nowCalls === 1 ? foldAt : 99_000;
			};

			try {
				state.hardSignals = {
					systemHash: "fold-a",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const first = materializeM0Pi(state, db);
				expect(first.m0).toContain("Pi D16c expiry-gap memory");
				expect(first.snapshotMarkers.materializedAt).toBe(foldAt);

				nowCalls = 0;
				state.hardSignals = {
					systemHash: "fold-b",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const second = materializeM0Pi(state, db);
				expect(second.m0).toContain("Pi D16c expiry-gap memory");
				expect(
					second.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				).toBe(
					first.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				);
			} finally {
				Date.now = realNow;
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("mustMaterializePi — SOFT/HARD taxonomy (parity with OpenCode)", () => {
	const baseHard = {
		systemHash: "sys-v1",
		modelKey: "anthropic/opus",
		cacheExpired: false,
		lastResponseTime: 0,
	};

	function compartment(seq: number, body: string) {
		return {
			sequence: seq,
			startMessage: seq,
			endMessage: seq,
			startMessageId: `entry-${seq}`,
			endMessageId: `entry-${seq}`,
			title: `T${seq}`,
			content: body,
			p1: body,
		};
	}

	it("does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-newcomp-"));
		try {
			const state = {
				...piState("ses-pi-tax-newcomp", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			// Publish a new compartment — the routine historian publish.
			appendCompartments(db, state.sessionId, [compartment(1, "Bravo")]);
			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a model change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-"));
		try {
			const state = {
				...piState("ses-pi-tax-model", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			expect(mustMaterializePi(switched, db)).toMatchObject({
				value: true,
				reason: "model_change",
				mismatch: {
					signal: "modelKey",
					cached: "anthropic/opus",
					current: "anthropic/sonnet",
				},
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a system-hash change folds m[0]", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-sys-"));
		try {
			const state = {
				...piState("ses-pi-tax-sys", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			expect(mustMaterializePi(changed, db)).toMatchObject({
				value: true,
				reason: "system_hash",
				mismatch: {
					signal: "systemHash",
					cached: "sys-v1",
					current: "sys-v2",
				},
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("lazy-adopts a NULL cached project marker without a no-switch HARD fold", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-project-null-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-null-b-"));
		try {
			const state = {
				...piState("ses-pi-tax-project-null", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, ["entry-0"]);
			const baselineM0 = textOf(first[0] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			const noSwitch = [userMessage("same project", 11)];
			const noSwitchResult = injectM0M1Pi(state, db, noSwitch as never, [
				"entry-0",
			]);

			expect(noSwitchResult.m0Materialized).toBe(false);
			expect(noSwitchResult.m0Reason).not.toBe("first_render");
			expect(noSwitchResult.m0Reason).not.toBe("project_change");
			expect(textOf(noSwitch[0] as never)).toBe(baselineM0);
			expect(
				db
					.prepare(
						"SELECT cached_m0_project_identity FROM session_meta WHERE session_id = ?",
					)
					.get(state.sessionId),
			).toEqual({ cached_m0_project_identity: state.projectIdentity });

			const switched = {
				...piState(state.sessionId, cwdB),
				hardSignals: baseHard,
			};
			expect(mustMaterializePi(switched, db)).toMatchObject({
				value: true,
				reason: "project_change",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("HARD: a genuine same-session project switch folds exactly once, then stabilizes", () => {
		const db = createTestDb();
		const cwdA = mkdtempSync(join(tmpdir(), "pi-tax-project-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "pi-tax-project-b-"));
		try {
			const stateA = {
				...piState("ses-pi-tax-project-switch", cwdA),
				hardSignals: baseHard,
			};
			insertMemory(db, {
				projectPath: stateA.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project A memory must not replay after /cd.",
			});
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(stateA, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Project A memory");

			const stateB = {
				...piState(stateA.sessionId, cwdB),
				hardSignals: baseHard,
			};
			insertMemory(db, {
				projectPath: stateB.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project B memory is the switched project baseline.",
			});

			const switched = [userMessage("after cd", 11)];
			const switchedResult = injectM0M1Pi(
				stateB,
				db,
				switched as never,
				undefined,
				true,
			);
			expect(switchedResult.m0Materialized).toBe(true);
			expect(switchedResult.m0Reason).toBe("project_change");
			expect(textOf(switched[0] as never)).toContain("Project B memory");
			expect(textOf(switched[0] as never)).not.toContain("Project A memory");

			const stable = [userMessage("after cd stable", 12)];
			const stableResult = injectM0M1Pi(
				stateB,
				db,
				stable as never,
				undefined,
				false,
			);
			expect(stableResult.m0Materialized).toBe(false);
			expect(stableResult.m0Reason).toBeNull();
			expect(textOf(stable[0] as never)).toBe(textOf(switched[0] as never));
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("model and system changes materialize with classified reasons, not first_render", () => {
		const db = createTestDb();
		const cwdModel = mkdtempSync(join(tmpdir(), "pi-tax-model-reason-"));
		const cwdSystem = mkdtempSync(join(tmpdir(), "pi-tax-system-reason-"));
		try {
			const modelState = {
				...piState("ses-pi-tax-model-reason", cwdModel),
				hardSignals: baseHard,
			};
			injectM0M1Pi(modelState, db, [userMessage("hi", 10)] as never);
			const modelChanged = {
				...modelState,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			const modelPass = [userMessage("model", 11)];
			const modelResult = injectM0M1Pi(modelChanged, db, modelPass as never);
			expect(modelResult.m0Materialized).toBe(true);
			expect(modelResult.m0Reason).toBe("model_change");
			expect(modelResult.m0Reason).not.toBe("first_render");

			const systemState = {
				...piState("ses-pi-tax-system-reason", cwdSystem),
				hardSignals: baseHard,
			};
			injectM0M1Pi(systemState, db, [userMessage("hi", 10)] as never);
			const systemChanged = {
				...systemState,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const systemPass = [userMessage("system", 11)];
			const systemResult = injectM0M1Pi(systemChanged, db, systemPass as never);
			expect(systemResult.m0Materialized).toBe(true);
			expect(systemResult.m0Reason).toBe("system_hash");
			expect(systemResult.m0Reason).not.toBe("first_render");
		} finally {
			rmSync(cwdModel, { recursive: true, force: true });
			rmSync(cwdSystem, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("an empty current HARD signal is never treated as a change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-empty-"));
		try {
			const state = {
				...piState("ses-pi-tax-empty", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const unknown = {
				...state,
				hardSignals: {
					systemHash: "",
					modelKey: "",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			expect(mustMaterializePi(unknown, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT materialize m[0] on a project docs hash change", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-soft-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-soft", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi docs\n");
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				true,
			);

			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# New Pi docs\n");

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("folds current project docs on the next natural HARD materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-docs-hard-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-hard", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi architecture\n");
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, undefined, true);
			expect(textOf(first[0] as never)).toContain("Old Pi architecture");

			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# Updated Pi architecture\nFresh Pi docs folded on hard bust.\n",
			);
			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const second = [userMessage("hi again", 11)];
			const result = injectM0M1Pi(
				changed,
				db,
				second as never,
				undefined,
				true,
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("system_hash");
			expect(textOf(second[0] as never)).toContain("Updated Pi architecture");
			expect(textOf(second[0] as never)).toContain(
				"Fresh Pi docs folded on hard bust.",
			);
			expect(textOf(second[0] as never)).not.toContain("Old Pi architecture");
		} finally {
			closeQuietly(db);
		}
	});
	it("reproduces the copied live marker tuple and keeps three canonical-alias replays byte-identical", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-live-marker-repro-"));
		try {
			const state = {
				...piState("019de471-4fdc-762d-9286-624dfad0b5fe", cwd),
				projectIdentity: "git:f78f6db52b23c81d58dae3879c9383f550ec180e",
				injectionBudgetTokens: 15_000,
				historyBudgetTokens: 27_540,
				muralEnabled: true,
				hardSignals: {
					...baseHard,
					systemHash: "38b2cc92af20c9236054057c7da1a3df",
					modelKey: "openai-codex/gpt-5.6-sol",
				},
			};
			appendCompartments(db, state.sessionId, [
				{
					sequence: 417,
					startMessage: 417,
					endMessage: 417,
					startMessageId: "entry-417",
					endMessageId: "entry-417",
					title: "Cached production boundary",
					content: "cached production compartment",
					p1: "cached production compartment",
				},
			]);
			db.prepare(
				"INSERT INTO m0_mutation_log (id, session_id, mutation_type, target_id, queued_at) VALUES (15, ?, 'compartment_upgrade', NULL, 1)",
			).run(state.sessionId);
			const firstMessages = [userMessage("same quiet tail", 10)];
			injectM0M1Pi(state, db, firstMessages as never, ["entry-0"]);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 425,
					startMessage: 425,
					endMessage: 425,
					startMessageId: "entry-425",
					endMessageId: "entry-425",
					title: "Live additive compartment",
					content: "new m1-only content after the cached boundary",
					p1: "new m1-only content after the cached boundary",
				},
			]);
			const firstM0 = textOf(firstMessages[0] as never);
			const firstM1 = textOf(firstMessages[1] as never);
			const meta = getOrCreateSessionMeta(db, state.sessionId);
			expect(meta.cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
			expect(meta.cachedM0MaxCompartmentSeq).toBe(417);
			expect(meta.cachedM0MaxMutationId).toBe(15);
			expect(meta.cachedM0UpgradeState).toContain("mural-enabled:1");
			expect(meta.cachedM0UpgradeState).toContain(
				"render-budgets:m15000-h27540",
			);

			for (let pass = 0; pass < 3; pass += 1) {
				const messages = [userMessage("same quiet tail", 10)];
				const result = injectM0M1Pi(
					state,
					db,
					messages as never,
					["entry-0"],
					false,
				);
				expect(result.m0Materialized).toBe(false);
				expect(result.m0Reason).toBeNull();
				expect(textOf(messages[0] as never)).toBe(firstM0);
				expect(textOf(messages[1] as never)).toBe(firstM1);
			}

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
			expect(
				mustMaterializePi({ ...state, muralEnabled: undefined }, db),
			).toEqual({
				value: true,
				reason: "render_config",
				mismatch: { signal: "muralEnabled", cached: true, current: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-forward-"));
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-forward", cwd),
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			expect(mustMaterializePi(aliasOnly, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-reverse-"));
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-reverse", cwd),
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0ModelKey).toBe(
				"openai/gpt-5.6-sol",
			);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			expect(mustMaterializePi(aliasOnly, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when an existing cached baseline stores a native alias", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-upgrade-"));
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-upgrade", cwd),
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			db.prepare(
				"UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?",
			).run("openai-codex/gpt-5.6-sol", state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("folds exactly once for a genuinely different model in the same alias family", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tax-model-alias-real-switch-"));
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-real-switch", cwd),
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);

			const realSwitch = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-codex" },
			};
			expect(mustMaterializePi(realSwitch, db)).toMatchObject({
				value: true,
				reason: "model_change",
				mismatch: {
					signal: "modelKey",
					cached: "openai/gpt-5.6-sol",
					current: "openai/gpt-5.6-codex",
				},
			});
			const folded = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
			);
			const replay = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
			);
			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("model_change");
			expect(replay.m0Materialized).toBe(false);
			expect(replay.m0Reason).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi m[1]-rendered coverage watermark (marker-drain liveness)", () => {
	it("reports the m[1] delta watermark on a fresh recompute and null on pure replay", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-"));
		try {
			const state = piState("ses-pi-m1-coverage", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "first compartment body",
					p1: "first compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never, ["entry-0"]);
			expect(r0.m0Materialized).toBe(true);
			// The full materialization folds the compartment into m[0], so the
			// m[0] boundary covers it and the m[1] delta carries nothing beyond
			// the m[0] snapshot watermark.
			expect(r0.renderedBoundary.endMessageId).toBe("entry-0");
			expect(r0.m1RenderedCoverage).toBeNull();

			// Historian publishes a SECOND compartment — an m[1] delta; m[0] is
			// NOT re-materialized (new_compartment is not a HARD trigger).
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "second compartment body",
					p1: "second compartment body",
				},
			]);

			// Cache-busting pass: the soft refresh recomputes m[1] from the same
			// compartment snapshot and certifies the m[1] delta watermark at the
			// new compartment. (With a non-empty baseline the soft refresh also
			// advances the persisted trim boundary string, so the m[0] arm moves
			// too; the empty-baseline test below is the shape where ONLY the m[1]
			// field certifies coverage.)
			const secondPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			expect(r1.contentionExhausted).toBe(false);
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-1",
				ordinal: 2,
			});

			// Pure replay pass (recomputeM1ThisPass=false): the served bytes
			// were rendered by an earlier pass, so no fresh coverage may be
			// certified — the field must be null.
			const thirdPass = [
				userMessage("covered-0", 10),
				userMessage("covered-1", 11),
				userMessage("keep", 12),
			];
			const r2 = injectM0M1Pi(
				state,
				db,
				thirdPass as never,
				["entry-0", "entry-1", "keep"],
				false,
			);
			expect(r2.m0Materialized).toBe(false);
			expect(r2.m1RenderedCoverage).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("certifies coverage from the m[1] delta when the m[0] baseline is empty (the liveness-gap shape)", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-empty-"));
		try {
			const state = piState("ses-pi-m1-coverage-empty", cwd);
			// Materialize with NO compartments: the empty m[0] baseline whose
			// snapshot markers carry no compartment boundary at all.
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(state, db, firstPass as never);
			expect(r0.m0Materialized).toBe(true);
			expect(r0.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			expect(r0.m1RenderedCoverage).toBeNull();

			// A normal publication lands (three compartments, mirroring the
			// diagnosis: seq 0:1-2, 1:3-4, 2:5-7). It renders into m[1] only.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "A",
					content: "chunk a",
					p1: "chunk a",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 4,
					startMessageId: "entry-3",
					endMessageId: "entry-4",
					title: "B",
					content: "chunk b",
					p1: "chunk b",
				},
				{
					sequence: 2,
					startMessage: 5,
					endMessage: 7,
					startMessageId: "entry-5",
					endMessageId: "entry-7",
					title: "C",
					content: "chunk c",
					p1: "chunk c",
				},
			]);

			const secondPass = [userMessage("hello", 10), userMessage("tail", 12)];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-1", "keep"],
				true,
			);
			expect(r1.m0Materialized).toBe(false);
			// The m[0] arm still reads <none>, so it cannot by itself certify
			// coverage for the pending marker…
			expect(r1.renderedBoundary).toEqual({
				endMessageId: null,
				ordinal: null,
			});
			// …while the fresh m[1] delta certifies coverage up to the latest
			// published compartment, so a pending marker at ordinal 7 covers.
			expect(r1.m1RenderedCoverage).toEqual({
				endMessageId: "entry-7",
				ordinal: 7,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("soft m[1] refresh sibling-fallback reports null coverage even with a newer live compartment", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m1-coverage-sibling-"));
		const originalExec = db.exec.bind(db);
		try {
			const state = piState("ses-pi-m1-coverage-sibling", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				true,
			);

			// A newer compartment lands in the live snapshot. A naive coverage
			// derivation from live DB rows would certify it — but the stale
			// sibling bytes served below were rendered BEFORE it existed.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-2",
					title: "New",
					content: "new compartment body",
					p1: "new compartment body",
				},
			]);

			let injectedSibling = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedSibling) {
					injectedSibling = true;
					db.prepare(
						"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_max_memory_id = ?, cached_m1_bytes = ? WHERE session_id = ?",
					).run(
						Buffer.from(
							`<session-history>${"baseline ".repeat(300)}</session-history>`,
							"utf8",
						),
						99,
						Buffer.from("sibling cached m1", "utf8"),
						state.sessionId,
					);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(state, db, bust as never, undefined, true);

			expect(injectedSibling).toBe(true);
			expect(result.m0Materialized).toBe(false);
			expect(textOf(bust[1] as never)).toBe("sibling cached m1");
			// The sibling-fallback leaves contentionExhausted FALSE (recomputed=
			// false), so the existing contention veto does NOT catch it — the
			// coverage field itself must be null to keep the deferred drain
			// signal armed for the next fresh render.
			expect(result.contentionExhausted).toBe(false);
			expect(result.m1RenderedCoverage).toBeNull();
		} finally {
			db.exec = originalExec as typeof db.exec;
			closeQuietly(db);
		}
	});
});
