import { expect, mock, test } from "bun:test";
import type { RescoreAdmission } from "../../plugin/src/features/magic-context/rescore-service";
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
		expect(id).toBe("admitted-attempt");
		return true;
	});
	expect(
		await carrier.complete(request, new AbortController().signal, opened),
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
	expect(await carrier.recover("old-process")).toBeNull();
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
		carrier.complete(request, new AbortController().signal, () => true),
	).rejects.toThrow("Missing credential");
	expect(run).toHaveBeenCalledTimes(1);
	await expect(
		carrier.complete(request, new AbortController().signal, () => false),
	).rejects.toThrow("owner lost");
	expect(run).toHaveBeenCalledTimes(1);
});
