import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";

import {
    type ConflictResult,
    DCP_PACKAGE_NAMES,
    extractPluginName,
    matchesPackageName,
} from "./conflict-detector";
import { appendJsoncArrayValues, removeJsoncArrayEntries, setJsoncValue } from "./jsonc-edit";
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

/** Unified OMO config names (oh-my-openagent >= 4.19.0) */
const OMO_UNIFIED_NAMES = ["omo.jsonc", "omo.json"] as const;

function isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

interface JsonConfigDocument {
    config: JsonObject;
    text: string;
}

function readConfig(filePath: string): JsonConfigDocument | null {
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const text = readFileSync(filePath, "utf-8");
        const parsed = parse(text);
        return isRecord(parsed) ? { config: parsed, text } : null;
    } catch {
        return null;
    }
}

function writeConfig(filePath: string, text: string): void {
    writeFileSync(filePath, text);
}

function resolveUserOpenCodeConfigPath(): string {
    const paths = getOpenCodeConfigPaths({ binary: "opencode" });
    if (existsSync(paths.configJsonc)) return paths.configJsonc;
    return paths.configJson;
}

export function projectOpenCodeConfigPaths(directory: string): string[] {
    return [
        join(directory, ".opencode", "opencode.jsonc"),
        join(directory, ".opencode", "opencode.json"),
        join(directory, "opencode.jsonc"),
        join(directory, "opencode.json"),
    ];
}

function collectOpenCodeConfigPaths(directory: string): string[] {
    const paths = new Set<string>();
    const userConfig = resolveUserOpenCodeConfigPath();

    if (existsSync(userConfig)) {
        paths.add(userConfig);
    }

    for (const filePath of projectOpenCodeConfigPaths(directory)) {
        if (existsSync(filePath)) {
            paths.add(filePath);
        }
    }

    return [...paths];
}

function collectOmoConfigPaths(directory: string): string[] {
    const paths = new Set<string>();
    const configDir = getOpenCodeConfigPaths({ binary: "opencode" }).configDir;

    // Legacy OMO config names in the OpenCode config dir and project dir
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

    // New unified omo.jsonc (oh-my-openagent >= 4.19.0)
    // User-level: ~/.omo/omo.jsonc (fallback ~/.omo/omo.json)
    const homeDir = process.env.HOME || homedir();
    const omoHomeDir = join(homeDir, ".omo");
    for (const name of OMO_UNIFIED_NAMES) {
        const userPath = join(omoHomeDir, name);
        if (existsSync(userPath)) {
            paths.add(userPath);
        }
    }

    // Project-level: .omo/omo.jsonc (fallback .omo/omo.json)
    for (const name of OMO_UNIFIED_NAMES) {
        const projectPath = join(directory, ".omo", name);
        if (existsSync(projectPath)) {
            paths.add(projectPath);
        }
    }

    return [...paths];
}

/** Check if a config path is a unified omo.json(c) path (not legacy). */
function isUnifiedOmoPath(configPath: string): boolean {
    const basename = configPath.split("/").pop() ?? "";
    return basename === "omo.jsonc" || basename === "omo.json";
}

function disableCompactionFlags(
    text: string,
    config: JsonObject,
): { text: string; changed: boolean } {
    if (!isRecord(config.compaction)) {
        return {
            text: setJsoncValue(text, ["compaction"], { auto: false, prune: false }),
            changed: true,
        };
    }

    let updated = text;
    let changed = false;
    if (config.compaction.auto !== false) {
        updated = setJsoncValue(updated, ["compaction", "auto"], false);
        changed = true;
    }
    if (config.compaction.prune !== false) {
        updated = setJsoncValue(updated, ["compaction", "prune"], false);
        changed = true;
    }
    return { text: updated, changed };
}

/**
 * Options for {@link fixConflicts}.
 *
 * `compactionEnabled` is the boot-resolved MC compaction mode (the result of
 * {@link isCompactionEnabled} on the resolved user-tier config). When `false`
 * (compaction-off mode), the fixer MUST NOT flip `compaction.auto`/`prune` to
 * `false` — native compaction fields are left byte-for-byte as found, because
 * native compaction (or nothing) is the user's chosen window manager. DCP and
 * OMO hook fixes keep their existing policy in BOTH modes.
 *
 * Default `true` (mode-on) preserves today's fix behavior for call sites that
 * cannot supply the resolved mode; they fail toward mode-on, never silently
 * skipping the fix.
 */
export interface FixConflictsOptions {
    compactionEnabled?: boolean;
}

export function fixConflicts(
    directory: string,
    conflicts: ConflictResult["conflicts"],
    options?: FixConflictsOptions,
): string[] {
    const compactionEnabled = options?.compactionEnabled ?? true;
    const actions: string[] = [];
    let updatedCompaction = false;
    let removedDcpPlugin = false;
    let disabledOmoHooks = false;

    // Native compaction fields are repaired ONLY when MC compaction is ON. In
    // compaction-off mode the fixer must not rewrite compaction.auto/prune —
    // native compaction is the intended manager and pre-existing values are
    // left byte-for-byte as found.
    const repairCompaction =
        compactionEnabled && (conflicts.compactionAuto || conflicts.compactionPrune);

    if (repairCompaction || conflicts.dcpPlugin) {
        for (const configPath of collectOpenCodeConfigPaths(directory)) {
            const document = readConfig(configPath);
            if (!document) {
                continue;
            }

            let text = document.text;
            let changed = false;

            if (repairCompaction) {
                const result = disableCompactionFlags(text, document.config);
                if (result.changed) {
                    text = result.text;
                    changed = true;
                    updatedCompaction = true;
                }
            }

            if (conflicts.dcpPlugin) {
                const result = removeJsoncArrayEntries(text, ["plugin"], (entry) => {
                    const name = extractPluginName(entry);
                    return name ? matchesPackageName(name, DCP_PACKAGE_NAMES) : false;
                });
                if (result.removed) {
                    text = result.text;
                    changed = true;
                    removedDcpPlugin = true;
                }
            }

            if (changed) {
                writeConfig(configPath, text);
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
            const document = readConfig(configPath);
            if (!document) {
                continue;
            }

            const unifiedPath = isUnifiedOmoPath(configPath);
            const target =
                unifiedPath && isRecord(document.config["[opencode]"])
                    ? document.config["[opencode]"]
                    : unifiedPath
                      ? {}
                      : document.config;
            const disabledHooks = new Set(asStringArray(target.disabled_hooks));
            const hooksToAdd = CONFLICTING_OMO_HOOKS.filter(
                (hook) => hooksToDisable.has(hook) && !disabledHooks.has(hook),
            );

            if (hooksToAdd.length > 0) {
                const path = unifiedPath ? ["[opencode]", "disabled_hooks"] : ["disabled_hooks"];
                const text = Array.isArray(target.disabled_hooks)
                    ? appendJsoncArrayValues(document.text, path, hooksToAdd)
                    : setJsoncValue(document.text, path, hooksToAdd);
                writeConfig(configPath, text);
                disabledOmoHooks = true;
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
