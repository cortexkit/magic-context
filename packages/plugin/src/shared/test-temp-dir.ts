import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const STALE_TEMP_DIR_AGE_MS = 60 * 60 * 1000;

// Keep this list narrow: startup cleanup must never turn into a shared /tmp purge.
export const TEST_TEMP_DIR_PREFIXES = [
    "mc-plugin-test-xdg-pid-",
    "mc-pi-test-xdg-",
    "mc-conflict-",
    "mc-conflict-fixer-",
    "mc-config-secret-",
    "pi-reasoning-replay-",
    "pi-session-api-test-",
    "pi-symlink-test-",
    "pi-running-vs-stale-",
    "pi-dist-metadata-",
    "pi-traversal-",
    "pi-source-mode-",
    "pi-source-missing-",
    "pi-nonprefixed-",
    "pi-default-cond-",
    "pi-array-exports-",
    "pi-extensionless-",
    "pi-tsx-source-",
    "pi-guidance-",
    "pi-system-v2-",
    "pi-no-guidance-",
    "pi-guidance-dedup-",
    "pi-noreduce-",
    "pi-language-baseline-",
    "pi-language-unset-",
    "pi-language-set-",
    "pi-a1-guidance-",
    "pi-prompt-epoch-",
    "pi-embedding-bootstrap-",
    "pi-embedding-home-",
    "magic-context-pi-latch-test-",
    "magic-context-pi-index-test-",
    "mc-test-temp-dir-helper-",
    "mc-v2-surface-",
    // Created by the NODE_ENV=test storage backstop in data-path.ts.
    "mc-test-db-backstop-",
] as const;

export type TestTempDirPrefix = string;
const OWNED_PREFIX = "mc-test-owned-";

type AfterAll = (callback: () => void) => void;
type SweepOptions = {
    tempDir?: string;
    nowMs?: number;
    staleAgeMs?: number;
};

const registeredTempDirs = new Set<string>();
let lifecycleCleanupInstalled = false;
let exitCleanupInstalled = false;

// os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows, on every
// call. Setting all three moves it on every platform.
const TEMP_DIR_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
// The temp directory in effect before redirectTempDirForTests ran, while that
// redirect is active.
let originalTempDir: string | undefined;

function hasRecognizedPrefix(name: string): boolean {
    return (
        name.startsWith(OWNED_PREFIX) ||
        TEST_TEMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
}

function isRegisteredTempDir(directory: string): boolean {
    const resolvedDirectory = resolve(directory);
    return registeredTempDirs.has(resolvedDirectory);
}

/**
 * Creates a test-owned root under the system temp directory. The returned cleanup
 * only removes roots made by this module, so an accidental path cannot delete an
 * unrelated temp directory.
 */
export function createTestTempDir(
    prefix: TestTempDirPrefix,
    nameSuffix = "",
): { dir: string; cleanup: () => void } {
    const label = prefix + nameSuffix;
    if (!label || label === "." || label === ".." || /[/\\\0]/.test(label)) {
        throw new Error("Test temp directory labels must be single path segments");
    }
    const dir = createTestTempDirFromPath(join(tmpdir(), `${prefix}${nameSuffix}`));
    return { dir, cleanup: () => cleanupTestTempDir(dir) };
}

/**
 * Registers fixtures with an explicit parent (including ADV_ROOT and nested roots).
 * A common namespace lets the stale sweep recognize every system-temp fixture,
 * without maintaining a list of caller-supplied labels.
 */
export function createTestTempDirFromPath(prefixPath: string): string {
    const dir = resolve(
        mkdtempSync(join(dirname(prefixPath), `${OWNED_PREFIX}${basename(prefixPath)}`)),
    );
    registeredTempDirs.add(dir);
    if (!exitCleanupInstalled) {
        exitCleanupInstalled = true;
        process.once("exit", cleanupRegisteredTestTempDirs);
    }
    return dir;
}

/** Removes one registered test root; busy roots remain registered for an exit retry. */
export function cleanupTestTempDir(directory: string): void {
    const resolvedDirectory = resolve(directory);
    if (!isRegisteredTempDir(resolvedDirectory)) return;

    try {
        rmSync(resolvedDirectory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
        });
        registeredTempDirs.delete(resolvedDirectory);
    } catch {
        // A process can still hold a file open on Windows. The next startup sweep retries it.
    }
}

