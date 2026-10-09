import { parentPort, workerData } from "node:worker_threads";
import { Database } from "../../shared/sqlite";

// Release independently of the prompt thread: its synchronous writer wait can
// expire while this lock holder continues running.
const db = new Database(workerData.path);
db.exec("BEGIN IMMEDIATE");
parentPort?.postMessage("locked");
parentPort?.once("message", async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    db.exec("ROLLBACK");
    db.close();
    parentPort?.close();
});
