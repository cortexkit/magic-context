/**
 * Native-binding resolver for Electron-runtime mismatches.
 *
 * Why this module exists
 * ----------------------
 * `better-sqlite3` uses raw v8/nan bindings, so its compiled `.node` file is
 * locked to a specific NODE_MODULE_VERSION (Node-API ABI revision). When
 * OpenCode Desktop (Electron 41 → ABI 145) loads a plugin whose `node_modules`
 * was populated by `bun install` / `npm install` under a different runtime,
 * the fetched prebuild is for `node-vNNN` (e.g. ABI 137 for Node 22) and
 * Electron refuses to load it with:
 *
 *   The module '...better_sqlite3.node' was compiled against a different
 *   Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
 *   requires NODE_MODULE_VERSION 145.
 *
 * `onnxruntime-node` (used by `@huggingface/transformers` for local
 * embeddings) is N-API v3 and is ABI-stable across runtimes, so it does NOT
 * have this problem. Only `better-sqlite3` is affected.
 *
 * What this does
 * --------------
 * On plugin load, before constructing any `Database`:
 *
 *  1. If we are NOT running under Electron (`process.versions.electron` is
 *     unset), return null. Bun uses `bun:sqlite` and never reaches this code;
 *     Pi/Node-CLI install matching Node-vNNN prebuilds via npm, which work
 *     natively against the on-disk binary.
 *
 *  2. If we ARE on Electron, locate the `.node` file path that
 *     `better-sqlite3`'s default `bindings()` lookup would try first. Probe
 *     its ABI by attempting a sandboxed `process.dlopen`. If it succeeds
 *     (Electron-compatible), return null — the default lookup will work.
 *
 *  3. Otherwise, look for a cached Electron prebuild at
 *     `<XDG_CACHE_HOME>/cortexkit/native-bindings/better-sqlite3/v<version>/electron-v<abi>-<platform>-<arch>/better_sqlite3.node`.
 *     Download it from the `WiseLibs/better-sqlite3` GitHub release if
 *     missing, extract with `nanotar` (pure-JS, ~45 KB, zero deps), validate
 *     the ABI, and return the absolute path.
 *
 * The caller (`sqlite.ts`) then passes this path through `better-sqlite3`'s
 * documented `nativeBinding` constructor option:
 *
 *   new Database(filename, { nativeBinding: <our cached path> })
 *
 * `better-sqlite3` calls `require()` directly on that path, bypassing the
 * normal `bindings()` lookup chain. This is a first-class API the maintainer
 * added for exactly this kind of cross-runtime extension scenario — see
 * `node_modules/better-sqlite3/lib/database.js` `nativeBinding` handling.
 *
 * Why we don't replace the on-disk binary
 * ---------------------------------------
 * An earlier iteration copied the cached Electron binary over the in-tree
 * `node_modules/.../better_sqlite3.node`. That worked but mutates a shared
 * resource: in monorepo dev setups (or any case where multiple runtimes
 * share one `node_modules`), a Pi process opening the plugin from the same
 * workspace would then load the Electron-ABI binary and fail. Returning a
 * separate cached path keeps the on-disk file untouched so each runtime
 * sees the binary it needs.
 *
 * Failure modes
 * -------------
 * If GitHub is unreachable (corporate firewall, offline laptop, rate limit)
 * AND no cached binary exists, this throws. The caller (sqlite.ts →
 * openDatabase) surfaces a `storage unavailable` error and Magic Context
 * disables itself for the run. The user can connect to the network and
 * restart, or wait for a cached binary from a previous successful launch.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { parseTarGzip } from "nanotar";
import { getCacheDir } from "./data-path";
import { log } from "./logger";

const PREFIX = "[native-binding]";

function logInfo(message: string): void {
    log(`${PREFIX} ${message}`);
}

function logWarn(message: string): void {
    log(`${PREFIX} WARN ${message}`);
}

/**
 * Result of probing a `.node` file's ABI by attempting a sandboxed `dlopen`.
 *
 * - `ok: true` means the runtime accepted the binary; the on-disk file is
 *   already Electron-compatible and we don't need to do anything.
 * - `ok: false` carries the parsed `actual` ABI for diagnostics (or `null`
 *   if the error message didn't match any known shape).
 */
