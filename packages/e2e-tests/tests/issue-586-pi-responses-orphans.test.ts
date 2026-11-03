import { openTestDb } from "../src/test-db";
/// <reference types="bun-types" />

/**
 * Real Pi host against a mock OpenAI Responses endpoint that rejects a
 * `function_call_output` without an earlier `function_call` for the same
 * call_id, the way Responses relays do (issue 586). A long tool-heavy session
 * with encrypted reasoning drives ctx_reduce drops, /ctx-flush busting passes
 * and later defer passes, then the two conditions under which the tool-drop
 * replay keeps a dropped call that the placeholder strip had already removed:
 *   1. a switch to a model whose API keeps tool pairs beside reasoning (a local
 *      openai-completions gateway), and
 *   2. removal markers that cannot be read (the replay document is corrupted
 *      from outside, standing in for any unreadable native replay state).
 * Every captured request is checked for tool results without their call.
 *
 * Opt in only from a throwaway root, e.g.
 *   TMPDIR=$TMPDIR/magic-context/issue-586 bun test tests/issue-586-pi-responses-orphans.test.ts
 * MC_E2E_PI_PACKAGE_JSON picks the Pi install (the report used 0.99.1);
 * MC_E2E_PI_PLUGIN_ROOT runs another plugin build (e.g. the pre-fix dist).
 */

import { expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MockProvider } from "../src/mock-provider/server";
import {
	attachStrictJsonlReader,
	PiRpcProtocol,
} from "../src/pi-runner/rpc-client";
import {
	childEnv,
	createPiIsolatedEnv,
	ensurePluginAvailable,
	resolvePiHostInvocation,
} from "../src/pi-runner/spawn";
import { prepareContextDatabase } from "../src/prepare-context-db";
import { sessionMetaFieldSelect, writeSessionMetaField } from "../src/session-meta-fields";

const root = realpathSync(tmpdir());
const enabled = /\/magic-context\/issue-586(?:\/|$)/.test(root);

type Item = Record<string, unknown> & { type?: string; role?: string };

/** Responses API: every function_call_output needs an earlier function_call with its call_id. */
function responsesOrphans(input: Item[]): string[] {
	const calls = new Set<string>();
	const orphans: string[] = [];
	for (const item of input) {
		if (item.type === "function_call") calls.add(String(item.call_id));
		if (
			item.type === "function_call_output" &&
			!calls.has(String(item.call_id))
		)
			orphans.push(String(item.call_id));
	}
	return orphans;
}

/** Chat Completions: every `tool` message needs an earlier assistant tool_calls entry with its id. */
function chatOrphans(messages: Item[]): string[] {
	const calls = new Set<string>();
	const orphans: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.tool_calls))
			for (const call of message.tool_calls as Item[])
				calls.add(String(call.id));
		if (message.role === "tool" && !calls.has(String(message.tool_call_id)))
			orphans.push(String(message.tool_call_id));
	}
	return orphans;
}

function lastUserText(input: Item[]): string {
	for (let i = input.length - 1; i >= 0; i--) {
		const item = input[i];
		if (item?.role !== "user") continue;
		const content = item.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((part) => String((part as { text?: unknown }).text ?? ""))
				.join("");
	}
	return "";
}

function toolOutputsSinceUser(input: Item[]): number {
	let count = 0;
	for (let i = input.length - 1; i >= 0; i--) {
		if (input[i]?.role === "user") break;
		if (input[i]?.type === "function_call_output") count++;
	}
	return count;
}

function tagNumbersIn(input: Item[]): number[] {
	const tags: number[] = [];
	for (const item of input) {
		if (item.type !== "function_call_output") continue;
		const match = /§(\d+)§/.exec(String(item.output ?? ""));
		if (match) tags.push(Number(match[1]));
	}
	return tags;
}

/** Index of the first differing item between two request inputs, or -1 when `next` extends `prev`. */
function firstDivergence(prev: Item[], next: Item[]): number {
	for (let i = 0; i < prev.length; i++) {
		if (i >= next.length || JSON.stringify(prev[i]) !== JSON.stringify(next[i]))
			return i;
	}
	return -1;
}

let reasoningCounter = 0;
function reasoning() {
	reasoningCounter += 1;
	return {
		type: "reasoning",
		id: `rs_${reasoningCounter}`,
		summary: [],
		encrypted_content: `enc-${reasoningCounter}-${"z".repeat(40)}`,
	};
}

function assertIsolatedProcess(pid: number): void {
	const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], {
		encoding: "utf8",
	});
	const dbPaths = [
		...new Set(
			opened
				.split("\n")
				.filter(
					(line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line),
				)
				.map((line) => resolve(line.slice(1))),
		),
	];
	console.log(`issue-586 lsof pid=${pid} db=${JSON.stringify(dbPaths)}`);
	expect(dbPaths.length).toBeGreaterThan(0);
	expect(dbPaths.every((path) => path.startsWith(`${root}/`))).toBe(true);
}