/** Removes every root registered by this process. Safe to call more than once. */
export function cleanupRegisteredTestTempDirs(): void {
    for (const directory of [...registeredTempDirs]) cleanupTestTempDir(directory);
}

/**
 * Runs a callback with a fresh root and removes that root even when the callback throws.
 * This keeps small fixture builders from forgetting a failure-path cleanup.
 */
export function withTestTempDir<T>(
    prefix: TestTempDirPrefix,
    callback: (directory: string) => T,
): T {
    const { dir, cleanup } = createTestTempDir(prefix);
    try {
        return callback(dir);
    } finally {
        cleanup();
    }
}

/**
 * Installs both Bun's normal suite cleanup and an exit fallback for aborted runs.
 * The callback is passed in so this utility remains usable from the test preload
 * without making production code import bun:test.
 */
export function installTestTempDirCleanup(afterAll: AfterAll): void {
    if (lifecycleCleanupInstalled) return;
    lifecycleCleanupInstalled = true;
    afterAll(cleanupRegisteredTestTempDirs);
    if (!exitCleanupInstalled) {
        exitCleanupInstalled = true;
        process.once("exit", cleanupRegisteredTestTempDirs);
    }
}

/**
 * Points os.tmpdir() at `directory` for this process and the child processes it
 * starts afterwards. Returns a function that puts back the previous values,
 * including unsetting variables that were unset.
 */
export function setProcessTempDirForTests(directory: string): () => void {
    const previous = TEMP_DIR_ENV_KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of TEMP_DIR_ENV_KEYS) process.env[key] = directory;
    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

/**
 * Moves os.tmpdir() to a fresh test-owned root for the rest of the test run, so
 * nothing a test writes there reaches the machine's temp directory.
 *
 * Production code writes the plugin log and historian response dumps under
 * os.tmpdir(), and the CLI doctor counts the dumps it finds there. Without the
 * redirect, a test that makes the historian dump a response leaves files in the
 * machine's temp directory, and a doctor test that runs later on the same
 * machine reports them as an extra warning.
 *
 * The previous values come back in `afterAll`. Under `bun test --parallel`, Bun
 * runs the preload and its afterAll hooks once per test file in the same
 * process, and the next file's preload creates its roots under os.tmpdir().
 * By then the cleanup has deleted this root, so the restore must run first.
 */
export function redirectTempDirForTests(afterAll: AfterAll): string {
    const machineTempDir = tmpdir();
    const { dir } = createTestTempDir("mc-test-tmpdir-");
    const restore = setProcessTempDirForTests(dir);
    originalTempDir = machineTempDir;
    afterAll(() => {
        restore();
        originalTempDir = undefined;
    });
    return dir;
}

/**
 * The temp directory this process had before redirectTempDirForTests moved
 * os.tmpdir(), so a test can check that nothing reached it. Without an active
 * redirect it is the current os.tmpdir().
 */
export function getOriginalTempDirForTests(): string {
    return originalTempDir ?? tmpdir();
}

/**
 * Removes only old, recognized test roots from one temp directory. The scan does
 * one directory read, ignores non-directories, and leaves fresh roots and every
 * unrecognized name alone so concurrently running tools stay isolated.
 */
export function sweepStaleTestTempDirs({
    tempDir = tmpdir(),
    nowMs = Date.now(),
    staleAgeMs = STALE_TEMP_DIR_AGE_MS,
}: SweepOptions = {}): string[] {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
        entries = readdirSync(tempDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const removed: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !hasRecognizedPrefix(entry.name)) continue;

        const directory = join(tempDir, entry.name);
        try {
            if (nowMs - statSync(directory).mtimeMs <= staleAgeMs) continue;
            rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            removed.push(directory);
        } catch {
            // Temp cleanup is best-effort; a later test run retries busy directories.
        }
    }
    return removed;
}
