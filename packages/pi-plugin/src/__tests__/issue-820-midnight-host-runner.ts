import { afterAll, expect, setSystemTime, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import { pinOmpLoggerFiles } from "./omp-log-files";

const parent = join(tmpdir(), "magic-context", "issue-820");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "midnight-host-"));
const environment = Object.fromEntries(
	[
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		"MAGIC_CONTEXT_STORAGE_DIR",
		"PI_CODING_AGENT_DIR",
	].map((key) => [key, join(root, key)]),
);
const previous = Object.fromEntries(
	Object.keys(environment).map((key) => [key, process.env[key]]),
);
for (const [key, value] of Object.entries(environment)) {
	mkdirSync(value, { recursive: true });
	process.env[key] = value;
}
const previousApiKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
const aliases = ["omp-coding-agent-18132", "omp-pi-ai-18132"];
await pinOmpLoggerFiles(root, aliases);
const omp = await import(aliases[0]!);
const require = createRequire(import.meta.url);
const ai = require.resolve(`${aliases[1]}/package.json`).slice(0, -12);
const agent = require.resolve(`${aliases[0]}/package.json`).slice(0, -12);
const { initializeExtensions } = await import(
	`${agent}src/modes/runtime-init.ts`
);
const { convertAnthropicMessages } = await import(
	`${ai}src/providers/anthropic.ts`
);
const { registerPiGuardedContext, clearPiContextReceipt } = await import(
	"../pi-context-refusal"
);
const { __setPiHarnessKindForTesting } = await import("../pi-harness-kind");
const { Type } = await import("typebox");
afterAll(() => {
	setSystemTime();
	__setPiHarnessKindForTesting(undefined);
	if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = previousApiKey;
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanupTestTempDir(root);
});

async function run(extraRow: boolean) {
	setSystemTime(new Date(2026, 0, 1, 23, 59, 59));
	__setPiHarnessKindForTesting("omp");
	const cwd = join(root, extraRow ? "negative" : "positive");
	mkdirSync(cwd, { recursive: true });
	const agentDir = environment.PI_CODING_AGENT_DIR!;
	const settings = omp.Settings.isolated({});
	const authStorage = await omp.discoverAuthStorage(agentDir, {
		settings,
		cwd,
	});
	const modelRegistry = new omp.ModelRegistry(
		authStorage,
		join(agentDir, "models.yml"),
		{ settings },
	);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled test model missing");
	const sessionManager = omp.SessionManager.inMemory(cwd);
	const refusalMessages: string[] = [];
	const { session } = await omp.createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		settings,
		sessionManager,
		extensions: [
			(api: any) => {
				registerPiGuardedContext(
					api,
					async (event) => ({ messages: event.messages }),
					{
						onRefusal: (_ctx, _budget, message) => {
							refusalMessages.push(message);
						},
					},
				);
				api.registerTool({
					name: "cross_midnight",
					label: "Cross simulated midnight",
					description: "Advance only the test process clock",
					parameters: Type.Object({}),
					execute: async () => {
						setSystemTime(new Date(2026, 0, 2, 0, 0, 1));
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				});
			},
		],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		toolNames: [],
	});
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: () => {},
	});
	let calls = 0;
	let replies = 0;
	const wires: any[] = [];
	// The real agent, SDK context transforms, extension runner and converter run.
	// Replace only network streaming, and invoke the same onPayload boundary.
	session.agent.streamFn = async (target: any, context: any, options: any) => {
		calls++;
		const payload = {
			model: target.id,
			max_tokens: 1024,
			system: [{ type: "text", text: "system" }],
			messages: convertAnthropicMessages(context.messages, target, false),
		};
		if (extraRow && calls === 2)
			payload.messages.push({ role: "user", content: "unmanaged extra row" });
		wires.push(structuredClone(payload));
		await options.onPayload(payload, target, options.signal);
		if (options.signal?.aborted || refusalMessages.length)
			throw new Error("dispatch refused");
		replies++;
		const output = {
			role: "assistant",
			api: target.api,
			provider: target.provider,
			model: target.id,
			content:
				calls === 1
					? [
							{
								type: "toolCall",
								id: "toolu_midnight",
								name: "cross_midnight",
								arguments: {},
							},
						]
					: [{ type: "text", text: "after midnight" }],
			stopReason: calls === 1 ? "toolUse" : "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		async function* events() {
			yield { type: "start", partial: output };
			yield { type: "done", reason: output.stopReason, message: output };
		}
		return Object.assign(events(), { result: async () => output });
	};
	try {
		const descriptors = execFileSync(
			"lsof",
			["-nP", "-p", String(process.pid)],
			{ encoding: "utf8", windowsHide: true },
		)
			.split("\n")
			.filter((line) => /\.db(?:-wal|-shm)?(?:\s|$)/u.test(line));
		expect(descriptors.length).toBeGreaterThan(0);
		for (const line of descriptors) expect(line).toContain(root);
		console.log("issue 820 host database descriptors:", descriptors.join("\n"));
		await session.prompt(
			"<session-history>managed</session-history> Run the long task.",
		);
		const entries = sessionManager.getEntries();
		const refusals = JSON.stringify(refusalMessages);
		console.log(
			"issue 820 midnight host:",
			JSON.stringify({ extraRow, calls, replies, refusals }),
		);
		return { calls, replies, wires, entries, refusals };
	} finally {
		clearPiContextReceipt(sessionManager.getSessionId());
		await session.dispose();
		setSystemTime();
	}
}

test("issue 820: real OMP 18.13.2 replies after simulated local midnight", async () => {
	const result = await run(false);
	expect(result.calls).toBe(2);
	expect(result.replies).toBe(2);
	expect(JSON.stringify(result.entries)).toContain("after midnight");
	expect(JSON.stringify(result.wires[1])).toContain("Today: 2026-01-02;");
	expect(result.refusals).not.toContain("prepared turn structure");
}, 30000);

test("issue 820: real OMP still refuses a non-reminder extra row after midnight", async () => {
	const result = await run(true);
	expect(result.calls).toBe(2);
	expect(result.replies).toBe(1);
	expect(result.refusals).toContain("prepared turn structure");
}, 30000);
