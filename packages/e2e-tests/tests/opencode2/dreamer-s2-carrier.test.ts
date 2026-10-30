import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	type RpcPortFileRecord,
	rpcPortDir,
} from "../../../plugin/src/shared/rpc-utils";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Three Dreamer tasks were filtered off OpenCode 2 as if they needed a tool
 * loop. They do not: `review-user-memories` answers with one JSON verdict,
 * `evaluate-smart-notes` compiles and confirms with no-tool prompts, and
 * `promote-primers` is database work with no model call at all.
 *
 * This runs them on the pinned real host against the mock provider and checks
 * the thing that actually matters — the database effect — plus the fail-closed
 * rule that a cut-short answer applies nothing.
 */
const REVIEW_PROMPT_MARKER = "Review User Memory Candidates";
const COMPILER_PROMPT_MARKER = "Compile this smart note condition into a sandbox check";

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
		await Bun.sleep(100);
	}
}

function contextDbPath(env: NodeJS.ProcessEnv): string {
	return join(
		env.XDG_DATA_HOME as string,
		"cortexkit",
		"magic-context",
		"context.db",
	);
}

function readContextDb<T>(env: NodeJS.ProcessEnv, read: (db: Database) => T): T {
	const db = openTestDb(contextDbPath(env), {
		readonly: true,
		fileMustExist: true,
	}, Database);
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function writeContextDb(env: NodeJS.ProcessEnv, write: (db: Database) => void): void {
	const db = openTestDb(contextDbPath(env), {
		readwrite: true,
		fileMustExist: true,
	}, Database);
	try {
		write(db);
	} finally {
		db.close();
	}
}

function activeUserMemories(env: NodeJS.ProcessEnv): string[] {
	return readContextDb(env, (db) =>
		(
			db
				.prepare(
					"SELECT content FROM user_memories WHERE status = 'active' ORDER BY id",
				)
				.all() as Array<{ content: string }>
		).map((row) => row.content),
	);
}

function candidateCount(env: NodeJS.ProcessEnv): number {
	return readContextDb(
		env,
		(db) =>
			(
				db
					.prepare("SELECT COUNT(*) AS count FROM user_memory_candidates")
					.get() as { count: number }
			).count,
	);
}

/** Completed dreamer runs for one task, newest first, as recorded telemetry. */
function dreamRunsFor(env: NodeJS.ProcessEnv, task: string): string[] {
	return readContextDb(env, (db) =>
		(
			db
				.prepare("SELECT tasks_json FROM dream_runs ORDER BY id DESC")
				.all() as Array<{ tasks_json: string }>
		)
			.map((row) => row.tasks_json)
			.filter((json) => json.includes(`"${task}"`)),
	);
}

async function rpcDiscovery(
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<RpcPortFileRecord> {
	const storageDir = join(
		env.XDG_DATA_HOME as string,
		"cortexkit",
		"magic-context",
	);
	return eventually(() => {
		const directory = rpcPortDir(storageDir, cwd);
		if (!existsSync(directory)) return undefined;
		const file = readdirSync(directory).find(
			(name) => name.startsWith("port-") && name.endsWith(".json"),
		);
		return file
			? (JSON.parse(
					readFileSync(join(directory, file), "utf8"),
				) as RpcPortFileRecord)
			: undefined;
	}, "the v2 RPC discovery file");
}

test("reclassified Dreamer tasks run on OpenCode 2 through the hidden carrier", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-dreamer.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	let reviewAnswer: {
		text: string;
		usage: { input_tokens: number; output_tokens: number };
		stop_reason?: "end_turn" | "max_tokens";
	} = {
		text: '{"promote":[{"content":"Prefers short, direct answers","candidate_ids":[1,2,3]}],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1,2,3]}',
		usage: { input_tokens: 120, output_tokens: 40 },
	};
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		// The Anthropic wire shape is the one whose mock honours a max-tokens stop
		// reason, which is how the cut-short answer below reaches the host as a
		// length-capped assistant row.
		providerID: "anthropic",
		magicContextConfig: {
			dreamer: {
				tasks: {
					"review-user-memories": { schedule: "0 3 * * *" },
					"promote-primers": { schedule: "0 4 * * *" },
					"evaluate-smart-notes": { schedule: "0 5 * * *" },
				},
			},
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "dreamer carrier",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher((body) =>
			JSON.stringify(body).includes(REVIEW_PROMPT_MARKER) ? reviewAnswer : null,
		);

		// Seed three candidate observations so the reviewer's default promotion
		// threshold is met and the task has real work to do rather than skipping.
		writeContextDb(host.env, (db) => {
			const insert = db.prepare(
				"INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES (?, ?, ?)",
			);
			insert.run("User asks for short answers", "seed-session-a", Date.now());
			insert.run("User dislikes long preambles", "seed-session-b", Date.now());
			insert.run("User wants the answer first", "seed-session-c", Date.now());
		});
		expect(candidateCount(host.env)).toBe(3);

		const discovery = await rpcDiscovery(host.env, host.cwd);
		const dream = async (task: string): Promise<{ ok: boolean; error?: string }> => {
			const response = await fetch(
				`http://127.0.0.1:${discovery.port}/rpc/dream`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${discovery.token}`,
					},
					body: JSON.stringify({ sessionId: session.id, task }),
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()) as { ok: boolean; error?: string };
		};

		// review-user-memories: a no-tool JSON verdict delivered by the carrier.
		expect(await dream("review-user-memories")).toMatchObject({ ok: true });
		const promoted = await eventually(() => {
			const memories = activeUserMemories(host.env);
			return memories.length > 0 ? memories : undefined;
		}, "the reviewer's promotion to reach the database");
		expect(promoted).toEqual(["Prefers short, direct answers"]);
		expect(candidateCount(host.env)).toBe(0);
		// The answer came from the carrier's hidden child, which is a session the
		// host owns, not a tool-looping child session of the user's.
		const reviewRequests = host.mock
			.requests()
			.filter((request) =>
				JSON.stringify(request.body).includes(REVIEW_PROMPT_MARKER),
			);
		expect(reviewRequests.length).toBeGreaterThan(0);
		expect(reviewRequests[0]?.body.tools).toBeUndefined();

		// promote-primers: host-side database work. It must complete without the
		// model being asked anything at all.
		const requestsBefore = host.mock.requests().length;
		expect(await dream("promote-primers")).toMatchObject({ ok: true });
		const promotionRuns = await eventually(() => {
			const runs = dreamRunsFor(host.env, "promote-primers");
			return runs.length > 0 ? runs : undefined;
		}, "a recorded promote-primers run");
		expect(promotionRuns[0]).not.toContain('"error"');
		expect(host.mock.requests().length).toBe(requestsBefore);

		// evaluate-smart-notes: a no-tool compiler prompt whose output runs in the
		// local capability sandbox, never as model tools.
		const projectPath = readContextDb(
			host.env,
			(db) =>
				(
					db.prepare("SELECT project_path FROM dream_runs LIMIT 1").get() as {
						project_path: string;
					}
				).project_path,
		);
		writeContextDb(host.env, (db) => {
			const now = Date.now();
			db.prepare(
				"INSERT INTO notes (type, status, content, project_path, surface_condition, created_at, updated_at) VALUES ('smart', 'pending', ?, ?, ?, ?, ?)",
			).run(
				"Remember to bump the changelog",
				projectPath,
				"the repository has a CHANGELOG.md entry for the next release",
				now,
				now,
			);
		});
		host.mock.addMatcher((body) =>
			JSON.stringify(body).includes(COMPILER_PROMPT_MARKER)
				? {
						text: JSON.stringify({
							compiled_check: "function check(cap) { return { met: false }; }",
							manifest: { capabilities: [], summary: "no capabilities" },
							check_cron: "0 * * * *",
						}),
						usage: { input_tokens: 90, output_tokens: 30 },
					}
				: null,
		);
		expect(await dream("evaluate-smart-notes")).toMatchObject({ ok: true });
		const compiled = await eventually(() => {
			const row = readContextDb(
				host.env,
				(db) =>
					db
						.prepare(
							"SELECT compiled_check, check_cron FROM notes WHERE type = 'smart'",
						)
						.get() as { compiled_check: string | null; check_cron: string | null },
			);
			return row?.compiled_check ? row : undefined;
		}, "the compiled smart-note check to be stored");
		expect(compiled.compiled_check).toContain("function check(cap)");
		expect(compiled.check_cron).toBe("0 * * * *");

		// A cut-short answer must apply nothing. Seed a fresh candidate, answer
		// with a complete-looking body that the host reports as length-capped, and
		// require the user-memory pool to be untouched.
		writeContextDb(host.env, (db) => {
			const insert = db.prepare(
				"INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES (?, ?, ?)",
			);
			insert.run("User prefers bullet lists", "seed-session-d", Date.now());
			insert.run("User skips the preamble", "seed-session-e", Date.now());
			insert.run("User wants numbers up front", "seed-session-f", Date.now());
		});
		reviewAnswer = {
			text: '{"promote":[{"content":"TRUNCATED PREFIX MUST NOT APPLY","candidate_ids":[4,5,6]}],"consume_candidate_ids":[4,5,6]}',
			usage: { input_tokens: 120, output_tokens: 40 },
			stop_reason: "max_tokens",
		};
		const runsBeforeTruncation = dreamRunsFor(
			host.env,
			"review-user-memories",
		).length;
		expect(await dream("review-user-memories")).toMatchObject({ ok: true });
		await eventually(
			() =>
				dreamRunsFor(host.env, "review-user-memories").length >
				runsBeforeTruncation
					? true
					: undefined,
			"the length-capped review run to be recorded",
		);
		expect(activeUserMemories(host.env)).toEqual([
			"Prefers short, direct answers",
		]);
		expect(candidateCount(host.env)).toBe(3);
		// Say WHY it applied nothing. Without this the assertions above would also
		// hold if the run had simply never started.
		expect(dreamRunsFor(host.env, "review-user-memories")[0]).toContain(
			"returned length-capped output",
		);
	} catch (error) {
		console.error(
			host.stderr(),
			existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no plugin log)",
			JSON.stringify(dreamRunsFor(host.env, "review-user-memories")),
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);
