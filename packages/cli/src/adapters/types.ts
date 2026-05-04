/**
 * HarnessAdapter — abstracts what the unified Magic Context CLI needs to know
 * about a specific agent harness (OpenCode, Pi).
 *
 * Each adapter covers:
 *   1. *Detection* — is the harness installed? is the plugin registered with it?
 *   2. *Configuration* — where do its config files live, how are they read/written?
 *   3. *Runtime state* — log file, storage dir, plugin cache dir
 *   4. *Setup* — how a user installs/registers our plugin with it
 *
 * Everything here is synchronous or returns synchronously-resolvable
 * structures; async work lives in the command layer.
 */

export type HarnessKind = "opencode" | "pi";

export interface HarnessConfigPaths {
    /** Primary config dir (e.g. `~/.config/opencode`, `~/.pi/agent`). */
    configDir: string;
    /** Path to the JSONC config file the plugin registers itself in. */
    pluginConfigPath: string;
    /** Path to the magic-context.jsonc the user can edit (per harness). */
    magicContextConfigPath: string;
    /**
     * Optional secondary config (e.g. `tui.json` for OpenCode TUI).
     * `null` when the harness has no equivalent.
     */
    secondaryConfigPath: string | null;
}

export interface PluginEntryResult {
    ok: boolean;
    /** What happened: added/updated/already_present/error. */
    action: "added" | "updated" | "already_present" | "error";
    /** Human-readable summary used by setup logs. */
    message: string;
    /** The config file we wrote (or would have written) to. */
    configPath: string;
}

export interface PluginCacheInfo {
    /** Cache directory for the plugin (or null if harness has no plugin cache). */
    path: string | null;
    /** Whether the cache currently has anything in it. */
    exists: boolean;
    /** Approximate cache size in bytes (0 when missing). */
    sizeBytes: number;
}

/**
 * The full adapter contract. Implementations live next to this file.
 */
export interface HarnessAdapter {
    /** Stable identifier — used in CLI flags, logs, and routing. */
    readonly kind: HarnessKind;
    /** Human-readable name used in prompts and notes. */
    readonly displayName: string;
    /** npm package name for the plugin this adapter installs. */
    readonly pluginPackageName: string;

    /** Whether the harness's host binary is installed (PATH probe + path probe). */
    isInstalled(): boolean;

    /** Whether the plugin is registered with this harness. */
    hasPluginEntry(): boolean;

    /** Resolve standard config paths. May be called even when harness isn't installed. */
    getConfigPaths(): HarnessConfigPaths;

    /**
     * Add the plugin entry to the harness's config (idempotent).
     *
     * Returns a PluginEntryResult describing what changed. Adapters MUST
     * preserve user comments/formatting when rewriting JSONC files.
     */
    ensurePluginEntry(): Promise<PluginEntryResult>;

    /**
     * Remove the plugin entry from the harness's config.
     *
     * Used by `doctor --uninstall`-style flows in the future. Returns
     * the same result shape as ensurePluginEntry.
     */
    removePluginEntry(): Promise<PluginEntryResult>;

    /**
     * Print user-facing install instructions when the harness host is
     * missing. Called by setup and doctor when isInstalled() is false.
     */
    getInstallHint(): string;

    /** Path to the harness's plugin cache, if it has one. */
    getPluginCacheInfo(): PluginCacheInfo;

    /** Path to the harness-specific log file (the plugin writes there). */
    getLogPath(): string;

    /** Latest installed version of the plugin in the harness's cache, if known. */
    getInstalledPluginVersion(): string | null;
}
