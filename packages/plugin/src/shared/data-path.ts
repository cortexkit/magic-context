import * as os from "node:os";
import * as path from "node:path";
import { getHarness, type HarnessId } from "./harness";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/**
 * Per-harness scratch directory under the OS temp dir.
 *
 * Layout:
 *   - OpenCode: `${os.tmpdir()}/opencode/magic-context/`
 *   - Pi:       `${os.tmpdir()}/pi/magic-context/`
 *
 * Why a per-harness subtree of `os.tmpdir()`:
 *   1. OpenCode Desktop runs as an Electron app with a permission sandbox.
 *      Writing to arbitrary tmp paths can trigger user-visible permission
 *      prompts; the `${tmpdir}/opencode/` subtree is allow-listed by
 *      OpenCode, so anything we put under it never asks for permission.
 *   2. Splitting OpenCode from Pi keeps their logs and historian dump
 *      directories cleanly separated. `doctor --issue` for each harness
 *      reports diagnostics from the matching subtree, so an OpenCode
 *      issue report never includes Pi log noise (and vice versa).
 *   3. Pi has no permission sandbox, so the path choice is purely
 *      cosmetic for Pi — it just keeps the layout symmetric.
 *
 * Pass an explicit `harness` only when the caller already knows the
 * harness without relying on the global `setHarness()` state (e.g. the
 * CLI's doctor commands, which target a specific harness regardless of
 * which plugin is loaded). Production runtime callers should omit it so
 * the helper picks up the boot-time harness automatically.
 */
export function getMagicContextTempDir(harness: HarnessId = getHarness()): string {
    return path.join(os.tmpdir(), harness, "magic-context");
}

/**
 * Standard log file path the plugin writes to. Pi and OpenCode write to
 * SEPARATE logs under their respective harness subtrees so a single
 * machine running both harnesses doesn't interleave session traces.
 *
 * The plugin's buffered logger calls this on every flush rather than
 * caching, so `setHarness("pi")` taking effect after module load is
 * reflected in the next flush.
 */
export function getMagicContextLogPath(harness: HarnessId = getHarness()): string {
    return path.join(getMagicContextTempDir(harness), "magic-context.log");
}

/**
 * Directory used for both historian validation-failure dumps and the
 * existing-state offload XMLs that large historian/recomp passes write
 * before invoking the model. Per-harness so dumps from different
 * harnesses don't collide on filename and so `doctor --issue` for each
 * harness reports only its own historian artifacts.
 */
export function getMagicContextHistorianDir(harness: HarnessId = getHarness()): string {
    return path.join(getMagicContextTempDir(harness), "historian");
}

/**
 * Project-local magic-context artifact directory.
 *
 * Layout: `<project-directory>/.opencode/magic-context/`
 *
 * Used for artifacts that the historian/recomp pipeline writes during a run
 * and that the model is asked to read via its native Read tool. OpenCode's
 * `external_directory` permission system asks the user before reading any
 * file outside the project directory or its worktree, which interrupts every
 * historian run when artifacts live under `os.tmpdir()`. Writing under the
 * project's own `.opencode/` subtree falls inside the project boundary and
 * never triggers a permission prompt.
 *
 * The `.opencode/` parent dir is OpenCode's own per-project convention (used
 * for project-local config, plans, dumps, plugin installs). Anchoring
 * magic-context artifacts under `.opencode/magic-context/` keeps them
 * co-located with related OpenCode metadata and makes them easy for users to
 * locate when debugging.
 *
 * Logger does NOT use this — log files stay in the per-harness tmp subtree
 * because they are written by the plugin process itself (no model-side Read
 * tool call, no permission prompt) and span sessions/projects.
 */
export function getProjectMagicContextDir(directory: string): string {
    return path.join(directory, ".opencode", "magic-context");
}

/**
 * Project-local historian artifact directory.
 *
 * Layout: `<project-directory>/.opencode/magic-context/historian/`
 *
 * Used for:
 *   - existing-state offload XMLs that long historian/recomp passes write
 *     before invoking the model (the model reads the file via Read tool)
 *   - validation-failure dump XMLs preserved for debugging
 *
 * Callers must `mkdirSync(dir, { recursive: true })` before writing — the
 * `.opencode/` parent may not exist on a fresh project, and write failures
 * here must degrade gracefully (e.g. historian falls back to inline state).
 */
export function getProjectMagicContextHistorianDir(directory: string): string {
    return path.join(getProjectMagicContextDir(directory), "historian");
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
