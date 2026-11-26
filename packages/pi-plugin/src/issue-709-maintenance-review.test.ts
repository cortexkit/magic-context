import { expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import * as tickOutcome from "@magic-context/core/features/magic-context/dreamer/tick-failure";
import * as indexer from "@magic-context/core/features/magic-context/git-commits/indexer";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage-db";
import { setBootQuietPeriodForTests } from "@magic-context/core/plugin/boot-quiet";
import {
	_getDreamTimerStateForTests,
	_resetDreamTimerForTests,
	_setDreamTimerStagesForTests,
	startDreamScheduleTimer,
} from "@magic-context/core/plugin/dream-timer";
import { _resetHarnessForTesting } from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import { isolatedTestGitEnv } from "@magic-context/core/shared/test-git-env";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import { registerV2DreamScheduleTimer } from "../../plugin/src/v2/hooks/dream-timer";
import { __test, registerPiDreamerProject } from "./dreamer";

// Each adapter reaches the real process-wide timer, SQLite lease and git indexer.
// Ticks are driven manually; unrelated message-history maintenance is disabled.
for (const lane of ["OC1", "OC2", "Pi"] as const) {
	for (const enabled of [false, true]) {
		test(`issue 709 maintenance: ${lane} git=${enabled} embeds=off deduplicates repeated ticks`, async () => {
			const base = join(tmpdir(), "magic-context/issue-709-review");
			mkdirSync(base, { recursive: true });
			const root = createTestTempDirFromPath(
				join(base, `maintenance-${lane}-${enabled}-`),
			);
			const saved = { ...process.env };
			const disposers: Array<() => void | Promise<void>> = [];
			for (const key of [
				"HOME",
				"XDG_DATA_HOME",
				"XDG_CONFIG_HOME",
				"XDG_CACHE_HOME",
				"XDG_STATE_HOME",
				"MAGIC_CONTEXT_TEST_DATA_DIR",
				"MAGIC_CONTEXT_TEST_CONFIG_DIR",
				"MAGIC_CONTEXT_STORAGE_DIR",
			]) {
				const directory = join(root, key);
				process.env[key] = directory;
				mkdirSync(directory, { recursive: true });
			}
			process.env.OPENCODE_DB = join(root, "absent-opencode.db");
			process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "plugin.log");
			for (const args of [
				["init", "--quiet"],
				[
					"-c",
					"user.name=Review",
					"-c",
					"user.email=review@example.invalid",
					"commit",
					"--quiet",
					"--allow-empty",
					"-m",
					root,
				],
			]) {
				const result = Bun.spawnSync(["git", "-C", root, ...args], {
					env: isolatedTestGitEnv(),
					windowsHide: true,
				});
				if (result.exitCode) throw new Error(result.stderr.toString());
			}
			const config = MagicContextConfigSchema.parse({
				auto_update: false,
				embedding: { provider: "off" },
				historian: { disable: true },
				dreamer: { disable: true },
				memory: {
					enabled: true,
					git_commit_indexing: { enabled, since_days: 365, max_commits: 100 },
				},
			});
			mkdirSync(join(root, ".cortexkit"));
			writeFileSync(
				join(root, ".cortexkit/magic-context.jsonc"),
				JSON.stringify(config),
			);
			const db = openDatabase();
			if (!db) throw new Error("isolated maintenance database unavailable");
			const opened = db.prepare("PRAGMA database_list").all() as Array<{
				file: string;
			}>;
			// SQLite reports the resolved path, so on macOS a root under /var reads
			// back as /private/var. Compare against both spellings of the same folder.
			const realRoot = realpathSync(root);
			if (
				opened.some(
					(row) =>
						row.file &&
						!row.file.startsWith(`${root}/`) &&
						!row.file.startsWith(`${realRoot}/`),
				)
			)
				throw new Error("maintenance database escaped isolated root");
			const project = resolveProjectIdentityForSession(root);
			if (!project)
				throw new Error("isolated git project identity unavailable");
			const dreamer = config.dreamer;
			if (!dreamer)
				throw new Error("disabled dreamer configuration unavailable");
			let interval: (() => void) | undefined;
			const originalInterval = globalThis.setInterval;
			const timer = spyOn(globalThis, "setInterval").mockImplementation(((
				callback: () => void,
				ms: number,
				...args: unknown[]
			) => {
				if (ms === 15 * 60 * 1000) interval = callback;
				return originalInterval(callback, ms, ...args);
			}) as typeof setInterval);
			const realOutcome = tickOutcome.clearDreamerTickFailure;
			let finished: (() => void) | undefined;
			const outcome = spyOn(
				tickOutcome,
				"clearDreamerTickFailure",
			).mockImplementation((database) => {
				realOutcome(database);
				finished?.();
			});
			const calls = spyOn(indexer, "indexCommitsForProject");
			const logs = spyOn(logger, "log");
			const restoreStages = _setDreamTimerStagesForTests({
				runMessageHistoryMaintenance: async () => {},
			});
			setBootQuietPeriodForTests(3600000);
			async function tick() {
				const run = interval;
				if (!run) throw new Error("maintenance timer did not register");
				await new Promise<void>((resolve, reject) => {
					const deadline = setTimeout(
						() => reject(new Error("maintenance tick timed out")),
						10000,
					);
					finished = () => {
						clearTimeout(deadline);
						resolve();
					};
					run();
					run();
				});
				finished = undefined;
			}
			try {
				for (let duplicate = 0; duplicate < 2; duplicate++) {
					if (lane === "OC1") {
						const stop = await startDreamScheduleTimer({
							directory: root,
							projectIdentity: project,
							harness: "opencode",
							dreamerConfig: config.dreamer,
							memoryEnabled: true,
							embeddingConfig: config.embedding,
							gitCommitIndexing: config.memory.git_commit_indexing,
							ensureRegistered: async () => {},
						});
						if (stop) disposers.push(stop);
					} else if (lane === "OC2") {
						const registration = registerV2DreamScheduleTimer({
							directory: root,
							projectIdentity: project,
							config,
							dreamer: config.dreamer,
							liveConfig: () => config,
							executor: { capabilities: { tools: false } } as never,
							openReader: () => ({
								latestRootSessionInDirectory: () => undefined,
								close() {},
							}),
						});
						disposers.push(() => registration.dispose());
					} else {
						__test.setStartDreamScheduleTimerFactory(startDreamScheduleTimer);
						registerPiDreamerProject({
							registrationOwner: {},
							db,
							projectDir: root,
							projectIdentity: project,
							harness: "pi",
							config: dreamer,
							memoryEnabled: true,
							embeddingConfig: config.embedding,
							gitCommitIndexing: config.memory.git_commit_indexing,
							sampleDreamRun: () => ({
								dreamerConfig: config.dreamer,
								gitCommitIndexing: config.memory.git_commit_indexing,
							}),
						} as Parameters<typeof registerPiDreamerProject>[0]);
					}
				}
				expect(_getDreamTimerStateForTests().directories).toEqual([root]);
				await tick();
				await tick();
				if (enabled) {
					config.memory.git_commit_indexing.enabled = false;
					await tick();
				}
				expect(calls.mock.calls.length).toBe(enabled ? 1 : 0);
				expect(
					logs.mock.calls.filter(([line]) =>
						String(line).includes("[git-commits] sweep starting"),
					).length,
				).toBe(enabled ? 1 : 0);
				const rows = db
					.prepare(
						"SELECT count(*) AS n FROM git_commits WHERE project_path = ?",
					)
					.get(project) as { n: number };
				expect(rows.n).toBe(enabled ? 1 : 0);
				console.log(
					`MAINTENANCE709 ${JSON.stringify({ lane, enabled, ticks: enabled ? 3 : 2, sweeps: calls.mock.calls.length, rows: rows.n })}`,
				);
			} finally {
				__test.reset();
				for (const dispose of disposers.reverse()) await dispose();
				_resetDreamTimerForTests();
				restoreStages();
				logs.mockRestore();
				calls.mockRestore();
				outcome.mockRestore();
				timer.mockRestore();
				closeDatabase();
				_resetHarnessForTesting();
				process.env = saved;
				cleanupTestTempDir(root);
			}
		}, 20000);
	}
}
