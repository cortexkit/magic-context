import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { OpenCode } from "@opencode/client";
import { CANONICAL_DREAM_TASKS } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	assertOpenPaths,
	CLI,
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Issue 639: a read-only Magic Context background agent edited the user's
 * files on OpenCode 2.
 *
 * OpenCode 2 builds one plugin instance per location (directory) and runs each
 * session's hooks in the instance of that session's location, but it delivers
 * every location's events to every instance. The dreamer's turn trigger in
 * directory A reacted to a turn that ended in directory B and hung a map-memories
 * child under B's session. The child took B's location, so B's instance ran its
 * hooks, found no record of the run, and passed the bare run marker to the model
 * with B as the working tree and the user's own permissions: OpenCode appends the
 * user's global rules after the agent's, and the last matching rule wins.
 *
 * Every scenario here runs the real plugin in two directories of one host, with
 * a user config that allows `edit` and `shell`, and a mock provider that answers
 * a bare marker by calling both tools.
 */

const HIDDEN_AGENTS = [
	"historian",
	"dreamer-classifier",
	"dreamer",
	"dreamer-memory-mapper",
	"dreamer-primer-investigator",
	"dreamer-retrospective",
];
const MAP_PROMPT = "Then output ONE <mappings> manifest";

function hashTree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (name === ".git") continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else
				out[relative(root, path)] = createHash("sha256")
					.update(readFileSync(path))
					.digest("hex");
		}
	};
	walk(root);
	return out;
}

function dreamerConfig(disable = false): Record<string, unknown> {
	const tasks: Record<string, unknown> = {};
	for (const task of CANONICAL_DREAM_TASKS)
		tasks[task] = { schedule: task === "map-memories" ? "0 3 * * *" : "" };
	return { disable, tasks };
}

async function eventually(check: () => boolean, what: string, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(250);
	}
}

/** Two directories (A: the project with memories to map, B: another repository), both running Magic Context. */
async function twoDirectoryHost(options: { dreamerDisabledAtBoot?: boolean } = {}) {
	const fixture = isolation();
	const projectB = join(fixture.root, "infra-repo");
	mkdirSync(join(projectB, "infra"), { recursive: true });
	writeFileSync(join(projectB, "infra", "main.tf"), 'backend_ip = "10.0.0.1"\n');
	writeFileSync(join(fixture.cwd, "fact.txt"), "The fixture fact lives here.\n");
	for (const directory of [fixture.cwd, projectB])
		Bun.spawnSync(["git", "init", "-q", directory]);
	// The user's own global OpenCode config allows edits and shell commands.
	const userConfig = join(fixture.env.XDG_CONFIG_HOME!, "opencode");
	mkdirSync(userConfig, { recursive: true });
	writeFileSync(
		join(userConfig, "opencode.json"),
		JSON.stringify({
			permissions: [
				{ action: "edit", resource: "*", effect: "allow" },
				{ action: "shell", resource: "*", effect: "allow" },
			],
		}),
	);
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		magicContextConfig: { dreamer: dreamerConfig(options.dreamerDisabledAtBoot === true) },
	});
	copyFileSync(join(fixture.cwd, "opencode.json"), join(projectB, "opencode.json"));
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	await waitForPluginActive(client, fixture.cwd);
	await waitForPluginActive(client, projectB);
	const opened = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
	const dbPaths = opened
		.split("\n")
		.filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line))
		.map((line) => line.slice(1));
	expect(dbPaths.length).toBeGreaterThan(0);
	assertOpenPaths(dbPaths, host.root);
	console.log(
		`issue-639 host ${execFileSync(CLI, ["--version"], { encoding: "utf8" }).trim()} pid=${host.pid} lsof db=${JSON.stringify(dbPaths)}`,
	);
	// The identity the plugin derives for A, as each of its passes does.
	const identityA = resolveProjectIdentityForSession(fixture.cwd);
	if (!identityA) throw new Error("project A has no identity");
	if (options.dreamerDisabledAtBoot !== true)
		await eventually(
			() => readPluginLog(host.env).includes(`[dreamer] registered project ${identityA} (`),
			"directory A to register with the dream timer",
		);
	const memoryIds: number[] = [];
	/** Adds unmapped memories to A and makes its map-memories task due now. */
	const seedDueMapping = (count: number) => {
		const db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
			readwrite: true,
			fileMustExist: true,
		});
		try {
			for (let index = 0; index < count; index++)
				memoryIds.push(
					insertMemory(db as never, {
						projectPath: identityA,
						category: "ARCHITECTURE",
						content: `Fixture claim ${memoryIds.length} is recorded in fact.txt.`,
					}).id,
				);
			db.prepare(
				`INSERT INTO task_schedule_state (project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count)
				 VALUES (?, 'map-memories', NULL, ?, NULL, NULL, NULL, 0)
				 ON CONFLICT(project_path, task) DO UPDATE SET last_run_at = NULL, next_due_at = excluded.next_due_at,
				   schedule = NULL, last_status = NULL, last_error = NULL, retry_count = 0`,
			).run(identityA, Date.now() - 60_000);
		} finally {
			db.close();
		}
	};
	seedDueMapping(3);
	const mappedCount = () => {
		const read = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
			readonly: true,
			fileMustExist: true,
		});
		try {
			return (
				read
					.prepare(
						"SELECT COUNT(DISTINCT memory_id) AS count FROM memory_verifications WHERE memory_id IN (SELECT value FROM json_each(?))",
					)
					.get(JSON.stringify(memoryIds)) as { count: number }
			).count;
		} finally {
			read.close();
		}
	};
	return {
		host,
		client,
		projectA: fixture.cwd,
		projectB,
		identityA,
		memoryIds,
		mappedCount,
		seedDueMapping,
	};
}

