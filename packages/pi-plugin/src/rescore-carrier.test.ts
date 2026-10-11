import { expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { RescoreAdmission } from "../../plugin/src/features/magic-context/rescore-service";
import { readProcessStartTime } from "../../plugin/src/shared/rpc-utils";
import type { SubagentRunOptions } from "../../plugin/src/shared/subagent-runner";
import { createPiRescoreCarrier } from "./rescore-carrier";

const request = {
	attempt: { id: "admitted-attempt" },
	system: "score-only",
	prompt: "opaque candidates",
	profile: {
		model: "provider/score",
		thinkingLevel: "low",
		temperature: 0,
		maxOutputTokens: 1234,
	},
} as RescoreAdmission;

test("Pi score carrier sends frozen profile and rescore accounting without fallback", async () => {
	const run = mock(async (_options: SubagentRunOptions) => ({
		ok: true as const,
		assistantText: "[]",
		durationMs: 1,
	}));
	const carrier = createPiRescoreCarrier({
		runner: { run, harness: "pi" },
		directory: "/project",
		sessionId: "session",
		timeoutMs: 1000,
	});
	const opened = mock((id: string) => {
		expect(JSON.parse(id).carrier).toBe("pi-rescore");
		return true;
	});
	expect(
		await carrier.complete(
			request,
			new AbortController().signal,
			opened,
			() => true,
		),
	).toBe("[]");
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0][0]).toMatchObject({
		agent: "rescore",
		model: "provider/score",
		thinkingLevel: "low",
		temperature: 0,
		maxOutputTokens: 1234,
		accountingSubagent: "rescore",
		accountingTask: "admitted-attempt",
		accountingSessionId: "session",
	});
	expect(run.mock.calls[0][0].fallbackModels).toBeUndefined();
	expect(await carrier.recover("old-process")).toEqual({ state: "unknown" });
});

test("Pi primary failure sends no fallback, and a lost owner never spawns", async () => {
	const run = mock(async (_options: SubagentRunOptions) => ({
		ok: false as const,
		reason: "model_failed" as const,
		error: "Missing credential",
		durationMs: 1,
	}));
	const carrier = createPiRescoreCarrier({
		runner: { run, harness: "pi" },
		directory: "/project",
		sessionId: "session",
		timeoutMs: 1000,
	});
	await expect(
		carrier.complete(
			request,
			new AbortController().signal,
			() => true,
			() => true,
		),
	).rejects.toThrow("Missing credential");
	expect(run).toHaveBeenCalledTimes(1);
	await expect(
		carrier.complete(
			request,
			new AbortController().signal,
			() => false,
			() => true,
		),
	).rejects.toThrow("owner lost");
	expect(run).toHaveBeenCalledTimes(1);
});

test("a restarted Pi carrier verifies process identity and awaits a remote child's termination", async () => {
	const id = randomUUID();
	const child = spawn(
		"node",
		[
			"-e",
			'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); console.log("ready"); setInterval(() => {}, 1000);',
			`mc-pi-subagent-${id}-`,
		],
		{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", () => resolve());
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code) reject(new Error(`fixture exited ${code}`));
			});
		});
		const carrier = createPiRescoreCarrier({
			runner: {
				harness: "pi",
				async run() {
					throw new Error("recovery must not spawn");
				},
			},
			sessionId: "session",
			directory: "/project",
			timeoutMs: 1000,
		});
		const identity = {
			carrier: "pi-rescore",
			host: hostname(),
			id,
			pid: child.pid,
			startedAt:
				child.pid === undefined ? null : readProcessStartTime(child.pid),
		};
		const foreign = JSON.stringify({ ...identity, id: randomUUID() });
		expect(await carrier.recover(foreign)).toEqual({ state: "unknown" });
		expect(await carrier.interrupt(foreign)).toBe(false);
		const saved = JSON.stringify(identity);
		expect(await carrier.recover(saved)).toEqual({ state: "active" });
		expect(await carrier.interrupt(saved)).toBe(true);
		await exited;
		expect(await carrier.recover(saved)).toEqual({ state: "unavailable" });
	} finally {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await exited;
	}
}, 15_000);