type ProbeResult = { ok: true } | { ok: false; expected: string; actual: string | null };

function probeAbi(binaryPath: string): ProbeResult {
    const expected = process.versions.modules;
    try {
        // Throwaway sandbox: process.dlopen runs the module's init function
        // against `sandbox.exports`. On ABI mismatch it throws BEFORE init
        // runs, so the binary is NOT loaded into process memory in the
        // failure case. On success the binary IS loaded (Node refcounts
        // these, so a second dlopen by the real `require()` is cheap).
        const sandbox = { exports: {} as Record<string, unknown> };
        process.dlopen(sandbox, binaryPath);
        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const pair = message.match(/NODE_MODULE_VERSION (\d+).*NODE_MODULE_VERSION (\d+)/s);
        if (pair?.[1] && pair[2]) {
            return { ok: false, expected: pair[2], actual: pair[1] };
        }
        const single = message.match(/NODE_MODULE_VERSION[ =:]+(\d+)/);
        if (single?.[1]) {
            return { ok: false, expected, actual: single[1] };
        }
        // Couldn't parse — log raw message so we can refine the regex if a
        // future runtime emits a different shape.
        logWarn(`could not parse ABI from dlopen error: ${message}`);
        return { ok: false, expected, actual: null };
    }
}

/**
 * Locate the on-disk path `better-sqlite3` ships its `.node` file at, plus
 * the package version. Returns null if better-sqlite3 isn't resolvable —
 * that's a broken install we let propagate naturally through the dynamic
 * import in sqlite.ts.
 */
function resolveBetterSqlite3OnDisk(
    requireFn: NodeRequire,
): { binaryPath: string; pkgVersion: string } | null {
    try {
        const pkgJsonPath = requireFn.resolve("better-sqlite3/package.json");
        const pkgDir = path.dirname(pkgJsonPath);
        const pkgJson = requireFn(pkgJsonPath) as { version: string };
        const binaryPath = path.join(pkgDir, "build", "Release", "better_sqlite3.node");
        return { binaryPath, pkgVersion: pkgJson.version };
    } catch (err) {
        logWarn(
            `could not resolve better-sqlite3 in node_modules: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Cache directory for downloaded native bindings. Keyed by
 * `<pkgVersion>/electron-v<abi>-<platform>-<arch>` so a Magic Context update
 * that bumps better-sqlite3 or an OpenCode update that bumps Electron both
 * trigger a fresh download cleanly.
 */
function getCachedBinaryPath(pkgVersion: string, abi: string): string {
    return path.join(
        getCacheDir(),
        "cortexkit",
        "native-bindings",
        "better-sqlite3",
        `v${pkgVersion}`,
        `electron-v${abi}-${process.platform}-${process.arch}`,
        "better_sqlite3.node",
    );
}

/**
 * Download the Electron-targeted prebuild tarball from WiseLibs/better-sqlite3
 * GitHub releases and extract the `.node` bytes. Throws on HTTP failure or
 * if the tarball doesn't contain the expected file.
 */
async function downloadElectronPrebuild(pkgVersion: string, abi: string): Promise<Uint8Array> {
    const filename = `better-sqlite3-v${pkgVersion}-electron-v${abi}-${process.platform}-${process.arch}.tar.gz`;
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkgVersion}/${filename}`;
    logInfo(`downloading ${url}`);

    const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "magic-context-plugin/native-binding" },
    });
    if (!response.ok) {
        throw new Error(
            `failed to download Electron prebuild (HTTP ${response.status} ${response.statusText}) from ${url}`,
        );
    }

    const tarballBytes = new Uint8Array(await response.arrayBuffer());
    logInfo(`downloaded ${(tarballBytes.length / 1024).toFixed(1)} KB; extracting`);

    const files = await parseTarGzip(tarballBytes);
    const nodeFile = files.find((f) => f.name.endsWith("better_sqlite3.node"));
    if (!nodeFile?.data) {
        const names = files.map((f) => f.name).join(", ");
        throw new Error(
            `Electron prebuild tarball did not contain better_sqlite3.node; got: [${names}]`,
        );
    }
    return nodeFile.data instanceof Uint8Array ? nodeFile.data : new Uint8Array(nodeFile.data);
}

