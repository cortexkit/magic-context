import { expect, spyOn, test } from "bun:test";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("branch projection expiry identifies the synchronous host stage", async () => {
	const db = createTestDb();
	const sessionId = "branch-stage-expiry";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const raw = [userMessage("branch projection", 1)];
	const ctx = fakeContext(sessionId, process.cwd(), ["u1"], raw);
	const readBranch = ctx.sessionManager.getBranch;
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	ctx.sessionManager.getBranch = () => {
		// Model a synchronous host call crossing the preparation deadline without
		// adding a real-time stall to the ordinary suite.
		now = 26000;
		return readBranch();
	};
	try {
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const error = await Promise.resolve(
			handler({ messages: raw } as never, ctx as never),
		).then(
			() => null,
			(reason: unknown) => reason,
		);
		expect(error).not.toBeNull();
		expect(String(error)).toContain("stage=branch projection");
		expect(
			db.prepare("SELECT * FROM tags WHERE session_id=?").all(sessionId),
		).toEqual([]);
	} finally {
		clock.mockRestore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
