import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as Db } from "../../../../packages/plugin/src/shared/sqlite";
import { schemaSnapshot as snapshot } from "../../../../packages/plugin/src/features/magic-context/schema-fingerprint";

const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
// The output directory confines incidental host lookups, config reads, and logger writes.
process.env.HOME = output;
process.env.XDG_DATA_HOME = join(output, "data");
process.env.XDG_CONFIG_HOME = join(output, "config");
process.env.XDG_CACHE_HOME = join(output, "cache");
process.env.MAGIC_CONTEXT_LOG_PATH = join(output, "magic-context.log");
process.env.NODE_ENV = "test";
const now = 1_800_000_000_000;
Date.now = () => now;
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const { Database } = await import(join(root, "packages/plugin/src/shared/sqlite.ts"));
const { ensureColumn } = await import(join(root, "packages/plugin/src/features/magic-context/storage-schema-helpers.ts"));
const { MIGRATIONS, runMigrations, LATEST_MIGRATION_VERSION } = await import(join(root, "packages/plugin/src/features/magic-context/migrations.ts"));
const { splitLkgSlotPrefixes, splitReplayDecisions, LKG_SLOT_CHUNKS_DDL, LKG_SLOTS_DDL } = await import(join(root, "packages/plugin/src/features/magic-context/migration-v94-write-split.ts"));
const { computeNormalizedHash } = await import(join(root, "packages/plugin/src/features/magic-context/memory/normalize-hash.ts"));
const { addNote } = await import(join(root, "packages/plugin/src/features/magic-context/storage-notes.ts"));
const { insertTag } = await import(join(root, "packages/plugin/src/features/magic-context/storage-tags.ts"));
const { writeReplayDocument } = await import(join(root, "packages/plugin/src/features/magic-context/storage-replay-document.ts"));

// Use the schema-version-87 initializer saved in storage-db-v87.source.txt.
// The current initializer preinstalls newer schema before running migrations,
// so it would conceal missing historical upgrade steps in a differential test.
const historicalSource = readFileSync(join(here, "storage-db-v87.source.txt"), "utf8");
const historicalJs = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
    historicalSource.replace("export function", "function"),
);
const initialize87 = new Function("ensureColumn", "BOOT_SQLITE_BUSY_TIMEOUT_MS", "resolveBootBusyTimeoutMs", "applySqliteTuningPragmas", `${historicalJs}; return initializeDatabase;`)(
    ensureColumn, 5000, (value: number) => value,
    // Cache-size/mmap tuning has no schema/data effect and needs no runtime config.
    () => {},
) as (db: Db) => void;

function applyThrough(db: Db, target: number): void {
    const index = MIGRATIONS.findIndex((m: { version: number }) => m.version > target);
    const later = index < 0 ? [] : MIGRATIONS.splice(index);
    try { runMigrations(db); } finally { MIGRATIONS.push(...later); }
}

const base = join(output, "base.db");
const db = new Database(base);
initialize87(db);
applyThrough(db, 87);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

function record(db: Db, operation: () => void): string[] {
    const sql: string[] = [];
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    db.exec = ((text: string) => {
        // The Rust runner owns the transaction; helper-local transaction wrappers
        // become savepoints when TypeScript runs inside its migration transaction.
        if (!/^(BEGIN IMMEDIATE|COMMIT)$/.test(text)) sql.push(text);
        return exec(text);
    }) as Db["exec"];
    db.prepare = ((text: string) => {
        const statement = prepare(text);
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => {
            // The empty DDL recorder has no legacy rows. Only deterministic seeds
            // and the rescore activation clock use bound parameters here.
            let index = 0;
            sql.push(text.replace(/\?/g, () => {
                const value = args[index++];
                return value === now ? ":now_ms" : value === null ? "NULL" :
                    typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
            }));
            return run(...args);
        }) as typeof statement.run;
        return statement;
    }) as Db["prepare"];
    try { operation(); } finally { db.exec = exec; db.prepare = prepare; }
    return sql;
}

if (process.argv[3] === "--assets") {
    const assetDb = new Database(base);
    const steps = [];
    for (const migration of MIGRATIONS.filter((m: { version: number }) => m.version > 87)) {
        let sql: string[];
        if (migration.version === 94) {
            splitLkgSlotPrefixes(assetDb);
            sql = record(assetDb, () => splitReplayDecisions(assetDb));
        } else {
            sql = record(assetDb, () => migration.up(assetDb));
        }
        steps.push({ version: migration.version, description: migration.description, sql });
    }
    writeFileSync(join(here, "steps.json"), JSON.stringify(steps, null, 2) + "\n");
    writeFileSync(join(here, "lkg_chunks.sql"), LKG_SLOT_CHUNKS_DDL);
    writeFileSync(join(here, "lkg_slots.sql"), LKG_SLOTS_DDL.replaceAll("lkg_slots", "lkg_slots_v94").trimEnd() + "\n");
    assetDb.close();
    console.log(`Captured ${steps.length} real TypeScript migration SQL plans (88-${LATEST_MIGRATION_VERSION})`);
    process.exit(0);
}

