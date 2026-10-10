import { expect, spyOn, test } from "bun:test";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import * as projectIdentity from "@magic-context/core/features/magic-context/memory/project-identity";
import { getAutoSearchHintDecisions } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { adoptPiFallbackMessageTag } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createPiLkgCoordinator } from "./pi-lkg";
import { capturePiServedArray } from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";

type Handler = (
	event: { messages: PiMessage[] },
	ctx: ReturnType<typeof fakeContext>,
) => Promise<{ messages: PiMessage[] }>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const cancellation of ["successor", "signal"] as const) {
	test(`r2: ${cancellation} fences checkout-claim resumption before all writes`, async () => {
		const db = createTestDb();
		const sessionId = `r2-claim-${cancellation}`;
		const paused = deferred<null>();
		const entered = deferred<void>();
		let calls = 0;
		const fake = createFakePi();
		registerPiContextHandler(
			fake.pi as never,
			{ db },
			{
				checkoutClaim: {
					refusal: async () => {
						if (++calls === 1) {
							entered.resolve();
							return paused.promise;
						}
						return null;
					},
				},
			},
		);
		const handler = fake.handlers.get("context") as unknown as Handler;
		const controller = new AbortController();
		const raw = [userMessage("old claim input")];
		const old = handler(
			{ messages: raw },
			{
				...fakeContext(sessionId, process.cwd(), ["old"], raw),
				signal: controller.signal,
			},
		).catch((error: Error) => error);
		try {
			await entered.promise;
			if (cancellation === "signal")
				controller.abort(new Error("cancelled claim"));
			else {
				const newer = [userMessage("new claim input", 2)];
				await handler(
					{ messages: newer },
					fakeContext(sessionId, process.cwd(), ["new"], newer),
				);
			}
			paused.resolve(null);
			expect(((await old) as Error).message).toBe(
				cancellation === "signal"
					? "cancelled claim"
					: "Pi context pass superseded before writer admission",
			);
			expect(
				db.prepare("SELECT * FROM tags WHERE message_id='old:p0'").all(),
			).toEqual([]);
		} finally {
			paused.resolve(null);
			await old;
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
		}
	});

	test(`r2: ${cancellation} fences real auto-search continuation and LKG publication`, async () => {
		const db = createTestDb();
		const sessionId = `r2-search-${cancellation}`;
		const paused =
			deferred<Awaited<ReturnType<typeof search.searchAutoHint>>>();
		const entered = deferred<void>();
		const spy = spyOn(search, "searchAutoHint").mockImplementation(() => {
			entered.resolve();
			return paused.promise;
		});
		const snapshot = spyOn(
			embedding,
			"getProjectEmbeddingSnapshot",
		).mockReturnValue(
			autoSearchTestSnapshot("github.com/cortexkit/magic-context"),
		);
		const identity = spyOn(
			projectIdentity,
			"resolveProjectIdentityForSession",
		).mockReturnValue("github.com/cortexkit/magic-context");
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			autoSearch: { enabled: true, minPromptChars: 1, scoreThreshold: 0.55 },
		});
		const handler = fake.handlers.get("context") as unknown as Handler;
		const controller = new AbortController();
		const raw = [
			userMessage(
				"Please find the previous implementation of writer admission",
			),
		];
		const old = handler(
			{ messages: raw },
			{
				...fakeContext(sessionId, process.cwd(), ["old"], raw),
				signal: controller.signal,
			},
		).catch((error: Error) => error);
		try {
			await entered.promise;
			if (cancellation === "signal")
				controller.abort(new Error("cancelled search"));
			else {
				const newer = [userMessage("x", 2)];
				// A stacked augmentation skips search on the successor, avoiding the paused query.
				newer[0] = userMessage(
					"<ctx-search-hint>already searched</ctx-search-hint>",
					2,
				);
				await handler(
					{ messages: newer },
					fakeContext(sessionId, process.cwd(), ["new"], newer),
				);
			}
			paused.resolve([]);
			expect(((await old) as Error).message).toBe(
				cancellation === "signal"
					? "cancelled search"
					: "Pi context pass superseded before writer admission",
			);
			await new Promise<void>((done) => setImmediate(done));
			expect(getSlot(sessionId)?.jsonPrefix ?? "").not.toContain(
				"previous implementation",
			);
			expect(
				getAutoSearchHintDecisions(db, sessionId).map(
					(decision) => decision.messageId,
				),
			).not.toContain("old");
		} finally {
			paused.resolve([]);
			await old;
			spy.mockRestore();
			snapshot.mockRestore();
			identity.mockRestore();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

for (const api of [
	"azure-openai-responses",
	"bedrock-converse-stream",
	"future-whole-context-api",
]) {
	test(`r2: unproved ${api} preserves the root LKG content fence`, () => {
		const db = createTestDb();
		let flush!: () => void;
		const coordinator = createPiLkgCoordinator(db, (capture) => {
			flush = capture;
		});
		const raw = [
			{
				role: "user",
				content: "question",
				timestamp: 1,
				contextSnapshot: "old",
			},
		];
		const begin = (messages: unknown[]) =>
			coordinator.beginPass({
				sessionId: api,
				messages,
				entryIds: ["u"],
				modelKey: "test/model",
				providerKey: "test",
				apiKey: api,
			});
		try {
			const snapshot = begin(raw);
			coordinator.captureAppliedPass({
				snapshot,
				outputMessages: raw,
				outputEntryIds: ["u"],
				cacheBusting: false,
			});
			flush();
			const next = structuredClone(raw);
			next[0].contextSnapshot = "new";
			expect(coordinator.replay(begin(next))).toEqual({
				ok: false,
				reason: "lkg_content_mismatch",
			});
		} finally {
			clearContextHandlerSession(api);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

test("r2: distinct multi-block real messages must not collide with one served fallback", async () => {
	const db = createTestDb();
	const sessionId = "r2-identical-real";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const raw = [
		userMessage(
			[
				{ type: "text", text: "repeat" },
				{ type: "text", text: "alpha" },
			],
			1,
		),
		userMessage(
			[
				{ type: "text", text: "repeat" },
				{ type: "text", text: "beta" },
			],
			1,
		),
	];
	try {
		const real = await handler(
			{ messages: [structuredClone(raw[0])] },
			fakeContext(sessionId, process.cwd(), ["first"], [raw[0]]),
		);
		expect(textOf(real.messages[0])).toBe("§1§ repeat§2§ alpha");
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const fallback = await handler(
			{ messages: [structuredClone(raw[1])] },
			unavailable,
		);
		expect(textOf(fallback.messages[0])).toBe("§3§ repeat§4§ beta");
		const result = await handler(
			{ messages: structuredClone(raw) },
			fakeContext(sessionId, process.cwd(), ["first", "second"], raw),
		).catch((error: Error) => error);
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error))
			expect(result.messages.map(textOf)).toEqual([
				"§1§ repeat§2§ alpha",
				"§3§ repeat§4§ beta",
			]);
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: an unserved racing real row is not served evidence merely because user text mentions its number", async () => {
	const db = createTestDb();
	const sessionId = "r2-literal-marker";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const original = userMessage(
		"Explain the marker §9§ in this pasted example",
		1,
	);
	try {
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const first = await handler(
			{ messages: [structuredClone(original)] },
			unavailable,
		);
		expect(textOf(first.messages[0])).toBe(
			"§1§ Explain the marker §9§ in this pasted example",
		);
		db.prepare(
			"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
		).run(sessionId);
		db.prepare(
			"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,?,0,'pi')",
		).run(sessionId, textOf(original));
		const next = [structuredClone(original)];
		const result = await handler(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["real"], next),
		).catch((error: Error) => error);
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error))
			expect(textOf(result.messages[0])).toBe(textOf(first.messages[0]));
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: three-row unserved ordinal collision retains the canonical real number", () => {
	const db = createTestDb();
	const sessionId = "r2-three-way";
	const raw = userMessage("same identity", 1);
	const fingerprint = __test
		.buildEntryFingerprintMap([raw], () => "real")
		.get("real");
	try {
		if (fingerprint === undefined)
			throw new Error("fixture fingerprint missing");
		for (const [id, number] of [
			["pi-msg-a:p0", 1],
			["pi-msg-a:p1", 2],
			["real:p0", 9],
		] as const)
			db.prepare(
				"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES (?,'message','active',?,?,0,?)",
			).run(id, sessionId, number, fingerprint);
		__test.adoptPiFallbackTags(
			db,
			sessionId,
			createTagger(),
			new Map([["real", fingerprint]]),
		);
		expect(
			db
				.prepare("SELECT message_id,tag_number FROM tags ORDER BY tag_number")
				.all(),
		).toEqual([
			{ message_id: "real:p1", tag_number: 2 },
			{ message_id: "real:p0", tag_number: 9 },
		]);
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: three-way collision folds only unserved duplicates into the served fallback", () => {
	const db = createTestDb();
	const sessionId = "r2-true-three-way";
	try {
		for (const number of [1, 9, 10])
			db.prepare(
				"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES (?,'message','active',?,?,0)",
			).run(number === 1 ? "pi-msg-a:p0" : "real:p0", sessionId, number);
		capturePiServedArray(sessionId, ["§1§ actually returned"]);
		expect(
			adoptPiFallbackMessageTag(
				db,
				sessionId,
				1,
				"pi-msg-a:p0",
				"real:p0",
				new Set([1]),
			),
		).toEqual({ action: "folded", tagNumber: 1, deletedTagNumbers: [9, 10] });
		expect(db.prepare("SELECT message_id,tag_number FROM tags").all()).toEqual([
			{ message_id: "real:p0", tag_number: 1 },
		]);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("r2: same-connection revision change discovers a historical fallback drop", async () => {
	const db = createTestDb();
	const sessionId = "r2-local-revision";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const historical = userMessage("historical text", 1);
	let restore: (() => void) | undefined;
	try {
		const first = await handler(
			{ messages: [structuredClone(historical)] },
			fakeContext(sessionId, process.cwd(), ["history"], [historical]),
		);
		expect(textOf(first.messages[0])).toBe("§1§ historical text");
		const fingerprint = __test
			.buildEntryFingerprintMap([historical], () => "history")
			.get("history");
		const prepare = db.prepare.bind(db);
		let inserted = false;
		const spy = spyOn(db, "prepare").mockImplementation((sql) => {
			if (
				sql === "SELECT total_changes() AS changes" &&
				!db.inTransaction &&
				!inserted
			) {
				inserted = true;
				prepare(
					"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES ('pi-msg-local:p0','message','dropped',?,9,0,?)",
				).run(sessionId, fingerprint);
			}
			return prepare(sql);
		});
		restore = () => spy.mockRestore();
		const next = [structuredClone(historical), userMessage("tail", 2)];
		const result = await handler(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["history", "tail"], next),
		);
		expect(inserted).toBe(true);
		expect(textOf(result.messages[0])).toBe("[dropped §1§]");
	} finally {
		restore?.();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: an event-aborted waiter superseded twice never aborts the latest turn", async () => {
	const db = createTestDb();
	const sessionId = "r2-three-generations";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const entered = deferred<void>();
	const controller = new AbortController();
	let aborts = 0;
	const exec = db.exec.bind(db);
	let begins = 0;
	const spy = spyOn(db, "exec").mockImplementation((sql) => {
		if (sql === "BEGIN IMMEDIATE" && ++begins === 1) {
			entered.resolve();
			throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
		}
		return exec(sql);
	});
	const raw = [userMessage("old waiting input")];
	const old = handler(
		{ messages: raw, signal: controller.signal } as { messages: PiMessage[] },
		{
			...fakeContext(sessionId, process.cwd(), ["old"], raw),
			abort: () => {
				aborts++;
			},
		} as ReturnType<typeof fakeContext>,
	).catch((error: Error) => error);
	try {
		await entered.promise;
		for (const id of ["middle", "latest"]) {
			const next = [userMessage(id, 2)];
			await handler(
				{ messages: next },
				fakeContext(sessionId, process.cwd(), [id], next),
			);
		}
		controller.abort(new Error("host abandoned old event"));
		expect(((await old) as Error).message).toBe(
			"Pi context pass superseded before writer admission",
		);
		expect(aborts).toBe(0);
	} finally {
		spy.mockRestore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: reloading a session must not forget its already-served fallback number", async () => {
	const db = createTestDb();
	const sessionId = "r2-reload-served";
	const original = userMessage("served before restart", 1);
	const install = () => {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		return fake.handlers.get("context") as unknown as Handler;
	};
	try {
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const first = await install()(
			{ messages: [structuredClone(original)] },
			unavailable,
		);
		expect(textOf(first.messages[0])).toBe("§1§ served before restart");
		db.prepare(
			"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
		).run(sessionId);
		db.prepare(
			"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,?,0,'pi')",
		).run(sessionId, textOf(original));
		// Session unload discards process-local evidence, but preserves the SQLite rows.
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		const next = [structuredClone(original)];
		const result = await install()(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["real"], next),
		);
		expect(textOf(result.messages[0])).toBe(textOf(first.messages[0]));
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