(enabled ? test : test.skip)(
	"issue 586: a real Pi openai-responses session never sends a tool result without its call",
	async () => {
		const toolsPerTurn = 12;
		const mock = new MockProvider();
		const { baseURL } = await mock.start();
		const env = createPiIsolatedEnv();
		for (const path of Object.values(env))
			expect(path.startsWith(`${root}/`)).toBe(true);
		if (!process.env.MC_E2E_PI_PLUGIN_ROOT) prepareContextDatabase(env.dataDir);
		ensurePluginAvailable(env);
		for (let i = 0; i < 60; i++)
			writeFileSync(
				join(env.workdir, `f${i}.txt`),
				`file ${i}\n${"lorem ipsum dolor ".repeat(80)}\n`,
			);
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		writeFileSync(
			join(env.agentDir, "settings.json"),
			JSON.stringify({
				packages: [env.pluginDir],
				defaultProvider: "relay",
				defaultModel: "gpt-relay",
				compaction: { enabled: false },
				retry: { enabled: false },
				quietStartup: true,
				enableInstallTelemetry: false,
			}),
		);
		writeFileSync(
			join(env.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					relay: {
						baseUrl: `${baseURL}/v1`,
						api: "openai-responses",
						apiKey: "test-key-not-real",
						models: [
							{
								id: "gpt-relay",
								name: "Relay",
								reasoning: true,
								input: ["text"],
								contextWindow: 100_000,
								maxTokens: 8192,
								cost,
							},
						],
					},
					gateway: {
						baseUrl: `${baseURL}/v1`,
						api: "openai-completions",
						apiKey: "test-key-not-real",
						models: [
							{
								id: "local-chat",
								name: "Gateway",
								reasoning: false,
								input: ["text"],
								contextWindow: 100_000,
								maxTokens: 8192,
								cost,
							},
						],
					},
				},
			}),
		);
		mkdirSync(join(env.configDir, "cortexkit"), { recursive: true });
		writeFileSync(
			join(env.configDir, "cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				enabled: true,
				protected_tags: 1,
				execute_threshold_percentage: 60,
				memory: {
					enabled: false,
					auto_promote: false,
					auto_search: { enabled: false },
					git_commit_indexing: { enabled: false },
				},
				embedding: { provider: "off" },
				historian: { model: "relay/gpt-relay" },
				dreamer: { disable: true },
			}),
		);

		const rejected: Array<{ request: number; api: string; orphans: string[] }> =
			[];
		let requestIndex = 0;
		let inputTokens = 20_000;
		mock.addMatcher((body) => {
			requestIndex += 1;
			if (Array.isArray(body.messages)) {
				const orphans = chatOrphans(body.messages as Item[]);
				if (orphans.length > 0) {
					rejected.push({
						request: requestIndex,
						api: "openai-completions",
						orphans,
					});
					return {
						error: {
							status: 400,
							type: "invalid_request_error",
							message: `messages with role 'tool' must be a response to a preceding message with 'tool_calls' (${orphans[0]})`,
						},
					};
				}
				return {
					text: "gateway reply",
					usage: { input_tokens: inputTokens, output_tokens: 20 },
				};
			}
			const input = (Array.isArray(body.input) ? body.input : []) as Item[];
			const orphans = responsesOrphans(input);
			if (orphans.length > 0) {
				rejected.push({
					request: requestIndex,
					api: "openai-responses",
					orphans,
				});
				const at = input.findIndex(
					(item) =>
						item.type === "function_call_output" && item.call_id === orphans[0],
				);
				return {
					error: {
						status: 400,
						type: "invalid_request_error",
						message: `invalid function_call_output at input[${at}]: requires previous_response_id, item_reference.id, or an earlier function_call with matching call_id "${orphans[0]}"`,
					},
				};
			}
			const usage = { input_tokens: inputTokens, output_tokens: 50 };
			const user = lastUserText(input);
			const done = toolOutputsSinceUser(input);
			const reduce = /REDUCE-ALL-OLD/.test(user);
			if (reduce && done === 0) {
				const tags = tagNumbersIn(input);
				const newest = Math.max(...tags);
				const drop = tags.filter((tag) => tag < newest - 4).join(",");
				return {
					openaiOutput: [
						reasoning(),
						{
							type: "function_call",
							call_id: `call_reduce_${requestIndex}`,
							name: "ctx_reduce",
							arguments: JSON.stringify({ drop }),
						},
					],
					usage,
				};
			}
			if (!reduce && done < toolsPerTurn) {
				return {
					openaiOutput: [
						reasoning(),
						{
							type: "function_call",
							call_id: `call_${requestIndex}`,
							name: "read",
							arguments: JSON.stringify({
								path: `f${(requestIndex * 7) % 60}.txt`,
							}),
						},
					],
					usage,
				};
			}
			return {
				openaiOutput: [
					reasoning(),
					{
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: `turn done ${requestIndex}`,
								annotations: [],
							},
						],
					},
				],
				usage,
			};
		});

		const invocation = resolvePiHostInvocation("pi");
		const version = JSON.parse(await Bun.file(invocation.packageJson).text())
			.version as string;
		console.log(`issue-586 Pi host ${version} at ${invocation.packageJson}`);
		console.log(
			`issue-586 plugin root ${process.env.MC_E2E_PI_PLUGIN_ROOT ?? "checkout"}`,
		);
		const protocol = new PiRpcProtocol();
		let stderr = "";
		const child: ChildProcess = spawn(
			invocation.command,
			[
				...invocation.prefixArgs,
				"--mode",
				"rpc",
				"--no-extensions",
				"--extension",
				env.pluginDir,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--model",
				"relay/gpt-relay",
				"--thinking",
				"high",
				"--api-key",
				"test-key-not-real",
			],
			{ cwd: env.workdir, env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] },
		);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		attachStrictJsonlReader(child.stdout!, (line) =>
			protocol.dispatchLine(line),
		);
		const write = (line: string) => child.stdin!.write(line);
		const send = (method: string, params: Record<string, unknown> = {}) =>
			protocol.sendCommand(write, method, params, { timeoutMs: 120_000 });
		const prompt = async (message: string) => {
			if (message.startsWith("/")) {
				const response = await send("prompt", { message });
				if (!response.success)
					throw new Error(`command failed: ${JSON.stringify(response)}`);
				for (let attempt = 0; attempt < 200; attempt++) {
					const state = (await send("get_state")).data as {
						isStreaming?: boolean;
					};
					if (!state.isStreaming) return;
					await Bun.sleep(25);
				}
				throw new Error(`${message} did not settle`);
			}
			const settled = protocol.waitForEvent(
				(event) => event.type === "agent_settled",
				{
					timeoutMs: 180_000,
					label: message,
				},
			);
			const response = await send("prompt", { message });
			if (!response.success)
				throw new Error(`prompt failed: ${JSON.stringify(response)}`);
			await settled;
		};

		const log: string[] = [];
		let previous: Item[] | null = null;
		const step = async (label: string, message: string) => {
			const from = mock.requests().length;
			log.push(`--- ${label}: ${message}`);
			await prompt(message);
			for (const request of mock.requests().slice(from)) {
				const items = (request.body.input ??
					request.body.messages ??
					[]) as Item[];
				const isChat = Array.isArray(request.body.messages);
				const calls = isChat
					? items.flatMap((m) =>
							Array.isArray(m.tool_calls) ? m.tool_calls : [],
						).length
					: items.filter((item) => item.type === "function_call").length;
				const outputs = items.filter(
					(item) =>
						item.type === "function_call_output" || item.role === "tool",
				).length;
				const orphans = isChat ? chatOrphans(items) : responsesOrphans(items);
				const divergence =
					previous && !isChat ? firstDivergence(previous, items) : null;
				log.push(
					`${isChat ? "chat" : "resp"} items=${items.length} calls=${calls} outputs=${outputs} orphans=${orphans.length}${divergence === null ? "" : ` prefix=${divergence === -1 ? "extends" : `diverges@${divergence}`}`}`,
				);
				if (!isChat) previous = items;
			}
		};

		const dbPath = join(
			env.dataDir,
			"cortexkit",
			"magic-context",
			"context.db",
		);
		const summary: Record<string, unknown> = {};
		try {
			await Bun.sleep(500);
			for (let turn = 1; turn <= 4; turn++)
				await step("work", `work phase ${turn}`);
			assertIsolatedProcess(child.pid!);
			const sessionId = (
				(await send("get_state")).data as { sessionId?: string }
			).sessionId!;
			await step("reduce", "REDUCE-ALL-OLD tool outputs now");
			inputTokens = 70_000;
			await step("flush (busting, drops materialize)", "/ctx-flush");
			await step("work", "work phase 5");
			await step("flush (busting, placeholder discovery)", "/ctx-flush");
			inputTokens = 20_000;
			await step("defer", "work phase 6");
			await step("defer", "work phase 7");
			const snapshot = (label: string) => {
				const db = openTestDb(dbPath, { readonly: true });
				const modes = db
					.prepare(
						"SELECT drop_mode AS mode, COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped' GROUP BY drop_mode",
					)
					.all(sessionId) as Array<{ mode: string; n: number }>;
				const owners = db
					.prepare(
						"SELECT tool_owner_message_id AS owner, drop_mode AS mode FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped'",
					)
					.all(sessionId) as Array<{ owner: string | null; mode: string }>;
				const row = db
					.prepare(
						`SELECT ${sessionMetaFieldSelect("stripped_placeholder_ids", "s")}, ${sessionMetaFieldSelect("trailing_blank_decisions", "d")} FROM session_meta WHERE session_id = ?`,
					)
					.get(sessionId) as { s?: string; d?: string };
				db.close();
				let markers: number | string = "unreadable";
				try {
					const inputs =
						(
							JSON.parse(row.d ?? "{}") as {
								piNative?: { toolInputs?: Record<string, string> };
							}
						).piNative?.toolInputs ?? {};
					markers = Object.values(inputs).filter(
						(v) => v === '{"__magic_context_remove_tool_arc__":true}',
					).length;
				} catch {}
				const stripped = row.s
					? (JSON.parse(row.s) as
							| string[]
							| { ids: string[]; pairedToolResults?: boolean })
					: [];
				const strippedIds = new Set(
					Array.isArray(stripped) ? stripped : stripped.ids,
				);
				// Frozen ids whose message owns a dropped arc stored in a mode that keeps
				// the call: the poisoned ids issue 586 describes.
				const keepsCall = new Set([
					"skeleton_real",
					"skeleton_stripped",
					"truncated",
					"edit_marker",
					"edit_marker_stripped",
				]);
				const poisoned = new Set(
					owners
						.filter(
							(o) =>
								o.owner && strippedIds.has(o.owner) && keepsCall.has(o.mode),
						)
						.map((o) => o.owner),
				);
				summary[label] = {
					strippedIds: strippedIds.size,
					poisonedIds: poisoned.size,
					dropModes: Object.fromEntries(modes.map((m) => [m.mode, m.n])),
					removalMarkers: markers,
				};
			};
			snapshot("afterDiscovery");

			// Condition 1: the same session on a local openai-completions gateway.
			const switched = await send("set_model", {
				provider: "gateway",
				modelId: "local-chat",
			});
			expect(switched.success).toBe(true);
			await step(
				"gateway (keeps tool pairs beside reasoning)",
				"gateway question",
			);
			await step("gateway", "gateway question 2");
			snapshot("afterGateway");
			expect(
				(await send("set_model", { provider: "relay", modelId: "gpt-relay" }))
					.success,
			).toBe(true);
			await step("back on relay", "work phase 8");
			await step("back on relay", "work phase 8b");
			snapshot("backOnRelay");

			// Condition 2: removal markers become unreadable (the native lane is
			// invalid while the rest of the replay document still parses).
			const writable = openTestDb(dbPath);
			writable.exec("PRAGMA busy_timeout = 5000");
			writeSessionMetaField(
				writable,
				sessionId,
				"trailing_blank_decisions",
				'{"version":2,"trailingBlank":{},"piNative":{"toolInputs":"{","reasoningIds":[]}}',
			);
			writable.close();
			await step("unreadable markers, defer", "work phase 9");
			await step("unreadable markers, defer", "work phase 10");
			await step("unreadable markers, busting", "/ctx-flush");
			await step("unreadable markers, after busting", "work phase 11");
			await step("unreadable markers, defer", "work phase 12");
			assertIsolatedProcess(child.pid!);
			snapshot("end");

			const db = openTestDb(dbPath, { readonly: true });
			summary.droppedToolTags = (
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped'",
					)
					.get(sessionId) as { n: number }
			).n;
			db.close();
			const outDir = process.env.MC_ISSUE_586_OUT;
			if (outDir) {
				mkdirSync(outDir, { recursive: true });
				writeFileSync(
					join(outDir, "requests.json"),
					JSON.stringify(
						mock.requests().map((r) => ({ path: r.path, body: r.body })),
						null,
						1,
					),
				);
				writeFileSync(
					join(outDir, "log.txt"),
					`${log.join("\n")}\n${JSON.stringify(summary)}\n${JSON.stringify(rejected)}\n`,
				);
			}
			console.log(log.join("\n"));
			console.log(`issue-586 summary=${JSON.stringify(summary)}`);
			console.log(`issue-586 rejected=${JSON.stringify(rejected)}`);
			expect(summary.droppedToolTags as number).toBeGreaterThan(0);
			expect(rejected).toEqual([]);
		} finally {
			child.kill("SIGTERM");
			await mock.stop();
			if (process.env.MC_ISSUE_586_DEBUG) console.log(stderr.slice(-4000));
		}
	},
	900_000,
);
