import { openTestDb } from "../../src/test-db";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

async function runTurns(gitRepo: boolean) {
	const fixture = isolation();
	if (gitRepo) {
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: fixture.cwd,
				env: {
					PATH: process.env.PATH,
					HOME: fixture.root,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "e2e",
					GIT_AUTHOR_EMAIL: "e2e@example.invalid",
					GIT_COMMITTER_NAME: "e2e",
					GIT_COMMITTER_EMAIL: "e2e@example.invalid",
				},
				encoding: "utf8",
			}).trim();
		git("init", "-q");
		git("commit", "-q", "--allow-empty", "-m", "root");
	}
	const host = await spawnOpencode2({ existingIsolation: fixture });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher(() => ({
			text: "Done.",
			usage: { input_tokens: 100, output_tokens: 10 },
		}));
		for (const text of ["First turn.", "Second turn.", "Third turn."]) {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(20000) },
			);
		}
		const hostStore = new Database(
			join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!),
			{ readonly: true },
		);
		let hostDirectory: string | undefined;
		try {
			hostDirectory = (
				hostStore
					.query("SELECT directory FROM session_v2 WHERE id = ?")
					.get(session.id) as { directory: string } | null
			)?.directory;
		} finally {
			hostStore.close();
		}
		const db = openTestDb(
			join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
			{ readonly: true },
		);
		const logPath = host.env.MAGIC_CONTEXT_LOG_PATH!;
		try {
			return {
				sessionID: session.id,
				hostDirectory,
				cwd: host.cwd,
				logMentionsSession:
					existsSync(logPath) && readFileSync(logPath, "utf8").includes(session.id),
				rows: db
					.query(
						"SELECT session_id, harness, project_path FROM session_projects",
					)
					.all() as Array<{
					session_id: string;
					harness: string;
					project_path: string;
				}>,
			};
		} finally {
			db.close();
		}
	} finally {
		await host.stop();
	}
}

// The Dashboard's Projects page groups sessions by the session-to-project
// binding in `session_projects`. OpenCode 2 exposes no SDK client to plugins, so
// the binding must come from the host's own session row; without it every
// OpenCode 2 session is projectless and the Projects page stays empty.
test("OpenCode 2 records the session's project binding for a non-git directory", async () => {
	const result = await runTurns(false);
	expect(result.hostDirectory).toBe(result.cwd);
	expect(result.rows).toHaveLength(1);
	expect(result.rows[0]).toMatchObject({
		session_id: result.sessionID,
		harness: "opencode2",
	});
	expect(result.rows[0]!.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
	expect(result.logMentionsSession).toBe(true);
}, 120000);

test("OpenCode 2 records the session's project binding for a git repository", async () => {
	const result = await runTurns(true);
	expect(result.hostDirectory).toBe(result.cwd);
	expect(result.rows).toHaveLength(1);
	expect(result.rows[0]).toMatchObject({
		session_id: result.sessionID,
		harness: "opencode2",
	});
	expect(result.rows[0]!.project_path).toMatch(/^git:[0-9a-f]{40}$/);
}, 120000);
