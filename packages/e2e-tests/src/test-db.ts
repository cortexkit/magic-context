import type { Database } from "bun:sqlite";

// Tests running under Node supply their existing adapter and must not load Bun's SQLite module.
const NativeDatabase: typeof Database | undefined =
	typeof Bun === "undefined"
		? undefined
		: (await import("bun:" + "sqlite")).Database;

type SqliteHandle = { exec(sql: string): unknown };
// SQLite adapters have different option types; infer them from the supplied constructor.
type SqliteConstructor = new (path: string, options?: any) => SqliteHandle;

/**
 * Open a SQLite handle for an e2e test with a non-zero `busy_timeout` always set.
 *
 * The e2e suite runs many files in parallel against a per-test shared
 * `context.db` while the plugin under test writes to the same file. A handle
 * opened with the default `busy_timeout = 0` fails immediately with SQLITE_BUSY
 * the instant any other connection holds the write lock, which surfaces as
 * flaky "database is locked" failures under load rather than a real regression.
 * Setting a timeout makes a new writer wait for the lock. A deferred transaction
 * that has already read cannot wait when upgrading a stale snapshot to a writer;
 * replay writers must reserve the write lock before reading with writeTestDb.
 * Pass an adapter's constructor as the third argument to retain its connection
 * tracking and transaction behavior while applying the same timeout policy.
 *
 * Every test that opens the context DB directly (reader or writer) must go
 * through this helper so the timeout can never be forgotten — a bare
 * `new Database(...)` in a test reintroduces the flake.
 */
export function openTestDb<C extends SqliteConstructor = typeof Database>(
	path: string,
	options?: ConstructorParameters<C>[1],
	constructor?: C,
): InstanceType<C> {
	const OpenDatabase = constructor ?? NativeDatabase;
	if (!OpenDatabase)
		throw new Error("Node test connections must supply a SQLite adapter");
	const db =
		options === undefined
			? new OpenDatabase(path)
			: new OpenDatabase(path, options);
	db.exec("PRAGMA busy_timeout=5000");
	return db as InstanceType<C>;
}

/** Lock out other writers before replay reads so their results stay valid for the write. */
export function writeTestDb<T>(db: Database, write: () => T): T {
	return db.transaction(write).immediate();
}
