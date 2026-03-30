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
            error instanceof Error ? error.message : String(error),
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
        // Deep-merge nested config objects so partial overrides don't lose base values
        memory: {
            ...(base.memory ?? {}),
            ...(override.memory ?? {}),
        } as MagicContextPluginConfig["memory"],
        embedding: (override.embedding ?? base.embedding) as MagicContextPluginConfig["embedding"],
        historian: override.historian ?? base.historian,
        dreamer: override.dreamer
            ? ({
                  ...(base.dreamer ?? {}),
                  ...override.dreamer,
              } as MagicContextPluginConfig["dreamer"])
            : base.dreamer,
        sidekick: override.sidekick
            ? ({
                  ...(base.sidekick ?? {}),
                  ...override.sidekick,
              } as MagicContextPluginConfig["sidekick"])
            : base.sidekick,
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
        // Return safe defaults with enabled:false so downstream code has all required fields
        // instead of an incomplete cast that would produce undefined for 18+ properties.
        const defaults = MagicContextConfigSchema.parse({});
        return { ...defaults, enabled: false, disabled_hooks: disabledHooks, command };
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

    let config: MagicContextPluginConfig = parsePluginConfig({});

    if (userConfig) {
        config = mergeConfigs(config, parsePluginConfig(userConfig));
    }

    if (projectConfig) {
        config = mergeConfigs(config, parsePluginConfig(projectConfig));
    }

    return config;
}
