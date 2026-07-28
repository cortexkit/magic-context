import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
    getMagicContextHistorianDir as getMagicContextHistorianDirCore,
    getMagicContextLogPath as getMagicContextLogPathCore,
} from "@magic-context/core/shared/data-path";
import type { HarnessId } from "@magic-context/core/shared/harness";

// ============================================================================
// OpenCode paths
// ============================================================================

export interface ConfigPaths {
    configDir: string;
    /** opencode.json or opencode.jsonc */
    opencodeConfig: string;
    opencodeConfigFormat: "json" | "jsonc" | "none";
    magicContextConfig: string;
    /** oh-my-opencode/oh-my-openagent json(c) if exists */
    omoConfig: string | null;
    tuiConfig: string;
    tuiConfigFormat: "json" | "jsonc" | "none";
}

/**
 * OpenCode config dir resolution.
 *
 * OpenCode uses ~/.config/opencode on ALL platforms (including Windows),
 * not %APPDATA%. The plugin runtime resolves it the same way; setup must
 * match or it will create a config the plugin can't read.
 */
export function getOpenCodeConfigDir(): string {
    const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    if (envDir) return envDir;
    if (process.platform === "win32") {
        return join(homedir(), ".config", "opencode");
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}

function findOmoConfig(configDir: string): string | null {
    const locations = [
        join(configDir, "oh-my-openagent.jsonc"),
        join(configDir, "oh-my-openagent.json"),
        join(configDir, "oh-my-opencode.jsonc"),
        join(configDir, "oh-my-opencode.json"),
    ];
    for (const loc of locations) {
        if (existsSync(loc)) return loc;
    }
    return null;
}

export function detectConfigPaths(): ConfigPaths {
    const configDir = getOpenCodeConfigDir();

    let opencodeConfig: string;
    let opencodeConfigFormat: "json" | "jsonc" | "none";
    let tuiConfig: string;
    let tuiConfigFormat: "json" | "jsonc" | "none";

    const jsoncPath = join(configDir, "opencode.jsonc");
    const jsonPath = join(configDir, "opencode.json");
    if (existsSync(jsoncPath)) {
        opencodeConfig = jsoncPath;
        opencodeConfigFormat = "jsonc";
    } else if (existsSync(jsonPath)) {
        opencodeConfig = jsonPath;
        opencodeConfigFormat = "json";
    } else {
        // Fresh installs use JSONC so users can add comments without creating a
        // second, higher-precedence config later.
        opencodeConfig = jsoncPath;
        opencodeConfigFormat = "none";
    }

    const tuiJsoncPath = join(configDir, "tui.jsonc");
    const tuiJsonPath = join(configDir, "tui.json");
    if (existsSync(tuiJsoncPath)) {
        // OpenCode merges tui.json + tui.jsonc with tui.jsonc winning, so an
        // existing tui.jsonc is the higher-precedence user file — write into it.
        tuiConfig = tuiJsoncPath;
        tuiConfigFormat = "jsonc";
    } else if (existsSync(tuiJsonPath)) {
        tuiConfig = tuiJsonPath;
        tuiConfigFormat = "json";
    } else {
        // Fresh install: create tui.jsonc (not tui.json) so the user can add
        // comments later and we don't leave a second, lower-precedence file
        // alongside a tui.jsonc they create afterward (#176).
        tuiConfig = tuiJsoncPath;
        tuiConfigFormat = "none";
    }

    return {
        configDir,
        opencodeConfig,
        opencodeConfigFormat,
        magicContextConfig: resolveCortexKitUserConfigPath(),
        omoConfig: findOmoConfig(configDir),
        tuiConfig,
        tuiConfigFormat,
    };
}

// ============================================================================
// Pi paths
// ============================================================================

function envFirstHomeDir(): string {
    const home = process.env.HOME?.trim();
    return home || homedir();
}

/** Pi's per-user agent dir; overridable via PI_CODING_AGENT_DIR. */
export function getPiAgentDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (envDir) return envDir;
    return join(envFirstHomeDir(), ".pi", "agent");
}

/** Pi's per-user agent dir; overridable via PI_CODING_AGENT_DIR. */
export function getPiAgentConfigDir(): string {
    return getPiAgentDir();
}

/** Pi session JSONL root (`<agentDir>/sessions`). */
export function getPiSessionsRoot(): string {
    return join(getPiAgentDir(), "sessions");
}

/** Pi cache root, kept beside the resolved agent dir (`<parent>/cache`). */
export function getPiCacheRoot(): string {
    return join(dirname(getPiAgentDir()), "cache");
}

/** Shared Magic Context user config, independent of the Pi agent settings dir. */
export function getPiUserConfigPath(): string {
    return resolveCortexKitUserConfigPath();
}

/**
 * Pi's `pi install <source>` command persists extension package sources in
 * the `packages` array inside ~/.pi/agent/settings.json.
 */
export function getPiUserExtensionsPath(): string {
    return join(getPiAgentConfigDir(), "settings.json");
}

