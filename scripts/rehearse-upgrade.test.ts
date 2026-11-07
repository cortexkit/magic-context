import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareServedBodies, firstDifference, snapshotRoot, hashFile, version, versionAfterCrash, schemaDigest } from "./lib/upgrade-audit";
import { assertEffects, assertDoctor, assertFullDoctorTarget, assertMigrationMetrics, newest049, assertHostPasses } from "./lib/upgrade-contract";
import { MOVED_COLUMNS, type PayloadProof } from "./lib/upgrade-payloads";
import { Database as ProductionDatabase } from "../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { restorePreV103SessionMetaLayout } from "../packages/plugin/src/features/magic-context/session-meta-pre-v103-test-support";
import { splitSessionMetaPayloads } from "../packages/plugin/src/features/magic-context/migration-v103-session-payloads";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { databaseDoctor } from "./lib/upgrade-doctor";
import { assertApplicationSchema } from "./lib/upgrade-schema";
import { isolatedEnvironment } from "./lib/upgrade-isolation";

function pair(): [string, string] {
	const parent = join(tmpdir(), "magic-context", "upgrade-audit-test");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "case-"));
	const before = join(root, "before.db");
	const after = join(root, "after.db");
	const db = new Database(before);
	db.exec(
		"CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT, embedding BLOB); INSERT INTO memories VALUES(1,'東京',x'00ff'); CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, state TEXT); INSERT INTO session_meta VALUES('s','opaque');",
	);
	db.close();
	copyFileSync(before, after);
	return [before, after];
}

test("upgrade audit accepts additive columns without changing old session_meta keys", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("ALTER TABLE session_meta ADD COLUMN held_release TEXT");
	db.close();
	expect(firstDifference(before, after)).toBeNull();
});

function schemaPair(): [string, string] {
	const [before, after] = pair();
	for (const path of [before, after]) {
		const db = new Database(path);
		db.exec("DROP TABLE session_meta; CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, system_prompt_hash TEXT DEFAULT '', thinking_binding_recovery_target TEXT NOT NULL DEFAULT ''); CREATE INDEX idx_memory_content ON memories(content)");
		db.close();
	}
	return [before, after];
}

test("application schema rejects an unknown extra table", () => {
	const [before, after] = schemaPair();
	const db = new Database(after);
	db.exec("CREATE TABLE unreviewed_runtime_state(value TEXT)"); db.close();
	expect(() => assertApplicationSchema(before, after)).toThrow("unknown extra table unreviewed_runtime_state");
});

test("application schema rejects a missing fresh column", () => {
	const [before, after] = schemaPair();
	const db = new Database(after);
	db.exec("ALTER TABLE memories DROP COLUMN embedding"); db.close();
	expect(() => assertApplicationSchema(before, after)).toThrow("missing fresh column memories.embedding");
});

test("application schema rejects an incompatible declared type", () => {
	const [before, after] = schemaPair();
	const db = new Database(after);
	db.exec("DROP TABLE memories; CREATE TABLE memories(id INTEGER PRIMARY KEY, content INTEGER, embedding BLOB); CREATE INDEX idx_memory_content ON memories(content)"); db.close();
	expect(() => assertApplicationSchema(before, after)).toThrow("incompatible column memories.content");
});

