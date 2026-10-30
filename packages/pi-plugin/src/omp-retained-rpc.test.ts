import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { closeDatabase } from "@magic-context/core/features/magic-context/storage";
import { __resetSchemaFenceStateForTests } from "@magic-context/core/features/magic-context/storage-db";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { OmpRetainedRpc } from "./omp-retained-rpc";
import { PiSubagentRunner } from "./subagent-runner";

let root: string;
let oldStorage: string | undefined;
beforeEach(() => {
	root = createTestTempDirFromPath(join(tmpdir(), "omp-rpc-unit-"));
	oldStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
	process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
	closeDatabase();
	__resetSchemaFenceStateForTests();
});
afterEach(() => {
	closeDatabase();
	__resetSchemaFenceStateForTests();
	if (oldStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
	else process.env.MAGIC_CONTEXT_STORAGE_DIR = oldStorage;
	rmSync(root, { recursive: true, force: true });
});

const ready = {
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1024 * 1024,
	maxReassembledFrameBytes: 64 * 1024 * 1024,
};

function fakeChild(pid: number, supported: boolean) {
	const emitter = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const commands: Record<string, any>[] = [];
	let exited = false;
	const child = Object.assign(emitter, {
		pid,
		stdin,
		stdout,
		stderr,
		exitCode: null as number | null,
		signalCode: null,
		kill() {
			if (!exited) {
				exited = true;
				child.exitCode = 0;
				stdin.end();
				stdout.end();
				stderr.end();
				emitter.emit("exit", 0, null);
				emitter.emit("close", 0, null);
			}
			return true;
		},
	});
	const emit = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
	stdin.on("data", (bytes) => {
		for (const line of bytes.toString().trim().split("\n")) {
			const command = JSON.parse(line);
			commands.push(command);
			if (command.type === "negotiate_protocol")
				emit({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
					data: { protocolVersion: 2 },
				});
			else if (command.type === "get_state")
				emit({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
					data: { dumpTools: [], isSettled: true, hasPendingAsyncWork: false },
				});
		}
	});
	queueMicrotask(() =>
		emit(supported ? ready : { ...ready, supportedProtocolVersions: [1] }),
	);
	return { child, commands, emit };
}

test("OMP without negotiated RPC stays one-pass and logs fallback once", async () => {
	const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
	const fake = fakeChild(100, false);
	const runner = new PiSubagentRunner({
		invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		budgetGuardAvailable: true,
		spawnImpl: (() => fake.child) as never,
	});
	const ordinary = spyOn(runner, "run").mockResolvedValue({
		ok: true,
		assistantText: "one pass",
		durationMs: 1,
	});
	try {
		expect(await runner.prepareRetainedHistorian(root)).toBe(false);
		expect(runner.canRetainHistorian).toBe(false);
		await runner.prepareRetainedHistorian(root);
		const result = await runner.runRetainedHistorian({
			agent: "historian",
			systemPrompt: "system",
			userMessage: "first",
			tokenBudget: 1000,
			cwd: root,
		});
		expect(result.child).toBeNull();
		expect(ordinary).toHaveBeenCalledTimes(1);
		expect(
			log.mock.calls.filter((call) =>
				String(call[1]).includes("using one-pass historian"),
			),
		).toHaveLength(1);
	} finally {
		ordinary.mockRestore();
		log.mockRestore();
	}
});

test("OMP negotiated RPC retains one child and waits for correlated prompt results", async () => {
	const probe = fakeChild(100, true);
	let actual: ReturnType<typeof fakeChild> | undefined;
	let spawns = 0;
	const runner = new PiSubagentRunner({
		invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		budgetGuardAvailable: true,
		spawnImpl: (() => {
			if (spawns++ === 0) return probe.child;
			actual = fakeChild(101, true);
			return actual.child;
		}) as never,
	});
	expect(await runner.prepareRetainedHistorian(root)).toBe(true);
	expect(runner.canRetainHistorian).toBe(true);
	const opening = runner.runRetainedHistorian(
		{
			agent: "historian",
			systemPrompt: "system",
			userMessage: "first",
			tokenBudget: 100000,
			cwd: root,
			timeoutMs: 2000,
		},
		"stage-one",
	);
	for (
		let i = 0;
		i < 200 && !actual?.commands.some((command) => command.type === "prompt");
		i++
	)
		await new Promise((resolve) => setTimeout(resolve, 1));
	expect(actual?.commands.map((command) => command.type)).toEqual([
		"negotiate_protocol",
		"get_state",
		"prompt",
	]);
	const assistant = (text: string) => ({
		role: "assistant",
		provider: "mock",
		model: "model",
		stopReason: "stop",
		usage: { input: 10, output: 2 },
		content: [{ type: "text", text }],
	});
	actual!.emit({ type: "agent_end", messages: [assistant("first")] });
	let delivered = false;
	void opening.then(() => {
		delivered = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(delivered).toBe(false);
	actual!.emit({
		type: "prompt_result",
		id: "wrong-stage",
		status: "completed",
		agentInvoked: true,
		sessionSettled: true,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(delivered).toBe(false);
	actual!.emit({
		type: "prompt_result",
		id: "stage-one",
		status: "completed",
		agentInvoked: true,
		sessionSettled: true,
	});
	const first = await opening;
	expect(first.result.ok).toBe(true);
	expect(first.child).not.toBeNull();
	const second = first.child!.send("second", "stage-two");
	actual!.emit({ type: "agent_end", messages: [assistant("second")] });
	actual!.emit({
		type: "prompt_result",
		id: "stage-two",
		status: "completed",
		agentInvoked: true,
		sessionSettled: true,
	});
	expect(await second).toMatchObject({ ok: true, assistantText: "second" });
	expect(spawns).toBe(2);
	expect(
		actual!.commands
			.filter((command) => command.type === "prompt")
			.map((command) => command.id),
	).toEqual(["stage-one", "stage-two"]);
	await first.child!.close();
});

test("OMP negotiated RPC reports truncation and a fresh retained run succeeds", async () => {
	let spawns = 0;
	const runner = new PiSubagentRunner({
		invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		budgetGuardAvailable: true,
		spawnImpl: (() => {
			const index = spawns++;
			const fake = fakeChild(200 + index, true);
			fake.child.stdin.on("data", (bytes) => {
				for (const line of bytes.toString().trim().split("\n")) {
					const command = JSON.parse(line);
					if (command.type !== "prompt") continue;
					fake.emit({
						type: "agent_end",
						messages: [
							{
								role: "assistant",
								provider: "mock",
								model: "model",
								stopReason: index === 1 ? "length" : "stop",
								content: [
									{ type: "text", text: "valid but length-capped reply" },
								],
								usage: { input: 10, output: 5 },
							},
						],
					});
					fake.emit({
						type: "prompt_result",
						id: command.id,
						status: "completed",
						agentInvoked: true,
						sessionSettled: true,
					});
				}
			});
			return fake.child;
		}) as never,
	});
	expect(await runner.prepareRetainedHistorian(root)).toBe(true);
	const options = {
		agent: "historian",
		systemPrompt: "system",
		userMessage: "first",
		tokenBudget: 100000,
		cwd: root,
		timeoutMs: 2000,
		maxOutputTokens: 64000,
	};
	const first = await runner.runRetainedHistorian(options, "capped-turn");
	expect(first.result).toMatchObject({
		ok: false,
		reason: "truncated",
		meta: { lengthCapped: true },
	});
	await first.child?.close();
	const second = await runner.runRetainedHistorian(options, "fresh-turn");
	expect(second.result).toMatchObject({
		ok: true,
		meta: { lengthCapped: false },
	});
	await second.child?.close();
});

test("OMP protocol refuses offered tools before sending a provider prompt", () => {
	const commands: Record<string, any>[] = [];
	const failures: string[] = [];
	let confirmed = false;
	const protocol = new OmpRetainedRpc({
		write: (line) => commands.push(JSON.parse(line)),
		ready: () => {
			confirmed = true;
		},
		unavailable: (reason) => failures.push(reason),
		terminal() {},
	});
	protocol.accept(JSON.stringify(ready));
	protocol.accept(
		JSON.stringify({
			type: "response",
			id: commands[0].id,
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		}),
	);
	protocol.accept(
		JSON.stringify({
			type: "response",
			id: commands[1].id,
			command: "get_state",
			success: true,
			data: { dumpTools: [{ name: "ctx_search" }] },
		}),
	);
	expect(confirmed).toBe(false);
	expect(failures).toHaveLength(1);
	expect(commands.some((command) => command.type === "prompt")).toBe(false);
});

test("OMP actual-child negotiation refusal falls back before any prompt is written", async () => {
	const probe = fakeChild(200, true);
	const rejected = fakeChild(201, false);
	let spawns = 0;
	const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
	const runner = new PiSubagentRunner({
		invocation: { command: "omp", prefixArgs: [], targetHarness: "omp" },
		budgetGuardAvailable: true,
		spawnImpl: (() => (spawns++ === 0 ? probe.child : rejected.child)) as never,
	});
	const ordinary = spyOn(runner, "run").mockResolvedValue({
		ok: true,
		assistantText: "one pass",
		durationMs: 1,
	});
	try {
		expect(await runner.prepareRetainedHistorian(root)).toBe(true);
		const result = await runner.runRetainedHistorian({
			agent: "historian",
			systemPrompt: "system",
			userMessage: "first",
			tokenBudget: 100000,
			cwd: root,
			timeoutMs: 2000,
		});
		expect(result.child).toBeNull();
		expect(result.result).toMatchObject({
			ok: true,
			assistantText: "one pass",
		});
		expect(rejected.commands.some((command) => command.type === "prompt")).toBe(
			false,
		);
		expect(runner.canRetainHistorian).toBe(false);
		expect(ordinary).toHaveBeenCalledTimes(1);
	} finally {
		ordinary.mockRestore();
		log.mockRestore();
	}
});

test("OMP v2 chunk framing preserves UTF-8 and enforces the negotiated line limit", () => {
	const lines: string[] = [];
	const failures: string[] = [];
	const protocol = new OmpRetainedRpc({
		write: (line) => lines.push(line),
		ready() {},
		unavailable: (reason) => failures.push(reason),
		terminal() {},
	});
	protocol.accept(JSON.stringify({ ...ready, maxFrameBytes: 4096 }));
	protocol.accept(
		JSON.stringify({
			type: "response",
			id: JSON.parse(lines[0]).id,
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		}),
	);
	protocol.accept(
		JSON.stringify({
			type: "response",
			id: JSON.parse(lines[1]).id,
			command: "get_state",
			success: true,
			data: { dumpTools: [], isSettled: true, hasPendingAsyncWork: false },
		}),
	);
	lines.length = 0;
	const message = "€".repeat(3000);
	protocol.prompt(message, "large");
	expect(lines).toHaveLength(4);
	expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 4096)).toBe(
		true,
	);
	const chunks = lines.map((line) => JSON.parse(line));
	expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
	const joined = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk.data, "base64")),
	).toString("utf8");
	expect(JSON.parse(joined)).toEqual({ type: "prompt", message, id: "large" });
	let decoded: unknown;
	for (const line of lines) decoded = protocol.accept(line);
	expect(decoded).toEqual({ type: "prompt", message, id: "large" });
	expect(failures).toEqual([]);
});

test("OMP v2 rejects out-of-order chunks without completing a turn", () => {
	const failures: string[] = [];
	let completions = 0;
	const protocol = new OmpRetainedRpc({
		write() {},
		ready() {},
		unavailable: (reason) => failures.push(reason),
		terminal() {
			completions++;
		},
	});
	protocol.accept(
		JSON.stringify({
			type: "rpc_chunk",
			chunkId: "bad",
			index: 1,
			count: 2,
			byteLength: 2,
			data: "YQ==",
		}),
	);
	expect(failures).toHaveLength(1);
	expect(protocol.supported).toBe(false);
	expect(completions).toBe(0);
});
