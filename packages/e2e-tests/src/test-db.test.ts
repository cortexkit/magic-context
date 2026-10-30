import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database as SharedDatabase } from "../../plugin/src/shared/sqlite";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";
import { openTestDb, writeTestDb } from "./test-db";

test("replay publication reserves the writer before reading its snapshot", () => {
	const root = createE2ETempDir("mc-replay-writer-");
	const path = join(root, "context.db");
	const replay = openTestDb(path);
	const competitor = openTestDb(path);
	try {
		replay.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE publications (id INTEGER)",
		);
		competitor.exec("PRAGMA busy_timeout=0");
		writeTestDb(replay, () => {
			expect(
				replay.prepare("SELECT COUNT(*) AS n FROM publications").get(),
			).toEqual({ n: 0 });
			// The replay must already own the write lock before its first read. Otherwise
			// another connection could commit here and make the replay's later write fail.
			expect(() =>
				competitor.exec("INSERT INTO publications VALUES (2)"),
			).toThrow("database is locked");
			replay.exec("INSERT INTO publications VALUES (1)");
		});
		expect(competitor.prepare("SELECT id FROM publications").all()).toEqual([
			{ id: 1 },
		]);
	} finally {
		replay.close();
		competitor.close();
		cleanupE2ETempDir(root);
	}
});

test("context handles retain the supplied adapter's transaction behavior", () => {
	const root = createE2ETempDir("mc-context-adapter-");
	const path = join(root, "context.db");
	const replay = openTestDb(path, undefined, SharedDatabase);
	const competitor = openTestDb(path);
	try {
		replay.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE publications (id INTEGER)",
		);
		expect(replay.prepare("PRAGMA busy_timeout").get()).toEqual({
			timeout: 5000,
		});
		competitor.exec("PRAGMA busy_timeout=0");
		replay.transaction(() => {
			replay.prepare("SELECT * FROM publications").all();
			expect(() =>
				competitor.exec("INSERT INTO publications VALUES (2)"),
			).toThrow("database is locked");
		})();
		const reader = openTestDb(
			path,
			{ readonly: true, fileMustExist: true },
			SharedDatabase,
		);
		try {
			expect(reader.prepare("PRAGMA busy_timeout").get()).toEqual({
				timeout: 5000,
			});
		} finally {
			reader.close();
		}
	} finally {
		replay.close();
		competitor.close();
		cleanupE2ETempDir(root);
	}
});
