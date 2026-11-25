import { expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { clearSession } from "@magic-context/core/features/magic-context/storage-meta-session";
import {
	TAG_REVISION_INCARNATION_KEY,
	tagIdentityRevisionKey,
	tagRevisionKey,
} from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { createPiTagSnapshotReader } from "./tag-snapshot-pi";

function fixture() {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-revision-incarnation-"),
	);
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	const writer = new Database(path);
	initializeDatabase(writer);
	return {
		db,
		writer,
		close() {
			writer.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function insert(
	db: Database,
	session: string,
	number: number,
	message: string,
) {
	db.prepare(
		"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?,?,'message','active',?,9,'pi')",
	).run(session, message, number);
}
function value(db: Database, key: string): string | null {
	return (
		(
			db
				.prepare("SELECT value FROM schema_migrations_meta WHERE key=?")
				.get(key) as { value: string } | null
		)?.value ?? null
	);
}
function stamp(db: Database, key: string) {
	const raw = value(db, key);
	if (raw === null) throw new Error("expected stored revision");
	const parts = raw.split(":");
	return {
		incarnation: parts.length === 1 ? "0" : parts[0],
		count: parts.at(-1),
	};
}

it("r2 permanent deletion and same-ID reuse must invalidate an already-open foreign reader", () => {
	const h = fixture();
	const tagger = createTagger();
	try {
		insert(h.writer, "reuse-live", 1, "before:p0");
		const read = createPiTagSnapshotReader(h.db);
		const old = read("reuse-live")[0];
		if (!old) throw new Error("missing seed tag");
		tagger.initFromDb("reuse-live", h.db);
		clearSession(h.writer, "reuse-live", false, true);
		h.writer
			.prepare(
				"INSERT INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'reuse-live','after:p0','message','dropped',7,9,'pi')",
			)
			.run(old.id);
		tagger.initFromDb("reuse-live", h.db);
		expect(read("reuse-live")).toEqual(getTagsBySession(h.db, "reuse-live"));
		expect(tagger.getTag("reuse-live", "after:p0", "message")).toBe(7);
		expect(tagger.getTag("reuse-live", "before:p0", "message")).toBeUndefined();
	} finally {
		tagger.cleanup("reuse-live");
		h.close();
	}
});

it("incarnations stay distinct when a reused session reaches the cached local count", () => {
	const h = fixture();
	try {
		const read = createPiTagSnapshotReader(h.db);
		for (let life = 0; life < 8; life++) {
			insert(h.writer, "reuse-count", 7, `life-${life}`);
			for (let i = 0; i < 41; i++)
				h.writer
					.prepare(
						"UPDATE tags SET byte_size=10 WHERE session_id='reuse-count'",
					)
					.run();
			const current = stamp(h.db, tagRevisionKey("reuse-count"));
			expect(current.count).toBe("42");
			expect(read("reuse-count")).toEqual(
				getTagsBySession(h.db, "reuse-count"),
			);
			const before = current.incarnation;
			clearSession(h.writer, "reuse-count", false, true);
			expect(value(h.db, tagRevisionKey("reuse-count"))).toBeNull();
			expect(value(h.db, tagIdentityRevisionKey("reuse-count"))).toBeNull();
			if (life < 7) {
				insert(h.writer, "reuse-count", 7, "temporary");
				expect(stamp(h.db, tagRevisionKey("reuse-count")).incarnation).not.toBe(
					before,
				);
				clearSession(h.writer, "reuse-count", false, true);
			}
		}
		expect(
			h.db
				.prepare(
					"SELECT key FROM schema_migrations_meta WHERE key LIKE 'tag_revision:%' OR key LIKE 'tag_identity_revision:%' OR key LIKE 'tag_revision_owner:%'",
				)
				.all(),
		).toEqual([]);
		expect(value(h.db, TAG_REVISION_INCARNATION_KEY)).not.toBeNull();
	} finally {
		h.close();
	}
});

it("warmed appends and updates do not write the database-wide allocation clock", () => {
	const h = fixture();
	try {
		insert(h.db, "warm", 1, "first:p0");
		const initial = value(h.db, TAG_REVISION_INCARNATION_KEY);
		const identity = value(h.db, tagIdentityRevisionKey("warm"));
		const read = createPiTagSnapshotReader(h.db);
		read("warm");
		h.db.exec(`CREATE TEMP TABLE seed_writes (value TEXT);
		CREATE TEMP TRIGGER observe_seed_writes AFTER UPDATE ON main.schema_migrations_meta
		WHEN NEW.key='${TAG_REVISION_INCARNATION_KEY}' BEGIN INSERT INTO seed_writes VALUES (NEW.value); END;`);
		// One transaction for the 1,001 appends: each insert committed by itself
		// is a separate disk sync, and on a slow CI disk that alone took the
		// test past its 30 s limit. The triggers under test fire per row either
		// way.
		h.db.exec("BEGIN");
		for (let i = 2; i <= 1002; i++) insert(h.db, "warm", i, `part-${i}:p0`);
		h.db.exec("COMMIT");
		h.db
			.prepare("UPDATE tags SET status='dropped' WHERE session_id='warm'")
			.run();
		expect(value(h.db, TAG_REVISION_INCARNATION_KEY)).toBe(initial);
		expect(value(h.db, tagIdentityRevisionKey("warm"))).toBe(identity);
		expect(h.db.prepare("SELECT * FROM seed_writes").all()).toEqual([]);
		expect(read("warm")).toEqual(getTagsBySession(h.db, "warm"));
	} finally {
		h.close();
	}
});

it("legacy scalar revisions preserve the local-write snapshot and tagger fast paths", () => {
	const h = fixture();
	const tagger = createTagger();
	try {
		insert(h.db, "legacy", 1, "first:p0");
		h.db
			.prepare("UPDATE schema_migrations_meta SET value='40' WHERE key=?")
			.run(tagRevisionKey("legacy"));
		h.db
			.prepare("UPDATE schema_migrations_meta SET value='17' WHERE key=?")
			.run(tagIdentityRevisionKey("legacy"));
		const read = createPiTagSnapshotReader(h.db);
		read("legacy");
		tagger.initFromDb("legacy", h.db);
		const prepare = spyOn(h.db, "prepare");
		try {
			tagger.assignTag("legacy", "second:p0", "message", 9, h.db);
			read("legacy");
			tagger.initFromDb("legacy", h.db);
			expect(
				prepare.mock.calls.filter(
					([sql]) =>
						sql.includes("FROM tags WHERE session_id") &&
						!sql.includes("tag_number IN") &&
						!sql.includes("MAX(") &&
						!sql.includes("message_id ="),
				),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
		expect(stamp(h.db, tagRevisionKey("legacy"))).toEqual({
			incarnation: "0",
			count: "41",
		});
		expect(read("legacy")).toEqual(getTagsBySession(h.db, "legacy"));
		h.writer
			.prepare("UPDATE tags SET status='dropped' WHERE session_id='legacy'")
			.run();
		expect(read("legacy")).toEqual(getTagsBySession(h.db, "legacy"));
		expect(value(h.db, tagIdentityRevisionKey("legacy"))).toBe("17");
	} finally {
		tagger.cleanup("legacy");
		h.close();
	}
});

it("seed allocation and first counter rows roll back with the tag write", () => {
	const h = fixture();
	try {
		insert(h.db, "kept", 1, "kept");
		const before = value(h.db, TAG_REVISION_INCARNATION_KEY);
		h.writer.exec("BEGIN");
		insert(h.writer, "rolled-back", 1, "discarded");
		expect(value(h.writer, TAG_REVISION_INCARNATION_KEY)).not.toBe(before);
		expect(value(h.db, TAG_REVISION_INCARNATION_KEY)).toBe(before);
		h.writer.exec("ROLLBACK");
		expect(value(h.db, TAG_REVISION_INCARNATION_KEY)).toBe(before);
		expect(value(h.db, tagRevisionKey("rolled-back"))).toBeNull();
		expect(value(h.db, tagIdentityRevisionKey("rolled-back"))).toBeNull();
		expect(getTagsBySession(h.db, "rolled-back")).toEqual([]);
	} finally {
		h.close();
	}
});

it("all missing revision creation paths use allocated incarnations", () => {
	const h = fixture();
	const allocated = new Set<string>();
	const take = (key: string) => {
		const current = stamp(h.db, key);
		expect(current.incarnation).not.toBe("0");
		expect(allocated.has(current.incarnation as string)).toBe(false);
		allocated.add(current.incarnation as string);
		return current;
	};
	const drop = (session: string) =>
		h.writer
			.prepare("DELETE FROM schema_migrations_meta WHERE key IN (?, ?)")
			.run(tagRevisionKey(session), tagIdentityRevisionKey(session));
	try {
		insert(h.writer, "source", 1, "before");
		take(tagRevisionKey("source"));
		take(tagIdentityRevisionKey("source"));
		drop("source");
		const row = getTagsBySession(h.db, "source")[0];
		if (!row) throw new Error("missing source tag");
		h.writer
			.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'replace-target','replaced','message','dropped',7,9,'pi')",
			)
			.run(row.id);
		take(tagRevisionKey("source"));
		take(tagIdentityRevisionKey("source"));
		take(tagRevisionKey("replace-target"));
		take(tagIdentityRevisionKey("replace-target"));
		h.writer
			.prepare("UPDATE tags SET session_id='update-target' WHERE id=?")
			.run(row.id);
		take(tagRevisionKey("update-target"));
		take(tagIdentityRevisionKey("update-target"));
		drop("update-target");
		h.writer.prepare("DELETE FROM tags WHERE id=?").run(row.id);
		take(tagRevisionKey("update-target"));
		clearSession(h.writer, "empty-clear");
		take(tagIdentityRevisionKey("empty-clear"));
	} finally {
		h.close();
	}
});

it("incarnations remain exact above JavaScript's safe integer range", () => {
	const h = fixture();
	try {
		insert(h.writer, "large-seed", 1, "before");
		h.writer
			.prepare(
				"UPDATE schema_migrations_meta SET value='9007199254740992' WHERE key=?",
			)
			.run(TAG_REVISION_INCARNATION_KEY);
		clearSession(h.writer, "large-seed", false, true);
		insert(h.writer, "large-seed", 1, "first-large");
		const read = createPiTagSnapshotReader(h.db);
		read("large-seed");
		const before = stamp(h.db, tagRevisionKey("large-seed"));
		expect(before.incarnation).toBe("9007199254740993");
		clearSession(h.writer, "large-seed", false, true);
		insert(h.writer, "large-seed", 7, "second-large");
		expect(stamp(h.db, tagRevisionKey("large-seed")).incarnation).toBe(
			"9007199254740995",
		);
		expect(read("large-seed")).toEqual(getTagsBySession(h.db, "large-seed"));
	} finally {
		h.close();
	}
});

it("exhausted incarnation allocation refuses atomically instead of reusing a stamp", () => {
	const h = fixture();
	try {
		insert(h.db, "kept", 1, "kept");
		h.db
			.prepare(
				"UPDATE schema_migrations_meta SET value='9223372036854775807' WHERE key=?",
			)
			.run(TAG_REVISION_INCARNATION_KEY);
		expect(() => insert(h.writer, "overflow", 1, "must-not-land")).toThrow();
		expect(value(h.db, TAG_REVISION_INCARNATION_KEY)).toBe(
			"9223372036854775807",
		);
		expect(value(h.db, tagRevisionKey("overflow"))).toBeNull();
		expect(value(h.db, tagIdentityRevisionKey("overflow"))).toBeNull();
		expect(getTagsBySession(h.db, "overflow")).toEqual([]);
	} finally {
		h.close();
	}
});

it("own first allocation mirrors its epoch without adopting a peer's seeded bindings", () => {
	const h = fixture();
	const tagger = createTagger();
	try {
		tagger.initFromDb("owned-first", h.db);
		tagger.assignTag("owned-first", "own:p0", "message", 9, h.db);
		expect(tagger.getLoadedTagIdentityRevision?.("owned-first", h.db)).toBe(
			value(h.db, tagIdentityRevisionKey("owned-first")),
		);
		const prepare = spyOn(h.db, "prepare");
		try {
			tagger.initFromDb("owned-first", h.db);
			expect(
				prepare.mock.calls.some(([sql]) =>
					sql.startsWith("SELECT message_id, tag_number, type"),
				),
			).toBe(false);
		} finally {
			prepare.mockRestore();
		}
		tagger.initFromDb("peer-first", h.db);
		insert(h.writer, "peer-first", 1, "peer:p0");
		tagger.assignTag("peer-first", "own:p0", "message", 9, h.db);
		expect(
			tagger.getLoadedTagIdentityRevision?.("peer-first", h.db),
		).toBeNull();
		tagger.initFromDb("peer-first", h.db);
		expect(tagger.getTag("peer-first", "peer:p0", "message")).toBe(1);
		expect(tagger.getTag("peer-first", "own:p0", "message")).toBe(2);
	} finally {
		tagger.cleanup("owned-first");
		tagger.cleanup("peer-first");
		h.close();
	}
});
