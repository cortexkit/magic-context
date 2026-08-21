import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import {
	__resetSchemaFenceStateForTests,
	LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import * as loggerModule from "@magic-context/core/shared/logger";
import type { SubagentRunOptions } from "@magic-context/core/shared/subagent-runner";

import { __test, PiSubagentRunner } from "./subagent-runner";

const baseOptions: SubagentRunOptions = {
	agent: "historian",
	systemPrompt: "system guidance",
	userMessage: "summarize this session",
};
const TEST_SYSTEM_PROMPT_PATH = "/tmp/mc-pi-system-prompt.txt";
const COLLISION_STDERR =
	"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const ISOLATED_RETRY_LOG_MESSAGE =
	"pi subagent: a loaded Pi extension started an agent turn before the child's prompt could run; retrying with an isolated extension set (user extensions disabled for this run)";
const ISOLATED_RETRY_MODEL_UNAVAILABLE_LOG_MESSAGE =
	"model unavailable in isolated retry: it is provided by a disabled extension; configure it through models.json or add a built-in/provider-configured fallback";
const ISOLATED_RETRY_SILENT_LOG_MESSAGE =
	"pi subagent: child exited successfully but emitted no protocol output (no agent_end, zero stdout); a loaded Pi extension likely broke print mode; retrying with an isolated extension set (user extensions disabled for this run)";
const OMP_ALLOWLISTABLE_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	bash: true,
	edit: true,
	write: true,
};

beforeEach(() => {
	__test.resetProviderFormCache();
});

afterEach(() => {
	closeDatabase();
	__resetSchemaFenceStateForTests();
});

type MockChild = ReturnType<typeof createMockChild>;

function createMockChild({ stdout = true }: { stdout?: boolean } = {}) {
	const events = new EventEmitter();
	const stdinStream = new PassThrough();
	stdinStream.setEncoding("utf8");
	const stdoutStream = stdout ? new PassThrough() : null;
	const stderrStream = new PassThrough();
	let stdinText = "";
	const stdinEnded = new Promise<void>((resolve) => {
		stdinStream.on("data", (chunk) => {
			stdinText += chunk;
		});
		stdinStream.on("end", () => resolve());
	});
	let killed = false;
	let exitCode: number | null = null;
	let signalCode: NodeJS.Signals | null = null;
	const killSignals: Array<NodeJS.Signals | number | undefined> = [];

	const child = {
		pid: 42,
		stdin: stdinStream,
		stdout: stdoutStream,
		stderr: stderrStream,
		get killed() {
			return killed;
		},
		get exitCode() {
			return exitCode;
		},
		get signalCode() {
			return signalCode;
		},
		get stdinText() {
			return stdinText;
		},
		kill: mock((signal?: NodeJS.Signals | number) => {
			killSignals.push(signal);
			killed = true;
			return true;
		}),
		on: events.on.bind(events),
		once: events.once.bind(events),
		emitClose: (
			code: number | null = 0,
			signal: NodeJS.Signals | null = null,
		) => {
			exitCode = code;
			signalCode = signal;
			stdoutStream?.end();
			stderrStream.end();
			if (!stdinStream.writableEnded) stdinStream.end();
			setTimeout(() => events.emit("close", code, signal), 0);
		},
		emitExit: (
			code: number | null = 0,
			signal: NodeJS.Signals | null = null,
		) => {
			exitCode = code;
			signalCode = signal;
			if (!stdinStream.writableEnded) stdinStream.end();
			events.emit("exit", code, signal);
		},
		emitError: (error: Error) => events.emit("error", error),
		writeStdoutLine: (event: unknown) => {
			if (!stdoutStream) throw new Error("stdout disabled");
			stdoutStream.write(`${JSON.stringify(event)}\n`);
		},
		writeRawStdoutLine: (line: string) => {
			if (!stdoutStream) throw new Error("stdout disabled");
			stdoutStream.write(`${line}\n`);
		},
		writeStderr: (text: string) => {
			stderrStream.write(text);
		},
		waitForStdinEnd: () => stdinEnded,
		killSignals,
	};

	return child;
}

function runnerWith(
	childOrChildren: MockChild | MockChild[],
	{
		piBinary = "pi-test",
		platform,
		extraArgs,
		subagentExtensions,
	}: {
		piBinary?: string;
		platform?: NodeJS.Platform;
		extraArgs?: readonly string[];
		subagentExtensions?: readonly string[];
	} = {},
) {
	const remainingChildren = Array.isArray(childOrChildren)
		? [...childOrChildren]
		: null;
	const spawnImpl = mock(() => {
		if (remainingChildren === null) return childOrChildren as never;
		const nextChild = remainingChildren.shift();
		if (!nextChild) throw new Error("unexpected extra spawn");
		return nextChild as never;
	});
	const runner = new PiSubagentRunner({
		piBinary,
		platform,
		extraArgs,
		subagentExtensions,
		spawnImpl: spawnImpl as never,
	});
	return { runner, spawnImpl };
}

function buildArgsForTest(
	options: SubagentRunOptions,
	opts?: Parameters<typeof __test.buildArgs>[1],
) {
	return __test.buildArgs(options, {
		systemPromptPath: TEST_SYSTEM_PROMPT_PATH,
		...opts,
	});
}

function requirePromptPath(promptPath: string | undefined): string {
	if (!promptPath) throw new Error("expected system prompt path");
	return promptPath;
}

function agentEnd(messages: unknown[]) {
	return { type: "agent_end", messages };
}

function nextTick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