test("application schema accepts only the reviewed legacy object and metadata profiles", () => {
	const [before, after] = schemaPair();
	for (const path of [before, after]) {
		const db = new Database(path); db.exec("CREATE TABLE sequence_owner(id INTEGER PRIMARY KEY AUTOINCREMENT)"); db.close();
	}
	const db = new Database(after);
	db.exec(`DROP TABLE session_meta;
		CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, system_prompt_hash INTEGER DEFAULT 0, thinking_binding_recovery_target TEXT DEFAULT '',
			nudge_45 INTEGER DEFAULT 0, nudge_55 INTEGER DEFAULT 0, nudge_65 INTEGER DEFAULT 0, times_65_reached INTEGER DEFAULT 0,
			todo_sticky_text TEXT DEFAULT '', todo_sticky_message_id TEXT DEFAULT '', last_emergency_drop_through_tag INTEGER DEFAULT 0);
		CREATE TABLE recalls(tag_id INTEGER,session_id TEXT,original_content TEXT,created_at INTEGER,PRIMARY KEY(session_id,tag_id));
		CREATE INDEX idx_recalls_session ON recalls(session_id);
		CREATE TABLE session_notes(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
		CREATE INDEX idx_session_notes_session ON session_notes(session_id);
		CREATE TABLE session_project_backfill_state(harness TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('running','completed')),started_at INTEGER,lease_expires_at INTEGER,completed_at INTEGER,holder_id TEXT);
		CREATE TABLE mirror_memory_repair_state(id INTEGER PRIMARY KEY CHECK(id=1),dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0,1)),updated_at INTEGER NOT NULL DEFAULT 0);
		CREATE INDEX idx_session_meta_session ON session_meta(session_id);`);
	const allowances = assertApplicationSchema(before, after);
	expect(allowances).toHaveLength(16);
	expect(allowances.every((entry) => entry.reason.length > 10 && Object.keys(entry.columns).length > 0)).toBe(true);
	expect(() => assertApplicationSchema(before, after, false)).toThrow("unknown extra table");
	db.exec("ALTER TABLE recalls ADD COLUMN unreviewed TEXT");
	expect(() => assertApplicationSchema(before, after)).toThrow("legacy table recalls");
	db.close();
});

test("application schema admits exact SQLite statistics names and untyped profiles only", () => {
	for (const variant of ["reviewed", "typed", "unknown"]) {
		const [before, after] = schemaPair();
		const db = new Database(after);
		db.exec(`CREATE TABLE fixturestat1(tbl,idx,stat); CREATE TABLE fixturestat2(tbl,idx,sampleno,sample);
			CREATE TABLE fixturestat3(tbl,idx,neq,nlt,ndlt,sample);
			CREATE TABLE fixturestat4(tbl ${variant === "typed" ? "TEXT" : ""},idx,nEq,nLt,nDLt,sample);`);
		if (variant === "unknown") db.exec("CREATE TABLE fixturestat5(tbl,idx,stat)");
		db.close();
		// Bun's defensive SQLite forbids creating reserved names and may lack STAT4.
		// The synthetic statistics tables are empty. Rename their equal-length names
		// in the closed fixture file and verify the occurrence count; cell lengths and
		// page layout stay intact, and the checker reads real PRAGMAs.
		const bytes = readFileSync(after);
		for (let n = 1; n <= (variant === "unknown" ? 5 : 4); n++) {
			const from = `fixturestat${n}`, to = `sqlite_stat${n}`;
			let count = 0, offset = bytes.indexOf(from);
			while (offset >= 0) { bytes.write(to, offset); count++; offset = bytes.indexOf(from, offset + to.length); }
			expect(count).toBe(3);
		}
		writeFileSync(after, bytes);
		if (variant === "reviewed") expect(assertApplicationSchema(before, after, false).map((entry) => entry.object)).toEqual(["sqlite_stat1", "sqlite_stat2", "sqlite_stat3", "sqlite_stat4"]);
		else expect(() => assertApplicationSchema(before, after)).toThrow(variant === "typed" ? "unreviewed column/type pairs" : "unknown extra table sqlite_stat5");
	}
});

