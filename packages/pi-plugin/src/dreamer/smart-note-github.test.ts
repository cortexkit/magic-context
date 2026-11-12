import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { DreamerConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	GITHUB_FAILURE_CHECK,
	GITHUB_FAILURE_CONDITION,
	githubPrivateResponses,
	githubRateLimitResponses,
} from "@magic-context/core/features/magic-context/smart-notes/__tests__/github-http-fixture.test";
import {
	localSmartNoteHttpTransport,
	timeoutTestDatabase,
} from "@magic-context/core/features/magic-context/smart-notes/__tests__/http-timeout-fixture.test";
import { __wakePlaneTest } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import {
	addNote,
	getNotes,
} from "@magic-context/core/features/magic-context/storage-notes";
import { __test, registerPiDreamerProject, runPiDreamForProject } from ".";

const PROJECT = "git:pi-smart-note-github";
const owner = {};
let fixture: ReturnType<typeof timeoutTestDatabase> | undefined;
let compilerCalls: number;
let disposeTransport: (() => Promise<void>) | undefined;

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
					return {
						ok: true,
						assistantText: JSON.stringify({
							compiled_check: GITHUB_FAILURE_CHECK,
							manifest: { capabilities: ["httpGet"] },
							check_cron: "*/15 * * * *",
						}),
					};
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
afterEach(async () => {
	await disposeTransport?.();
	disposeTransport = undefined;
	__test.reset();
	__wakePlaneTest.reset();
	// Setup can fail before the database fixture is assigned; preserve that original error.
	fixture?.dispose();
	fixture = undefined;
});

async function setup(
	response: { status: number; headers?: Record<string, string>; body: string },
	phase: string,
) {
	const transport = await localSmartNoteHttpTransport(
		"api.github.com",
		(_request, res) => {
			res.writeHead(response.status, response.headers ?? {});
			res.end(response.body);
		},
	);
	disposeTransport = transport.dispose;
	const note = addNote(fixture!.db, "smart", {
		projectPath: PROJECT,
		sessionId: "pi-owner",
		content: "wake on CI failure",
		surfaceCondition: GITHUB_FAILURE_CONDITION,
	});
	if (phase === "due")
		fixture!.db
			.prepare(`UPDATE notes SET compiled_check=?,
        check_status='compiled', policy_version=1, check_next_due_at=0 WHERE id=?`)
			.run(GITHUB_FAILURE_CHECK, note.id);
	return transport.paths;
}
function state() {
	return getNotes(fixture!.db, { type: "smart", projectPath: PROJECT })[0];
}

for (const response of githubRateLimitResponses(
	Math.floor(Date.now() / 1000) + 7200,
)) {
	test.each([
		"compile",
		"due",
	])(`Pi GitHub ${response.name} defers %s without owner warnings`, async (phase) => {
		const paths = await setup(response, phase);
		const startedAt = Date.now();
		await runPiDreamForProject(PROJECT, "evaluate-smart-notes", owner);
		expect(state()).toMatchObject({
			status: "pending",
			checkStatus: phase === "compile" ? "uncompiled" : "compiled",
			checkFailureCount: 0,
			checkNetworkFailureCount: 1,
			readyReason: null,
		});
		expect(state().checkNextDueAt).toBeGreaterThanOrEqual(
			response.name === "primary 403"
				? Number(response.headers["x-ratelimit-reset"]) * 1000
				: startedAt + response.delayMs,
		);
		expect(
			getNotes(fixture!.db, { type: "session", sessionId: "pi-owner" }),
		).toEqual([]);
		expect(paths).toHaveLength(1);
		expect(compilerCalls).toBe(phase === "compile" ? 1 : 0);
		await runPiDreamForProject(PROJECT, "evaluate-smart-notes", owner);
		expect(paths).toHaveLength(1);
	});
}
for (const response of githubPrivateResponses) {
	test.each([
		"compile",
		"due",
	])(`Pi private GitHub ${response.status} parks %s with one notice`, async (phase) => {
		await setup(response, phase);
		await runPiDreamForProject(PROJECT, "evaluate-smart-notes", owner);
		expect(state()).toMatchObject({
			status: "pending",
			checkStatus: "parked",
			checkNextDueAt: null,
		});
		expect(
			getNotes(fixture!.db, { type: "session", sessionId: "pi-owner" }),
		).toHaveLength(1);
	});
}
