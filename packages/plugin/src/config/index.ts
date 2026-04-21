import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectConfigFile, parseJsonc } from "../shared/jsonc-parser";
import { type MagicContextConfig, MagicContextConfigSchema } from "./schema/magic-context";
import { substituteConfigVariables } from "./variable";

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

interface LoadedConfigFile {
    config: Record<string, unknown>;
    /** Warnings from {env:} / {file:} substitution, with config-path prefix applied. */
    warnings: string[];
}

function loadConfigFile(configPath: string): LoadedConfigFile | null {
    try {
        if (!existsSync(configPath)) {
            return null;
        }
        const rawText = readFileSync(configPath, "utf-8");
        // Substitute {env:VAR} and {file:path} tokens on the raw text before
        // parsing so users can reference env vars (API keys) and external files
        // without leaking secrets into the config file itself. Matches OpenCode's
        // ConfigVariable.substitute semantics exactly.
        const substituted = substituteConfigVariables({ text: rawText, configPath });
        return {
            config: parseJsonc<Record<string, unknown>>(substituted.text),
            warnings: substituted.warnings.map((w) => `${configPath}: ${w}`),
        };
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

function parsePluginConfig(
    rawConfig: Record<string, unknown>,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    const parsed = MagicContextConfigSchema.safeParse(rawConfig);
    const disabledHooks = Array.isArray(rawConfig.disabled_hooks)
        ? rawConfig.disabled_hooks.filter((value): value is string => typeof value === "string")
        : undefined;
    const command =
        typeof rawConfig.command === "object" && rawConfig.command !== null
            ? (rawConfig.command as MagicContextPluginConfig["command"])
            : undefined;

    if (parsed.success) {
        return {
            ...parsed.data,
            disabled_hooks: disabledHooks,
            command,
        };
    }

    // Full parse failed — recover field-by-field using defaults for invalid fields.
    // Agent configs (historian, dreamer, sidekick) are dropped on error rather than defaulted
    // because wrong model config could run expensive models or fail silently.
    const defaults = MagicContextConfigSchema.parse({});
    const warnings: string[] = [];

    // Build a patched copy of rawConfig, replacing invalid fields with undefined
    // so Zod fills in defaults on the second parse.
    const errorPaths = new Set<string>();
    for (const issue of parsed.error.issues) {
        const topKey = issue.path[0];
        if (topKey !== undefined) {
            errorPaths.add(String(topKey));
        }
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    for (const key of errorPaths) {
        const isAgentConfig = key === "historian" || key === "dreamer" || key === "sidekick";
        if (isAgentConfig) {
            // Drop agent configs entirely on error — don't default them
            delete patched[key];
            warnings.push(
                `"${key}": invalid agent configuration, ignoring. Check your magic-context.jsonc.`,
            );
        } else {
            // Use Zod default for this field
            delete patched[key];
            const defaultVal = (defaults as unknown as Record<string, unknown>)[key];
            warnings.push(
                `"${key}": invalid value ${JSON.stringify(rawConfig[key])}, using default ${JSON.stringify(defaultVal)}.`,
            );
        }
    }

    const retryParsed = MagicContextConfigSchema.safeParse(patched);
    if (retryParsed.success) {
        return {
            ...retryParsed.data,
            disabled_hooks: disabledHooks,
            command,
            configWarnings: warnings,
        };
    }

    // If even the patched version fails (shouldn't happen), fall back to full defaults
    // but keep enabled:true — the user intended to use the plugin.
    warnings.push("Config recovery failed, using all defaults.");
    return { ...defaults, disabled_hooks: disabledHooks, command, configWarnings: warnings };
}

export function loadPluginConfig(
    directory: string,
): MagicContextPluginConfig & { configWarnings?: string[] } {
    const userDetected = detectConfigFile(getUserConfigBasePath());
    // Check project root first, then .opencode/ — root takes precedence
    const rootDetected = detectConfigFile(join(directory, CONFIG_FILE_BASENAME));
    const dotOpenCodeDetected = detectConfigFile(getProjectConfigBasePath(directory));
    const projectDetected = rootDetected.format !== "none" ? rootDetected : dotOpenCodeDetected;

    const userLoaded = userDetected.format === "none" ? null : loadConfigFile(userDetected.path);
    const projectLoaded =
        projectDetected.format === "none" ? null : loadConfigFile(projectDetected.path);

    let config: MagicContextPluginConfig & { configWarnings?: string[] } = parsePluginConfig({});
    const allWarnings: string[] = [];

    if (userLoaded) {
        // Variable-substitution warnings surface first so users see missing
        // env vars before any downstream schema-validation warnings.
        allWarnings.push(...userLoaded.warnings.map((w) => `[user config] ${w}`));
        const parsed = parsePluginConfig(userLoaded.config);
        if (parsed.configWarnings?.length) {
            allWarnings.push(...parsed.configWarnings.map((w) => `[user config] ${w}`));
        }
        config = mergeConfigs(config, parsed);
    }

    if (projectLoaded) {
        allWarnings.push(...projectLoaded.warnings.map((w) => `[project config] ${w}`));
        const parsed = parsePluginConfig(projectLoaded.config);
        if (parsed.configWarnings?.length) {
            allWarnings.push(...parsed.configWarnings.map((w) => `[project config] ${w}`));
        }
        config = mergeConfigs(config, parsed);
    }

    if (allWarnings.length > 0) {
        config.configWarnings = allWarnings;
    }

    return config;
}
