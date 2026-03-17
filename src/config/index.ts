import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectConfigFile, parseJsonc } from "../shared/jsonc-parser";
import { type AgentOverrides, AgentOverridesSchema } from "./schema/agent-overrides";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";

export interface MagicContextPluginConfig {
    magic_context?: MagicContextConfig;
    agents?: AgentOverrides;
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
    } catch (_error) {
        return null;
    }
}

function mergeConfigs(
    base: MagicContextPluginConfig,
    override: MagicContextPluginConfig,
): MagicContextPluginConfig {
    return {
        ...base,
        ...override,
        magic_context: override.magic_context ?? base.magic_context,
        agents: {
            ...base.agents,
            ...override.agents,
        },
        disabled_hooks: [
            ...new Set([...(base.disabled_hooks ?? []), ...(override.disabled_hooks ?? [])]),
        ],
        command: {
            ...(base.command ?? {}),
            ...(override.command ?? {}),
        },
    };
}

function parsePluginConfig(rawConfig: Record<string, unknown>): MagicContextPluginConfig {
    const parsedMagicContext = MagicContextConfigSchema.safeParse(
        rawConfig.magic_context ?? rawConfig,
    );
    const parsedAgents = AgentOverridesSchema.safeParse(rawConfig.agents ?? {});
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    return {
        magic_context: parsedMagicContext.success ? parsedMagicContext.data : undefined,
        agents: parsedAgents.success ? parsedAgents.data : undefined,
        disabled_hooks: disabledHooks,
        command,
    };
}

export function loadPluginConfig(directory: string): MagicContextPluginConfig {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    const projectDetected = detectConfigFile(getProjectConfigBasePath(directory));

    const userConfig = userDetected.format === "none" ? null : loadConfigFile(userDetected.path);
    const projectConfig =
        projectDetected.format === "none" ? null : loadConfigFile(projectDetected.path);

    let config: MagicContextPluginConfig = {};

    if (userConfig) {
        config = mergeConfigs(config, parsePluginConfig(userConfig));
    }

    if (projectConfig) {
        config = mergeConfigs(config, parsePluginConfig(projectConfig));
    }

    return config;
}
