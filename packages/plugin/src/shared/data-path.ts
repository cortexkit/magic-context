import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

export function getOpenCodeStorageDir(): string {
    return path.join(getDataDir(), "opencode", "storage");
}

/**
 * Resolve the shared magic-context storage directory.
 *
 * Magic-context's own data (compartments, facts, memories, embeddings, dream
 * runs, notes, etc.) lives at this path regardless of which harness loaded the
 * plugin (OpenCode or Pi). This enables:
 *   - Shared project memories across harnesses
 *   - Shared embedding cache
 *   - Shared Dreamer runs (one per project per machine)
 *   - Future cross-harness session migration
 *
 * Layout: <XDG_DATA_HOME>/cortexkit/magic-context/
 */
export function getMagicContextStorageDir(): string {
    return path.join(getDataDir(), "cortexkit", "magic-context");
}

/**
 * Legacy magic-context storage directory used by the OpenCode plugin before the
 * shared cortexkit path. Used only for one-time migration of existing data into
 * the new shared location. The legacy directory is left in place after copy so
 * users can roll back if needed; manual cleanup is safe after one stable
 * release.
 */
export function getLegacyOpenCodeMagicContextStorageDir(): string {
    return path.join(getOpenCodeStorageDir(), "plugin", "magic-context");
}

/**
 * Resolve OpenCode's cache base directory.
 *
 * OpenCode uses the `xdg-basedir` package, which — on every platform, including
 * Windows — falls back to `<homedir>/.cache` when `XDG_CACHE_HOME` is unset.
 * A previous Windows-specific branch that resolved to `%LOCALAPPDATA%` did not
 * match OpenCode's own resolution and caused `doctor --force` to target a
 * non-existent directory, leaving the real cache at `C:\Users\<user>\.cache`
 * untouched.
 */
export function getCacheDir(): string {
    return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export function getOpenCodeCacheDir(): string {
    return path.join(getCacheDir(), "opencode");
}
