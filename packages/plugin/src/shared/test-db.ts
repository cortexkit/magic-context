import {
    __setScheduleStartupMaintenanceOnOpenForTests,
    __waitForDatabaseStartupForTests,
    openDatabase,
} from "../features/magic-context/storage-db";
import { Database } from "./sqlite";

/** A raw fixture connection, without changing the caller's SQLite lock policy. */
export function openTestDb(
    path: string,
    options?: ConstructorParameters<typeof Database>[1],
): Database {
    return new Database(path, options);
}

/**
 * Real transform fixtures need an idle serving database. Startup backfills open
 * separate connections to the same SQLite file. Their write locks can make a
 * healthy pass replay the previous saved request instead of running the work
 * the test is asserting. This helper opts into real startup even when the unit
 * preload disables it, then joins the writers before returning.
 */
export async function openTestDatabase(
    ...args: Parameters<typeof openDatabase>
): Promise<Database> {
    const previous = __setScheduleStartupMaintenanceOnOpenForTests(true);
    let db: Database | null;
    try {
        db = openDatabase(...args);
    } finally {
        __setScheduleStartupMaintenanceOnOpenForTests(previous);
    }
    if (!db) throw new Error("Test database unavailable");
    await __waitForDatabaseStartupForTests(db);
    return db;
}