/**
 * Answers a bare run marker the way the reporter's model did: by editing a
 * Terraform file and running a shell command. Counts what reached the provider.
 */
function scriptMock(
	host: Awaited<ReturnType<typeof spawnOpencode2>>,
	memoryIds: number[],
	options: { readFirst?: boolean } = {},
) {
	const seen = {
		raw: 0,
		shaped: 0,
		shapedTools: [] as string[][],
		toolOutputs: [] as string[],
	};
	host.mock.addMatcher((body) => {
		const text = JSON.stringify(body);
		const outputs = ((body.input as Array<{ type?: string; output?: string }>) ?? []).filter(
			(item) => item.type === "function_call_output",
		);
		if (text.includes(MAP_PROMPT)) {
			seen.shaped++;
			seen.shapedTools.push(
				((body.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name).sort(),
			);
			if (options.readFirst && outputs.length === 0)
				return {
					openaiOutput: [
						{
							type: "function_call",
							id: "fc_read_1",
							call_id: "read_1",
							name: "read",
							arguments: JSON.stringify({ path: "fact.txt" }),
						},
					],
					usage: { input_tokens: 10, output_tokens: 10 },
				};
			seen.toolOutputs.push(...outputs.map((item) => String(item.output)));
			return {
				text: `<mappings>${memoryIds.map((id) => `<memory id="${id}" files="fact.txt"/>`).join("")}</mappings>`,
				usage: { input_tokens: 10, output_tokens: 20 },
			};
		}
		if (text.includes("mc:hidden:")) {
			seen.raw++;
			seen.toolOutputs.push(...outputs.map((item) => String(item.output)));
			console.log(
				`issue-639 bare marker reached the provider: tools=${JSON.stringify(((body.tools as Array<{ name: string }>) ?? []).map((tool) => tool.name))}`,
			);
			if (outputs.length > 0)
				return {
					text: "I'm ready to help! What would you like to work on today?",
					usage: { input_tokens: 10, output_tokens: 5 },
				};
			return {
				openaiOutput: [
					{
						type: "function_call",
						id: `fc_edit_${seen.raw}`,
						call_id: `edit_${seen.raw}`,
						name: "edit",
						arguments: JSON.stringify({
							path: "infra/main.tf",
							oldString: "10.0.0.1",
							newString: "6.6.6.6",
						}),
					},
					{
						type: "function_call",
						id: `fc_shell_${seen.raw}`,
						call_id: `shell_${seen.raw}`,
						name: "shell",
						arguments: JSON.stringify({
							command: "echo pwned > pwned.txt",
							description: "fixture",
						}),
					},
				],
				usage: { input_tokens: 10, output_tokens: 10 },
			};
		}
		return null;
	});
	return seen;
}

async function endTurn(
	client: ReturnType<typeof OpenCode.make>,
	directory: string,
	title: string,
): Promise<string> {
	const session = await client.session.create({
		title,
		location: { directory },
		model: { providerID: "openai", id: "mock-model" },
	});
	await client.session.prompt({ sessionID: session.id, text: "hello" } as never);
	await client.session.wait({ sessionID: session.id } as never);
	return session.id;
}

test(
	"a turn ending in another directory starts no hidden run there, and no tool touches either project",
	async () => {
		const state = await twoDirectoryHost();
		const { host, client, projectA, projectB } = state;
		try {
			for (const agent of HIDDEN_AGENTS) {
				const info = (await client.agent.get({
					agentID: agent as never,
					location: { directory: projectA },
				})) as { data: { permissions: Array<{ action: string; resource: string; effect: string }> } };
				console.log(
					`issue-639 agent ${agent} permissions=${JSON.stringify(info.data.permissions.filter((rule) => rule.action !== "external_directory"))}`,
				);
			}
			const beforeA = hashTree(projectA);
			const beforeB = hashTree(projectB);
			const seen = scriptMock(host, state.memoryIds);
			// The user works in their other repository; the turn ends there.
			await endTurn(client, projectB, "infra work");
			// Give every instance's trigger time to react to the event, then
			// confirm the dreamer is still alive by ending a turn in A itself.
			await Bun.sleep(5_000);
			console.log(`issue-639 after foreign turn ${JSON.stringify(seen)}`);
			expect(existsSync(join(projectB, "pwned.txt"))).toBe(false);
			expect(hashTree(projectB)).toEqual(beforeB);
			expect(hashTree(projectA)).toEqual(beforeA);
			expect(readFileSync(join(projectB, "infra", "main.tf"), "utf8")).toBe(
				'backend_ip = "10.0.0.1"\n',
			);
			// No tool ran on behalf of a bare marker: any call that reached the host
			// came back as an error, never as a tool's own output.
			expect(seen.toolOutputs.filter((output) => !output.startsWith('{"error"'))).toEqual([]);
			// A's memories were not mapped by a run hung under B's session.
			expect(state.mappedCount()).toBe(0);
		} catch (error) {
			console.error(host.stderr(), readPluginLog(host.env));
			throw error;
		} finally {
			await host.stop();
		}
	},
	180_000,
);

test(
	"control: a map-memories run started in its own directory still reads with its allowlist and maps",
	async () => {
		const state = await twoDirectoryHost();
		const { host, client, projectA, projectB } = state;
		try {
			const beforeB = hashTree(projectB);
			const seen = scriptMock(host, state.memoryIds, { readFirst: true });
			await endTurn(client, projectA, "project work");
			await eventually(() => state.mappedCount() === state.memoryIds.length, "the mapping run");
			console.log(`issue-639 control ${JSON.stringify(seen)}`);
			expect(seen.raw).toBe(0);
			expect(seen.shaped).toBeGreaterThanOrEqual(2);
			// The host offered exactly the mapper's read-only tools.
			for (const tools of seen.shapedTools) expect(tools).toEqual(["glob", "grep", "read"]);
			// The allowed read ran and returned the file.
			expect(seen.toolOutputs.join("\n")).toContain("The fixture fact lives here.");
			expect(hashTree(projectB)).toEqual(beforeB);
			expect(readPluginLog(host.env)).not.toContain("hidden_prompt_unrecognized");
		} catch (error) {
			console.error(host.stderr(), readPluginLog(host.env));
			throw error;
		} finally {
			await host.stop();
		}
	},
	180_000,
);

test(
	"dreamer.disable takes effect without a restart, in both directions",
	async () => {
		const state = await twoDirectoryHost({ dreamerDisabledAtBoot: true });
		const { host, client, projectA } = state;
		const userConfig = join(host.env.XDG_CONFIG_HOME!, "cortexkit", "magic-context.jsonc");
		const setDisable = async (disable: boolean) => {
			const config = JSON.parse(readFileSync(userConfig, "utf8"));
			config.dreamer = { ...config.dreamer, disable };
			writeFileSync(userConfig, JSON.stringify(config, null, 2));
			// The config reader keys on mtime and size; let the edit be observable.
			await Bun.sleep(1_100);
		};
		try {
			const seen = scriptMock(host, state.memoryIds);
			// Off at boot: a finished turn starts nothing.
			await endTurn(client, projectA, "work while the dreamer is off");
			await Bun.sleep(5_000);
			expect(seen.shaped).toBe(0);
			expect(state.mappedCount()).toBe(0);

			// Turned on in the config: the next turn starts the dreamer and runs the due task.
			await setDisable(false);
			await endTurn(client, projectA, "work after turning it on");
			await eventually(() => state.mappedCount() === state.memoryIds.length, "the mapping run");
			const shapedWhileOn = seen.shaped;
			expect(shapedWhileOn).toBeGreaterThanOrEqual(1);

			// Turned off again, with new work due: nothing more runs.
			await setDisable(true);
			state.seedDueMapping(2);
			await endTurn(client, projectA, "work after turning it off again");
			await Bun.sleep(5_000);
			expect(seen.shaped).toBe(shapedWhileOn);
			expect(state.mappedCount()).toBe(state.memoryIds.length - 2);
		} catch (error) {
			console.error(host.stderr(), readPluginLog(host.env));
			throw error;
		} finally {
			await host.stop();
		}
	},
	180_000,
);
