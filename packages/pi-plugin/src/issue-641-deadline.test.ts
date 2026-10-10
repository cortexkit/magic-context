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
	let finish!: () => void;
	const historian = new Promise<void>((resolve) => {
		finish = resolve;
	});
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
		const started = performance.now();
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const result = await handler({ messages: raw }, ctx);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(JSON.stringify(result)).toContain("§1§ available state");
		let joined = false;
		const drain = awaitInFlightHistorians(sessionId).then(() => {
			joined = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(joined).toBe(false);
		finish();
		await drain;
	} finally {
		finish();
		restore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
