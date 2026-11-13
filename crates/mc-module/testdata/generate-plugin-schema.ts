// Writes the fresh context.db schema of the checkout's plugin migration chain
// as SQL, in the same form as crates/mc-module/testdata/context-schema.sql.
// Run from the checkout whose chain to dump: for context-schema-95.sql, a 0.49
// master checkout, whose chain ends at schema version 95.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mc-context-schema-"));
process.env.HOME = sandbox;
process.env.XDG_DATA_HOME = sandbox;
process.env.XDG_CONFIG_HOME = sandbox;
process.env.XDG_CACHE_HOME = sandbox;
process.env.MAGIC_CONTEXT_LOG_PATH = join(sandbox, "magic-context.log");
process.env.NODE_ENV = "test";

try {
    const root = process.cwd();
    const output = resolve(process.argv[2]);
    const { Database } = await import(join(root, "packages/plugin/src/shared/sqlite.ts"));
    const { runMigrations, LATEST_MIGRATION_VERSION } = await import(
        join(root, "packages/plugin/src/features/magic-context/migrations.ts")
    );
    const { initializeDatabase, LATEST_SUPPORTED_VERSION: fence } = await import(
        join(root, "packages/plugin/src/features/magic-context/storage-db.ts")
    );
    if (fence !== LATEST_MIGRATION_VERSION) throw new Error(`fence ${fence} != chain ${LATEST_MIGRATION_VERSION}`);
    const db = new Database(join(sandbox, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const shadows = new Set(
        (db.prepare("PRAGMA table_list").all() as { name: string; type: string }[])
            .filter((row) => row.type === "shadow")
            .map((row) => row.name),
    );
    const master = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY rowid").all() as {
        type: string;
        name: string;
        sql: string | null;
    }[];
    const migrations = db.prepare("SELECT version, description FROM schema_migrations ORDER BY version").all() as {
        version: number;
        description: string;
    }[];
    const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const literal = (value: unknown) =>
        value === ":applied_at"
            ? ":applied_at"
            : value === null
              ? "NULL"
              : typeof value === "string"
                ? `'${value.replaceAll("'", "''")}'`
                : String(value);
    let sql = `-- Generated from the plugin migration chain through schema version ${fence}.\n`;
    sql += `PRAGMA user_version = ${userVersion};\n\n`;
    sql += master
        .filter((row) => row.sql && !row.name.startsWith("sqlite_") && !shadows.has(row.name))
        .map((row) => `${row.sql};\n`)
        .join("\n");
    sql += "\nINSERT INTO schema_migrations (version, description, applied_at) VALUES\n";
    sql += `${migrations.map((row) => `(${row.version}, ${literal(row.description)}, :applied_at)`).join(",\n")};\n`;
    for (const row of master.filter(
        (r) =>
            r.type === "table" &&
            r.sql &&
            !r.name.startsWith("sqlite_") &&
            !shadows.has(r.name) &&
            r.name !== "schema_migrations" &&
            !r.sql.startsWith("CREATE VIRTUAL TABLE"),
    )) {
        const rows = db.prepare(`SELECT * FROM ${quoted(row.name)}`).all() as Record<string, unknown>[];
        if (rows.length === 0) continue;
        const columns = Object.keys(rows[0]);
        sql += `\nINSERT INTO ${quoted(row.name)} (${columns.map(quoted).join(", ")}) VALUES\n`;
        sql += `${rows
            .map((r) => `(${columns.map((c) => literal(c === "activated_at" ? ":applied_at" : r[c])).join(", ")})`)
            .join(",\n")};\n`;
    }
    if (master.some((row) => row.name === "sqlite_stat1")) {
        sql += "\nANALYZE;\n";
        if (!master.some((row) => row.name === "sqlite_stat4")) sql += "DROP TABLE IF EXISTS sqlite_stat4;\n";
    }
    writeFileSync(output, sql);
    db.close();
    console.log(`fence ${fence}; migrations ${migrations.length}; objects ${master.length}`);
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
