import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import { getAutoSearchHintDecisions } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { persistAutoSearchSkip } from "@magic-context/core/hooks/magic-context/auto-search-deadline";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { searchAutoHint } from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import { runAutoSearchHintForPi } from "./auto-search-pi";
import { createTestDb, userMessage } from "./test-utils.test";

const root = join(tmpdir(), "magic-context", "auto-search-deadline");
mkdirSync(root, { recursive: true });
const db = createTestDb(
	join(createTestTempDirFromPath(join(root, "pi-")), "context.db"),
);
const options = {
	enabled: true,
	projectPath: "git:pi-deadline",
	minPromptChars: 1,
};
let snapshotSpy: ReturnType<
	typeof spyOn<typeof embedding, "getProjectEmbeddingSnapshot">
>;
beforeEach(() => {
	snapshotSpy = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
		autoSearchTestSnapshot(options.projectPath),
	);
});
afterEach(() => snapshotSpy.mockRestore());
afterAll(() => db.close());

test("Pi aborts slow embeddings at the deadline and replays byte-identical skip on retry", async () => {
	let signal: AbortSignal | undefined;
	let release: ((value: null) => void) | undefined;
	const spy = spyOn(embedding, "embedTextForProject").mockImplementation(
		async (_project, _text, current) => {
			signal = current;
			return new Promise<null>((resolve) => {
				release = resolve;
			});
		},
	);
	try {
		const messages = [userMessage("explain historian cache wiring", 1)];
		const before = JSON.stringify(messages);
		const start = performance.now();
		await runAutoSearchHintForPi({
			db,
			sessionId: "pi-slow",
			messages,
			entryIds: ["user"],
			options,
		});
		expect(performance.now() - start).toBeLessThan(3150);
		expect(signal?.aborted).toBe(true);
		expect(JSON.stringify(messages)).toBe(before);
		release?.(null);
		await persistAutoSearchSkip(db, "pi-slow", "user");
		expect(getAutoSearchHintDecisions(db, "pi-slow")[0]).toEqual({
			messageId: "user",
			decision: "no-hint",
			reason: "timeout",
		});
		expect(
			db
				.prepare("SELECT harness FROM session_meta WHERE session_id = ?")
				.get("pi-slow"),
		).toEqual({ harness: "pi" });
		const replay = [userMessage("explain historian cache wiring", 1)];
		await runAutoSearchHintForPi({
			db,
			sessionId: "pi-slow",
			messages: replay,
			entryIds: ["user"],
			options,
		});
		expect(JSON.stringify(replay)).toBe(before);
		expect(spy).toHaveBeenCalledTimes(1);
	} finally {
		release?.(null);
		spy.mockRestore();
	}
}, 6000);

test("Pi bounds a synchronous SQLite search worker by the same turn deadline", async () => {
	const realSearch = searchAutoHint;
	const spy = spyOn(search, "searchAutoHint").mockImplementation(
		(db, session, project, query, options) =>
			realSearch(
				db,
				session,
				project,
				query,
				options,
				new URL(
					"../../plugin/src/hooks/magic-context/auto-search-blocking.fixture.ts",
					import.meta.url,
				),
			),
	);
	const embed = spyOn(embedding, "embedTextForProject").mockResolvedValue(null);
	try {
		const messages = [userMessage("explain historian cache wiring", 1)];
		const before = JSON.stringify(messages);
		const start = performance.now();
		await runAutoSearchHintForPi({
			db,
			sessionId: "pi-sync",
			messages,
			entryIds: ["user"],
			options,
		});
		expect(performance.now() - start).toBeLessThan(3150);
		expect(embed).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(messages)).toBe(before);
	} finally {
		spy.mockRestore();
		embed.mockRestore();
	}
}, 6000);

test("Pi defers cold synchronous preparation without holding the served stage", async () => {
	snapshotSpy.mockReturnValue(null);
	let prepared = false;
	const messages = [userMessage("explain historian cache wiring", 1)];
	const before = JSON.stringify(messages);
	const start = performance.now();
	await runAutoSearchHintForPi({
		db,
		sessionId: "pi-cold-preparation",
		messages,
		entryIds: ["cold-user"],
		options,
		ensureProjectRegistered: async () => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3600);
			prepared = true;
		},
	});
	expect(performance.now() - start).toBeLessThan(3150);
	expect(prepared).toBe(false);
	expect(JSON.stringify(messages)).toBe(before);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(prepared).toBe(true);
}, 7000);
