import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	CLI,
	inspectOpenFiles,
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
	waitForPluginLog,
} from "../../src/opencode2-runner/spawn";

const HOST_VERSION = JSON.parse(
	readFileSync(join(realpathSync(CLI), "..", "..", "package.json"), "utf8"),
).version as string;
const [major, minor, patch] = HOST_VERSION.split(".").map(Number);
const supportedHost =
	major! > 2 || (major === 2 && (minor! > 0 || patch! >= 24));
const MODEL = "claude-opus-5-5";
const MARKER = "HELD-THINKING-LOOP";
// Cache breakpoints move with the growing tail; compare the actual prompt content.
const bytes = (value: unknown) =>
	JSON.stringify(value, (key, item) =>
		key === "cache_control" ? undefined : item,
	);
const sha = (value: unknown) =>
	createHash("sha256").update(bytes(value)).digest("hex");
// Every step is heavy: OpenCode 2 records no reasoning-token count, so the
// thinking text itself must estimate above 1,500 tokens for the bounded
// signed-thinking hold to apply at 66% (below the 75% cap).
const thinking = (n: number) => ({
	type: "thinking",
	thinking: `Thought ${n} ${"weighing the next step carefully ".repeat(400)}`,
	signature: `sig-${n}`,
});
type Body = {
	model?: string;
	system?: unknown;
	messages?: unknown[];
	tools?: Array<{ name: string }>;
};

