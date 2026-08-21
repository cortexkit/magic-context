import { expect, test } from "bun:test";
import { awaitInFlightRecomps, spawnPiRecompRun } from "./pi-recomp-runner";

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
