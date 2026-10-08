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
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import {
	__resetSchemaFenceStateForTests,
	LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { getSubagentInvocations } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import * as loggerModule from "@magic-context/core/shared/logger";
import type { SubagentRunOptions } from "@magic-context/core/shared/subagent-runner";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	__test,
	configurePiSubagentHostTools,
	PiSubagentRunner,
} from "./subagent-runner";

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
	__setPiHarnessKindForTesting(undefined);
	__test.resetProviderFormCache();
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	__test.resetHostToolState();
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
		invocation,
		platform,
		extraArgs,
		subagentExtensions,
		getHostToolNames,
	}: {
		piBinary?: string;
		invocation?: {
			command: string;
			prefixArgs: string[];
			targetHarness: "pi" | "omp";
			fallbackDiagnostic?: string;
		};
		platform?: NodeJS.Platform;
		extraArgs?: readonly string[];
		subagentExtensions?: readonly string[];
		getHostToolNames?: () => readonly string[] | undefined;
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
		invocation,
		platform,
		extraArgs,
		subagentExtensions,
		getHostToolNames,
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
		historianCalibrationEntryPath: null,
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

function writePiCliFixture(bin: string, useBinShim = false) {
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-pi-cli-layout-"));
	const packageRoot = join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	const cliPath = join(packageRoot, bin);
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(dirname(cliPath), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: bin },
		}),
	);
	writeFileSync(cliPath, "#!/usr/bin/env node\n");
	if (!useBinShim) return { root, packageRoot, cliPath, entry: cliPath };

	const shim = join(root, "bin", "pi");
	mkdirSync(dirname(shim), { recursive: true });
	symlinkSync(cliPath, shim);
	return { root, packageRoot, cliPath, entry: shim };
}

