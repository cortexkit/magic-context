import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { resolveProjectIdentityForSession } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import {
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * A hidden child the host compacts before its first step must still run.
 *
 * OpenCode 2 sizes a hidden child by what it can see: the carrier agent's
 * system prompt, the project's instructions, the tool definitions and the
 * one-line marker the child was prompted with. When that crosses the model's
 * compaction threshold, the host compacts the child before the first model
 * request and folds the marker's message into a `<conversation-checkpoint>`.
 * Magic Context used to answer that compaction with the user-session history
 * fold, so the hidden-child guard found no marker and refused every run with
 * `hidden_prompt_unrecognized` before the provider was reached.
 *
 * A small model window stands in for whatever pushes a real child over the
 * threshold, and the run is started the way the report did: `serve --service`
 * and `/ctx-dream map-memories` through the command API.
 */
const MAPPER_PROMPT = "memory mapper for the magic-context system";

async function eventually<T>(
	read: () => T | undefined,
	what: string,
	timeoutMs = 45_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

function withDb<T>(path: string, read: (db: Database) => T, readwrite = false): T {
	const db = readwrite
		? openTestDb(path, undefined, Database)
		: openTestDb(path, { readonly: true }, Database);
	try {
		return read(db);
	} finally {
		db.close();
	}
}

test("a hidden child compacted by OpenCode 2 before its first step runs its registered prompt", async () => {
	const fixture = isolation();
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		serviceMode: true,
		// The child's own sizing crosses this window's compaction threshold.
		modelContextLimit: 1300,
		magicContextConfig: {
			// Keep the settled child so the host's compaction rows remain inspectable.
			keep_subagents: true,
			dreamer: { tasks: { "map-memories": { schedule: "0 3 * * *" } } },
		},
	});
	const contextDb = join(host.env.MAGIC_CONTEXT_STORAGE_DIR as string, "context.db");
	const openCodeDb = gaDatabasePath(host.env.XDG_DATA_HOME as string, "latest", host.env);
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "dreamer probe",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		writeFileSync(join(host.cwd, "src-fixture.ts"), "export const fixture = true;\n");
		const memoryId = withDb(
			contextDb,
			(db) => {
				const now = Date.now();
				return Number(
					db
						.prepare(
							"INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'ARCHITECTURE', 'The fixture flag lives in src-fixture.ts', 'fixture-flag', ?, ?, ?, ?)",
						)
						.run(resolveProjectIdentityForSession(host.cwd, false), now, now, now, now)
						.lastInsertRowid,
				);
			},
			true,
		);
		host.mock.addMatcher((body) =>
			JSON.stringify(body).includes(MAPPER_PROMPT)
				? {
						text: `<mappings><memory id="${memoryId}" files="src-fixture.ts"/></mappings>`,
						usage: { input_tokens: 120, output_tokens: 20 },
					}
				: null,
		);

		await client.session.command({
			sessionID: session.id,
			name: "ctx-dream",
			text: "map-memories",
		});

		// The dreamer run made progress: the memory now has its mapping row.
		await eventually(
			() =>
				withDb(contextDb, (db) =>
					(
						db
							.prepare("SELECT COUNT(*) AS count FROM memory_verifications WHERE memory_id = ?")
							.get(memoryId) as { count: number }
					).count > 0
						? true
						: undefined,
				),
			"the map-memories run to record a mapping",
		);

		const log = readPluginLog(host.env);
		expect(log).not.toContain("hidden_prompt_unrecognized");
		expect(log).not.toContain("hidden child refused");

		// The path under test was taken: the host compacted the hidden child.
		const compactions = withDb(openCodeDb, (db) =>
			(
				db
					.prepare(
						"SELECT m.data FROM session_message m JOIN session_v2 s ON s.id = m.session_id WHERE m.type = 'compaction' AND json_extract(s.metadata, '$.magic_context') = 'hidden-run'",
					)
					.all() as Array<{ data: string }>
			).map((row) => JSON.parse(row.data) as { summary?: string; status?: string }),
		);
		expect(compactions.length).toBeGreaterThan(0);
        expect(withDb(openCodeDb, (db) => db.prepare("SELECT title FROM session_v2 WHERE json_extract(metadata, '$.magic_context') = 'hidden-run'").all())).toEqual([{ title: "Magic Context dreamer" }]);
		// Answered with the run's marker, never with a user-session history fold.
		for (const compaction of compactions) {
			expect(compaction.summary ?? "").toMatch(/^mc:hidden:[0-9a-f-]+:[0-9a-f-]+$/);
		}

		// The provider got the calibrated prompt alone: no placeholder, no checkpoint.
		const mapperRequests = host.mock
			.requests()
			.filter((request) => JSON.stringify(request.body).includes(MAPPER_PROMPT));
		expect(mapperRequests.length).toBeGreaterThan(0);
		for (const request of mapperRequests) {
			const body = JSON.stringify(request.body);
			expect(body).not.toContain("mc:hidden:");
			expect(body).not.toContain("conversation-checkpoint");
		}
	} catch (error) {
		console.error(host.stderr(), readPluginLog(host.env));
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);

