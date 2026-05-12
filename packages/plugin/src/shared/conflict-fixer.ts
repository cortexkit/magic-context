import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "comment-json";

import {
    type ConflictResult,
    DCP_PACKAGE_NAMES,
    extractPluginName,
    matchesPackageName,
} from "./conflict-detector";
import { getOpenCodeConfigPaths } from "./opencode-config-dir";

type JsonObject = Record<string, unknown>;

const CONFLICTING_OMO_HOOKS = [
    "context-window-monitor",
    "preemptive-compaction",
    "anthropic-context-window-limit-recovery",
] as const;

const OMO_CONFIG_NAMES = [
    "oh-my-openagent.jsonc",
    "oh-my-openagent.json",
    "oh-my-opencode.jsonc",
    "oh-my-opencode.json",
] as const;

function isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

function readConfig(filePath: string): JsonObject | null {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const parsed = parse(readFileSync(filePath, "utf-8"));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writeConfig(filePath: string, config: JsonObject): void {
    writeFileSync(filePath, `${stringify(config, null, 2)}\n`);
}

function resolveUserOpenCodeConfigPath(): string {
    const paths = getOpenCodeConfigPaths({ binary: "opencode" });
    if (existsSync(paths.configJsonc)) return paths.configJsonc;
    return paths.configJson;
}

function collectOpenCodeConfigPaths(directory: string): string[] {
    const paths = new Set<string>();
    const userConfig = resolveUserOpenCodeConfigPath();

    if (existsSync(userConfig)) {
        paths.add(userConfig);
    }

    for (const filePath of [
        join(directory, ".opencode", "opencode.jsonc"),
        join(directory, ".opencode", "opencode.json"),
        join(directory, "opencode.jsonc"),
        join(directory, "opencode.json"),
    ]) {
        if (existsSync(filePath)) {
            paths.add(filePath);
        }
    }

    return [...paths];
}

function collectOmoConfigPaths(directory: string): string[] {
    const paths = new Set<string>();
    const configDir = getOpenCodeConfigPaths({ binary: "opencode" }).configDir;

    for (const fileName of OMO_CONFIG_NAMES) {
        const userPath = join(configDir, fileName);
        const projectPath = join(directory, fileName);

        if (existsSync(userPath)) {
            paths.add(userPath);
        }

        if (existsSync(projectPath)) {
            paths.add(projectPath);
        }
    }

    return [...paths];
}

function filterDcpPluginEntries(entries: unknown[]): { plugins: unknown[]; removed: boolean } {
    const plugins = entries.filter((entry) => {
        const name = extractPluginName(entry);
        return name ? !matchesPackageName(name, DCP_PACKAGE_NAMES) : true;
    });
    return { plugins, removed: plugins.length !== entries.length };
}

export function fixConflicts(directory: string, conflicts: ConflictResult["conflicts"]): string[] {
    const actions: string[] = [];
    let updatedCompaction = false;
    let removedDcpPlugin = false;
    let disabledOmoHooks = false;

    if (conflicts.compactionAuto || conflicts.compactionPrune || conflicts.dcpPlugin) {
        for (const configPath of collectOpenCodeConfigPaths(directory)) {
            const config = readConfig(configPath);
            if (!config) {
                continue;
            }

            let changed = false;

            if (conflicts.compactionAuto || conflicts.compactionPrune) {
                const compaction = isRecord(config.compaction) ? config.compaction : {};

                if (compaction.auto !== false) {
                    compaction.auto = false;
                    changed = true;
                    updatedCompaction = true;
                }

                if (compaction.prune !== false) {
                    compaction.prune = false;
                    changed = true;
                    updatedCompaction = true;
                }

                config.compaction = compaction;
            }

            if (conflicts.dcpPlugin) {
                const plugins = Array.isArray(config.plugin) ? config.plugin : [];
                const filtered = filterDcpPluginEntries(plugins);

                if (filtered.removed) {
                    config.plugin = filtered.plugins;
                    changed = true;
                    removedDcpPlugin = true;
                }
            }

            if (changed) {
                writeConfig(configPath, config);
            }
        }
    }

    if (
        conflicts.omoContextWindowMonitor ||
        conflicts.omoPreemptiveCompaction ||
        conflicts.omoAnthropicRecovery
    ) {
        const hooksToDisable = new Set<string>();
        if (conflicts.omoContextWindowMonitor) {
            hooksToDisable.add("context-window-monitor");
        }
        if (conflicts.omoPreemptiveCompaction) {
            hooksToDisable.add("preemptive-compaction");
        }
        if (conflicts.omoAnthropicRecovery) {
            hooksToDisable.add("anthropic-context-window-limit-recovery");
        }

        for (const configPath of collectOmoConfigPaths(directory)) {
            const config = readConfig(configPath);
            if (!config) {
                continue;
            }

            const disabledHooks = new Set(asStringArray(config.disabled_hooks));
            let changed = false;

            for (const hook of hooksToDisable) {
                if (!disabledHooks.has(hook)) {
                    disabledHooks.add(hook);
                    changed = true;
                    disabledOmoHooks = true;
                }
            }

            if (changed) {
                config.disabled_hooks = [
                    ...CONFLICTING_OMO_HOOKS.filter((hook) => disabledHooks.has(hook)),
                    ...[...disabledHooks].filter(
                        (hook) =>
                            !CONFLICTING_OMO_HOOKS.includes(
                                hook as (typeof CONFLICTING_OMO_HOOKS)[number],
                            ),
                    ),
                ];
                writeConfig(configPath, config);
            }
        }
    }

    if (updatedCompaction) {
        actions.push("Disabled auto-compaction");
    }

    if (removedDcpPlugin) {
        actions.push("Removed opencode-dcp plugin");
    }

    if (disabledOmoHooks) {
        actions.push("Disabled conflicting oh-my-opencode hooks");
    }

    return actions;
}