// OMP (@oh-my-pi/pi-coding-agent) declares `bin: { omp: "dist/cli.js" }` and
// ships no `pi` bin. The resolver must accept the `omp` key so an OMP host
// without a standalone `pi` on PATH still spawns its own CLI instead of the
// bare `pi` fallback (which ENOENTs).
function writeOmpCliFixture(bin: string, useBinShim = false) {
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-omp-cli-layout-"));
	const packageRoot = join(
		root,
		"node_modules",
		"@oh-my-pi",
		"pi-coding-agent",
	);
	const cliPath = join(packageRoot, bin);
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(dirname(cliPath), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			bin: { omp: bin },
		}),
	);
	writeFileSync(cliPath, "#!/usr/bin/env node\n");
	if (!useBinShim) return { root, packageRoot, cliPath, entry: cliPath };

	const shim = join(root, "bin", "omp");
	mkdirSync(dirname(shim), { recursive: true });
	symlinkSync(cliPath, shim);
	return { root, packageRoot, cliPath, entry: shim };
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

	it.each([
		["legacy dist layout", "dist/cli.js"],
		["bundled dist layout", "dist/bundle/cli.js"],
	])("resolves the %s through package.json bin", (_label, bin) => {
		const fixture = writePiCliFixture(bin);
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node.exe",
				argv1: fixture.entry,
				platform: "win32",
				resolvePackageJson: () => null,
			});
			expect(invocation).toEqual({
				command: "/runtime/node.exe",
				prefixArgs: [realpathSync(fixture.cliPath)],
				targetHarness: "pi",
			});
			expect(__test.isPiCliScript(fixture.entry)).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("resolves a bundled CLI from the running module paths' package.json", () => {
		const fixture = writePiCliFixture("dist/bundle/cli.js");
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: "/embedded-host/start.js",
				resolvePackageJson: () => join(fixture.packageRoot, "package.json"),
			});
			expect(invocation).toEqual({
				command: "/runtime/node",
				prefixArgs: [realpathSync(fixture.cliPath)],
				targetHarness: "pi",
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("resolves a bin-shim symlink to the package-declared Pi CLI", () => {
		const fixture = writePiCliFixture("dist/bundle/cli.js", true);
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			expect(invocation).toEqual({
				command: "/runtime/node",
				prefixArgs: [realpathSync(fixture.cliPath)],
				targetHarness: "pi",
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("resolves the global OMP bin shim via bin.omp, never the bare pi fallback", () => {
		// npm installs `omp` as a symlink to the package's `bin.omp` entry. Follow
		// that real layout so the target harness comes from the resolved package,
		// not merely from an entry path whose basename happens to contain `omp`.
		const fixture = writeOmpCliFixture("dist/cli.js", true);
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			expect(invocation).toEqual({
				command: "/runtime/node",
				prefixArgs: [realpathSync(fixture.cliPath)],
				targetHarness: "omp",
			});
			expect(invocation.command).not.toBe("pi");
			expect(invocation.fallbackDiagnostic).toBeUndefined();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("uses OMP argv when the resolved binary is OMP despite a Pi host label", () => {
		const fixture = writeOmpCliFixture("dist/cli.js");
		try {
			__setPiHarnessKindForTesting("pi");
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			const args = buildArgsForTest(baseOptions, {
				targetHarness: invocation.targetHarness,
			});

			expect(args).toContain("--no-rules");
			expect(args).not.toContain("--no-prompt-templates");
			expect(args).not.toContain("--no-context-files");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("uses Pi argv when the resolved binary is Pi despite an OMP host label", () => {
		const fixture = writePiCliFixture("dist/cli.js");
		try {
			__setPiHarnessKindForTesting("omp");
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			const args = buildArgsForTest(baseOptions, {
				targetHarness: invocation.targetHarness,
			});

			expect(args).toContain("--no-prompt-templates");
			expect(args).toContain("--no-context-files");
			expect(args).not.toContain("--no-rules");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("keeps resolving a Pi host via bin.pi unchanged", () => {
		const fixture = writePiCliFixture("dist/cli.js");
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			expect(invocation).toEqual({
				command: "/runtime/node",
				prefixArgs: [realpathSync(fixture.cliPath)],
				targetHarness: "pi",
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("still resolves a string bin (no object map)", () => {
		const root = createTestTempDirFromPath(join(tmpdir(), "mc-pi-string-bin-"));
		const packageRoot = join(
			root,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		const cliPath = join(packageRoot, "dist/cli.js");
		mkdirSync(dirname(cliPath), { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: "dist/cli.js",
			}),
		);
		writeFileSync(cliPath, "#!/usr/bin/env node\n");
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: cliPath,
				resolvePackageJson: () => null,
			});
			expect(invocation).toEqual({
				command: "/runtime/node",
				prefixArgs: [realpathSync(cliPath)],
				targetHarness: "pi",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls through to the bare pi fallback when the manifest has neither bin.pi nor bin.omp", () => {
		const root = createTestTempDirFromPath(join(tmpdir(), "mc-pi-no-bin-"));
		const packageRoot = join(
			root,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		const cliPath = join(packageRoot, "dist/cli.js");
		mkdirSync(dirname(cliPath), { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { other: "dist/cli.js" },
			}),
		);
		writeFileSync(cliPath, "#!/usr/bin/env node\n");
		try {
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: cliPath,
				resolvePackageJson: () => null,
			});
			expect(invocation.command).toBe("pi");
			expect(invocation.fallbackDiagnostic).toContain("script-detection miss");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back with a self-diagnosing miss when no Pi package resolves", () => {
		const invocation = __test.resolvePiInvocation({
			execPath: "/runtime/node",
			argv1: "/not-a-pi-host/cli.js",
			resolvePackageJson: () => null,
		});
		expect(invocation.command).toBe("pi");
		expect(invocation.fallbackDiagnostic).toContain(
			"script-detection miss on /not-a-pi-host/cli.js",
		);
	});

	it("rejects a package bin that escapes its package root", () => {
		const fixture = writePiCliFixture("../outside-cli.js");
		try {
			writeFileSync(
				join(fixture.root, "node_modules", "@earendil-works", "outside-cli.js"),
				"",
			);
			const invocation = __test.resolvePiInvocation({
				execPath: "/runtime/node",
				argv1: fixture.entry,
				resolvePackageJson: () => null,
			});
			expect(invocation.command).toBe("pi");
			expect(invocation.fallbackDiagnostic).toContain("outside-cli.js");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it.each([
		[".EXE", "/Pi/pi.exe", "/Pi/pi.exe", []],
		[".CMD", "/Pi/pi.cmd", "cmd.exe", ["/d", "/s", "/c", "/Pi/pi.cmd"]],
		[
			".PS1",
			"/Pi/pi.ps1",
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "/Pi/pi.ps1"],
		],
	])("uses the PATHEXT-resolved %s Pi command without shell:true", (extension, expectedPath, command, prefixArgs) => {
		const invocation = __test.resolvePiInvocation({
			execPath: "/runtime/node.exe",
			argv1: "/not-a-pi-host/cli.js",
			platform: "win32",
			env: { PATH: "/Pi", PATHEXT: extension },
			resolvePackageJson: () => null,
			fs: {
				existsSync: (path) => path === expectedPath,
				statSync: () => ({ isFile: () => true }),
			},
		});
		expect(invocation.command).toBe(command);
		expect(invocation.prefixArgs).toEqual(prefixArgs);
		expect(invocation.fallbackDiagnostic).toContain(
			`Windows PATHEXT resolved ${expectedPath}`,
		);
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
			// `--no-session` keeps historian, dreamer, recomp, and compressor
			// child sessions out of `pi resume`
			// and the session picker (uses Pi's
			// SessionManager.inMemory()).
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-tools",
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

	it("loads the calibration and provenance extension for historian and dreamer requests", () => {
		const historian = buildArgsForTest(
			{ ...baseOptions, agent: "magic-context-historian" },
			{ historianCalibrationEntryPath: "/tmp/historian-calibration.js" },
		);
		expect(historian).toEqual(
			expect.arrayContaining(["--extension", "/tmp/historian-calibration.js"]),
		);
		const dreamer = buildArgsForTest(
			{ ...baseOptions, agent: "dreamer" },
			{ historianCalibrationEntryPath: "/tmp/historian-calibration.js" },
		);
		expect(dreamer).toContain("/tmp/historian-calibration.js");
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
				agent: "dreamer-retrospective",
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
		__setPiHarnessKindForTesting("omp");
		const root = createTestTempDirFromPath(
			join(homedir(), ".mc-omp-host-test-"),
		);
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
		__setPiHarnessKindForTesting("omp");
		const root = createTestTempDirFromPath(
			join(homedir(), ".mc-omp-default-host-test-"),
		);
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
		__setPiHarnessKindForTesting("omp");
		const root = createTestTempDirFromPath(
			join(homedir(), ".mc-omp-profile-host-test-"),
		);
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
			args.indexOf("--no-tools"),
		);
	});

	it("emits only OMP-supported startup flags and tool names on an OMP host", () => {
		__setPiHarnessKindForTesting("omp");
		const root = createTestTempDirFromPath(
			join(homedir(), ".mc-omp-argv-test-"),
		);
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
			expect(historianArgs).toEqual(expect.arrayContaining(["--no-tools"]));

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
		// hidden subagents is that historian/dreamer runs never
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

	it("locks every historian variant to zero tools even with discovered extensions", () => {
		for (const agent of [
			"magic-context-historian",
			"historian",
			"historian-recomp",
			"historian-editor",
		]) {
			const args = buildArgsForTest({ ...baseOptions, agent });
			expect(args).toContain("--no-tools");
			expect(args).not.toContain("--tools");
			expect(args).not.toContain("--no-extensions");
			expect(__test.STRICT_TOOL_ALLOWLIST.get(agent)).toEqual([]);
		}
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

	it("intersects OMP built-ins with the host registry when grep or glob is disabled", () => {
		const readOnlyTools = ["read", "grep", "find", "ls"];
		expect(
			__test.resolveHostToolAllowlist(readOnlyTools, true, ["read", "glob"]),
		).toEqual(["read", "glob"]);
		expect(
			__test.resolveHostToolAllowlist(readOnlyTools, true, ["read", "grep"]),
		).toEqual(["read", "grep"]);
		expect(
			__test.resolveHostToolAllowlist(readOnlyTools, false, [
				"read",
				"find",
				"ls",
			]),
		).toEqual(["read", "find", "ls"]);
		expect(__test.resolveHostToolAllowlist(readOnlyTools, true, [])).toEqual(
			[],
		);

		const args = buildArgsForTest(
			{ ...baseOptions, agent: "dreamer-memory-mapper" },
			{ targetHarness: "omp", hostToolNames: [] },
		);
		expect(args).toContain("--no-tools");
		expect(args).not.toContain("--tools");
	});

	it("locks base dreamer (curate) to the two memory tools, stripping all built-ins", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("ctx_memory,ctx_memory_list");
		expect(args).not.toContain("--no-tools");
		// No codebase/shell built-ins survive the allow-list. (The memory tools are
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

	it("locks magic-context-dreamer (Pi facade default) to the two memory tools", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "magic-context-dreamer",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("ctx_memory,ctx_memory_list");
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

	it("locks dreamer-docs to read-only file tools and optional AFT reads", () => {
		const args = buildArgsForTest({
			...baseOptions,
			agent: "dreamer-docs",
			model: "anthropic/claude-sonnet",
		});
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe(
			"read,grep,find,ls,aft_outline,aft_zoom,aft_search",
		);
		expect(args).not.toContain("--no-tools");
		// No shell, writing, memory tools or extension are available.
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
			expect(tools).toEqual([]);
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
		// receive ctx_memory in the child extension. Historian, compressor,
		// and recomp agents stay without the dreamer flag.
		for (const agent of ["historian", "compressor", "recomp"]) {
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
	it("records OMP message_end usage in subagent_invocations", async () => {
		__setPiHarnessKindForTesting("omp");
		const child = createMockChild();
		const { runner } = runnerWith(child, {
			invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		});
		const testDataDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-accounting-"),
		);
		const previousTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		const previousXdgDataHome = process.env.XDG_DATA_HOME;
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
		process.env.XDG_DATA_HOME = testDataDir;
		closeDatabase();
		try {
			const resultPromise = runner.run({
				...baseOptions,
				model: "anthropic/claude-sonnet",
				accountingSessionId: "omp-accounting-session",
				accountingSubagent: "historian",
			});
			child.writeStdoutLine({
				// Captured OMP 18.1.11 shape: usage lives on each assistant
				// message_end message, including intermediate tool turns.
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", id: "call-1" }],
					stopReason: "toolUse",
					usage: {
						input: 1_200,
						output: 80,
						cacheRead: 300,
						cacheWrite: 20,
						totalTokens: 1_600,
						reasoningTokens: 10,
						cost: { input: 0.01 },
					},
				},
			});
			child.writeStdoutLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: {
						input: 400,
						output: 30,
						cacheRead: 100,
						cacheWrite: 5,
						totalTokens: 535,
						reasoningTokens: 4,
						cost: { output: 0.02 },
					},
				},
			});
			child.emitClose(0);

			expect(await resultPromise).toMatchObject({
				ok: true,
				assistantText: "done",
			});
			const db = openDatabase();
			if (!db) throw new Error("accounting test database did not open");
			const [row] = getSubagentInvocations(db, "omp-accounting-session");
			expect(row).toMatchObject({
				harness: "omp",
				inputTokens: 1_600,
				outputTokens: 110,
				cacheReadTokens: 400,
				cacheWriteTokens: 25,
			});
		} finally {
			closeDatabase();
			if (previousTestDataDir === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previousTestDataDir;
			if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previousXdgDataHome;
			rmSync(testDataDir, { recursive: true, force: true });
		}
	});

	it("keeps successful OMP invocation at zero tokens when stream omits usage", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child, {
			invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		});
		const testDataDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-accounting-empty-"),
		);
		const previousTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		const previousXdgDataHome = process.env.XDG_DATA_HOME;
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testDataDir;
		process.env.XDG_DATA_HOME = testDataDir;
		closeDatabase();
		try {
			const resultPromise = runner.run({
				...baseOptions,
				accountingSessionId: "omp-accounting-empty",
				accountingSubagent: "historian",
			});
			child.writeStdoutLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				},
			});
			child.emitClose(0);

			expect(await resultPromise).toMatchObject({
				ok: true,
				assistantText: "done",
			});
			const db = openDatabase();
			if (!db) throw new Error("accounting test database did not open");
			const [row] = getSubagentInvocations(db, "omp-accounting-empty");
			expect(row).toMatchObject({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
		} finally {
			closeDatabase();
			if (previousTestDataDir === undefined)
				delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
			else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previousTestDataDir;
			if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previousXdgDataHome;
			rmSync(testDataDir, { recursive: true, force: true });
		}
	});

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

	it("surfaces the checked paths when the bare Pi fallback ENOENTs", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child, {
			invocation: {
				command: "pi",
				prefixArgs: [],
				targetHarness: "pi",
				fallbackDiagnostic:
					"script-detection miss on /host/cli.js, /host/node_modules/@earendil-works/pi-coding-agent/package.json",
			},
		});

		const resultPromise = runner.run(baseOptions);
		child.emitError(new Error("spawn pi ENOENT"));

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "spawn_failed",
			error:
				"spawn pi ENOENT after script-detection miss on /host/cli.js, /host/node_modules/@earendil-works/pi-coding-agent/package.json",
			durationMs: expect.any(Number),
		});
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

	it("accepts a tool-only dreamer run after a completed ctx_memory result", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run({ ...baseOptions, agent: "dreamer" });
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "curate-1",
						name: "ctx_memory",
						arguments: { action: "archive" },
					},
				],
				stopReason: "toolUse",
			},
		});
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "curate-1",
				toolName: "ctx_memory",
				content: [{ type: "text", text: "Archived memory." }],
				isError: false,
			},
		});
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: true,
			assistantText: "",
			toolCallCount: 1,
			completedToolCalls: [
				{ name: "ctx_memory", arguments: { action: "archive" } },
			],
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("rejects a tool-only dreamer run when ctx_memory returned an error", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run({ ...baseOptions, agent: "dreamer" });
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "curate-error",
						name: "ctx_memory",
						arguments: { action: "archive" },
					},
				],
				stopReason: "toolUse",
			},
		});
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "curate-error",
				toolName: "ctx_memory",
				content: [{ type: "text", text: "Archive rejected." }],
				isError: true,
			},
		});
		child.emitClose(0);

		const result = await resultPromise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no_assistant");
	});

	it("spawns pi, parses stdout, trims assistant text, and captures stderr", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { piBinary: "custom-pi" });

		const resultPromise = runner.run({
			...baseOptions,
			model: "anthropic/claude-sonnet",
			cwd: "/tmp/project",
			temperature: 0.1,
			maxOutputTokens: 32_000,
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
					MAGIC_CONTEXT_HISTORIAN_TEMPERATURE: "0.1",
					MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS: "32000",
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

	it("keeps a multibyte stderr character intact when it spans two chunks", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);
		const progressChunks: string[] = [];

		const resultPromise = runner.run({
			...baseOptions,
			onProgress: (event) => {
				if (event.type === "stderr") progressChunks.push(event.chunk);
			},
		});
		// "é" is 0xC3 0xA9 in UTF-8; a pipe may deliver the two bytes apart.
		const bytes = Buffer.from("café — failed\n", "utf8");
		child.stderr.write(bytes.subarray(0, 4));
		child.stderr.write(bytes.subarray(4));
		child.emitClose(1);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		expect(result.meta?.stderr).toBe("café — failed\n");
		expect(progressChunks.join("")).toBe("café — failed\n");
	});

	it("preserves an explicit zero historian temperature in the child environment", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, { piBinary: "custom-pi" });
		const resultPromise = runner.run({
			...baseOptions,
			model: "test/historian",
			temperature: 0,
		});
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

		const [, , spawnOptions] = (spawnImpl.mock.calls as unknown[][])[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		expect(spawnOptions.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE).toBe("0");
	});

	it("omits historian temperature from the spawned child environment when unspecified", async () => {
		const previousTemperature = process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE;
		delete process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE;
		try {
			const child = createMockChild();
			const { runner, spawnImpl } = runnerWith(child, {
				piBinary: "custom-pi",
			});
			const resultPromise = runner.run({
				...baseOptions,
				model: "test/historian",
			});
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

			const [, , spawnOptions] = (spawnImpl.mock.calls as unknown[][])[0] as [
				string,
				string[],
				{ env: NodeJS.ProcessEnv },
			];
			expect(spawnOptions.env).not.toHaveProperty(
				"MAGIC_CONTEXT_HISTORIAN_TEMPERATURE",
			);
		} finally {
			if (previousTemperature === undefined)
				delete process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE;
			else
				process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE = previousTemperature;
		}
	});

	it("with no piBinary override, spawns the host runtime + cli.js (Windows-safe, #177)", async () => {
		// Default resolution must NOT spawn a bare "pi" (which ENOENTs on Windows
		// because npm installs a pi.cmd shim, not a literal pi). It re-invokes the
		// exact host CLI: process.execPath + process.argv[1], with no shell.
		const root = createTestTempDirFromPath(join(tmpdir(), "mc-pi-cli-"));
		const distDir = join(
			root,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
		);
		const cliPath = join(distDir, "cli.js");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(
			join(dirname(distDir), "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "dist/cli.js" },
			}),
		);
		writeFileSync(cliPath, "");
		const previousScript = process.argv[1];
		process.argv[1] = cliPath;
		try {
			const child = createMockChild();
			const spawnImpl = mock(() => child as never);
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

			const [command, spawnArgs, opts] = (
				spawnImpl.mock.calls as unknown[][]
			)[0] as [string, string[], { shell?: boolean }];
			expect(command).toBe(process.execPath);
			expect(spawnArgs[0]).toBe(realpathSync(cliPath));
			// Crucially, never a bare "pi".
			expect(command).not.toBe("pi");
			expect(opts.shell).toBeFalsy();
		} finally {
			if (previousScript === undefined) delete process.argv[1];
			else process.argv[1] = previousScript;
			rmSync(root, { recursive: true, force: true });
		}
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

		const resultPromise = runner.run({ ...baseOptions, maxOutputTokens: 32 });
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					usage: { input: 5, output: 32, cacheRead: 0, cacheWrite: 1 },
					stopReason: "length",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "truncated",
			error:
				'pi assistant stopped with reason "length"; tokens={"input":5,"output":32,"reasoning":null,"cache_read":0,"cache_write":1,"max_tokens":32,"finish_reason":"length"}',
			durationMs: expect.any(Number),
			meta: { stderr: undefined },
		});
	});

	it("returns spawn_failed when spawn throws synchronously", async () => {
		const spawnImpl = mock(() => {
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

	it("surfaces the provider error behind empty assistant text", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage:
						"OpenAI API error (400): Unsupported parameter: temperature",
				},
			]),
		);
		child.emitClose(0);

		expect(await resultPromise).toEqual({
			ok: false,
			reason: "no_assistant",
			error:
				"pi assistant produced empty text (provider error: OpenAI API error (400): Unsupported parameter: temperature)",
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

	it("surfaces the error behind a bundled source line on non-zero exit", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);
		const sourceLine =
			// The literal `${VERSION2}` imitates minified source text quoted by a
			// stack trace; it is data, not an interpolation.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture reproduces raw source text
			`263 | ${"FROM cacheInterceptorV${VERSION2} ".repeat(100)}`.slice(
				0,
				3_000,
			);
		const stderr = [
			sourceLine,
			"^",
			"SqliteError: database is locked",
			"    at openDatabase (bundle.js:100:20)",
			"    at runHistorian (runner.js:12:4)",
		].join("\n");

		const resultPromise = runner.run(baseOptions);
		child.writeStderr(stderr);
		child.emitClose(1);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non_zero_exit");
			expect(result.error).toContain("SqliteError: database is locked");
			expect(result.error).not.toContain(sourceLine);
			expect(result.error).toContain("at openDatabase (bundle.js:100:20)");
		}
	});

	it("keeps the tail when a chatty child exceeds the stderr buffer cap", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);
		const stderr = `${"head-only\n".repeat(2_000)}${"tail-only\n".repeat(2_000)}`;

		const resultPromise = runner.run(baseOptions);
		child.writeStderr(stderr);
		child.emitClose(7);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non_zero_exit");
			expect(result.error).toContain("tail-only");
			expect(result.error).not.toContain("head-only");
			expect(result.meta?.stderr).toContain("tail-only");
			expect(result.meta?.stderr).not.toContain("head-only");
		}
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
				agent: "dreamer-retrospective",
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
			"--no-tools",
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

	it("plain Pi never reads a loading-phase host tool registry", async () => {
		const getTools = mock(() => {
			throw new Error(
				"Extension runtime not initialized. Action methods cannot be called during extension loading.",
			);
		});
		configurePiSubagentHostTools(getTools);
		for (const agent of [
			"historian",
			"historian-recomp",
			"dreamer-memory-mapper",
		]) {
			const child = createMockChild();
			const { runner, spawnImpl } = runnerWith(child, {
				invocation: { command: "pi-test", prefixArgs: [], targetHarness: "pi" },
				getHostToolNames: getTools,
			});
			const result = runner.run({ ...baseOptions, agent });
			child.writeStdoutLine(
				agentEnd([
					{ role: "assistant", content: [{ type: "text", text: "done" }] },
				]),
			);
			child.emitClose(0);
			expect((await result).ok).toBe(true);
			expect(spawnImpl).toHaveBeenCalledTimes(1);
			if (agent === "dreamer-memory-mapper") {
				const args = spawnImpl.mock.calls[0]?.[1] as string[];
				expect(args[args.indexOf("--tools") + 1]).toBe(
					"read,grep,find,ls,aft_outline,aft_zoom,aft_search",
				);
			}
		}
		expect(getTools).not.toHaveBeenCalled();
	});

	it("OMP launches with its normal tools when the host registry is not initialized", async () => {
		configurePiSubagentHostTools(() => {
			throw new Error(
				"Extension runtime not initialized. Action methods cannot be called during extension loading.",
			);
		});
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, {
			invocation: { command: "omp-test", prefixArgs: [], targetHarness: "omp" },
		});
		const result = runner.run({
			...baseOptions,
			agent: "dreamer-memory-mapper",
		});
		child.writeStdoutLine(
			agentEnd([
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]),
		);
		child.emitClose(0);
		expect((await result).ok).toBe(true);
		const args = spawnImpl.mock.calls[0]?.[1] as string[];
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,glob");
	});

	it("applies the host tool intersection to fallback child invocations", async () => {
		const first = createMockChild();
		const second = createMockChild();
		let spawnCount = 0;
		const spawnImpl = mock(() => {
			spawnCount += 1;
			return (spawnCount === 1 ? first : second) as never;
		});
		const runner = new PiSubagentRunner({
			invocation: {
				command: "omp-test",
				prefixArgs: [],
				targetHarness: "omp",
			},
			getHostToolNames: () => ["read", "glob"],
			spawnImpl: spawnImpl as never,
		});

		const resultPromise = runner.run({
			...baseOptions,
			agent: "dreamer-memory-mapper",
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback"],
		});
		first.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					stopReason: "error",
				},
			]),
		);
		first.emitClose(0);
		await nextTick();
		second.writeStdoutLine(
			agentEnd([
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback succeeded" }],
					stopReason: "stop",
				},
			]),
		);
		second.emitClose(0);

		expect(await resultPromise).toMatchObject({
			ok: true,
			assistantText: "fallback succeeded",
		});
		expect(spawnImpl).toHaveBeenCalledTimes(2);
		for (const [, argv] of spawnImpl.mock.calls) {
			const args = argv as string[];
			const toolsIndex = args.indexOf("--tools");
			expect(toolsIndex).toBeGreaterThanOrEqual(0);
			expect(args[toolsIndex + 1]).toBe("read,glob");
			expect(args[toolsIndex + 1]).not.toContain("grep");
		}
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
		const dataHome = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-fence-probe-"),
		);
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

