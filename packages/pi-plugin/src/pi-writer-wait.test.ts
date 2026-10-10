import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
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

async function underWriter(
	run: (
		db: ReturnType<typeof createTestDb>,
		locker: Database,
		dir: string,
	) => Promise<void>,
) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-writer-wait-"));
	const db = createTestDb(join(dir, "context.db"));
	const locker = new Database(join(dir, "context.db"));
	locker.exec("BEGIN IMMEDIATE");
	try {
		await run(db, locker, dir);
	} finally {
		if (locker.inTransaction) locker.exec("ROLLBACK");
		locker.close();
		db.close();
		clearContextHandlerSession("waiter");
		rmSync(dir, { recursive: true, force: true });
	}
}

function install(db: ReturnType<typeof createTestDb>) {
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("Context handler not installed");
	return handler;
}

test("a usable Pi LKG is replayed before any backed-off writer wait", async () => {
	await underWriter(async (db, locker, dir) => {
		locker.exec("ROLLBACK");
		const handler = install(db);
		const raw = [userMessage("saved prefix", 1)];
		const ctx = Object.assign(fakeContext("waiter", dir, ["u"], raw), {
			model: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				contextWindow: 272000,
				maxTokens: 68000,
			},
			getSystemPrompt: () => "current system",
		});
		const first = await handler({ messages: structuredClone(raw) }, ctx);
		await new Promise((done) => setImmediate(done));
		locker.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		const replay = await handler({ messages: structuredClone(raw) }, ctx);
		expect(replay).toEqual(first);
		expect(performance.now() - started).toBeLessThan(350);
		expect(locker.inTransaction).toBe(true);
	});
});

test("Pi session metadata is read inside the acquired transaction, not after an empty preflight", async () => {
	const db = createTestDb();
	const prepare = db.prepare.bind(db);
	let firstReadHeld: boolean | undefined;
	const spy = spyOn(db, "prepare").mockImplementation((sql) => {
		if (sql.includes("FROM session_meta") && firstReadHeld === undefined)
			firstReadHeld = db.inTransaction;
		return prepare(sql);
	});
	try {
		const raw = [userMessage("unsent request", 1)];
		const handler = install(db);
		const ctx = fakeContext("waiter", process.cwd(), ["u"], raw);
		const first = await handler({ messages: structuredClone(raw) }, ctx);
		expect(firstReadHeld).toBe(true);
		// Repeat the same raw history without sending the first output or emitting
		// message_end: stored tags must replay even when the request was abandoned.
		const next = await handler({ messages: structuredClone(raw) }, ctx);
		expect(next).toEqual(first);
	} finally {
		spy.mockRestore();
		db.close();
		clearContextHandlerSession("waiter");
	}
});

test("Pi writer wait yields and performs the actual managed write after release", async () => {
	await underWriter(async (db, locker, dir) => {
		const handler = install(db);
		const raw = [userMessage("new turn", 1)];
		let ticked = false;
		const release = setTimeout(() => {
			ticked = true;
			locker.exec("ROLLBACK");
		}, 200);
		try {
			const result = await handler(
				{ messages: raw },
				fakeContext("waiter", dir, ["u"], raw),
			);
			expect(ticked).toBe(true);
			expect(JSON.stringify(result)).toContain("§");
			expect(
				db
					.prepare(
						"SELECT session_id FROM session_meta WHERE session_id='waiter'",
					)
					.get(),
			).toBeDefined();
		} finally {
			clearTimeout(release);
		}
	});
});

test("Pi writer wait honours a supplied host abort signal before writes", async () => {
	await underWriter(async (db, _locker, dir) => {
		const handler = install(db);
		const controller = new AbortController();
		const raw = [userMessage("cancelled", 1)];
		const ctx = Object.assign(fakeContext("waiter", dir, ["u"], raw), {
			signal: controller.signal,
		});
		const abort = setTimeout(
			() => controller.abort(new Error("host cancelled")),
			100,
		);
		const started = performance.now();
		try {
			await expect(handler({ messages: raw }, ctx)).rejects.toThrow(
				"host cancelled",
			);
		} finally {
			clearTimeout(abort);
		}
		expect(performance.now() - started).toBeLessThan(350);
		expect(
			db.prepare("SELECT * FROM session_meta WHERE session_id='waiter'").get(),
		).toBeNull();
	});
});

test("a superseded Pi waiter never writes or aborts the newer pass", async () => {
	await underWriter(async (db, locker, dir) => {
		const handler = install(db);
		const older = [userMessage("abandoned old input", 1)];
		let oldAborts = 0;
		const oldCtx = Object.assign(fakeContext("waiter", dir, ["old"], older), {
			abort: () => {
				oldAborts++;
			},
		});
		const old = handler({ messages: older }, oldCtx).then(
			() => "unexpected success",
			(error: Error) => error.message,
		);
		await new Promise((done) => setTimeout(done, 100));
		const newer = [userMessage("replacement input", 2)];
		const current = handler(
			{ messages: newer },
			fakeContext("waiter", dir, ["new"], newer),
		);
		const release = setTimeout(() => locker.exec("ROLLBACK"), 200);
		try {
			expect(await old).toContain("superseded");
			const result = await current;
			expect(oldAborts).toBe(0);
			expect(JSON.stringify(result)).toContain("replacement input");
			expect(JSON.stringify(result)).not.toContain("abandoned old input");
			expect(
				db
					.prepare("SELECT message_id FROM tags WHERE session_id='waiter'")
					.all()
					.every(
						(row) =>
							!(row as { message_id: string }).message_id.startsWith("old"),
					),
			).toBe(true);
		} finally {
			clearTimeout(release);
		}
	});
});
