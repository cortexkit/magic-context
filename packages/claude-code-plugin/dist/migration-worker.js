import"./chunk-6q6cxsv6.js";
import {
  setLogLineForwarder,
  Database
} from "./chunk-e4mkgkj9.js";
import {
  runMigrationsWithRetry,
  setSqlitePragmaConfig,
  initializeDatabase
} from "./chunk-eea1pbdp.js";
import {
  closeQuietly
} from "./chunk-q5f7wcc8.js";
import"./chunk-t7etejbh.js";

// ../plugin/src/features/magic-context/migration-worker.ts
import { parentPort, workerData } from "node:worker_threads";
function post(message) {
  parentPort?.postMessage(message);
}
async function main() {
  const data = workerData;
  setLogLineForwarder((line) => post({ type: "log", line }));
  setSqlitePragmaConfig(data.sqlitePragmaConfig);
  post({ type: "ready" });
  let db;
  try {
    db = new Database(data.dbPath);
    initializeDatabase(db, data.busyTimeoutMs);
    await runMigrationsWithRetry(db, {
      sleep: async (delayMs) => {
        post({ type: "lock-wait", waiting: true });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        post({ type: "lock-wait", waiting: false });
      }
    });
    post({ type: "done" });
  } catch (error) {
    post({
      type: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (db)
      closeQuietly(db);
    setLogLineForwarder(null);
  }
}
main();
