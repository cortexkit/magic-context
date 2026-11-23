import { workerData } from "node:worker_threads";
import { Database } from "@magic-context/core/shared/sqlite";

const gate = new Int32Array(workerData.writerGate as SharedArrayBuffer);
const exec = Database.prototype.exec;
Database.prototype.exec = function (this: Database, sql: string) {
	const result = exec.call(this, sql);
	if (
		sql === "BEGIN IMMEDIATE" &&
		Atomics.compareExchange(gate, 0, 0, 1) === 0
	) {
		// Pause only after the real indexer's native BEGIN has acquired the writer.
		Atomics.notify(gate, 0);
		if (Atomics.wait(gate, 1, 0, 10_000) === "timed-out")
			throw new Error("Pi served-check index writer was not released");
	}
	return result;
};

await import(
	new URL(
		"../../../plugin/src/hooks/magic-context/raw-ordinal-warmup-worker.ts",
		import.meta.url,
	).href
);
