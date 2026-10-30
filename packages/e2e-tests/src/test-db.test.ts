import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, writeTestDb } from "./test-db";

test("replay publication reserves the writer before reading its snapshot", () => {
	const root = mkdtempSync(join(tmpdir(), "mc-replay-writer-"));
	const path = join(root, "context.db");
	const replay = openTestDb(path);
	const competitor = openTestDb(path);
	try {
		replay.exec("PRAGMA journal_mode=WAL; CREATE TABLE publications (id INTEGER)");
		competitor.exec("PRAGMA busy_timeout=0");
		writeTestDb(replay, () => {
			expect(replay.prepare("SELECT COUNT(*) AS n FROM publications").get()).toEqual({ n: 0 });
			// The replay must already own the write lock before its first read. Otherwise
			// another connection could commit here and make the replay's later write fail.
			expect(() => competitor.exec("INSERT INTO publications VALUES (2)")).toThrow("database is locked");
			replay.exec("INSERT INTO publications VALUES (1)");
		});
		expect(competitor.prepare("SELECT id FROM publications").all()).toEqual([{ id: 1 }]);
	} finally {
		replay.close();
		competitor.close();
		rmSync(root, { recursive: true, force: true });
	}
});