function populate(db: Db): void {
    insertTag(db, "session-main", "message-user", "user", 80, 1);
    insertTag(db, "session-main", "message-assistant", "assistant", 160, 2);
    // The current reader requires columns added after v87; seed the historical
    // memory layout directly so the migration, not fixture setup, adds them.
    const memoryContent = "Retain Unicode 東京 🧠 and the exact original bytes.";
    db.prepare(`INSERT INTO memories(project_path,category,content,normalized_hash,source_type,source_session_id,first_seen_at,created_at,updated_at,last_seen_at)
        VALUES('/fixture/project','CONSTRAINTS',?,?,'agent','session-main',?,?,?,?)`).run(memoryContent, computeNormalizedHash(memoryContent), now, now, now, now);
    addNote(db, "session", { sessionId: "session-main", content: "Preserve this follow-up", anchorOrdinal: 2 });
    addNote(db, "smart", { sessionId: "session-main", projectPath: "/fixture/project", content: "Conditional follow-up", surfaceCondition: "After the build passes" });
    writeReplayDocument(db, "session-main", { version: 2, trailingBlank: { "message-assistant": "keep:3" }, piNative: { retained: "opaque" } });

    // These are historical storage formats whose current public writers no longer
    // accept the old layouts. Raw inserts supplement (not replace) the public-path rows.
    db.exec(`INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,created_at) VALUES ('session-main',1,1,2,'message-user','message-assistant','History','Original content','tier one','tier two','tier three','tier four',123);`);
    db.exec(`INSERT INTO git_commits(sha,project_path,short_sha,message,author,committed_at,indexed_at) VALUES ('abc123','/fixture/project','abc','Preserve exact FTS rowids','fixture',123,456);`);
    db.prepare("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES (1,?,'fixture-model')").run(Buffer.from([0, 1, 2, 255]));
    const prefixes = ["x".repeat(65_535) + "🧠東京" + "y".repeat(65_540), "", "expired"];
    for (const [index, prefix] of prefixes.entries()) {
        const session = `slot-${index}`;
        const captured = index === 2 ? now - 86_400_001 : now - 86_400_000;
        db.prepare("INSERT INTO lkg_slots(session_id,json_prefix,input_id_seq,input_content_digests,last_input_message_id,captured_at) VALUES (?,?, '[]','[]','message-assistant',?)").run(session, prefix, captured);
    }
    const replayCases = [
        '{"version":"keep","message":"strip"}', '{"dup":"keep","dup":"strip"}',
        '{"bad":"keep:01"}', '{"empty":"keep:1"}', '{"":"keep"}',
        '{"version":3,"trailingBlank":{"message":"strip"}}', '{broken',
        '{"version":2.0,"trailingBlank":{"m":"keep:10000"},"cacheTtlPolicy":{"unchanged":true}}',
    ];
    replayCases.forEach((blob, index) => {
        insertTag(db, `replay-${index}`, "m", "assistant", 10, 1);
        db.prepare("UPDATE session_meta SET trailing_blank_decisions=? WHERE session_id=?").run(blob, `replay-${index}`);
    });
    const temporalCases = [
        '["temporal-message-v1:[\\"message-assistant\\",\\"marker 東京\\"]","temporal-message-v1:[\\"message-assistant\\",\\"ignored duplicate\\"]","ordinary",7,{"z":1.0,"a":-0,"4":1e21,"2":1e-7,"nested":[1e-6,1e20,9007199254740993],"lone":"\\ud800","\\udfff":1e400},"temporal-message-v1:[\\"\\",\\"invalid\\"]"]',
        '{broken temporal-message-v1:', '{"temporal-message-v1:":true}',
    ];
    temporalCases.forEach((blob, index) => {
        db.prepare("UPDATE session_meta SET merged_reasoning_stripped_ids=? WHERE session_id=?").run(blob, index === 0 ? "session-main" : `replay-${index}`);
    });
    db.exec("INSERT INTO schema_migrations VALUES (10001,'downstream fixture',123)");
}

function data(db: Db, startingVersion: number): unknown {
    const tables = db.prepare("PRAGMA table_list").all() as {name: string; type: string; schema: string}[];
    return tables.filter(t => t.schema === "main" && t.type !== "shadow" && !t.name.startsWith("sqlite_schema"))
        .sort((a,b) => a.name < b.name ? -1 : 1).map(table => {
            const columns = (db.prepare(`PRAGMA table_info('${table.name}')`).all() as {name: string}[]).map(c => c.name);
            const rows = (db.prepare(`SELECT * FROM '${table.name}'`).all() as Record<string, unknown>[]).map(row => columns.map(column => {
                const value = row[column];
                if (column === "applied_at" && table.name === "schema_migrations") return ":clock";
                if (column === "generation" && table.name === "compartment_history_versions" && startingVersion < 93) {
                    if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Invalid generated revision token");
                    return ":random-generation";
                }
                return value instanceof Uint8Array ? { blob: Buffer.from(value).toString("hex") } : value;
            }));
            rows.sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
            return { name: table.name, columns, rows };
        });
}

for (let version = 87; version <= LATEST_MIGRATION_VERSION; version++) {
    const start = join(output, `v${version}.db`);
    copyFileSync(base, start);
    const fixture = new Database(start);
    populate(fixture);
    if (version > 87) applyThrough(fixture, version);
    fixture.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fixture.close();
    const upgraded = join(output, `expected-v${version}.db`);
    copyFileSync(start, upgraded);
    const reference = new Database(upgraded);
    runMigrations(reference);
    writeFileSync(join(output, `v${version}.json`), JSON.stringify({ now, snapshot: snapshot(reference), data: data(reference, version) }));
    reference.close();
}
console.log(`TypeScript historical differential fixtures: ${LATEST_MIGRATION_VERSION - 86} populated starting versions (87-${LATEST_MIGRATION_VERSION}), fence ${LATEST_MIGRATION_VERSION}`);
