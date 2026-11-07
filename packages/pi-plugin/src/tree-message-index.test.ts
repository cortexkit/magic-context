import { afterEach, expect, it } from "bun:test";
import { indexMessagesAfterOrdinal } from "@magic-context/core/features/magic-context/message-index";
import {
	__resetMessageIndexAsyncForTests,
	getMessageIndexQueueHeapStats,
	isSessionReconciled,
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import {
	searchMessageHistory,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import {
	BOOT_QUIET_MS,
	setBootQuietPeriodForTests,
} from "@magic-context/core/plugin/boot-quiet";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { convertEntriesToRawMessages } from "./read-session-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const sessionId = "ses-tree-index";
afterEach(() => {
	setBootQuietPeriodForTests(null);
	clearContextHandlerSession(sessionId);
	__resetMessageIndexAsyncForTests();
});

function fixture() {
	setBootQuietPeriodForTests(null);
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const ctx = fakeContext(
		sessionId,
		process.cwd(),
		["keep", "abandoned"],
		[
			userMessage("survivorquartz legitimate archive"),
			userMessage("abandonedzephyr old branch", 2),
		],
	);
	const old = convertEntriesToRawMessages(ctx.sessionManager.getBranch());
	indexMessagesAfterOrdinal(db, sessionId, old, 0, old.length);
	const navigate = async (sameLeaf = false) => {
		const next = fakeContext(
			sessionId,
			process.cwd(),
			["keep", "replacement"],
			[
				userMessage("survivorquartz legitimate archive"),
				userMessage("replacement active branch", 3),
			],
		);
		await fake.handlers.get("session_tree")?.(
			{
				type: "session_tree",
				oldLeafId: "abandoned",
				newLeafId: sameLeaf ? "abandoned" : "replacement",
			} as never,
			next as never,
		);
	};
	const search = (query: string) =>
		unifiedSearch(db, sessionId, process.cwd(), query, {
			sources: ["message"],
			maxMessageOrdinal: 10,
			embeddingEnabled: false,
			measurementDisabled: true,
		});
	return { db, old, navigate, search };
}

it("tree branch change clears abandoned rows and rebuilds the active path", async () => {
	const { db, old, navigate, search } = fixture();
	try {
		expect(await search("abandonedzephyr")).toHaveLength(1);
		// Old callbacks and a settled incremental snapshot must not repopulate the removed branch.
		scheduleReconciliation(db, sessionId, () => old);
		const abandonedMessage = old[1];
		if (!abandonedMessage) throw new Error("Missing abandoned fixture message");
		scheduleIncrementalIndex(
			db,
			sessionId,
			abandonedMessage.id,
			abandonedMessage,
		);
		await navigate();
		const deadline = Date.now() + 2000;
		while (!isSessionReconciled(sessionId) && Date.now() < deadline)
			await Bun.sleep(10);
		expect(isSessionReconciled(sessionId)).toBe(true);
		await Bun.sleep(150);
		expect(await search("abandonedzephyr")).toEqual([]);
		expect(await search("survivorquartz")).toHaveLength(1);
		expect(await search("replacement")).toHaveLength(1);
		expect(
			db
				.prepare(
					"SELECT message_id FROM message_history_fts WHERE session_id = ? ORDER BY CAST(message_ordinal AS INTEGER)",
				)
				.all(sessionId),
		).toEqual([{ message_id: "keep" }, { message_id: "replacement" }]);
	} finally {
		db.close();
	}
});

it("message search hides abandoned rows while a tree rebuild waits for boot quiet", async () => {
	const { db, navigate, search } = fixture();
	try {
		expect(await search("abandonedzephyr")).toHaveLength(1);
		setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS + 250);
		await navigate();
		expect(getMessageIndexQueueHeapStats().queueLength).toBeGreaterThan(0);
		// The abandoned ordinal is below the search cutoff and still in FTS,
		// so only the rebuild gate can prevent this result from leaking.
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ?",
				)
				.get(sessionId),
		).toEqual({ n: 2 });
		expect(await search("abandonedzephyr")).toEqual([]);
		const deadline = Date.now() + 2000;
		while (!isSessionReconciled(sessionId) && Date.now() < deadline)
			await Bun.sleep(10);
		expect(isSessionReconciled(sessionId)).toBe(true);
		expect(await search("survivorquartz")).toHaveLength(1);
	} finally {
		db.close();
	}
});

it("same-leaf tree events leave the message index searchable", async () => {
	const { db, navigate, search } = fixture();
	try {
		await navigate(true);
		expect(await search("abandonedzephyr")).toHaveLength(1);
	} finally {
		db.close();
	}
});

it("a search begun on the old branch cannot return its delayed worker result", async () => {
	const { db, navigate } = fixture();
	try {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = unifiedSearch(
			db,
			sessionId,
			process.cwd(),
			"abandonedzephyr",
			{
				sources: ["message"],
				maxMessageOrdinal: 10,
				embeddingEnabled: false,
				measurementDisabled: true,
				searchMessageHistory: async (request) => {
					const outcome = searchMessageHistory(db, request);
					expect(outcome.results).toHaveLength(1);
					started.resolve();
					await release.promise;
					return outcome;
				},
			},
		);
		await started.promise;
		await navigate();
		const deadline = Date.now() + 2000;
		while (!isSessionReconciled(sessionId) && Date.now() < deadline)
			await Bun.sleep(10);
		release.resolve();
		expect(await pending).toEqual([]);
	} finally {
		db.close();
	}
});
