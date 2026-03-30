import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigPaths {
    configDir: string;
    opencodeConfig: string; // opencode.json or opencode.jsonc
    opencodeConfigFormat: "json" | "jsonc" | "none";
    magicContextConfig: string;
    omoConfig: string | null; // oh-my-opencode.json(c) if exists
}

function getConfigDir(): string {
    const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    if (envDir) return envDir;

    if (process.platform === "win32") {
        const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        return join(appData, "opencode");
    }

    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}

function findOmoConfig(configDir: string): string | null {
    const locations = [
        // Current name: oh-my-openagent
        join(configDir, "oh-my-openagent.jsonc"),
        join(configDir, "oh-my-openagent.json"),
        // Legacy name: oh-my-opencode
        join(configDir, "oh-my-opencode.jsonc"),
        join(configDir, "oh-my-opencode.json"),
    ];
    for (const loc of locations) {
        if (existsSync(loc)) return loc;
    }
    return null;
}

export function detectConfigPaths(): ConfigPaths {
    const configDir = getConfigDir();

    let opencodeConfig: string;
    let opencodeConfigFormat: "json" | "jsonc" | "none";

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

    return {
        configDir,
        opencodeConfig,
        opencodeConfigFormat,
        magicContextConfig: join(configDir, "magic-context.jsonc"),
        omoConfig: findOmoConfig(configDir),
    };
}
