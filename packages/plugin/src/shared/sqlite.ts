/**
 * SQLite chokepoint — runtime-detected backend selection.
 *
 * The same shipped plugin artifact must run under two different runtimes:
 *   - Bun (current OpenCode releases) → uses `bun:sqlite` (built-in, fast)
 *   - Node (OpenCode beta + future Pi plugin) → uses `better-sqlite3`
 *
 * Bun cannot load `better-sqlite3` (oven-sh/bun#4290), and Node has no
 * `bun:sqlite` module. Static imports of either would crash at parse time
 * in the wrong runtime, so we use dynamic imports gated by runtime detection.
 *
 * The Function-constructor wrapper around `import()` defeats bundler static
 * analysis — without it, esbuild/bun build would try to resolve both modules
 * during the bundle step, including the one that doesn't exist in the build
 * runtime.
 *
 * Both libraries expose ~95% API parity:
 *   - new Database(path, { readonly?: boolean })
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.transaction(fn) → wrapped function
 *   - db.close()
 *
 * The 5% that differs (db.query, db.run, db.close(boolean), Database.open)
 * is either rewritten to common-subset patterns or hidden behind the helpers
 * in `./sqlite-helpers.ts`.
 */

// Type import only — better-sqlite3's runtime is loaded dynamically below.
// @types/better-sqlite3 has richer definitions than @types/bun's bun:sqlite
// types, and bun:sqlite is a structural superset for the API surface we use,
// so calls typed against BetterSqlite3 work under both runtimes at runtime.
import type BetterSqlite3 from "better-sqlite3";

// Detect Bun via process.versions.bun. Both globalThis.Bun and
// process.versions.bun are set by the Bun runtime, but process.versions
// is a lower-level surface less likely to be sandboxed by host runtimes
// (e.g. Electron in OpenCode desktop apps that re-expose a Bun-flavored
// environment). Real Node and Electron never set this field.
const isBun = typeof process !== "undefined" && typeof process.versions?.bun === "string";

// IMPORTANT: bundler-evading dynamic imports.
//
// We can't write `await import("better-sqlite3")` directly because esbuild/bun
// would try to resolve both modules at build time, and one of them won't exist
// in the build runtime (bun:sqlite is missing in Node, better-sqlite3 isn't
// shipped in Bun-only environments). Earlier versions used
// `new Function("p", "return import(p)")("modname")` to defeat static
// analysis, but that breaks Pi's vm-based extension loader: a Function
// constructed at runtime has no module record, so `import()` inside it has
// no referrer module and Node throws "A dynamic import callback was not
// specified".
//
// The /* @vite-ignore */ + variable indirection pattern hides the specifier
// from static analyzers while keeping a real referrer module for the
// dynamic import — Pi's loader, esbuild, and bun build all accept it.
const bunSpec = "bun:" + "sqlite";
const betterSpec = "better-" + "sqlite3";

// Under Electron, the npm-installed better-sqlite3 binary has the wrong ABI
// (it's a Node prebuild but Electron embeds a different NODE_MODULE_VERSION).
// resolveBetterSqliteNativeBinding() detects this and downloads + caches the
// matching Electron prebuild, then returns its absolute path so we can pass
// it to better-sqlite3 via the `nativeBinding` constructor option (a
// documented public API). Returns null outside Electron OR when the on-disk
// binary already matches the runtime ABI — in those cases the default
// bindings() lookup just works.
const electronNativeBinding = isBun
    ? null
    : await (async () => {
          const mod = await import("./native-binding");
          return mod.resolveBetterSqliteNativeBinding();
      })();

const sqliteModule = isBun
    ? await import(/* @vite-ignore */ bunSpec)
    : await import(/* @vite-ignore */ betterSpec);

// Different export shapes between the two libraries:
//   - bun:sqlite     → named export `Database`
//   - better-sqlite3 → default export
const RawDatabaseImpl = isBun ? sqliteModule.Database : sqliteModule.default;

// When we resolved a non-default Electron-compatible native binding above,
// transparently inject it into every `new Database(...)` call. This is the
// public `nativeBinding` constructor option that better-sqlite3 ships
// specifically for cross-runtime extension scenarios — it makes
// better-sqlite3 `require()` the binary at the supplied path directly,
// bypassing the default bindings() resolver.
//
// Subclassing keeps the call sites untouched: existing
// `new Database(filename, { readonly: true })` invocations work as-is.
// Callers can still override `nativeBinding` explicitly if they need to.
//
// The TypeScript type intentionally references @types/better-sqlite3 because
// its definitions are richer than @types/bun's bun:sqlite types and bun:sqlite
// is a structural superset for the API surface we use. Calls written against
// this type work correctly under both runtimes at runtime.
//
// @types/better-sqlite3 uses `export = Database` (CommonJS interop), which
// surfaces in TypeScript as `import Database = require("better-sqlite3")`.
// We capture the DatabaseConstructor type from the namespace re-export.
const DatabaseImpl: typeof BetterSqlite3 =
    electronNativeBinding == null
        ? (RawDatabaseImpl as typeof BetterSqlite3)
        : (class DatabaseWithElectronBinding extends (RawDatabaseImpl as typeof BetterSqlite3) {
              constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
                  // Type narrowing: the surrounding ternary already proved
                  // electronNativeBinding is non-null in this branch, but
                  // TypeScript can't follow that across the class boundary.
                  const fallback = electronNativeBinding as string;
                  super(filename, {
                      ...options,
                      nativeBinding: options?.nativeBinding ?? fallback,
                  });
              }
          } as typeof BetterSqlite3);

export const Database: typeof BetterSqlite3 = DatabaseImpl;

/** Instance type alias used by helpers and storage modules. */
export type Database = BetterSqlite3.Database;

/**
 * Statement instance type used for WeakMap caches throughout the codebase.
 *
 * We deliberately use the variadic Statement<unknown[], unknown> shape rather
 * than `ReturnType<Database["prepare"]>` because the latter resolves through
 * a conditional return type in @types/better-sqlite3 that confuses TypeScript
 * about how many arguments .run/.get/.all accept. With this explicit type,
 * cached statements accept any number of bind args (matching bun:sqlite's
 * historical behavior in this codebase).
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;