describe("subagent-runner pure helpers", () => {
	it("extracts the last assistant text and status from mixed messages", () => {
		const result = __test.extractFinalAssistant([
			{ role: "assistant", content: [{ type: "text", text: "old" }] },
			{ role: "user", content: [{ type: "text", text: "prompt" }] },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "ignored" },
					{ type: "text", text: "hello " },
					{ type: "text", text: "world" },
				],
				stopReason: "stop",
				errorMessage: "ignored on success but preserved",
			},
		]);

		expect(result).toEqual({
			text: "hello world",
			stopReason: "stop",
			errorMessage: "ignored on success but preserved",
		});
	});

	it("returns null text when no assistant message exists", () => {
		expect(
			__test.extractFinalAssistant([{ role: "user", content: [] }, null]),
		).toEqual({ text: null, stopReason: null, errorMessage: null });
	});

	it("distinguishes Pi from embedded Node hosts", () => {
		expect(__test.isGenericRuntimeExecutable("/usr/bin/node24")).toBe(true);
		expect(__test.isPiCliScript("/app/node_modules/.bin/next")).toBe(false);
		expect(
			__test.isPiCliScript(
				"/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
			),
		).toBe(true);
	});
	it("builds argv with system prompt, primary model, and prompt last", () => {
		expect(
			buildArgsForTest({
				...baseOptions,
				model: "anthropic/claude-sonnet",
			}),
		).toEqual([
			"--print",
			"--mode",
			"json",
			// `--no-session` keeps historian / sidekick / dreamer /
			// recomp / compressor child sessions out of `pi resume`
			// and the session picker (uses Pi's
			// SessionManager.inMemory()).
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--tools",
			"read,grep,find,ls,aft_search",
			"--system-prompt",
			TEST_SYSTEM_PROMPT_PATH,
			"--model",
			"anthropic/claude-sonnet",
			// No --thinking flag: thinkingLevel not set in baseOptions,
			// so Pi's own resolution handles it (correct for Anthropic).
			// Users on providers like GitHub Copilot should set
			// historian.thinking_level in their Pi magic-context.jsonc.
			"summarize this session",
		]);
	});

	it("passes the active entry thinking level through Pi's --thinking flag", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "github-copilot/gpt-5",
			thinkingLevel: "high",
		});

		expect(args.slice(-5)).toEqual([
			"--model",
			"github-copilot/gpt-5",
			"--thinking",
			"high",
			"summarize this session",
		]);
	});

	it("keeps extension discovery enabled so provider and AFT extensions can load", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "google/antigravity-gemini-3.5-flash",
		});

		expect(args).not.toContain("--no-extensions");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
	});

	it("isolated retry disables discovered extensions but keeps explicit --extension paths", () => {
		const args = buildArgsForTest(
			{
				...baseOptions,
				agent: "sidekick",
				model: "anthropic/claude-sonnet",
			},
			{
				disableDiscoveredExtensions: true,
				subagentEntryPath: "/tmp/subagent-entry.js",
			},
		);

		expect(args).toEqual(
			expect.arrayContaining([
				"--no-extensions",
				"--extension",
				"/tmp/subagent-entry.js",
			]),
		);
	});

	it("uses the configured extension allowlist in order and resolves relative paths from Pi settings", () => {
		const args = buildArgsForTest(
			{ ...baseOptions, model: "anthropic/claude-sonnet" },
			{
				subagentExtensions: [
					"provider-package",
					"./extensions/provider.ts",
					"../shared/provider.ts",
				],
			},
		);

		const firstExtension = args.indexOf("--extension");
		expect(args.slice(firstExtension, firstExtension + 6)).toEqual([
			"--extension",
			join(homedir(), ".pi/agent/provider-package"),
			"--extension",
			join(homedir(), ".pi/agent/extensions/provider.ts"),
			"--extension",
			join(homedir(), ".pi/shared/provider.ts"),
		]);
		expect(args).toContain("--no-extensions");
	});

	it("keeps plain Pi relative allowlist entries rooted at the stock agent dir", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/tmp/plain-pi-custom-agent";
		try {
			const args = buildArgsForTest(
				{ ...baseOptions, model: "anthropic/claude-sonnet" },
				{ subagentExtensions: ["provider-package"] },
			);
			const firstExtension = args.indexOf("--extension");
			expect(args.slice(firstExtension, firstExtension + 2)).toEqual([
				"--extension",
				join(homedir(), ".pi/agent/provider-package"),
			]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});

	it("uses PI_CODING_AGENT_DIR only for a positively identified OMP host", () => {
		const root = mkdtempSync(join(homedir(), ".mc-omp-host-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousPackageDir = process.env.PI_PACKAGE_DIR;
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
		);
		process.env.PI_PACKAGE_DIR = root;
		process.env.PI_CODING_AGENT_DIR = "/tmp/omp-profile/agent";
		try {
			const args = buildArgsForTest(
				{ ...baseOptions, model: "anthropic/claude-sonnet" },
				{ subagentExtensions: ["provider-package"] },
			);
			const firstExtension = args.indexOf("--extension");
			expect(args.slice(firstExtension, firstExtension + 2)).toEqual([
				"--extension",
				"/tmp/omp-profile/agent/provider-package",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			if (previousAgentDir === undefined)
				delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previousPackageDir;
		}
	});

	it("uses the OMP default agent dir when PI_CODING_AGENT_DIR is unset", () => {
		const root = mkdtempSync(join(homedir(), ".mc-omp-default-host-test-"));
		const previous = {
			agentDir: process.env.PI_CODING_AGENT_DIR,
			packageDir: process.env.PI_PACKAGE_DIR,
			configDir: process.env.PI_CONFIG_DIR,
			ompProfile: process.env.OMP_PROFILE,
			piProfile: process.env.PI_PROFILE,
		};
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
		);
		process.env.PI_PACKAGE_DIR = root;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CONFIG_DIR;
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		try {
			const args = buildArgsForTest(
				{ ...baseOptions, model: "anthropic/claude-sonnet" },
				{ subagentExtensions: ["provider-package"] },
			);
			const firstExtension = args.indexOf("--extension");
			expect(args.slice(firstExtension, firstExtension + 2)).toEqual([
				"--extension",
				join(homedir(), ".omp/agent/provider-package"),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			for (const [key, value] of [
				["PI_CODING_AGENT_DIR", previous.agentDir],
				["PI_PACKAGE_DIR", previous.packageDir],
				["PI_CONFIG_DIR", previous.configDir],
				["OMP_PROFILE", previous.ompProfile],
				["PI_PROFILE", previous.piProfile],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("gives a named OMP profile precedence over a stale agent-dir override", () => {
		const root = mkdtempSync(join(homedir(), ".mc-omp-profile-host-test-"));
		const previous = {
			agentDir: process.env.PI_CODING_AGENT_DIR,
			packageDir: process.env.PI_PACKAGE_DIR,
			configDir: process.env.PI_CONFIG_DIR,
			ompProfile: process.env.OMP_PROFILE,
			piProfile: process.env.PI_PROFILE,
		};
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
		);
		process.env.PI_PACKAGE_DIR = root;
		process.env.PI_CODING_AGENT_DIR = "/tmp/stale-omp-agent";
		process.env.PI_CONFIG_DIR = ".omp-test";
		process.env.OMP_PROFILE = "work";
		delete process.env.PI_PROFILE;
		try {
			const args = buildArgsForTest(
				{ ...baseOptions, model: "anthropic/claude-sonnet" },
				{ subagentExtensions: ["provider-package"] },
			);
			const firstExtension = args.indexOf("--extension");
			expect(args.slice(firstExtension, firstExtension + 2)).toEqual([
				"--extension",
				join(homedir(), ".omp-test/profiles/work/agent/provider-package"),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			for (const [key, value] of [
				["PI_CODING_AGENT_DIR", previous.agentDir],
				["PI_PACKAGE_DIR", previous.packageDir],
				["PI_CONFIG_DIR", previous.configDir],
				["OMP_PROFILE", previous.ompProfile],
				["PI_PROFILE", previous.piProfile],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("keeps the current all-extension argv shape when no allowlist is configured", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});

		expect(args).not.toContain("--no-extensions");
		expect(args).not.toContain("--extension");
	});

	it("disables project context files so hidden subagents see only our prompt", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});

		expect(args).toContain("--no-context-files");
		expect(args.indexOf("--no-context-files")).toBeLessThan(
			args.indexOf("--tools"),
		);
	});

	it("emits only OMP-supported startup flags and tool names on an OMP host", () => {
		const root = mkdtempSync(join(homedir(), ".mc-omp-argv-test-"));
		const previousPackageDir = process.env.PI_PACKAGE_DIR;
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
		);
		process.env.PI_PACKAGE_DIR = `~/${basename(root)}`;
		try {
			const historianArgs = buildArgsForTest({
				...baseOptions,
				agent: "historian",
			});
			expect(historianArgs).toContain("--no-rules");
			expect(historianArgs).not.toContain("--no-prompt-templates");
			expect(historianArgs).not.toContain("--no-context-files");
			expect(historianArgs).toEqual(
				expect.arrayContaining(["--tools", "read,grep,glob"]),
			);

			const dreamerArgs = buildArgsForTest({
				...baseOptions,
				agent: "dreamer",
			});
			expect(dreamerArgs).toContain("--no-tools");
			expect(dreamerArgs).not.toContain("--tools");
		} finally {
			rmSync(root, { recursive: true, force: true });
			if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previousPackageDir;
		}
	});

	it("always includes --no-session so child sessions don't appear in pi resume", () => {
		// Pinned-down regression: the user-visible promise of magic-context
		// hidden subagents is that historian/sidekick/dreamer runs never
		// pollute Pi's session list. If this assertion ever fails, the
		// child sessions WILL show up in `pi resume` again.
		const args = buildArgsForTest({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});
		expect(args).toContain("--no-session");
		// And before --system-prompt / --model so they're parsed in the
		// expected order alongside other startup-time flags.
		const noSessionIdx = args.indexOf("--no-session");
		const modelIdx = args.indexOf("--model");
		expect(noSessionIdx).toBeLessThan(modelIdx);
	});

	it("builds a single --model; runner handles fallback with fresh children", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback", "google/last"],
		});

		expect(args).toContain("--model");
		expect(args).not.toContain("--models");
		expect(args).toContain("anthropic/primary");
		expect(args).not.toContain("openai/fallback");
		expect(args.at(-1)).toBe("summarize this session");
	});

	it("translates the canonical (OpenCode) provider to Pi's form at --model", () => {
		// Shared config stores canonical ids; Pi names two auth-plugin providers
		// differently. The spawned --model must carry Pi's form.
		expect(
			buildArgsForTest({ ...baseOptions, model: "openai/gpt-5.5" }),
		).toEqual(expect.arrayContaining(["--model", "openai-codex/gpt-5.5"]));
		expect(
			buildArgsForTest({
				...baseOptions,
				model: "google/antigravity-gemini-3.5-flash",
			}),
		).toEqual(
			expect.arrayContaining([
				"--model",
				"google-antigravity/antigravity-gemini-3.5-flash",
			]),
		);
		// Anthropic and other providers pass through unchanged.
		expect(
			buildArgsForTest({ ...baseOptions, model: "anthropic/claude-opus-4-8" }),
		).toEqual(expect.arrayContaining(["--model", "anthropic/claude-opus-4-8"]));
	});

	it("passes prompt last without a -- sentinel", () => {
		const args = buildArgsForTest({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			userMessage: "ordinary prompt",
		});

		expect(args.at(-1)).toBe("ordinary prompt");
		expect(args).not.toContain("--");
	});

	it("locks dreamer-retrospective to --tools ctx_search (no built-ins) and never --no-tools", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer-retrospective",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("ctx_search");
		// --no-tools would disable EVERYTHING including ctx_search — must not appear.
		expect(args).not.toContain("--no-tools");
	});

	it("locks historian and sidekick to explicit read-only allow-lists", () => {
		const historianArgs = buildArgsForTest({
			...baseOptions,
			agent: "historian",
		});
		expect(historianArgs).toEqual(
			expect.arrayContaining(["--tools", "read,grep,find,ls,aft_search"]),
		);
		const sidekickArgs = buildArgsForTest({
			...baseOptions,
			agent: "sidekick",
		});
		expect(sidekickArgs).toEqual(
			expect.arrayContaining(["--tools", "read,grep,find,ls,ctx_search"]),
		);
	});

	it("translates every strict Pi allow-list into valid OMP built-ins", () => {
		expect(
			__test.resolveHostToolAllowlist(["read", "grep", "find", "ls"], true),
		).toEqual(["read", "grep", "glob"]);
		expect(
			__test.resolveHostToolAllowlist(
				["read", "aft_search", "ctx_search"],
				true,
			),
		).toEqual(["read"]);
		expect(
			__test.resolveHostToolAllowlist(
				["read", "find", "ls", "aft_search"],
				false,
			),
		).toEqual(["read", "find", "ls", "aft_search"]);

		for (const [agent, tools] of __test.STRICT_TOOL_ALLOWLIST) {
			const resolved = __test.resolveHostToolAllowlist(tools, true);
			for (const tool of resolved) {
				expect(OMP_ALLOWLISTABLE_TOOLS[tool] === true, agent).toBe(true);
			}
			expect(new Set(resolved).size, agent).toBe(resolved.length);
		}
	});

	it("locks base dreamer (curate) to --tools ctx_memory, stripping all built-ins", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("ctx_memory");
		expect(args).not.toContain("--no-tools");
		// No codebase/shell built-ins survive the allow-list. (ctx_memory itself is
		// registered by the lean extension when a real bundle path is present; in
		// this dev/test env SUBAGENT_ENTRY_PATH is undefined so --extension and the
		// dreamer-actions flag are absent — the strict allow-list is independent.)
		const toolList = args[idx + 1];
		for (const denied of [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"write",
			"edit",
		]) {
			expect(toolList).not.toContain(denied);
		}
	});

	it("locks magic-context-dreamer (Pi facade default) to --tools ctx_memory only", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "magic-context-dreamer",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("ctx_memory");
		expect(args).not.toContain("--no-tools");
		const toolList = args[idx + 1];
		for (const denied of [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"write",
			"edit",
		]) {
			expect(toolList).not.toContain(denied);
		}
	});

	it("every DREAMER_ACTION_AGENTS member has a STRICT_TOOL_ALLOWLIST entry", () => {
		for (const agent of __test.DREAMER_ACTION_AGENTS) {
			expect(__test.STRICT_TOOL_ALLOWLIST.has(agent)).toBe(true);
		}
	});

	it("emits an explicit tool gate for every known Pi subagent agent", () => {
		for (const agent of __test.KNOWN_PI_SUBAGENT_AGENTS) {
			const args = buildArgsForTest({ ...baseOptions, agent });
			const hasTools = args.includes("--tools");
			const hasNoTools = args.includes("--no-tools");
			expect(__test.STRICT_TOOL_ALLOWLIST.has(agent)).toBe(true);
			expect(hasTools || hasNoTools).toBe(true);
			expect(hasTools && hasNoTools).toBe(false);
		}
	});

	it("fails closed to --no-tools for unknown agent ids", () => {
		const args = buildArgsForTest({ ...baseOptions, agent: "future-agent" });
		expect(args).toContain("--no-tools");
		expect(args).not.toContain("--tools");
	});

	it("locks dreamer-docs to file tools plus optional AFT read tools, with no ctx_memory and no extension", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer-docs",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe(
			"read,grep,find,ls,bash,write,edit,aft_outline,aft_zoom,aft_search",
		);
		expect(args).not.toContain("--no-tools");
		// Edits docs, never the memory store: no ctx_memory, and the lean extension
		// (which would register it) is not loaded for this agent.
		expect(args[idx + 1]).not.toContain("ctx_memory");
		expect(args).not.toContain("--magic-context-dreamer-actions");
	});

	it("locks dreamer-reviewer to --no-tools (pure JSON reviewer, zero tools)", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer-reviewer",
			model: "anthropic/claude-sonnet",
		});
		expect(args).toContain("--no-tools");
		expect(args).not.toContain("--tools");
		expect(args).not.toContain("--magic-context-dreamer-actions");
	});

	it("locks dreamer-primer-investigator to read-only built-ins, AFT read tools, and ctx_search", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer-primer-investigator",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe(
			"read,grep,find,ls,aft_outline,aft_zoom,aft_search,ctx_search",
		);
		expect(args).not.toContain("--no-tools");
		// Source-safety + cache-neutrality: no write/edit/bash, and crucially no
		// ctx_memory (its mutations bump the project memory epoch → bust m[0]).
		const toolList = args[idx + 1];
		for (const denied of ["write", "edit", "bash", "ctx_memory", "ctx_note"]) {
			expect(toolList).not.toContain(denied);
		}
		// The lean extension loads (so ctx_search is registered to be gated), but
		// the dreamer-actions flag (which adds ctx_memory) must NOT be present.
		expect(args).not.toContain("--magic-context-dreamer-actions");
	});

	it("adds AFT read tools exactly to the intended Pi child allow-lists", () => {
		const toolListFor = (agent: string) => {
			const args = buildArgsForTest({ ...baseOptions, agent });
			const idx = args.indexOf("--tools");
			return idx >= 0 ? args[idx + 1].split(",") : [];
		};
		const aftReadSet = ["aft_outline", "aft_zoom", "aft_search"];

		for (const agent of [
			"dreamer-memory-mapper",
			"dreamer-primer-investigator",
			"dreamer-docs",
		]) {
			expect(toolListFor(agent)).toEqual(expect.arrayContaining(aftReadSet));
		}

		for (const agent of [
			"magic-context-historian",
			"historian",
			"historian-recomp",
			"historian-editor",
		]) {
			const tools = toolListFor(agent);
			expect(tools).toContain("aft_search");
			expect(tools).not.toContain("aft_outline");
			expect(tools).not.toContain("aft_zoom");
		}

		for (const agent of [
			"dreamer",
			"magic-context-dreamer",
			"dreamer-classifier",
			"dreamer-reviewer",
			"smart-note-compiler",
			"dreamer-retrospective",
		]) {
			const tools = toolListFor(agent);
			expect(tools.some((tool) => tool.startsWith("aft_"))).toBe(false);
		}
	});

	it("parses JSON event lines and normalizes parse errors", () => {
		expect(__test.parsePiEventLine('{"type":"agent_start"}')).toEqual({
			ok: true,
			event: { type: "agent_start" },
		});

		const parsed = __test.parsePiEventLine("{not-json");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok && "error" in parsed) {
			expect(parsed.error).toContain("failed to parse event");
			expect(parsed.error).toContain("line={not-json");
		} else {
			throw new Error("malformed JSON must be an error, not noise");
		}

		// Plain-text stdout from co-loaded extensions (issue #211:
		// "[Worker] Ready") is noise to skip, never a recorded error.
		const noise = __test.parsePiEventLine("[Worker] Ready");
		expect(noise.ok).toBe(false);
		if (!noise.ok) expect("noise" in noise).toBe(true);
	});

	// Issue #211: a co-loaded Pi extension printing "[Worker] Ready" to
	// stdout interleaved with the event stream and failed the whole run as
	// parse_failed even though the terminal message_end arrived intact.
	it("ignores non-JSON stdout noise from co-loaded extensions", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeRawStdoutLine("[Worker] Ready");
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		});
		child.writeRawStdoutLine("[Worker] Shutting down");
		child.emitClose(0);

		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.assistantText).toBe("done");
		}
	});

	// Subagent extension entry loading. These tests verify the
	// runner's argv contract for loading Magic Context's lean subagent
	// extension (./subagent-entry.js) inside spawned Pi child processes.
	// The bundle is only present after `bun run build`; in unit tests
	// running source via Bun directly, the dev fallback (no --extension)
	// kicks in. Both shapes are valid and locked in.

	it("dev mode (no bundle): does NOT pass --extension flag, so ctx_* tools are unavailable", () => {
		// In dev mode (running .ts source), there's no dist/subagent-entry.js
		// next to subagent-runner.ts, so resolveSubagentEntryPath() returns
		// undefined and we skip the --extension flag. Discovered provider/AFT
		// extensions still load; only Magic Context's explicit ctx_* entry is absent.
		const args = buildArgsForTest({
			...baseOptions,
			agent: "historian",
			model: "anthropic/claude-sonnet",
		});
		// Neither --extension nor the legacy -x alias should appear when
		// the bundle isn't built (this test runs the source, not the
		// dist build). Pinning this is what lets us run unit tests
		// without a build step. -x was removed in Pi 0.71+ and now hard-fails.
		expect(args).not.toContain("--extension");
		expect(args).not.toContain("-x");
		expect(args).not.toContain("--magic-context-dreamer-actions");
	});

	it("does not set --magic-context-dreamer-actions for non-dreamer agents", () => {
		// Even if the bundle were present, only dreamer-equivalent agents should
		// receive ctx_memory in the child extension. Historian, sidekick,
		// compressor etc. stay without the dreamer flag.
		for (const agent of ["historian", "sidekick", "compressor", "recomp"]) {
			const args = buildArgsForTest({
				...baseOptions,
				agent,
				model: "anthropic/claude-sonnet",
			});
			expect(args).not.toContain("--magic-context-dreamer-actions");
		}
	});
});