// ============================================================================
// OMP paths
// ============================================================================

export interface OmpPaths {
    configRoot: string;
    agentDir: string;
    dataRoot: string;
    dataAgentRoot: string;
    pluginsDir: string;
    sessionsRoot: string;
}

/** Mirror OMP's profile/custom-dir/XDG resolution without importing the host. */
export function resolveOmpPaths(): OmpPaths {
    const rawProfile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
    const normalizedProfile = rawProfile?.trim();
    const profile =
        normalizedProfile &&
        normalizedProfile !== "default" &&
        /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalizedProfile)
            ? normalizedProfile
            : undefined;
    const configDirName = process.env.PI_CONFIG_DIR?.trim() || ".omp";
    const baseConfigRoot = join(envFirstHomeDir(), configDirName);
    const configRoot = profile ? join(baseConfigRoot, "profiles", profile) : baseConfigRoot;
    const defaultAgentDir = join(configRoot, "agent");
    // Named profiles deliberately ignore PI_CODING_AGENT_DIR. OMP sets the env
    // to the derived profile path for children, but the profile remains the
    // authority so a stale/custom override cannot escape its root.
    const override = profile ? undefined : process.env.PI_CODING_AGENT_DIR?.trim();
    const agentDir = override ? resolve(override) : defaultAgentDir;
    const canUseXdg =
        (process.platform === "linux" || process.platform === "darwin") &&
        agentDir === defaultAgentDir;
    let dataRoot = configRoot;
    if (canUseXdg) {
        const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
        if (xdgDataHome) {
            const appRoot = join(xdgDataHome, "omp");
            const candidate = profile ? join(appRoot, "profiles", profile) : appRoot;
            if (existsSync(candidate)) dataRoot = candidate;
        }
    }
    // OMP flattens the `agent/` prefix when XDG data is active.
    const dataAgentRoot = dataRoot === configRoot ? agentDir : dataRoot;
    return {
        configRoot,
        agentDir,
        dataRoot,
        dataAgentRoot,
        pluginsDir: join(dataRoot, "plugins"),
        sessionsRoot: join(dataAgentRoot, "sessions"),
    };
}

/** OMP's active agent dir, including named profiles and explicit overrides. */
export function getOmpAgentDir(): string {
    return resolveOmpPaths().agentDir;
}

/** OMP session JSONL root, including its XDG data layout. */
export function getOmpSessionsRoot(): string {
    return resolveOmpPaths().sessionsRoot;
}

/** OMP's global YAML settings file. */
export function getOmpConfigPath(): string {
    return join(resolveOmpPaths().agentDir, "config.yml");
}

/** OMP's npm/link plugin root, including profile and XDG data layout. */
export function getOmpPluginsDir(): string {
    return resolveOmpPaths().pluginsDir;
}

/** OMP's plugin runtime lock file. */
export function getOmpPluginsLockPath(): string {
    return join(resolveOmpPaths().pluginsDir, "omp-plugins.lock.json");
}

/** Shared Magic Context config used by OMP's Pi-compatible extension. */
export function getOmpUserConfigPath(): string {
    return resolveCortexKitUserConfigPath();
}

// ============================================================================
// Plugin / shared paths
// ============================================================================

/** Plugin log file path under the harness-scoped temp dir. */
export function getMagicContextLogPath(harness: HarnessId): string {
    return getMagicContextLogPathCore(harness);
}

/** Historian dump + state-file dir under the harness-scoped temp dir. */
export function getMagicContextHistorianDir(harness: HarnessId): string {
    return getMagicContextHistorianDirCore(harness);
}

/**
 * Cache directory used by OpenCode for installed plugin packages.
 *
 * OpenCode uses the `xdg-basedir` package, which — on every platform, including
 * Windows — falls back to `<homedir>/.cache` when `XDG_CACHE_HOME` is unset.
 * A previous Windows-specific branch that resolved to `%LOCALAPPDATA%` did not
 * match OpenCode's own resolution and caused `doctor --force` to clear a
 * non-existent directory while the real cache at `C:\Users\<user>\.cache`
 * stayed untouched. The plugin runtime fixed the same bug in
 * packages/plugin/src/shared/data-path.ts; this CLI helper must stay aligned.
 */
export function getOpenCodePluginCacheDir(): string {
    const xdg = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(xdg, "opencode", "packages");
}

/** True if `path` exists and is a directory. */
export function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Recursive size in bytes of a directory; returns 0 if missing. */
export function dirSizeBytes(path: string): number {
    if (!isDir(path)) return 0;
    let total = 0;
    const stack = [path];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        try {
            const entries = readdirSync(cur, { withFileTypes: true });
            for (const entry of entries) {
                const child = join(cur, entry.name);
                if (entry.isDirectory()) {
                    stack.push(child);
                } else if (entry.isFile()) {
                    try {
                        total += statSync(child).size;
                    } catch {
                        // ignore unreadable
                    }
                }
            }
        } catch {
            // ignore unreadable directories
        }
    }
    return total;
}
