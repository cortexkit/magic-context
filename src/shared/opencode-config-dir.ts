import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { OpenCodeConfigDirOptions, OpenCodeConfigPaths } from "./opencode-config-dir-types";

export type {
    OpenCodeBinaryType,
    OpenCodeConfigDirOptions,
    OpenCodeConfigPaths,
} from "./opencode-config-dir-types";

function getCliConfigDir(): string {
    const envConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    if (envConfigDir) {
        return resolve(envConfigDir);
    }

    if (process.platform === "win32") {
        return join(homedir(), ".config", "opencode");
    }

    return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

export function getOpenCodeConfigDir(_options: OpenCodeConfigDirOptions): string {
    return getCliConfigDir();
}

export function getOpenCodeConfigPaths(options: OpenCodeConfigDirOptions): OpenCodeConfigPaths {
    const configDir = getOpenCodeConfigDir(options);
    return {
        configDir,
        configJson: join(configDir, "opencode.json"),
        configJsonc: join(configDir, "opencode.jsonc"),
        packageJson: join(configDir, "package.json"),
        omoConfig: join(configDir, "magic-context.jsonc"),
    };
}
