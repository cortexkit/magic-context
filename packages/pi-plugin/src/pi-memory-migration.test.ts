import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMemoryMigrationDone } from "@magic-context/core/features/magic-context/memory/memory-migration";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import type {
	SubagentRunner,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import { runPiMemoryMigration } from "./pi-memory-migration";

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
	prevDataHome = process.env.XDG_DATA_HOME;
	tempHome = mkdtempSync(join(tmpdir(), "mc-pi-memmig-"));
	process.env.XDG_DATA_HOME = tempHome;
	mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
	closeDatabase();
});

afterEach(() => {
	closeDatabase();
	if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevDataHome;
	rmSync(tempHome, { recursive: true, force: true });
});

function runnerReturning(assistantText: string): SubagentRunner {
	return {
		run: async (): Promise<SubagentRunResult> => ({
			ok: true,
			assistantText,
		}),
	};
}

/**
 * Records the model of every attempt and returns empty until the Nth call,
 * which returns valid migrated XML. Lets a test assert the exact escalation
 * order (which models are tried, in what sequence).
 */
function recordingRunner(succeedOnCall: number): {
	runner: SubagentRunner;
	models: string[];
} {
	const models: string[] = [];
	return {
		models,
		runner: {
			run: async (opts: { model?: string }): Promise<SubagentRunResult> => {
				models.push(opts.model ?? "<default>");
				return {
					ok: true,
					assistantText:
						models.length >= succeedOnCall ? MIGRATED_XML : "no migrated block",
				};
			},
		},
	};
}

const MIGRATED_XML = `<migrated>
<ARCHITECTURE>
* SSE client owns reconnection (external constraint).
</ARCHITECTURE>
<CONFIG_VALUES>
* reconnect cap: 8 attempts.
</CONFIG_VALUES>
</migrated>
<user_observations>
* User prefers terse communication.
</user_observations>`;

describe("Pi memory migration (E6c)", () => {
	it("re-evaluates memories into the 5-cat taxonomy and marks the project done", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "legacy arch fact",
		});
		insertMemory(db, {
			projectPath,
			category: "KNOWN_ISSUES",
			content: "legacy known issue",
		});

		const outcome = await runPiMemoryMigration({
			db,
			runner: runnerReturning(MIGRATED_XML),
			model: "test/model",
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
			userMemoriesEnabled: true,
		});

		expect(outcome.ran).toBe(true);
		const after = getMemoriesByProject(db, projectPath);
		expect(after.map((m) => m.category).sort()).toEqual([
			"ARCHITECTURE",
			"CONFIG_VALUES",
		]);
		expect(isMemoryMigrationDone(db, projectPath)).toBe(true);
	});

	it("is idempotent — a second run does not re-migrate", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "legacy arch fact",
		});

		// userMemoriesEnabled:true so the USER_* safety guard does not abort
		// (MIGRATED_XML contains a <user_observations> block).
		await runPiMemoryMigration({
			db,
			runner: runnerReturning(MIGRATED_XML),
			model: "test/model",
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
			userMemoriesEnabled: true,
		});
		const second = await runPiMemoryMigration({
			db,
			runner: runnerReturning(MIGRATED_XML),
			model: "test/model",
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
			userMemoriesEnabled: true,
		});
		expect(second.ran).toBe(false);
		expect(second.summary).toContain("already migrated");
	});

	it("does not wipe the pool when the model returns no usable output", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "keep me",
		});

		const outcome = await runPiMemoryMigration({
			db,
			runner: runnerReturning("garbage with no migrated block"),
			model: "test/model",
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
		});

		expect(outcome.ran).toBe(false);
		// Pool untouched, guard NOT set (so a later good run can still migrate).
		expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
		expect(isMemoryMigrationDone(db, projectPath)).toBe(false);
	});

	it("REFUSES to wipe the pool on a parsed-but-EMPTY <migrated> block (OpenCode parity)", async () => {
		// Root-cause regression (dogfood 2026-05-31): an empty <migrated></migrated>
		// block parses successfully but has 0 v2 memories. It must NOT delete the
		// pool and must NOT set the guard (so a retry with a real model can run).
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "keep me",
		});

		const outcome = await runPiMemoryMigration({
			db,
			runner: runnerReturning("<migrated>\n</migrated>"),
			model: "test/model",
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
			userMemoriesEnabled: true,
		});

		expect(outcome.ran).toBe(false);
		expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
		expect(isMemoryMigrationDone(db, projectPath)).toBe(false);
	});

	it("chain = [primaryModel, ...fallbackModels] — does NOT insert the historian model between them (OpenCode parity)", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "legacy arch fact",
		});

		// Primary (session model) returns empty → must escalate straight to the
		// configured fallback, NOT to deps.model (the historian). A regression
		// that re-inserted the historian as an always-present 2nd element would
		// make models = [session, historian, fallback] and diverge from OpenCode.
		const { runner, models } = recordingRunner(2);
		const outcome = await runPiMemoryMigration({
			db,
			runner,
			primaryModel: "session/main-model",
			model: "historian/model",
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
			userMemoriesEnabled: true,
		});

		// The escalation ORDER is the assertion: primary (empty) → fallback,
		// with the historian model NEVER inserted between them.
		expect(models).toEqual([
			"session/main-model",
			"anthropic/claude-sonnet-4-6",
		]);
		expect(models).not.toContain("historian/model");
		expect(outcome.ran).toBe(true);
	});

	it("chain head falls back to the historian model when no primaryModel is given", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "legacy arch fact",
		});

		const { runner, models } = recordingRunner(1);
		await runPiMemoryMigration({
			db,
			runner,
			model: "historian/model",
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
			directory: process.cwd(),
			sessionId: "ses-pi-mig",
		});

		// No primary → historian model is the chain head (mirrors OpenCode's
		// `primaryModelId ?? undefined` falling through to the agent default).
		expect(models[0]).toBe("historian/model");
	});

	it("cancellation stops the fallback chain before applying memory changes", async () => {
		const db = openDatabase();
		const projectPath = resolveProjectIdentity(process.cwd());
		insertMemory(db, {
			projectPath,
			category: "ARCHITECTURE_DECISIONS",
			content: "keep me",
		});
		const controller = new AbortController();
		let calls = 0;
		let observedSignal: AbortSignal | undefined;
		const outcome = await runPiMemoryMigration({
			db,
			runner: {
				run: async (options: { signal?: AbortSignal }) => {
					calls += 1;
					observedSignal = options.signal;
					controller.abort();
					return { ok: true, assistantText: "no migrated block" };
				},
			} as never,
			model: "historian/model",
			fallbackModels: ["fallback/model"],
			directory: process.cwd(),
			sessionId: "ses-pi-mig-cancel",
			signal: controller.signal,
		});

		expect(outcome.summary).toContain("cancelled");
		expect(observedSignal).toBe(controller.signal);
		expect(calls).toBe(1);
		expect(getMemoriesByProject(db, projectPath)).toHaveLength(1);
		expect(isMemoryMigrationDone(db, projectPath)).toBe(false);
	});
});