describe("child observability", () => {
	it("warns once for replaced prompts and never for identical prompts", async () => {
		const { createHash } = await import("node:crypto");
		const log = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
		try {
			for (const changed of [false, true]) {
				log.mockClear();
				const child = createMockChild();
				const { runner } = runnerWith(child);
				const run = runner.run(baseOptions);
				await new Promise((resolve) => setTimeout(resolve, 10));
				const text = changed ? "another persona" : baseOptions.systemPrompt;
				const event = {
					type: "mc_system_prompt",
					bytes: Buffer.byteLength(text),
					sha256: createHash("sha256").update(text).digest("hex"),
					containsIntended: !changed,
				};
				child.writeStdoutLine(event);
				child.writeStdoutLine(event);
				child.writeStdoutLine({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "done" }],
					},
				});
				child.emitClose();
				await run;
				const warnings = log.mock.calls.filter((args) =>
					String(args[1]).startsWith("subagent_system_prompt_replaced "),
				);
				expect(warnings.length).toBe(changed ? 1 : 0);
			}
		} finally {
			log.mockRestore();
		}
	});

	it("logs exact step, tool output byte and prompt token counts without terminal duplication", async () => {
		const log = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
		try {
			const child = createMockChild();
			const { runner } = runnerWith(child);
			const run = runner.run(baseOptions);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const messages = [
				{
					role: "assistant",
					stopReason: "toolUse",
					usage: { input: 10, cacheRead: 20, cacheWrite: 5 },
					content: [
						{ type: "toolCall", id: "a", name: "read" },
						{ type: "toolCall", id: "b", name: "read" },
					],
				},
				{
					role: "assistant",
					stopReason: "stop",
					usage: { input: 7, cacheRead: 40 },
					content: [{ type: "text", text: "done" }],
				},
			];
			child.writeStdoutLine({ type: "message_end", message: messages[0] });
			for (const id of ["a", "b"])
				child.writeStdoutLine({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "read",
					result: { content: [{ type: "text", text: "é" }] },
				});
			child.writeStdoutLine({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "a",
					content: [{ type: "text", text: "é" }],
				},
			});
			child.writeStdoutLine({ type: "message_end", message: messages[1] });
			child.writeStdoutLine({ type: "agent_end", messages });
			child.emitClose();
			await run;
			const lines = log.mock.calls.filter((args) =>
				String(args[1]).startsWith("subagent_telemetry "),
			);
			expect(lines).toHaveLength(1);
			const summary = JSON.parse(
				String(lines[0]?.[1]).slice("subagent_telemetry ".length),
			);
			expect(summary.steps).toBe(2);
			expect(summary.tools).toEqual({ read: { calls: 2, outputBytes: 4 } });
			expect(summary.promptTokens).toEqual({ first: 35, last: 47, max: 47 });
		} finally {
			log.mockRestore();
		}
	});

	it("aborts over-cap streams with step_limit", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);
		const run = runner.run({ ...baseOptions, agent: "dreamer-classifier" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		for (let n = 0; n < 5; n++)
			child.writeStdoutLine({
				type: "message_end",
				message: { role: "assistant", stopReason: "toolUse", content: [] },
			});
		const killed = child.killed;
		child.emitClose();
		const result = await run;
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("step_limit");
		expect(killed).toBe(true);
	});
});

