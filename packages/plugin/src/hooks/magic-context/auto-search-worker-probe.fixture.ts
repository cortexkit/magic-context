import { parentPort } from "node:worker_threads";
import { Database } from "../../shared/sqlite";

const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (this: Database, sql: string) {
    if (sql.includes("FROM compartment_chunk_embeddings WHERE session_id = ?")) {
        parentPort?.postMessage({ kind: "history-load-started" });
    }
    return prepare.call(this, sql);
} as typeof prepare;

// Install the observer before the real worker opens its read-only connection.
await import("./auto-search-worker");
