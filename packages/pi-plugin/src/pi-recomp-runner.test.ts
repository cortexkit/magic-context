import { expect, test } from "bun:test";
import { createPiHistorianClient } from "./pi-recomp-client-shared";
import {
	abortInFlightRecomps,
	awaitInFlightRecomps,
	spawnPiRecompRun,
} from "./pi-recomp-runner";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("awaitInFlightRecomps waits only for the requested session", async () => {
	const sessionA = deferred();
	const sessionB = deferred();
	const spawn = (sessionId: string, work: Promise<void>) =>
		spawnPiRecompRun({
			sessionId,
			provider: { readMessages: async () => [] } as never,
			onStatusChange: () => {},
			work: () => work,
		});

	spawn("session-a", sessionA.promise);
	spawn("session-b", sessionB.promise);
	let sessionADrained = false;
	const drainA = awaitInFlightRecomps("session-a").then(() => {
		sessionADrained = true;
	});

	sessionB.resolve();
	await awaitInFlightRecomps("session-b");
	expect(sessionADrained).toBe(false);

	sessionA.resolve();
	await drainA;
	expect(sessionADrained).toBe(true);
});

test("abort fences a detached run before a late settle", async () => {
	const gate = deferred();
	let observedSignal: AbortSignal | undefined;
	let statusChanges = 0;
	let settled = false;

	spawnPiRecompRun({
		sessionId: "session-abort",
		provider: { readMessages: async () => [] } as never,
		onStatusChange: () => {
			statusChanges += 1;
		},
		work: async (signal) => {
			observedSignal = signal;
			await gate.promise;
			settled = true;
		},
	});
	await Promise.resolve();

	abortInFlightRecomps("session-abort");
	expect(observedSignal?.aborted).toBe(true);
	gate.resolve();
	await awaitInFlightRecomps("session-abort");

	expect(settled).toBe(true);
	expect(statusChanges).toBe(1);
});

test("historian client forwards cancellation and rejects a late result", async () => {
	const gate = deferred();
	const controller = new AbortController();
	let runnerSignal: AbortSignal | undefined;
	let runCalls = 0;
	const client = createPiHistorianClient({
		runner: {
			run: async (options: { signal?: AbortSignal }) => {
				runCalls += 1;
				runnerSignal = options.signal;
				await gate.promise;
				return { ok: true, assistantText: "done" };
			},
		} as never,
		model: "provider/model",
		systemPrompt: "system",
		directory: "/project",
		accountingSessionId: "session-client-abort",
		signal: controller.signal,
		notify: () => {},
	});
	const session = await client.session.create();
	const prompt = client.session.prompt({
		path: { id: session.id },
		body: { parts: [{ text: "rebuild" }] },
	});
	await Promise.resolve();

	controller.abort();
	gate.resolve();
	await expect(prompt).rejects.toThrow("prompt aborted by external signal");
	expect(runnerSignal).toBe(controller.signal);
	expect(runCalls).toBe(1);
});
