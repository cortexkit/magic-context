import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SubagentRunOptions } from "@magic-context/core/shared/subagent-runner";

import { __test, PiSubagentRunner } from "./subagent-runner";

const baseOptions: SubagentRunOptions = {
	agent: "historian",
	systemPrompt: "system guidance",
	userMessage: "summarize this session",
};

type MockChild = ReturnType<typeof createMockChild>;

function createMockChild({ stdout = true }: { stdout?: boolean } = {}) {
	const events = new EventEmitter();
	const stdoutStream = stdout ? new PassThrough() : null;
	const stderrStream = new PassThrough();
	let killed = false;
	const killSignals: Array<NodeJS.Signals | number | undefined> = [];

	const child = {
		pid: 42,
		stdout: stdoutStream,
		stderr: stderrStream,
		get killed() {
			return killed;
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
			stdoutStream?.end();
			stderrStream.end();
			setTimeout(() => events.emit("close", code, signal), 0);
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
		killSignals,
	};

	return child;
}

function runnerWith(child: MockChild, piBinary = "pi-test") {
	const spawnImpl = mock(() => child as never);
	const runner = new PiSubagentRunner({
		piBinary,
		spawnImpl: spawnImpl as never,
	});
	return { runner, spawnImpl };
}

function agentEnd(messages: unknown[]) {
	return { type: "agent_end", messages };
}

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

	it("builds argv with system prompt, primary model, and prompt last", () => {
		expect(
			__test.buildArgs({
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
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--system-prompt",
			"system guidance",
			"--model",
			"anthropic/claude-sonnet",
			// No --thinking flag: thinkingLevel not set in baseOptions,
			// so Pi's own resolution handles it (correct for Anthropic).
			// Users on providers like GitHub Copilot should set
			// historian.thinking_level in their Pi magic-context.jsonc.
			"summarize this session",
		]);
	});

	it("always includes --no-session so child sessions don't appear in pi resume", () => {
		// Pinned-down regression: the user-visible promise of magic-context
		// hidden subagents is that historian/sidekick/dreamer runs never
		// pollute Pi's session list. If this assertion ever fails, the
		// child sessions WILL show up in `pi resume` again.
		const args = __test.buildArgs({
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

	it("builds --models when fallback models are provided", () => {
		const args = __test.buildArgs({
			...baseOptions,
			model: "anthropic/primary",
			fallbackModels: ["openai/fallback", "google/last"],
		});

		expect(args).toContain("--models");
		expect(args).not.toContain("--model");
		expect(args).toContain("anthropic/primary,openai/fallback,google/last");
		expect(args.at(-1)).toBe("summarize this session");
	});

	it("parses JSON event lines and normalizes parse errors", () => {
		expect(__test.parsePiEventLine('{"type":"agent_start"}')).toEqual({
			ok: true,
			event: { type: "agent_start" },
		});

		const parsed = __test.parsePiEventLine("{not-json");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.error).toContain("failed to parse event");
			expect(parsed.error).toContain("line={not-json");
		}
	});

	// Subagent extension entry loading. These tests verify the
	// runner's argv contract for loading Magic Context's lean subagent
	// extension (./subagent-entry.js) inside spawned Pi child processes.
	// The bundle is only present after `bun run build`; in unit tests
	// running source via Bun directly, the dev fallback (no --extension)
	// kicks in. Both shapes are valid and locked in.

	it("dev mode (no bundle): does NOT pass --extension flag, so subagents run without Magic Context tools", () => {
		// In dev mode (running .ts source), there's no dist/subagent-entry.js
		// next to subagent-runner.ts, so resolveSubagentEntryPath() returns
		// undefined and we skip the --extension flag. This matches the
		// original pre-tools behavior where subagents ran with
		// `--no-extensions` and no Magic Context tools at all.
		const args = __test.buildArgs({
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
		// Even if the bundle were present, only agent="dreamer" should
		// see the elevated ctx_memory action surface. Historian, sidekick,
		// compressor etc. get write/delete/list only.
		for (const agent of ["historian", "sidekick", "compressor", "recomp"]) {
			const args = __test.buildArgs({
				...baseOptions,
				agent,
				model: "anthropic/claude-sonnet",
			});
			expect(args).not.toContain("--magic-context-dreamer-actions");
		}
	});
});

describe("PiSubagentRunner spawn lifecycle", () => {
	it("spawns pi, parses stdout, trims assistant text, and captures stderr", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child, "custom-pi");

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
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		expect(result).toEqual({
			ok: true,
			assistantText: "final answer",
			durationMs: expect.any(Number),
			meta: { stderr: "warning from pi" },
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
			meta: { stderr: undefined },
		});
	});

	it("returns no_assistant for empty stdout and successful exit", async () => {
		const child = createMockChild();
		const { runner } = runnerWith(child);

		const resultPromise = runner.run(baseOptions);
		child.emitClose(0);

		const result = await resultPromise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("no_assistant");
			expect(result.error).toContain("without emitting agent_end");
			expect(result.meta).toEqual({
				stderr: undefined,
				exitCode: 0,
				signal: null,
			});
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

	it("passes fallback models, cwd, and prompt arguments through spawn", async () => {
		const child = createMockChild();
		const { runner, spawnImpl } = runnerWith(child);

		const resultPromise = runner.run({
			...baseOptions,
			agent: "dreamer",
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
			[
				"--print",
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--system-prompt",
				"system guidance",
				"--models",
				"anthropic/primary,openai/fallback",
				// No --thinking: thinkingLevel not set in options above.
				"summarize this session",
			],
			expect.objectContaining({ cwd: "/workspace/project" }),
		);
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
});
