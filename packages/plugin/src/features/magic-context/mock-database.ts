import type { Database } from "../../shared/sqlite";

export function toDatabase<T>(db: T): Database {
    return db as unknown as Database;
}
