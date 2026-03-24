import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectConfigFile, parseJsonc } from "../shared/jsonc-parser";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";

export interface MagicContextPluginConfig extends MagicContextConfig {
    disabled_hooks?: string[];
    command?: Record<
        string,
        {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            subtask?: boolean;
        }
    >;
}

const CONFIG_FILE_BASENAME = "magic-context";

function getUserConfigBasePath(): string {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(configRoot, "opencode", CONFIG_FILE_BASENAME);
}

function getProjectConfigBasePath(directory: string): string {
    return join(directory, ".opencode", CONFIG_FILE_BASENAME);
}

function loadConfigFile(configPath: string): Record<string, unknown> | null {
    try {
        if (!existsSync(configPath)) {
            return null;
        }
        return parseJsonc<Record<string, unknown>>(readFileSync(configPath, "utf-8"));
    } catch (error) {
        console.warn(
            `[magic-context] failed to load config from ${configPath}:`,
            error instanceof Error ? error.message : error,
        );
        return null;
    }
}

function mergeConfigs(
    base: MagicContextPluginConfig,
    override: MagicContextPluginConfig,
): MagicContextPluginConfig {
    const config: MagicContextPluginConfig = {
        ...base,
        ...override,
        disabled_hooks: [
            ...new Set([...(base.disabled_hooks ?? []), ...(override.disabled_hooks ?? [])]),
        ],
        command: {
            ...(base.command ?? {}),
            ...(override.command ?? {}),
        },
    };

    return config;
}

function parsePluginConfig(rawConfig: Record<string, unknown>): MagicContextPluginConfig {
    const parsed = MagicContextConfigSchema.safeParse(rawConfig);
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    if (!parsed.success) {
        return { disabled_hooks: disabledHooks, command } as MagicContextPluginConfig;
    }

    const config: MagicContextPluginConfig = {
        ...parsed.data,
        disabled_hooks: disabledHooks,
        command,
    };

    return config;
}

export function loadPluginConfig(directory: string): MagicContextPluginConfig {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    // Check project root first, then .opencode/ — root takes precedence
    const rootDetected = detectConfigFile(join(directory, CONFIG_FILE_BASENAME));
    const dotOpenCodeDetected = detectConfigFile(getProjectConfigBasePath(directory));
    const projectDetected = rootDetected.format !== "none" ? rootDetected : dotOpenCodeDetected;

    const userConfig = userDetected.format === "none" ? null : loadConfigFile(userDetected.path);
    const projectConfig =
        projectDetected.format === "none" ? null : loadConfigFile(projectDetected.path);

    let config: MagicContextPluginConfig = {} as MagicContextPluginConfig;

    if (userConfig) {
        config = mergeConfigs(config, parsePluginConfig(userConfig));
    }

    if (projectConfig) {
        config = mergeConfigs(config, parsePluginConfig(projectConfig));
    }

    return config;
}