test("application schema checks a populated historical metadata layout after migration 103", () => {
	const [before, after] = pair();
	for (const path of [before, after]) {
		const db = new ProductionDatabase(path);
		db.exec("DROP TABLE memories; DROP TABLE session_meta"); initializeDatabase(db); runMigrations(db); db.close();
	}
	let db = new ProductionDatabase(after);
	restorePreV103SessionMetaLayout(db);
	db.exec("DROP TABLE session_render_cache; DROP TABLE session_meta_chunks; DROP TABLE session_meta_collection_revisions; DELETE FROM schema_migrations WHERE version >= 103");
	for (const [column, declaration] of [["nudge_45", "INTEGER DEFAULT 0"], ["nudge_55", "INTEGER DEFAULT 0"], ["nudge_65", "INTEGER DEFAULT 0"], ["times_65_reached", "INTEGER DEFAULT 0"], ["todo_sticky_text", "TEXT DEFAULT ''"], ["todo_sticky_message_id", "TEXT DEFAULT ''"], ["last_emergency_drop_through_tag", "INTEGER DEFAULT 0"]])
		db.exec(`ALTER TABLE session_meta ADD COLUMN ${column} ${declaration}`);
	const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='session_meta'").get() as { sql: string }).sql;
	const historical = sql.replace(/system_prompt_hash TEXT DEFAULT ''/i, "system_prompt_hash INTEGER DEFAULT 0").replace(/thinking_binding_recovery_target TEXT NOT NULL DEFAULT ''/i, "thinking_binding_recovery_target TEXT DEFAULT ''");
	expect(historical).not.toBe(sql);
	// Recreate the empty synthetic table with its historical declaration before
	// writing payloads, so fixture setup cannot convert the values being audited.
	expect(db.prepare("SELECT COUNT(*) AS n FROM session_meta").get()).toEqual({ n: 0 });
	const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='session_meta' AND type <> 'table' AND sql IS NOT NULL").all() as { sql: string }[];
	db.exec("PRAGMA foreign_keys=OFF; DROP TABLE session_meta"); db.exec(historical);
	for (const dependent of dependents) db.exec(dependent.sql);
	db.exec("INSERT INTO session_meta(session_id,cached_m0_bytes,system_prompt_hash,thinking_binding_recovery_target) VALUES('historical','opaque cache',0,NULL)");
	runMigrations(db); db.close();
	expect(assertApplicationSchema(before, after)).toHaveLength(9);
	db = new ProductionDatabase(after);
	expect(db.prepare("SELECT system_prompt_hash,thinking_binding_recovery_target FROM session_meta WHERE session_id='historical'").get()).toEqual({ system_prompt_hash: 0, thinking_binding_recovery_target: null });
	db.close();
});

test("application schema normalizes cosmetic DDL but preserves literals and index definitions", () => {
	const [before, after] = schemaPair();
	const db = new Database(after);
	db.exec(`DROP TABLE memories; CREATE TABLE "memories" ("id" integer PRIMARY KEY, /* format */ "content" text, "embedding" blob); CREATE INDEX "idx_memory_content" ON "memories" ("content")`);
	expect(assertApplicationSchema(before, after)).toEqual([]);
	db.exec("DROP INDEX idx_memory_content; CREATE INDEX idx_memory_content ON memories(content DESC)");
	expect(() => assertApplicationSchema(before, after)).toThrow("index");
	db.close();
});

test("application schema refuses unknown columns, indexes, triggers and non-cosmetic defaults", () => {
	for (const ddl of [
		"ALTER TABLE session_meta ADD COLUMN unknown TEXT",
		"CREATE INDEX unknown ON memories(id)",
		"CREATE TRIGGER unknown AFTER INSERT ON memories BEGIN SELECT 1; END",
		"DROP TABLE session_meta; CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, system_prompt_hash TEXT DEFAULT 'different', thinking_binding_recovery_target TEXT NOT NULL DEFAULT '')",
	]) {
		const [before, after] = schemaPair();
		const db = new Database(after); db.exec(ddl); db.close();
		expect(() => assertApplicationSchema(before, after)).toThrow("Application schema");
	}
});

test("database hashing reads every buffer and the short final block", () => {
    const [path] = pair();
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x31);
    bytes[1024 * 1024 + 7] = 0xff;
    bytes[bytes.length - 1] = 0x80;
    writeFileSync(path, bytes);
    expect(hashFile(path)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    bytes[bytes.length - 1] = 0x81;
    writeFileSync(path, bytes);
    expect(hashFile(path)).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
});

