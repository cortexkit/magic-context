import { expect, test } from "bun:test";
import {
	__test,
	awaitInFlightHistorians,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

test("emergency foreground with tool reclaim never joins a still-running historian", async () => {
	const db = createTestDb();
	const sessionId = "deadline-historian";
	// Count every subscription to the in-flight historian. A subclass makes
	// `await`, `Promise.race` and `.then` all go through `then`, so a foreground
	// pass that waited on the historian, even with a deadline, shows up here.
	let subscriptions = 0;
	let watched: unknown;
	class WatchedHistorian extends Promise<void> {
		// biome-ignore lint/suspicious/noThenProperty: this subclass is a promise; overriding then is how it observes subscriptions.
		override then<A = void, B = never>(
			onFulfilled?: ((value: void) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): Promise<A | B> {
			if (this === watched) subscriptions++;
			return super.then(onFulfilled, onRejected);
		}
	}
	let finish!: () => void;
	const historian = new WatchedHistorian((resolve) => {
		finish = () => resolve();
	});
	watched = historian;
	const restore = __test.setInFlightHistorianForTests(sessionId, historian);
	try {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		const raw = [
			userMessage("available state", 1),
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
				],
				timestamp: 2,
			},
			toolResultMessage("read-1", "available result", 3),
		];
		const ctx = Object.assign(
			fakeContext(sessionId, process.cwd(), ["u", "a", "r"], raw),
			{
				getContextUsage: () => ({
					tokens: 96000,
					percent: 96,
					contextWindow: 100000,
				}),
			},
		);
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const result = await handler({ messages: raw }, ctx);
		// The pass finished while the historian was still pending and never
		// subscribed to it, so it could not have waited on it.
		expect(subscriptions).toBe(0);
		expect(JSON.stringify(result)).toContain("§1§ available state");
		let joined = false;
		const drain = awaitInFlightHistorians(sessionId).then(() => {
			joined = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(joined).toBe(false);
		// Control: a real wait on the historian is counted, so the zero above
		// is not vacuous.
		expect(subscriptions).toBeGreaterThan(0);
		finish();
		await drain;
	} finally {
		finish();
		restore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