describe("PiSubagentRunner spawn lifecycle", () => {
	it("refuses to spawn known zero-tool agents without a system prompt", async () => {
		const spawnImpl = mock(() => {
			throw new Error("spawn must not be reached");
		});
		// Replace the runner's test seam with a throwing spawn so this assertion
		// proves the guard runs before any child process is created.
		const guardedRunner = new PiSubagentRunner({
			piBinary: "pi-test",
			spawnImpl: spawnImpl as never,
		});

		for (const agent of ["dreamer-classifier", "dreamer-reviewer"]) {
			const result = await guardedRunner.run({
				...baseOptions,
				agent,
				systemPrompt: "  \n\t",
			});
			expect(result).toEqual({
				ok: false,
				reason: "invalid_prompt",
				transient: true,
				error: `zero-tool Pi subagent "${agent}" requires a non-empty system prompt`,
				durationMs: expect.any(Number),
			});
		}
		expect(spawnImpl).not.toHaveBeenCalled();
	});

	it("treats a terminal stop turn as success even when drain SIGTERM closes the child", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "looks done" }],
				stopReason: "stop",
			},
		});
		child.emitClose(null, "SIGTERM");

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "looks done",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});
	it("counts toolCall content parts from assistant message_end into toolCallCount (grounding gate)", async () => {
		// The grounding gate (refresh-primers) treats toolCallCount === 0 as a
		// closed-book paraphrase and refuses to commit. The count is derived from
		// `toolCall` CONTENT parts on assistant message_end turns — NOT a tool
		// event name. Pi has no `tool_result_end` (its real tool event is
		// `tool_execution_end`), so content-part counting is robust to event-name
		// drift. (Confirmed against Pi source via the PI peer.)
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		// Two intermediate tool-calling assistant turns (one toolCall part each).
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolName: "read", toolCallId: "c1" }],
				stopReason: "toolUse",
			},
		});
		// A toolResult message_end (role: "tool") must NOT be counted.
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "tool",
				content: [{ type: "toolResult", text: "read ok" }],
			},
		});
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", toolName: "grep", toolCallId: "c2" }],
				stopReason: "toolUse",
			},
		});
		// Terminal assistant turn: text only, no toolCall → not counted.
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "grounded answer" }],
				stopReason: "stop",
			},
		});
		child.emitClose(0);

		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.toolCallCount).toBe(2);
	});

	it("spawns pi, parses stdout, trims assistant text, and captures stderr", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { piBinary: "custom-pi" });

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			cwd: "/tmp/project",
		});
		child.writeStderr("warning from pi");
		child.writeStdoutLine({ type: "session", id: "s1" });
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "  final answer  " }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);

		const result = await resultPromise;

		expect(spawnImpl).toHaveBeenCalledWith(
			"custom-pi",
			expect.arrayContaining(["--model", "anthropic/claude-sonnet"]),
			expect.objectContaining({
				cwd: "/tmp/project",
				env: expect.objectContaining({
					MAGIC_CONTEXT_PI_SUBAGENT: "1",
					PATH: process.env.PATH,
				}),
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		expect(result).toEqual({
			ok: true,
			assistantText: "final answer",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: "warning from pi" },
		});
	});

	it("with no piBinary override, does not re-run an embedded host", async () => {
		// The Bun test file stands in for pi-web's Next.js argv[1].
		const child = createMockChild();
		const spawnImpl = mock(() => child as never);
		const { PiSubagentRunner } = await import("./subagent-runner");
		const runner = new PiSubagentRunner({ spawnImpl: spawnImpl as never });

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine({ type: "session", id: "s1" });
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);
		await resultPromise;

		expect(spawnImpl).toHaveBeenCalledTimes(1);
		const [command, spawnArgs, opts] = (
			spawnImpl.mock.calls as unknown[][]
		)[0] as [string, string[], { shell?: boolean }];
		expect(spawnArgs[0]).not.toBe(process.argv[1]);
		expect(spawnArgs).toContain("--no-session");
		expect(command.length).toBeGreaterThan(0);
		// Never spawned through a shell (no cmd.exe in the path = no arg-escaping
		// or injection on the untrusted prompt/task text).
		expect(opts.shell).toBeFalsy();
	});

	it("returns model_failed promptly for live terminal error stopReason", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run({ ...baseOptions, timeoutMs: 60_000 });
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "provider exploded",
			},
		});
		child.emitClose(null, "SIGTERM");

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "model_failed",
			error: "provider exploded",
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("returns model_failed when the final assistant stopReason is error", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStderr("provider failed");
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					stopReason: "error",
					errorMessage: "model overloaded",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "model_failed",
			error: "model overloaded",
			durationMs: expect.any(Number),
			meta: { stderr: "provider failed" },
		});
	});

	it("returns model_failed when the final assistant stopReason is aborted", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					stopReason: "aborted",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "model_failed",
			error: 'pi assistant stopped with reason "aborted"',
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("returns truncated when the final assistant stopReason is length", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					stopReason: "length",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "truncated",
			error: 'pi assistant stopped with reason "length"',
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("returns spawn_failed when spawn throws synchronously", async () => {
		const spawnImpl = mock(() => {
			throw new Error("ENOENT pi");
		});
		const runner = new PiSubagentRunner({ spawnImpl: spawnImpl as never });

		expect(await runner.run(baseOptions)).toEqual({
			ok: false,
			reason: "spawn_failed",
			error: "ENOENT pi",
			durationMs: expect.any(Number),
		});
	});

	it("writes the system prompt to a temp file path and removes it after success", async () => {
		const child = createMockChild();
		let promptPath: string | undefined;
		const spawnImpl = mock((_command: string, args: string[]) => {
			const promptFlagIndex = args.indexOf("--system-prompt");
			expect(promptFlagIndex).toBeGreaterThan(-1);
			promptPath = args[promptFlagIndex + 1];
			const systemPromptPath = requirePromptPath(promptPath);
			expect(systemPromptPath).not.toBe(baseOptions.systemPrompt);
			expect(isAbsolute(systemPromptPath)).toBe(true);
			expect(existsSync(systemPromptPath)).toBe(true);
			expect(readFileSync(systemPromptPath, "utf8")).toBe(
				baseOptions.systemPrompt,
			);
			return child as never;
		});
		const runner = new PiSubagentRunner({
			piBinary: "pi-test",
			spawnImpl: spawnImpl as never,
		});

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "ok",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		const systemPromptPath = requirePromptPath(promptPath);
		expect(existsSync(systemPromptPath)).toBe(false);
	});

	it("removes the temp system prompt file when spawn throws", async () => {
		let promptPath: string | undefined;
		const spawnImpl = mock((_command: string, args: string[]) => {
			const promptFlagIndex = args.indexOf("--system-prompt");
			expect(promptFlagIndex).toBeGreaterThan(-1);
			promptPath = args[promptFlagIndex + 1];
			expect(existsSync(requirePromptPath(promptPath))).toBe(true);
			throw new Error("ENOENT pi");
		});
		const runner = new PiSubagentRunner({
			piBinary: "pi-test",
			spawnImpl: spawnImpl as never,
		});

		expect(await runner.run(baseOptions)).toEqual({
			ok: false,
			reason: "spawn_failed",
			error: "ENOENT pi",
			durationMs: expect.any(Number),
		});
		const systemPromptPath = requirePromptPath(promptPath);
		expect(existsSync(systemPromptPath)).toBe(false);
	});

	it("pipes small win32 user messages through stdin instead of argv", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { platform: "win32" });
		const userMessage = "small win32 prompt";

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			userMessage,
		});
		await child.waitForStdinEnd();

		const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[] | undefined;
		const spawnOptions = spawnImpl.mock.calls[0]?.[2] as
			| { stdio?: [string, string, string] }
			| undefined;
		expect(spawnArgs).not.toContain(userMessage);
		expect(child.stdinText).toBe(userMessage);
		expect(spawnOptions?.stdio).toEqual(["pipe", "pipe", "pipe"]);

		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);
		await resultPromise;
	});

	it("keeps small linux user messages positional", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { platform: "linux" });
		const userMessage = "small linux prompt";

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			userMessage,
		});

		const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[] | undefined;
		const spawnOptions = spawnImpl.mock.calls[0]?.[2] as
			| { stdio?: [string, string, string] }
			| undefined;
		expect(spawnArgs?.at(-1)).toBe(userMessage);
		expect(child.stdinText).toBe("");
		expect(spawnOptions?.stdio).toEqual(["ignore", "pipe", "pipe"]);

		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);
		await resultPromise;
	});

	it("keeps win32 argv well under the CreateProcess limit with a large system prompt", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { platform: "win32" });
		const systemPrompt = "h".repeat(60 * 1024);

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			systemPrompt,
			userMessage: "hi",
		});
		await child.waitForStdinEnd();

		const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[] | undefined;
		expect(spawnArgs).toBeDefined();
		expect(spawnArgs?.join(" ").length ?? 0).toBeLessThan(32_767);
		expect(spawnArgs).not.toContain(systemPrompt);
		expect(spawnArgs).not.toContain("hi");

		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);
		await resultPromise;
	});

	it("returns spawn_failed when the child emits an error", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.emitError(new Error("permission denied"));

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "spawn_failed",
			error: "permission denied",
			durationMs: expect.any(Number),
		});
	});

	it("returns parse_failed for malformed stdout without agent_end", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStderr("bad json emitted");
		child.writeRawStdoutLine("{not-json");
		child.emitClose(0);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("parse_failed");
			expect(result.error).toContain("failed to parse event");
			expect(result.meta).toEqual({
				stderr: "bad json emitted",
				exitCode: 0,
				signal: null,
			});
		}
	});

	it("ignores malformed lines if a later agent_end succeeds", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeRawStdoutLine("not json");
		child.writeStdoutLine(
			agentEnd([
				{ role: "assistant", content: [{ type: "text", text: "recovered" }] },
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "recovered",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("returns no_assistant for agent_end without assistant messages", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(agentEnd([{ role: "user", content: [] }]));
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "no_assistant",
			error: "pi agent_end did not include an assistant message",
			durationMs: expect.any(Number),
			meta: { stderr: undefined, sawProtocolOutput: true },
		});
	});

	it("returns no_assistant for empty assistant text", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "   " }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "no_assistant",
			error: "pi assistant produced empty text",
			durationMs: expect.any(Number),
			meta: { stderr: undefined, sawProtocolOutput: true },
		});
	});

	it("returns no_assistant for empty stdout and successful exit", async () => {
		// Issue #238: an empty-stdout exit-0 primary now fires the one-shot
		// isolated retry. When the isolated attempt ALSO exits 0 with no output,
		// the run settles as no_assistant (the retry must not loop forever) and
		// carries the no-protocol-output marker.
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);

		const resultPromise = runner.run(baseOptions);
		first.emitClose(0);
		await nextTick();
		second.emitClose(0);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("no_assistant");
			expect(result.error).toContain("without emitting agent_end");
			expect(result.meta).toEqual({
				stderr: undefined,
				exitCode: 0,
				signal: null,
				sawProtocolOutput: false,
			});
		}
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
		expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
	});

	it("returns non_zero_exit with stderr and exit metadata", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStderr("auth missing");
		child.emitClose(7);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non_zero_exit");
			expect(result.error).toContain("code=7");
			expect(result.error).toContain("auth missing");
			expect(result.meta).toEqual({
				stderr: "auth missing",
				exitCode: 7,
				signal: null,
			});
		}
	});

	it("retries a translated provider with the canonical form after a missing-key exit", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);

		const resultPromise = runner.run({
			...baseOptions,
			model: "openai/gpt-5.5",
		});
		first.writeStderr(
			"No API key found for openai-codex. Use /login to authenticate.",
		);
		first.emitClose(1);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "direct API success" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "direct API success",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining(["--model", "openai-codex/gpt-5.5"]),
		);
		expect(spawnImpl.mock.calls[1]?.[1]).toEqual(
			expect.arrayContaining(["--model", "openai/gpt-5.5"]),
		);
	});

	it("caches the provider form that succeeds for later spawns", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const third = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second, third]);

		const firstRun = runner.run({ ...baseOptions, model: "openai/gpt-5.5" });
		first.writeStderr(
			"No API key found for openai-codex. Use /login to authenticate.",
		);
		first.emitClose(1);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "first direct success" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);
		await firstRun;

		const secondRun = runner.run({ ...baseOptions, model: "openai/gpt-5.4" });
		third.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "cached direct success" }],
					stopReason: "stop",
				},
			]),
		);
		third.emitClose(0);
		await secondRun;

		expect(spawnImpl).toHaveBeenCalledTimes(3);
		expect(spawnImpl.mock.calls[2]?.[1]).toEqual(
			expect.arrayContaining(["--model", "openai/gpt-5.4"]),
		);
	});

	it("does not provider-retry an unrelated stderr failure", async () => {
		const first = createMockChild();
		const { runner, spawnImpl } = runnerWith(first);

		const resultPromise = runner.run({
			...baseOptions,
			model: "openai/gpt-5.5",
		});
		first.writeStderr(
			"No API key found for another-provider. Check configuration.",
		);
		first.emitClose(1);

		const result = await resultPromise;
		expect(result.ok).toBe(false);
		expect(spawnImpl).toHaveBeenCalledTimes(1);
	});

	it("retries google's translated provider with canonical google", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);

		const resultPromise = runner.run({
			...baseOptions,
			model: "google/gemini-2.5-pro",
		});
		first.writeStderr(
			"No API key found for google-antigravity. Use /login to authenticate.",
		);
		first.emitClose(1);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "google API success" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);
		await resultPromise;

		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining(["--model", "google-antigravity/gemini-2.5-pro"]),
		);
		expect(spawnImpl.mock.calls[1]?.[1]).toEqual(
			expect.arrayContaining(["--model", "google/gemini-2.5-pro"]),
		);
	});

	it("bounds provider and extension retries to three spawns", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const third = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second, third]);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "openai/gpt-5.5",
			});
			first.writeStderr(
				"No API key found for openai-codex. Use /login to authenticate.",
			);
			first.emitClose(1);
			await nextTick();
			second.writeStderr(COLLISION_STDERR);
			second.emitClose(1);
			await nextTick();
			third.writeStdoutLine(
				agentEnd([
					{
						role: "assistant",
						content: [{ type: "text", text: "bounded success" }],
						stopReason: "stop",
					},
				]),
			);
			third.emitClose(0);

			expect(await resultPromise).toEqual({
				ok: true,
				assistantText: "bounded success",
				toolCallCount: 0,
				durationMs: expect.any(Number),
				meta: { stderr: undefined },
			});
			expect(spawnImpl).toHaveBeenCalledTimes(3);
			expect(spawnImpl.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["--model", "openai-codex/gpt-5.5"]),
			);
			expect(spawnImpl.mock.calls[1]?.[1]).toEqual(
				expect.arrayContaining(["--model", "openai/gpt-5.5"]),
			);
			expect(spawnImpl.mock.calls[1]?.[1]).not.toContain("--no-extensions");
			expect(spawnImpl.mock.calls[2]?.[1]).toEqual(
				expect.arrayContaining(["--model", "openai/gpt-5.5"]),
			);
			expect(spawnImpl.mock.calls[2]?.[1]).toContain("--no-extensions");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("retries once with --no-extensions after an extension turn collision", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/claude-sonnet",
			});
			first.writeStderr(COLLISION_STDERR);
			first.emitClose(1);
			await nextTick();
			second.writeStdoutLine(
				agentEnd([
					{
						role: "assistant",
						content: [{ type: "text", text: "isolated success" }],
						stopReason: "stop",
					},
				]),
			);
			second.emitClose(0);

			expect(await resultPromise).toEqual({
				ok: true,
				assistantText: "isolated success",
				toolCallCount: 0,
				durationMs: expect.any(Number),
				meta: { stderr: undefined },
			});
			expect(spawnImpl).toHaveBeenCalledTimes(2);
			expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
			expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
			expect(
				logSpy.mock.calls.some(
					(call) =>
						call[0] === "pi-subagent" && call[1] === ISOLATED_RETRY_LOG_MESSAGE,
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not retry forever when the isolated retry hits the same collision", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});
		first.writeStderr(COLLISION_STDERR);
		first.emitClose(1);
		await nextTick();
		second.writeStderr(COLLISION_STDERR);
		second.emitClose(1);

		const result = await resultPromise;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non_zero_exit");
			expect(result.meta).toEqual({
				stderr: COLLISION_STDERR,
				exitCode: 1,
				signal: null,
			});
		}
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
	});

	it("does not insert an isolated retry for unrelated failures", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback"],
		});
		first.writeStderr("auth missing");
		first.emitClose(1);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback success" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "fallback success",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
		expect(spawnImpl.mock.calls[1]?.[1]).not.toContain("--no-extensions");
		expect(spawnImpl.mock.calls[1]?.[1]).toEqual(
			expect.arrayContaining(["--model", "openai-codex/fallback"]),
		);
	});

	it("does not start a retry loop when the allowlist already disables discovery", async () => {
		const first = createMockChild();
		const { runner, spawnImpl } = runnerWith(first, {
			subagentExtensions: ["provider-package", "./provider.ts"],
		});
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/primary",
			});
			first.writeStderr(COLLISION_STDERR);
			first.emitClose(1);

			const result = await resultPromise;
			expect(result.ok).toBe(false);
			expect(spawnImpl).toHaveBeenCalledTimes(1);
			const args = spawnImpl.mock.calls[0]?.[1] as string[];
			expect(args.filter((arg) => arg === "--no-extensions")).toHaveLength(1);
			const firstExtension = args.indexOf("--extension");
			expect(args.slice(firstExtension, firstExtension + 4)).toEqual([
				"--extension",
				join(homedir(), ".pi/agent/provider-package"),
				"--extension",
				join(homedir(), ".pi/agent/provider.ts"),
			]);
			expect(
				logSpy.mock.calls.some(
					(call) => call[1] === ISOLATED_RETRY_LOG_MESSAGE,
				),
			).toBe(false);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not start a retry loop when the spawn already disables extensions", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second], {
			extraArgs: ["--no-extensions"],
		});
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/primary",
				fallbackModels: ["openai/fallback"],
			});
			first.writeStderr(COLLISION_STDERR);
			first.emitClose(1);
			await nextTick();
			second.writeStdoutLine(
				agentEnd([
					{
						role: "assistant",
						content: [{ type: "text", text: "fallback without retry loop" }],
						stopReason: "stop",
					},
				]),
			);
			second.emitClose(0);

			expect(await resultPromise).toEqual({
				ok: true,
				assistantText: "fallback without retry loop",
				toolCallCount: 0,
				durationMs: expect.any(Number),
				meta: { stderr: undefined },
			});
			expect(spawnImpl).toHaveBeenCalledTimes(2);
			expect(spawnImpl.mock.calls[0]?.[1]).toContain("--no-extensions");
			expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
			expect(
				logSpy.mock.calls.some(
					(call) => call[1] === ISOLATED_RETRY_LOG_MESSAGE,
				),
			).toBe(false);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("logs model-unavailable guidance when the isolated retry loses an extension-only model", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const { runner } = runnerWith([first, second]);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "openai/extension-model",
			});
			first.writeStderr(COLLISION_STDERR);
			first.emitClose(1);
			await nextTick();
			second.writeStderr("Unknown model openai-codex/extension-model");
			second.emitClose(1);

			const result = await resultPromise;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("non_zero_exit");
				expect(result.error).toContain(
					ISOLATED_RETRY_MODEL_UNAVAILABLE_LOG_MESSAGE,
				);
				expect(result.error).toContain("Original failure:");
			}
			expect(
				logSpy.mock.calls.some(
					(call) => call[1] === ISOLATED_RETRY_LOG_MESSAGE,
				),
			).toBe(true);
			expect(
				logSpy.mock.calls.some(
					(call) => call[1] === ISOLATED_RETRY_MODEL_UNAVAILABLE_LOG_MESSAGE,
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not keep isolated mode for the next run", async () => {
		const first = createMockChild();
		const second = createMockChild();
		const third = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second, third]);

		const degradedRun = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});
		first.writeStderr(COLLISION_STDERR);
		first.emitClose(1);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "isolated success" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);
		await degradedRun;

		const freshRun = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
		});
		third.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "extensions restored" }],
					stopReason: "stop",
				},
			]),
		);
		third.emitClose(0);

		expect(await freshRun).toEqual({
			ok: true,
			assistantText: "extensions restored",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
		expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
		expect(spawnImpl.mock.calls[2]?.[1]).not.toContain("--no-extensions");
	});

	it("retries once with --no-extensions after a silent exit-0 primary (no agent_end, zero stdout)", async () => {
		// Issue #238: certain user extension sets make Pi --print exit 0 with
		// ZERO stdout (no agent_end). The primary is classified no_assistant
		// with no protocol output, which must fire the one-shot isolated retry
		// instead of falling through every fallback model identically.
		const first = createMockChild();
		const second = createMockChild();
		const { runner, spawnImpl } = runnerWith([first, second]);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/claude-sonnet",
			});
			// Primary: exit 0, no stdout written at all.
			first.emitClose(0);
			await nextTick();
			second.writeStdoutLine(
				agentEnd([
					{
						role: "assistant",
						content: [{ type: "text", text: "isolated success" }],
						stopReason: "stop",
					},
				]),
			);
			second.emitClose(0);

			expect(await resultPromise).toEqual({
				ok: true,
				assistantText: "isolated success",
				toolCallCount: 0,
				durationMs: expect.any(Number),
				meta: { stderr: undefined },
			});
			expect(spawnImpl).toHaveBeenCalledTimes(2);
			expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
			expect(spawnImpl.mock.calls[1]?.[1]).toContain("--no-extensions");
			expect(
				logSpy.mock.calls.some(
					(call) =>
						call[0] === "pi-subagent" &&
						call[1] === ISOLATED_RETRY_SILENT_LOG_MESSAGE,
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not fire the isolated retry when agent_end arrived with empty assistant text", async () => {
		// A legitimate empty model response: Pi's machinery worked (agent_end
		// observed) but the model returned only whitespace. This is no_assistant
		// WITH protocol output, so it must fall through to fallback models rather
		// than spend the one-shot isolated retry.
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child);
		const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/claude-sonnet",
			});
			child.writeStdoutLine(
				agentEnd([
					{
						role: "assistant",
						content: [{ type: "text", text: "   " }],
						stopReason: "stop",
					},
				]),
			);
			child.emitClose(0);

			const result = await resultPromise;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("no_assistant");
				expect(result.meta).toEqual({
					stderr: undefined,
					sawProtocolOutput: true,
				});
			}
			// No isolated retry: exactly one spawn, discovery left enabled.
			expect(spawnImpl).toHaveBeenCalledTimes(1);
			expect(spawnImpl.mock.calls[0]?.[1]).not.toContain("--no-extensions");
			expect(
				logSpy.mock.calls.some(
					(call) => call[1] === ISOLATED_RETRY_SILENT_LOG_MESSAGE,
				),
			).toBe(false);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("isolated retry argv keeps explicit --extension entries while dropping discovered extensions", () => {
		// The one-shot isolated retry re-runs buildArgs with
		// disableDiscoveredExtensions: true. That must add --no-extensions (drop
		// DISCOVERED user extensions) WITHOUT removing explicit --extension
		// entries — the subagent-entry extension and any user-tier allowlist
		// entries — because those supply the models/tools the child needs.
		const args = buildArgsForTest(
			{
				...baseOptions,
				agent: "sidekick",
				model: "anthropic/claude-sonnet",
			},
			{
				disableDiscoveredExtensions: true,
				subagentEntryPath: "/tmp/subagent-entry.js",
				subagentExtensions: ["provider-package"],
			},
		);

		expect(args).toContain("--no-extensions");
		expect(args).toEqual(
			expect.arrayContaining(["--extension", "/tmp/subagent-entry.js"]),
		);
		expect(args).toEqual(
			expect.arrayContaining([
				"--extension",
				join(homedir(), ".pi/agent/provider-package"),
			]),
		);
	});

	it("returns parse_failed when stdout is missing", async () => {
		const child = createMockChild({ stdout: false });
		const { runner } = runnerWith(child);

		expect(await runner.run(baseOptions)).toEqual({
			ok: false,
			reason: "parse_failed",
			error: "pi child process did not expose stdout (stdio misconfigured)",
			durationMs: expect.any(Number),
		});
	});

	it("passes fallback models, cwd, prompt arguments, and merged subagent env through spawn", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child);

		const resultPromise = runner.run({
			...baseOptions,
			// Historian now has an explicit read-only --tools allow-list; this asserts
			// that spawn plumbing still passes model/cwd/prompt/env through around it.
			agent: "historian",
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback"],
			cwd: "/workspace/project",
			timeoutMs: 500,
		});
		child.writeStdoutLine(
			agentEnd([
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]),
		);
		child.emitClose(0);
		await resultPromise;

		expect(spawnImpl).toHaveBeenCalledWith(
			"pi-test",
			expect.any(Array),
			expect.objectContaining({
				cwd: "/workspace/project",
				env: expect.objectContaining({
					...process.env,
					MAGIC_CONTEXT_PI_SUBAGENT: "1",
				}),
			}),
		);
		const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[] | undefined;
		expect(spawnArgs).toEqual([
			"--print",
			"--mode",
			"json",
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--tools",
			"read,grep,find,ls,aft_search",
			"--system-prompt",
			expect.stringMatching(/system-prompt\.txt$/),
			"--model",
			"anthropic/primary",
			// No --thinking: thinkingLevel not set in options above.
			"summarize this session",
		]);
		const spawnOptions = spawnImpl.mock.calls[0]?.[2] as
			| { env?: NodeJS.ProcessEnv }
			| undefined;
		expect(spawnOptions?.env).not.toBe(process.env);
	});

	it("keeps the Magic Context env guard when the extension allowlist is active", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, {
			subagentExtensions: ["provider-package"],
		});

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/model",
		});
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "allowlisted" }],
					stopReason: "stop",
				},
			]),
		);
		child.emitClose(0);
		await resultPromise;

		const spawnOptions = spawnImpl.mock.calls[0]?.[2] as
			| { env?: NodeJS.ProcessEnv }
			| undefined;
		expect(spawnOptions?.env).toEqual(
			expect.objectContaining({ MAGIC_CONTEXT_PI_SUBAGENT: "1" }),
		);
	});

	it("does not let a post-terminal child signal override captured success", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "looks done" }],
					stopReason: "stop",
				},
			]),
		);
		child.writeStderr("process reported late noise");
		child.emitClose(null, "SIGTERM");

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "looks done",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: "process reported late noise" },
		});
	});

	it("retries fallback models by spawning fresh children", async () => {
		const first = createMockChild();
		const second = createMockChild();
		let spawnCount = 0;
		const spawnImpl = mock(() => {
			spawnCount += 1;
			return (spawnCount === 1 ? first : second) as never;
		});
		const runner = new PiSubagentRunner({
			piBinary: "pi-test",
			spawnImpl: spawnImpl as never,
		});

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback"],
		});
		first.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "bad" }],
					stopReason: "error",
				},
			]),
		);
		first.emitClose(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "good" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "good",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		expect(spawnImpl.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining(["--model", "anthropic/primary"]),
		);
		// The canonical (OpenCode) `openai/` provider is translated to Pi's
		// `openai-codex/` form at the spawn boundary.
		expect(spawnImpl.mock.calls[1]?.[1]).toEqual(
			expect.arrayContaining(["--model", "openai-codex/fallback"]),
		);
	});

	it("retries fallback models after empty assistant text", async () => {
		const first = createMockChild();
		const second = createMockChild();
		let spawnCount = 0;
		const spawnImpl = mock(() => {
			spawnCount += 1;
			return (spawnCount === 1 ? first : second) as never;
		});
		const runner = new PiSubagentRunner({
			piBinary: "pi-test",
			spawnImpl: spawnImpl as never,
		});

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback"],
		});
		first.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: " " }],
					stopReason: "stop",
				},
			]),
		);
		first.emitClose(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback text" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "fallback text",
			toolCallCount: 0,
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
		expect(spawnImpl).toHaveBeenCalledTimes(2);
	});

	it("returns timeout and terminates a child that never closes", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const result = await runner.run({ ...baseOptions, timeoutMs: 20 });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("timeout");
			expect(result.error).toContain("20ms");
		}
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.killSignals).toEqual(["SIGTERM"]);
	});

	it("returns abort without spawning when caller signal is already aborted", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child);
		const controller = new AbortController();
		controller.abort();

		const result = await runner.run({
			...baseOptions,
			signal: controller.signal,
		});

		expect(spawnImpl).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("abort");
		}
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("returns abort and terminates the child when the caller signal aborts", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child);
		const controller = new AbortController();

		const resultPromise = runner.run({
			...baseOptions,
			signal: controller.signal,
		});
		controller.abort();

		const result = await resultPromise;

		expect(spawnImpl).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("abort");
			expect(result.error).toContain("aborted by caller");
		}
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.killSignals).toEqual(["SIGTERM"]);
	});

	it("does not send SIGKILL when child exits after SIGTERM before escalation timeout", async () => {
		const child = createMockChild();

		__test.terminateChild(child as never);
		child.emitExit(0, null);
		await new Promise((resolve) => setTimeout(resolve, 2100));

		expect(child.killSignals).toEqual(["SIGTERM"]);
	});

	it("sends SIGKILL when child remains alive past escalation timeout", async () => {
		const child = createMockChild();

		__test.terminateChild(child as never);
		await new Promise((resolve) => setTimeout(resolve, 2100));

		expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("Pi subagent schema-fence probe", () => {
	it("does not spawn a Pi child when the shared database is newer than this build", async () => {
		const dataHome = mkdtempSync(join(tmpdir(), "mc-pi-fence-probe-"));
		try {
			process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataHome;
			process.env.XDG_DATA_HOME = dataHome;
			closeDatabase();
			__resetSchemaFenceStateForTests();
			const db = openDatabase();
			if (!db) throw new Error("expected a fresh test database");
			db.prepare(
				"INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)",
			).run(LATEST_SUPPORTED_VERSION + 1, "future schema", Date.now());

			const { runner, spawnImpl } = runnerWith(createMockChild());
			const result = await runner.run(baseOptions);

			// Removing the pre-spawn probe makes this fake process launch, so the
			// assertion proves Pi shares the stale-build fence rather than merely
			// returning a matching failure from a later path.
			expect(spawnImpl).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				ok: false,
				reason: "spawn_failed",
				error: expect.stringContaining(
					"plugin build is older than its database",
				),
			});
		} finally {
			closeDatabase();
			__resetSchemaFenceStateForTests();
			if (originalTestDataDir === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
			if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdgDataHome;
			rmSync(dataHome, { recursive: true, force: true });
		}
	});
});
