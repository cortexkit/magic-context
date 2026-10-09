import { parentPort, workerData } from "node:worker_threads";
import { Database } from "../../shared/sqlite";
import type { AutoSearchWorkerInput } from "./auto-search-worker-client";

const input = workerData as AutoSearchWorkerInput;
const db = new Database(input.path, { readonly: true });
parentPort?.postMessage({ kind: "query", id: 1, text: "synchronous-fixture-entered" });
// A synchronous SQLite statement with no opportunity for JS deadline checks.
// The owner must terminate it without waiting for this worker to acknowledge.
db.prepare(
    "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n",
).get();
parentPort?.postMessage({ kind: "result", results: [] });
db.close();