it("accepts provenance redirected to chunked stderr by Pi's output guard", async () => {
	const { promptFingerprint } = await import("./subagent-telemetry");
	const log = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
	try {
		const child = createMockChild();
		const { runner } = runnerWith(child);
		const run = runner.run(baseOptions);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const line = `${JSON.stringify({
			type: "mc_system_prompt",
			...promptFingerprint("replacement"),
			containsIntended: false,
		})}\n`;
		child.writeStderr(line.slice(0, 10));
		child.writeStderr(line.slice(10));
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
			},
		});
		child.emitClose();
		await run;
		expect(
			log.mock.calls.filter((args) =>
				String(args[1]).startsWith("subagent_system_prompt_replaced "),
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
	}
});

describe("Pi dreamer prompt-token budget", () => {
	it("hard-stops at soft limit when the lean tool guard is unavailable", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, {
			invocation: { command: "pi-test", prefixArgs: [], targetHarness: "pi" },
		});
		const run = runner.run({
			...baseOptions,
			agent: "dreamer-memory-mapper",
			tokenBudget: 100,
		});
		for (let i = 0; i < 100 && spawnImpl.mock.calls.length === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(spawnImpl.mock.calls[0]?.[1]).toContain("json");
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 81 },
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
			},
		});
		expect(await run).toMatchObject({
			ok: false,
			reason: "token_budget",
			meta: { tokenBudget: { finalizeFired: false } },
		});
		expect(child.stdinText).not.toContain("dreamer-finalize");
	});
	const invocation = {
		command: "pi-test",
		prefixArgs: [],
		targetHarness: "pi" as const,
	};
	async function started(tokenBudget = 100) {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, {
			invocation,
			subagentExtensions: ["subagent-entry.js"],
		});
		const run = runner.run({
			...baseOptions,
			agent: "dreamer-memory-mapper",
			tokenBudget,
		});
		for (
			let i = 0;
			i < 100 && !child.stdinText.includes("dreamer-initial");
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(child.stdinText).toContain("dreamer-initial");
		expect(spawnImpl.mock.calls[0]?.[1]).toContain("rpc");
		return { child, run, spawnImpl };
	}

	it("finalizes the mapper before its step cap and retains a partial manifest below token budget", async () => {
		const { child, run } = await started(3_000_000);
		for (let step = 1; step <= 58; step++)
			child.writeStdoutLine({
				type: "message_end",
				message: {
					role: "assistant",
					usage: { input: 1 },
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: `read-${step}`, name: "read" }],
				},
			});
		const steered = child.stdinText.includes("dreamer-finalize");
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 1 },
				stopReason: "stop",
				content: [
					{ type: "text", text: '<verify><verified id="1"/></verify>' },
				],
			},
		});
		child.emitClose();
		expect(await run).toMatchObject({
			ok: true,
			meta: { tokenBudget: { spent: 59, finalizeFired: true } },
		});
		expect(steered).toBe(true);
		expect(child.stdinText.match(/dreamer-finalize/g)).toHaveLength(1);
	});

	it("does not steer a completed under-budget child", async () => {
		const { child, run } = await started();
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 50 },
				stopReason: "stop",
				content: [{ type: "text", text: "<mappings/>" }],
			},
		});
		child.emitClose();
		expect(await run).toMatchObject({ ok: true, assistantText: "<mappings/>" });
		expect(child.stdinText).not.toContain("dreamer-finalize");
	});

	it("steers once at 80%, retains its tools, and accepts a final manifest", async () => {
		const { child, run, spawnImpl } = await started();
		const argsBefore = JSON.stringify(spawnImpl.mock.calls[0]?.[1]);
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 20, cacheRead: 61, cacheWrite: 0 },
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(child.stdinText.match(/dreamer-finalize/g)).toHaveLength(1);
		expect(child.stdinText).toContain("no more tool calls");
		expect(JSON.stringify(spawnImpl.mock.calls[0]?.[1])).toBe(argsBefore);
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 1 },
				stopReason: "stop",
				content: [{ type: "text", text: "<mappings/>" }],
			},
		});
		child.emitClose();
		const result = await run;
		expect(result).toMatchObject({ ok: true, assistantText: "<mappings/>" });
	});

	it("hard-stops at 100% even after only one refused call", async () => {
		const { child, run } = await started();
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 81 },
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
			},
		});
		child.writeStdoutLine({
			type: "tool_execution_end",
			toolCallId: "blocked-1",
			toolName: "read",
			isError: true,
			result: {
				content: [
					{
						type: "text",
						text: "Out of token budget: no more tool calls. Output your result now.",
					},
				],
			},
		});
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 19 },
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
			},
		});
		expect(await run).toMatchObject({ ok: false, reason: "token_budget" });
	});

	it("hard-stops after two blocked post-finalize calls", async () => {
		const { child, run } = await started();
		child.writeStdoutLine({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 81 },
				stopReason: "toolUse",
				content: [{ type: "toolCall", name: "read" }],
			},
		});
		for (let i = 0; i < 2; i++)
			child.writeStdoutLine({
				type: "tool_execution_end",
				toolCallId: `blocked-${i}`,
				toolName: "read",
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Out of token budget: no more tool calls. Output your result now.",
						},
					],
				},
			});
		expect(await run).toMatchObject({ ok: false, reason: "token_budget" });
	});
});
