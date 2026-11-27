import { parentPort, workerData } from "node:worker_threads";
import { Database, type Statement } from "../../shared/sqlite";

const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (this: Database, sql: string) {
    if (sql.includes("FROM compartment_chunk_embeddings WHERE session_id = ?")) {
        parentPort?.postMessage({ kind: "history-load-started" });
    }
    const statement = prepare.call(this, sql) as Statement;
    if (sql.includes("SELECT memory_embeddings.memory_id AS memoryId")) {
        const all = statement.all.bind(statement);
        statement.all = (...args: unknown[]) => {
            parentPort?.postMessage({ kind: "memory-load" });
            return all(...args);
        };
    }
    return statement;
} as typeof prepare;

if (workerData.virtualUpkeep) {
    let now = Date.now();
    Date.now = () => now;
    let upkeep: (() => void) | undefined;
    const realSetInterval = setInterval;
    globalThis.setInterval = ((callback: () => void, delay?: number) => {
        if (delay !== 5_000) return realSetInterval(callback, delay);
        upkeep = callback;
        // Return a normal handle, but upkeep runs only when a message requests it.
        const handle = realSetInterval(() => {}, delay);
        clearInterval(handle);
        return handle;
    }) as typeof setInterval;
    const realSetTimeout = setTimeout;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay !== 0) return realSetTimeout(callback, delay);
        const handle = realSetTimeout(() => {}, delay);
        clearTimeout(handle);
        return handle;
    }) as typeof setTimeout;
    parentPort?.on("message", (message: { kind: string; advance?: number; upkeep?: boolean }) => {
        if (message.kind !== "clock") return;
        now += message.advance ?? 0;
        if (message.upkeep) upkeep?.();
        parentPort?.postMessage({ kind: "clock" });
    });
}

// Install the observer before the real worker opens its read-only connection.
await import("./auto-search-worker");
