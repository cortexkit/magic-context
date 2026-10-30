import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { getDreamRuns } from "../../../plugin/src/features/magic-context/dreamer/storage-dream-runs";
import { CANONICAL_DREAM_TASKS } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	inspectOpenFiles,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Issue 627: on OpenCode 2 the dreamer's schedule timer never started.
 *
 * OpenCode 1 registers the timer from its `server` lane; OpenCode 2 only calls
 * `setup`, so due tasks ran only after a session turn ended, never on their
 * schedule. This boots the real host, opens one session and sends nothing in
 * it (no turn, so the session-turn trigger cannot fire), makes one task due,
 * and waits for the timer's own startup pass to dispatch it.
 *
 * The task is the user-memory review: it needs a child session, so the run also
 * proves that a timer-started run (which has no triggering session) finds the
 * session in this directory to hang its child under.
 */

const SCHEDULED_TASK = "review-user-memories";
const REVIEW_PROMPT_MARKER = "Review User Memory Candidates";
/** The timer's first pass waits out the 120 s boot-quiet period. */
const TICK_WAIT_MS = 240_000;

function dreamerConfig(): Record<string, unknown> {
	const tasks: Record<string, unknown> = {};
	for (const task of CANONICAL_DREAM_TASKS) {
		tasks[task] = { schedule: task === SCHEDULED_TASK ? "0 3 * * *" : "" };
	}
	return { disable: false, tasks };
}

function contextDbPath(env: NodeJS.ProcessEnv): string {
	return join(env.XDG_DATA_HOME as string, "cortexkit", "magic-context", "context.db");
}

function withContextDb<T>(env: NodeJS.ProcessEnv, use: (db: Database) => T): T {
	const db = openTestDb(contextDbPath(env), { readwrite: true, fileMustExist: true }, Database);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		return use(db);
	} finally {
		db.close();
	}
}

async function eventually<T>(
	read: () => T | undefined,
	what: string,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(1_000);
	}
}

test(
	"the schedule timer dispatches a due dream task on OpenCode 2 with no session activity",
	async () => {
		const host = await spawnOpencode2({
			magicContextConfig: { dreamer: dreamerConfig() },
		});
		try {
			const client = OpenCode.make({
				baseUrl: host.url,
				headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
			});
			// The session a timer-started run hangs its child under. No prompt is
			// sent to it, so no turn ever ends and the turn trigger stays idle.
			const session = await client.session.create({
				title: "idle session",
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(client, host.cwd);
			host.mock.addMatcher((body) =>
				JSON.stringify(body).includes(REVIEW_PROMPT_MARKER)
					? {
							text: '{"promote":[{"content":"Prefers short, direct answers","candidate_ids":[1,2,3]}],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1,2,3]}',
							usage: { input_tokens: 120, output_tokens: 40 },
						}
					: null,
			);

			// The v2 lane registered this location's project with the timer.
			const registered = await eventually(() => {
				const match = readPluginLog(host.env).match(/\[dreamer\] registered project (\S+) \(/);
				return match?.[1];
			}, "the v2 lane to register its project with the schedule timer");
			expect(readPluginLog(host.env)).toContain("[dreamer] started independent schedule timer");

			const requestsBeforeTick = host.mock.requests().length;
			withContextDb(host.env, (db) => {
				// One memory keeps the project from being pruned as idle; three
				// candidates meet the review's default promotion threshold.
				insertMemory(db as never, {
					projectPath: registered,
					category: "ARCHITECTURE",
					content: "The project keeps its schedule in one place.",
				});
				const candidate = db.prepare(
					"INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES (?, ?, ?)",
				);
				candidate.run("User asks for short answers", "seed-session-a", Date.now());
				candidate.run("User dislikes long preambles", "seed-session-b", Date.now());
				candidate.run("User wants the answer first", "seed-session-c", Date.now());
				db.prepare(
					`INSERT INTO task_schedule_state
						 (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count)
					 VALUES (?, ?, NULL, ?, NULL, NULL, NULL, 0)
					 ON CONFLICT(project_path, task) DO UPDATE SET
						 last_run_at = NULL, next_due_at = excluded.next_due_at, schedule = NULL,
						 last_status = NULL, last_error = NULL, retry_count = 0`,
				).run(registered, SCHEDULED_TASK, Date.now() - 60_000);
			});

			// Nothing but the timer can run the task now.
			const run = await eventually(
				() =>
					withContextDb(host.env, (db) =>
						getDreamRuns(db, registered).find((row) =>
							row.tasks_json.includes(`"${SCHEDULED_TASK}"`),
						),
					),
				"the timer to dispatch the due task",
				TICK_WAIT_MS,
			);

			// The host process only ever held throwaway paths while the run ran.
			if (host.pid) inspectOpenFiles(host.pid, host.root, host.env);

			const task = JSON.parse(run.tasks_json)[0] as { name: string; status: string };
			expect(task).toMatchObject({ name: SCHEDULED_TASK, status: "completed" });
			expect(run.tasks_failed).toBe(0);
			// The child session was parented to the idle session in this directory.
			const parent = withContextDb(host.env, (db) =>
				db
					.prepare("SELECT parent_session_id FROM dream_runs WHERE id = ?")
					.get(run.id),
			);
			expect(parent).toEqual({ parent_session_id: session.id });
			// The review's answer reached the database through the timer's run.
			const promoted = withContextDb(host.env, (db) =>
				(
					db
						.prepare("SELECT content FROM user_memories WHERE status = 'active'")
						.all() as Array<{ content: string }>
				).map((row) => row.content),
			);
			expect(promoted).toEqual(["Prefers short, direct answers"]);
			expect(host.mock.requests().length).toBeGreaterThan(requestsBeforeTick);

			// The schedule timer, not the turn trigger, ran it.
			const log = await eventually(() => {
				const content = readPluginLog(host.env);
				return content.includes(`timer tick (startup) ${registered} — ran 1 task(s)`)
					? content
					: undefined;
			}, "the timer's own record of the run");
			expect(log).toContain(`timer tick (startup) ${registered} — ran 1 task(s)`);
		} catch (error) {
			console.error(host.stderr(), readPluginLog(host.env));
			throw error;
		} finally {
			await host.stop();
		}
	},
	TICK_WAIT_MS + 120_000,
);
