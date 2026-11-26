import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashFile, integrity, version } from "./upgrade-audit";
import { isolatedEnvironment } from "./upgrade-isolation";

const [binary, root] = process.argv.slice(2);
const context = join(root, "context.db");
const sessions = join(root, "sessions.db");
if (existsSync(join(root, "store.db")) || existsSync(sessions))
    throw new Error("Startup requires context.db only");
const before = hashFile(context);
// The missing --subc connection file ends startup after both databases open and the catalog is written.
const result = spawnSync(binary, ["--subc", join(root, "missing-connection.json")], {
    env: {
        ...isolatedEnvironment(root, root),
        MAGIC_CONTEXT_DB: context,
        MAGIC_CONTEXT_SESSIONS_STORE: sessions,
    },
    encoding: "utf8",
    timeout: 30_000,
});
if (
	result.error ||
	result.status !== 1 ||
	!result.stderr.includes("ConnectionFile") ||
	!result.stderr.includes(join(root, "missing-connection.json")) ||
	!existsSync(sessions) ||
    !existsSync(join(root, "engram-catalog.json"))
)
    throw new Error(
        `ck-mc did not reach its connection boundary: ${result.error ?? result.stderr}`,
    );
const db = new Database(sessions, { readonly: true });
let schema: number;
try {
    schema = Number(
        (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
} finally {
    db.close();
}
if (schema !== 5 || version(context) !== 105 || existsSync(join(root, "store.db")))
    throw new Error("Wrong startup schema or retired store created");
if (before !== hashFile(context)) throw new Error("ck-mc startup rewrote the upgraded context.db");
console.log(
    JSON.stringify({
        context: 105,
        sessions: schema,
        storePresent: false,
        catalog: true,
        contextUnchanged: true,
        integrity: integrity(sessions),
        connectionBoundaryExit: result.status,
        stderr: result.stderr.trim(),
    }),
);