test("crash audit recovers a hot rollback journal before reading the ledger", async () => {
    const [file] = pair();
    const path = join(file, "..", "context.db");
    const ready = join(file, "..", "writer-ready");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(102); CREATE TABLE durable_data(id INTEGER PRIMARY KEY,body BLOB)");
    const insert = db.query("INSERT INTO durable_data VALUES(?,zeroblob(32768))");
    for (let i=0;i<64;i++) insert.run(i);
    db.close();
    const before = hashFile(path);
    const code = `import {Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs'; const db=new Database(${JSON.stringify(path)}); db.exec('PRAGMA cache_size=8; PRAGMA cache_spill=ON; BEGIN IMMEDIATE; UPDATE durable_data SET body=zeroblob(32769); INSERT INTO schema_migrations VALUES(103)'); writeFileSync(${JSON.stringify(ready)},'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`;
    const child = Bun.spawn([process.execPath,"-e",code],{stdout:"ignore",stderr:"pipe"});
    try {
        const deadline = performance.now()+10000;
        while (!existsSync(ready) && child.exitCode===null && performance.now()<deadline) await Bun.sleep(10);
        expect(existsSync(ready)).toBe(true);
        child.kill("SIGKILL"); await child.exited;
        expect(statSync(`${path}-journal`).size).toBeGreaterThan(512);
        expect(() => version(path)).toThrow("readonly");
        expect(versionAfterCrash(path)).toBe(102);
        expect(hashFile(path)).toBe(before);
        const recovered = new Database(path,{readonly:true});
        expect(recovered.query("SELECT COUNT(*) AS n,SUM(length(body)) AS bytes FROM durable_data").get()).toEqual({n:64,bytes:64*32768});
        recovered.close();
    } finally { if (child.exitCode===null) child.kill("SIGKILL"); await child.exited; }
},30000);

test("upgrade audit names the exact changed memory row including blobs", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("UPDATE memories SET embedding=x'00fe' WHERE id=1");
	db.close();
	expect(firstDifference(before, after)).toContain(
		'memories: lost/changed row {"__rowid":1,"id":1',
	);
});

test("upgrade audit catches deleted session_meta keys", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("DELETE FROM session_meta");
	db.close();
	expect(firstDifference(before, after)).toContain(
		"session_meta: lost/changed row",
	);
});

test("upgrade audit refuses the live storage root before opening databases", () => {
	expect(() =>
		snapshotRoot(
			join(process.env.HOME!, ".local/share/cortexkit/magic-context"),
		),
	).toThrow("Refusing live storage root");
});

test("upgrade audit compares WITHOUT ROWID tables and skips views", () => {
	const [before, after] = pair();
	for (const path of [before, after]) {
		const db = new Database(path);
		db.exec(
			"CREATE VIEW memory_view AS SELECT id,content FROM memories; CREATE TABLE durable_keys(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; INSERT INTO durable_keys VALUES('k','original')",
		);
		db.close();
	}
	expect(firstDifference(before, after)).toBeNull();
	const db = new Database(after);
	db.exec("UPDATE durable_keys SET value='changed'");
	db.close();
	expect(firstDifference(before, after)).toContain(
		'durable_keys: lost/changed row {"key":"k","value":"original"}',
	);
});

test("upgrade audit compares actual served reasoning and does not normalize changed bytes", () => {
	const before = { system: "Keep 東京", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "signed" }] }], tools: [{ name: "ctx" }] };
	const same = compareServedBodies(before, structuredClone(before));
	expect(Object.values(same).every((part) => part.equal)).toBe(true);
	const after = structuredClone(before);
	after.messages[0].content[0].signature = "changed";
	const changed = compareServedBodies(before, after);
	expect(changed.system.equal).toBe(true);
	expect(changed.tools.equal).toBe(true);
	expect(changed.messages.equal).toBe(false);
	expect(changed.messages.firstDifference).toBeGreaterThan(0);
	expect(changed.messages.sha256Before).not.toBe(changed.messages.sha256After);
	expect(changed.messages.afterExcerpt).toContain("changed");
});

test("upgrade audit distinguishes missing payload fields from served empty arrays", () => {
	const changed = compareServedBodies({}, { system: [], messages: [], tools: [] });
	for (const part of Object.values(changed)) {
		expect(part.equal).toBe(false);
		expect(part.bytesBefore).toBe(4);
		expect(part.bytesAfter).toBe(2);
		expect(part.firstDifference).toBe(0);
	}
});

test("upgrade audit scopes live domain preservation without hiding changed rows or missing tables", () => {
	const [before, after] = pair();
	const db = new Database(after);
	db.exec("UPDATE session_meta SET state='startup-timestamp'");
	expect(firstDifference(before, after, ["memories"])).toBeNull();
	db.exec("DELETE FROM memories");
	expect(firstDifference(before, after, ["memories"])).toContain("memories: lost/changed row");
	db.close();
	expect(() => firstDifference(before, after, ["misspelled_table"])).toThrow("Preservation table not present in baseline");
});

