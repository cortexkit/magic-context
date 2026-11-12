import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { DreamerConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	COMPILER_OUTPUT,
	timeoutTestDatabase,
	withLocalHttpServer,
} from "@magic-context/core/features/magic-context/smart-notes/__tests__/http-timeout-fixture.test";
import { __wakePlaneTest } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import {
	addNote,
	getNotes,
} from "@magic-context/core/features/magic-context/storage-notes";
import { __test, registerPiDreamerProject, runPiDreamForProject } from ".";

const PROJECT = "git:pi-smart-note-timeout";
const owner = {};
let fixture: ReturnType<typeof timeoutTestDatabase> | undefined;
let compilerCalls: number;

beforeEach(() => {
	fixture = timeoutTestDatabase();
	compilerCalls = 0;
	__wakePlaneTest.reset();
	__wakePlaneTest.setCatalogProbe(async () => []);
	__test.setStartDreamScheduleTimerFactory(async () => () => {});
	__test.setPiSubagentRunnerFactory(
		() =>
			({
				run: async ({ agent }: { agent: string }) => {
					expect(agent).toBe("smart-note-compiler");
					compilerCalls++;
					return { ok: true, assistantText: COMPILER_OUTPUT };
				},
			}) as never,
	);
	registerPiDreamerProject({
		db: fixture!.db,
		projectDir: tmpdir(),
		projectIdentity: PROJECT,
		registrationOwner: owner,
		harness: "pi",
		memoryEnabled: false,
		embeddingConfig: { provider: "off" },
		gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 },
		config: DreamerConfigSchema.parse({
			model: "test/model",
			tasks: { "evaluate-smart-notes": { schedule: "* * * * *" } },
		}),
	});
});
afterEach(() => {
	__test.reset();
	__wakePlaneTest.reset();
	// Setup can fail before the database fixture is assigned; preserve that original error.
	fixture?.dispose();
	fixture = undefined;
});

function source() {
	return addNote(fixture!.db, "smart", {
		projectPath: PROJECT,
		sessionId: "pi-owner",
		content: "watch remote",
		surfaceCondition: "remote resource becomes ready",
	});
}
function state() {
	return getNotes(fixture!.db, { type: "smart", projectPath: PROJECT })[0];
}
function run() {
	return runPiDreamForProject(PROJECT, "evaluate-smart-notes", owner);
}

test("Pi dreamer uses the shared sandbox for 3-second HTTP compile and evaluation", async () => {
	await withLocalHttpServer(3_000, async (requests) => {
		const note = source();
		await run();
		expect(state()).toMatchObject({
			checkStatus: "compiled",
			status: "pending",
			checkFailureCount: 0,
		});
		fixture!.db
			.prepare("UPDATE notes SET check_next_due_at=0 WHERE id=?")
			.run(note.id);
		await run();
		expect(state()).toMatchObject({
			checkStatus: "compiled",
			status: "pending",
			checkFailureCount: 0,
			checkNetworkFailureCount: 0,
		});
		expect(requests()).toBe(2);
		expect(compilerCalls).toBe(1);
	});
}, 20_000);

test("Pi HTTP deadlines retry compilation without fallback or owner notices", async () => {
	await withLocalHttpServer(null, async (requests) => {
		const note = source();
		for (let i = 0; i < 4; i++) {
			fixture!.db
				.prepare("UPDATE notes SET check_next_due_at=0 WHERE id=?")
				.run(note.id);
			const startedAt = Date.now();
			await run();
			expect(state()).toMatchObject({
				checkStatus: "uncompiled",
				status: "pending",
				checkFailureCount: 0,
				checkNetworkFailureCount: i + 1,
				readyReason: null,
			});
			expect(state().checkNextDueAt).toBeGreaterThanOrEqual(
				startedAt + 5 * 60_000,
			);
			expect(
				getNotes(fixture!.db, { type: "session", sessionId: "pi-owner" }),
			).toEqual([]);
		}
		expect(requests()).toBe(4);
		expect(compilerCalls).toBe(4);
	});
}, 30_000);