// Run this same real-host scenario against a before/after plugin build. The mock
// reports 66% usage after ctx_reduce, inside the signed thinking tool loop.
test.skipIf(!supportedHost)(
	"OC2 execute-threshold thinking loop holds the prefix through a next user until explicit flush",
	async () => {
		const version = HOST_VERSION;
		expect(supportedHost).toBe(true);
		const fixture = isolation();
		fixture.env.TMPDIR = join(fixture.root, "tmp");
		mkdirSync(fixture.env.TMPDIR);
		const host = await spawnOpencode2({
			existingIsolation: fixture,
			providerID: "anthropic",
			defaultModelID: MODEL,
			modelContextLimit: 100_000,
			modelOutputLimit: 1024,
			compactionAuto: false,
			magicContextConfig: {
				cache_ttl: "13h",
				protected_tokens: 4000,
				execute_threshold_percentage: 65,
				clear_reasoning_age: 1000,
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
		});
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const contextDb = () => {
			const db = openTestDb(
				join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
			);
			db.exec("PRAGMA busy_timeout = 10000");
			return db;
		};
		let step = 0;
		let queued: number[] = [];
		try {
			const session = await client.session.create({
				title: "held thinking prefix",
				location: { directory: host.cwd },
				model: { providerID: "anthropic", id: MODEL },
			});
			await waitForPluginActive(client, host.cwd);
			const openDatabases = inspectOpenFiles(
				host.pid!,
				host.root,
				host.env,
			).filter((path) => /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path));
			expect(openDatabases.length).toBeGreaterThan(0);
			expect(openDatabases.every((path) => path.startsWith(host.root))).toBe(
				true,
			);
			console.log(
				JSON.stringify({
					hostVersion: version,
					hostPid: host.pid,
					root: host.root,
					openDatabases,
				}),
			);
			const descriptors = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], {
				encoding: "utf8",
			});
			expect(descriptors.status).toBe(0);
			const hostDirectDatabases = descriptors.stdout
				.split("\n")
				.filter(
					(line) =>
						line.startsWith("n") &&
						/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(line),
				)
				.map((line) => line.slice(1));
			expect(hostDirectDatabases.length).toBeGreaterThan(0);
			expect(
				hostDirectDatabases.every((path) => path.startsWith(host.root)),
			).toBe(true);
			const prompt = async (text: string) => {
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(60_000) },
				);
				const listed = (await client.message.list({
					sessionID: session.id,
				})) as {
					data: Array<{ type: string; outcome?: string }>;
				};
				expect(listed.data.find((row) => row.type === "idle")?.outcome).toBe(
					"succeeded",
				);
			};
			host.mock.setDefault({
				text: "ok",
				usage: { input_tokens: 10_000, output_tokens: 10 },
			});
			let warm = 0;
			host.mock.addMatcher((rawBody) => {
				const body = rawBody as Body;
				if (
					body.model !== MODEL ||
					!body.tools?.some((tool: { name: string }) => tool.name === "shell")
				)
					return null;
				if (!bytes(body.messages).includes(MARKER)) {
					warm++;
					if (warm === 1)
						return {
							content: [
								thinking(0),
								{
									type: "tool_use",
									id: "old-call",
									name: "shell",
									input: {
										command: "printf OLD-SPENT",
										description: "Old output",
									},
								},
							],
							stop_reason: "tool_use",
							usage: { input_tokens: 10_000, output_tokens: 10 },
						};
					return {
						text: "warm task done",
						usage: { input_tokens: 10_000, output_tokens: 10 },
					};
				}
				step++;
				if (step === 2) {
					const db = contextDb();
					try {
						queued = (
							db
								.query(
									"SELECT tag_number AS n FROM tags WHERE session_id = ? AND type = 'tool' AND tool_name = 'shell' ORDER BY tag_number",
								)
								.all(session.id) as Array<{ n: number }>
						).map((row) => row.n);
					} finally {
						db.close();
					}
					return {
						content: [
							thinking(step),
							{
								type: "tool_use",
								id: "reduce-call",
								name: "ctx_reduce",
								input: { drop: queued.join(",") },
							},
						],
						stop_reason: "tool_use",
						usage: { input_tokens: 66_000, output_tokens: 10 },
					};
				}
				if (step === 3)
					return {
						content: [
							thinking(step),
							...["a", "b", "c"].map((suffix) => ({
								type: "tool_use",
								id: `loop-3-${suffix}`,
								name: "shell",
								input: {
									command: `python3 -c "print('step-3-${suffix} ' * 5000)"`,
									description: `Loop step 3 ${suffix}`,
								},
							})),
						],
						stop_reason: "tool_use",
						usage: { input_tokens: 66_000, output_tokens: 10 },
					};
				if (step === 1)
					return {
						content: [
							thinking(step),
							{
								type: "tool_use",
								id: `loop-${step}`,
								name: "shell",
								input: {
									command: `printf step-${step}`,
									description: `Loop step ${step}`,
								},
							},
						],
						stop_reason: "tool_use",
						usage: { input_tokens: 10_000, output_tokens: 10 },
					};
				return {
					content: [thinking(step), { type: "text", text: "loop done" }],
					usage: { input_tokens: 61_000, output_tokens: 10 },
				};
			});
			await prompt("WARM completed task");
			await prompt(`${MARKER} run tools and queue reductions`);
			expect(step).toBe(4);
			expect(queued).toHaveLength(2);
			const loop = host.mock
				.requests()
				.map((request) => request.body as Body)
				.filter(
					(body) =>
						body.model === MODEL && bytes(body.messages).includes(MARKER),
				);
			const pendingBeforeUser = (() => {
				const db = contextDb();
				try {
					return db
						.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
						.all(session.id);
				} finally {
					db.close();
				}
			})();
			expect(pendingBeforeUser).toHaveLength(2);
			await prompt("NEXT-USER keep deferred work queued");
			const requests = host.mock
				.requests()
				.map((request) => request.body as Body)
				.filter(
					(body) =>
						body.model === MODEL && bytes(body.messages).includes(MARKER),
				);
			const changes = requests.slice(1).map((body, i) => ({
				request: i + 2,
				changed:
					sha({
						system: body.system,
						messages: body.messages?.slice(0, requests[i]!.messages!.length),
					}) !==
					sha({ system: requests[i]!.system, messages: requests[i]!.messages }),
				prefixHash: sha(body.messages?.slice(0, requests[i]!.messages!.length)),
			}));
			const pendingAfterUser = (() => {
				const db = contextDb();
				try {
					return db
						.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
						.all(session.id);
				} finally {
					db.close();
				}
			})();
			const log = await waitForPluginLog(host.env, "context=61.6%");
			const report = {
				hostVersion: version,
				hostPid: host.pid,
				root: host.root,
				openDatabases,
				hostDirectDatabases,
				loopRequests: loop.length,
				loopPrefixChanges: changes
					.slice(0, loop.length - 1)
					.filter((row) => row.changed).length,
				totalPrefixChanges: changes.filter((row) => row.changed).length,
				queued,
				pendingBeforeUser,
				pendingAfterUser,
				changes,
				observedDecisions: log
					.split("\n")
					.filter((line) =>
						/transform scheduler:|pending ops (held|WILL)|proactive thinking strip:|injected m\[0\]/.test(
							line,
						),
					),
				activeHoldLogs: log
					.split("\n")
					.filter((line) => line.includes("m[0]/m[1] frozen:")),
			};
			console.log(JSON.stringify(report));
			if (process.env.MC_HOLD_REPORT) {
				writeFileSync(
					process.env.MC_HOLD_REPORT,
					`${JSON.stringify(report, null, 2)}\n`,
				);
			}
			expect(report.loopPrefixChanges).toBe(0);
			// A plain user turn is not permission to rewrite a served signed prefix.
			// Only a separately authorized bust, such as ctx-flush, drains these drops.
			expect(report.totalPrefixChanges).toBe(0);
			expect(pendingAfterUser).toEqual(pendingBeforeUser);
			expect(report.activeHoldLogs).toHaveLength(2);
			await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
			await prompt("EXPLICIT-FLUSH apply deferred work");
			const flushed = contextDb();
			try {
				expect(flushed.query("SELECT tag_id FROM pending_ops WHERE session_id = ?").all(session.id)).toHaveLength(0);
			} finally { flushed.close(); }
		} catch (error) {
			console.error(
				host.stderr().slice(-3000),
				readPluginLog(host.env).slice(-10000),
			);
			throw error;
		} finally {
			await host.stop();
		}
	},
	240_000,
);
