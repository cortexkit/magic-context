import type { Database } from "bun:sqlite";

export function toDatabase<T>(db: T): Database {
    return db as unknown as Database;
}
