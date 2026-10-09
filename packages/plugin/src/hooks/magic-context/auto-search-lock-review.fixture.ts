import { parentPort, workerData } from "node:worker_threads";
import { Database } from "../../shared/sqlite";

// The independent writer releases after provider completion, not on the prompt
// thread's timer: the legacy synchronous SQLite call must be able to wait for it.
const db = new Database(workerData.path);
db.exec("BEGIN IMMEDIATE");
parentPort?.postMessage("locked");
parentPort?.once("message", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    db.exec("ROLLBACK");
    db.close();
    parentPort?.close();
});