function movedPair(): [string, string] {
    const [before, after] = pair();
    const db = new ProductionDatabase(before);
    db.exec("DROP TABLE session_meta; DROP TABLE memories");
    initializeDatabase(db);
    restorePreV103SessionMetaLayout(db);
    db.exec("DROP TABLE IF EXISTS session_render_cache; DROP TABLE IF EXISTS session_meta_chunks; DROP TABLE IF EXISTS session_meta_collection_revisions");
    for (const id of ["text", "blob", "empty", "empty-blob", "invalid-text", "invalid-blob", "null", "default", "integer", "real"])
        db.prepare("INSERT INTO session_meta(session_id) VALUES(?)").run(id);
    const large = ` { \"duplicate\": 1, \"duplicate\": 2, \"text\": \"${"é🙂東京".repeat(400)}\" } `;
    for (const column of MOVED_COLUMNS) {
        for (const [id, value] of [["text", large], ["blob", Buffer.from(large)], ["empty", ""], ["empty-blob", Buffer.alloc(0)], ["invalid-blob", Buffer.from([0x80, 0, 0xff])]] as const)
            db.prepare(`UPDATE session_meta SET ${column}=? WHERE session_id=?`).run(value, id);
        db.exec(`UPDATE session_meta SET ${column}=CAST(x'8000ff' AS TEXT) WHERE session_id='invalid-text'`);
        db.exec(`UPDATE session_meta SET ${column}=9007199254740993 WHERE session_id='integer'; UPDATE session_meta SET ${column}=1.5 WHERE session_id='real'`);
        const info = db.prepare("PRAGMA table_info(session_meta)").all() as { name: string; notnull: number }[];
        if (!info.find((c) => c.name === column)?.notnull)
            db.exec(`UPDATE session_meta SET ${column}=NULL WHERE session_id='null'`);
    }
    db.close();
    copyFileSync(before, after);
    const next = new ProductionDatabase(after);
    splitSessionMetaPayloads(next);
    next.close();
    return [before, after];
}

test("migration 103 audit proves all thirteen payloads through production accessors", () => {
    const [before, after] = movedPair();
    const proof = { payloads: [] as PayloadProof[], tables: [] as {name: string; rows: number; sha256: string}[] };
    expect(firstDifference(before, after, undefined, proof)).toBeNull();
    expect(proof.payloads.map((p) => p.column).sort()).toEqual([...MOVED_COLUMNS].sort());
    expect(MOVED_COLUMNS).toHaveLength(13);
    expect(proof.payloads.every((p) => p.rows === 10 && p.bytes > 1000 && p.sha256.length === 64)).toBe(true);
    expect(proof.tables.some((t) => t.name === "session_meta" && t.rows === 10)).toBe(true);
});

test("migration 103 audit rejects a changed late chunk", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("UPDATE session_meta_chunks SET body=x'636f7272757074' WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk=(SELECT MAX(chunk) FROM session_meta_chunks WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk!='-1')");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.trailing_blank_decisions:");
});

test("migration 103 audit rejects NULL becoming empty cache bytes", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("INSERT OR REPLACE INTO session_render_cache VALUES('null','cached_m0_bytes',x'')");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.cached_m0_bytes:");
});

test("migration 103 audit rejects orphan chunks hidden by default reads", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("DELETE FROM session_meta_chunks WHERE session_id='text' AND column_name='trailing_blank_decisions' AND chunk='-1'");
    db.close();
    expect(firstDifference(before, after)).toContain("session_meta.trailing_blank_decisions:");
});
test("migration 103 audit rejects destination rows without an owner", () => {
    const [before, after] = movedPair();
    const db = new Database(after);
    db.exec("INSERT INTO session_render_cache VALUES('missing-owner','cached_m0_bytes',x'01')");
    db.close();
    expect(firstDifference(before, after)).toContain("orphan or unreviewed payload key");
});

test("effects manifest accepts the current context head without a retired store fence", () => {
    expect(() => assertEffects(105)).not.toThrow();
    expect(() => assertEffects(106)).toThrow("manifest needs review");
    expect(() => assertEffects(103)).toThrow("manifest needs review");
});

test("release selection chooses the newest stable 0.49 patch numerically", () => {
    expect(newest049(["0.49.9", "0.50.0", "0.49.37", "0.49.38-beta.1", "0.49.7"])).toBe("0.49.37");
    expect(() => newest049(["0.50.0"])).toThrow("No released");
});

