import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
        opencodeConfig = jsonPath;
        opencodeConfigFormat = "none";
    }

    const tuiJsoncPath = join(configDir, "tui.jsonc");
    const tuiJsonPath = join(configDir, "tui.json");
    if (existsSync(tuiJsoncPath)) {
        tuiConfig = tuiJsoncPath;
        tuiConfigFormat = "jsonc";
    } else if (existsSync(tuiJsonPath)) {
        tuiConfig = tuiJsonPath;
        tuiConfigFormat = "json";
    } else {
        tuiConfig = tuiJsonPath;
        tuiConfigFormat = "none";
    }

    return {
        configDir,
        opencodeConfig,
        opencodeConfigFormat,
        magicContextConfig: join(configDir, "magic-context.jsonc"),
        omoConfig: findOmoConfig(configDir),
        tuiConfig,
        tuiConfigFormat,
    };
}

// ============================================================================
// Pi paths
// ============================================================================

/** Pi's per-user agent dir; overridable via PI_CODING_AGENT_DIR. */
export function getPiAgentConfigDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (envDir) return envDir;
    return join(homedir(), ".pi", "agent");
}

export function getPiUserConfigPath(): string {
    return join(getPiAgentConfigDir(), "magic-context.jsonc");
}

/**
 * Pi's `pi install <source>` command persists extension package sources in
 * the `packages` array inside ~/.pi/agent/settings.json.
 */
export function getPiUserExtensionsPath(): string {
    return join(getPiAgentConfigDir(), "settings.json");
}

// ============================================================================
// Plugin / shared paths
// ============================================================================

/** Standard temp log path the plugin writes to. */
export function getMagicContextLogPath(): string {
    return join(tmpdir(), "magic-context.log");
}

/** Cache directory used by OpenCode for installed plugin packages. */
export function getOpenCodePluginCacheDir(): string {
    if (process.platform === "win32") {
        return join(homedir(), "AppData", "Local", "opencode", "Cache", "packages");
    }
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