/**
 * Singleton promise so concurrent callers (multiple plugin init paths in the
 * same process) only do the check + download once. Reset to null after
 * completion so a future call can retry on transient failures.
 */
let inFlight: Promise<string | null> | null = null;

/**
 * Resolve the absolute path to a `better-sqlite3` `.node` binary that the
 * current runtime can load.
 *
 *   - Returns `null` outside Electron (Bun uses `bun:sqlite`; Pi/Node CLI
 *     loads matching prebuilds from `node_modules` natively).
 *   - Returns `null` on Electron when the on-disk binary already matches
 *     the runtime's ABI (rare but possible — a future OpenCode build that
 *     post-install-rebuilds for Electron would hit this fast path).
 *   - Returns the cached/downloaded prebuild path on Electron when the
 *     on-disk binary's ABI doesn't match.
 *
 * The returned path is suitable as the `nativeBinding` option to
 * `new Database(filename, { nativeBinding })`. better-sqlite3 calls `require()`
 * directly on it, bypassing the default `bindings()` lookup chain — this is
 * a documented public API in better-sqlite3, not an internal hack.
 */
export async function resolveBetterSqliteNativeBinding(): Promise<string | null> {
    if (!process.versions.electron) {
        return null;
    }

    if (inFlight) {
        return inFlight;
    }

    const promise = (async () => {
        const expected = process.versions.modules;
        logInfo(
            `Electron detected (v${process.versions.electron}, NODE_MODULE_VERSION ${expected}); verifying better-sqlite3 binding`,
        );

        const requireFn = createRequire(import.meta.url);
        const resolved = resolveBetterSqlite3OnDisk(requireFn);
        if (!resolved) {
            return null;
        }
        const { binaryPath: diskPath, pkgVersion } = resolved;

        // Fast path: if the on-disk binary already matches the runtime's
        // ABI, we don't need to override the lookup at all. This handles
        // any future OpenCode build that rebuilds native modules for
        // Electron at install time, plus the case where the user manually
        // ran `prebuild-install --runtime=electron`.
        if (existsSync(diskPath)) {
            const diskProbe = probeAbi(diskPath);
            if (diskProbe.ok) {
                logInfo(
                    `on-disk binary already matches Electron ABI v${expected}; using default bindings() lookup`,
                );
                return null;
            }
            logInfo(
                `on-disk binary ABI ${diskProbe.actual ?? "unknown"} != required ${expected}; will use Electron prebuild`,
            );
        } else {
            logWarn(
                `expected better-sqlite3 binary not found at ${diskPath}; will fetch Electron prebuild anyway`,
            );
        }

        // Look for a cached Electron prebuild from a previous launch.
        const cachedPath = getCachedBinaryPath(pkgVersion, expected);
        if (existsSync(cachedPath)) {
            const cachedProbe = probeAbi(cachedPath);
            if (cachedProbe.ok) {
                logInfo(`using cached Electron prebuild at ${cachedPath}`);
                return cachedPath;
            }
            logWarn(
                `cached binary at ${cachedPath} has wrong ABI (${cachedProbe.actual ?? "unknown"} != ${expected}); refetching`,
            );
        }

        // Download fresh.
        mkdirSync(path.dirname(cachedPath), { recursive: true });
        const nodeFileBytes = await downloadElectronPrebuild(pkgVersion, expected);
        writeFileSync(cachedPath, nodeFileBytes);
        logInfo(
            `cached Electron prebuild at ${cachedPath} (${(nodeFileBytes.length / 1024).toFixed(1)} KB)`,
        );

        // Validate the freshly downloaded binary before returning it — if
        // the upstream tarball was malformed or for the wrong ABI, fail
        // loudly here rather than letting the better-sqlite3 constructor
        // throw a less actionable error later.
        const finalProbe = probeAbi(cachedPath);
        if (!finalProbe.ok) {
            throw new Error(
                `downloaded Electron prebuild has wrong ABI (${finalProbe.actual ?? "unknown"} != ${expected}); refusing to use`,
            );
        }

        return cachedPath;
    })();

    inFlight = promise;
    try {
        return await promise;
    } finally {
        if (inFlight === promise) {
            inFlight = null;
        }
    }
}