test("first-pass coverage requires managed provider traffic from each upgraded host", () => {
    const rows = ["opencode", "opencode2", "pi"].map((host) => ({
        host,
        status: "PASS",
        version: 105,
        requests: 1,
        tagged: true,
    }));
    assertHostPasses(rows);
    expect(() => assertHostPasses(rows.slice(1))).toThrow("opencode");
    for (const change of [
        { version: 95 },
        { requests: 0 },
        { requests: 2 },
        { tagged: false },
        { status: "FAIL" },
    ])
        expect(() =>
            assertHostPasses(rows.map((row) => (row.host === "pi" ? { ...row, ...change } : row))),
        ).toThrow("pi");
});

test("schema digest detects a changed schema rather than comparing a file to itself", () => {
    const [before, after] = pair();
    expect(schemaDigest(before)).toBe(schemaDigest(after));
    const db = new Database(after);
    db.exec("ALTER TABLE memories ADD COLUMN safety_critical INTEGER");
    db.close();
    expect(schemaDigest(before)).not.toBe(schemaDigest(after));
});

test("subprocess environment fences inherited config and database overrides", () => {
    const [file] = pair();
    const root = join(file, "..");
    const saved = process.env.MAGIC_CONTEXT_DB;
    process.env.MAGIC_CONTEXT_DB = "/forbidden/context.db";
    try {
        const env = isolatedEnvironment(root, join(root, "store"));
        for (const key of [
            "HOME",
            "TMPDIR",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
            "OPENCODE_DB",
            "MAGIC_CONTEXT_STORAGE_DIR",
        ])
            expect(env[key]!.startsWith(root + "/") || env[key] === root).toBe(true);
        expect(env.MAGIC_CONTEXT_DB).toBeUndefined();
    } finally {
        if (saved === undefined) delete process.env.MAGIC_CONTEXT_DB;
        else process.env.MAGIC_CONTEXT_DB = saved;
    }
});

test("doctor gate rejects warnings and failures", () => {
    const result = {schema:true,integrity:true,foreignKeys:true,shadowBackfills:true,maintenance:true,compartments:true};
    assertDoctor(JSON.stringify(result));
    for (const name of Object.keys(result))
        expect(() => assertDoctor(JSON.stringify({...result,[name]:false}))).toThrow("clean migrated store");
});
test("full doctor target gate rejects test-backstop and missing-store success proxies", () => {
    assertFullDoctorTarget("/isolated/migrated SQLite integrity_check: ok", "/isolated/migrated", "pi");
    expect(() => assertFullDoctorTarget("TEST BACKSTOP /isolated/migrated SQLite integrity_check: ok", "/isolated/migrated", "pi")).toThrow("intended migrated store");
    expect(() => assertFullDoctorTarget("/isolated/migrated Shared context DB not found yet", "/isolated/migrated", "pi")).toThrow("intended migrated store");
});

test("production database doctor detects a damaged foreign-key relationship", () => {
    const [file] = pair();
    const path = join(file, "..", "context.db");
    const db = new ProductionDatabase(path);
    initializeDatabase(db);
    runMigrations(db);
    expect(() => assertDoctor(JSON.stringify(databaseDoctor(path)))).not.toThrow();
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE rehearsal_owner(id INTEGER PRIMARY KEY); CREATE TABLE rehearsal_child(owner INTEGER REFERENCES rehearsal_owner(id)); INSERT INTO rehearsal_child VALUES(99)");
    expect(() => assertDoctor(JSON.stringify(databaseDoctor(path)))).toThrow("clean migrated store");
    db.close();
});

test("migration measurement gate requires all ten context migrations and real RSS", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
        database: "context",
        version: 96 + i,
        seconds: 0.1,
        peakKiB: 1000,
        beforeMainWal: [4096, 0],
        afterMainWal: [8192, 0],
    }));
    assertMigrationMetrics(rows);
    expect(() => assertMigrationMetrics(rows.slice(1))).toThrow("context 96");
    expect(() => assertMigrationMetrics(rows.slice(0, -1))).toThrow("context 105");
    expect(() => assertMigrationMetrics(rows.map((r) => ({ ...r, peakKiB: 0 })))).toThrow(
        "measurement",
    );
});
