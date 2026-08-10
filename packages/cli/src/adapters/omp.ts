import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    detectOmpBinary,
    listOmpPlugins,
    OMP_PLUGIN_PACKAGE,
    runOmpCommand,
} from "../lib/omp-helpers";
import {
    dirSizeBytes,
    getMagicContextLogPath,
    getOmpAgentDir,
    getOmpPluginsDir,
    getOmpPluginsLockPath,
    getOmpUserConfigPath,
} from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

export class OmpAdapter implements HarnessAdapter {
    readonly kind = "omp" as const;
    readonly displayName = "Oh My Pi (OMP)";
    readonly pluginPackageName = OMP_PLUGIN_PACKAGE;

    isInstalled(): boolean {
        return detectOmpBinary() !== null;
    }

    hasPluginEntry(): boolean {
        const omp = detectOmpBinary();
        if (!omp) return false;
        return (
            listOmpPlugins(omp.path)?.some(
                (plugin) => plugin.name === OMP_PLUGIN_PACKAGE && plugin.enabled,
            ) ?? false
        );
    }

    getConfigPaths(): HarnessConfigPaths {
        return {
            configDir: getOmpAgentDir(),
            pluginConfigPath: getOmpPluginsLockPath(),
            magicContextConfigPath: getOmpUserConfigPath(),
            secondaryConfigPath: null,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const configPath = getOmpPluginsLockPath();
        const omp = detectOmpBinary();
        if (!omp) return this.errorResult(configPath, "OMP binary not found");
        const plugins = listOmpPlugins(omp.path);
        if (plugins === null) {
            return this.errorResult(configPath, "`omp plugin list --json` failed");
        }
        const installed = plugins.find((plugin) => plugin.name === OMP_PLUGIN_PACKAGE);
        if (installed?.enabled) {
            return {
                ok: true,
                action: "already_present",
                message: `${OMP_PLUGIN_PACKAGE} is already enabled in OMP.`,
                configPath,
            };
        }
        const originalRuntimeEnabled = this.readRuntimeEnabled(configPath);

        const args = installed
            ? ["plugin", "enable", OMP_PLUGIN_PACKAGE]
            : ["plugin", "install", OMP_PLUGIN_PACKAGE];
        const result = runOmpCommand(omp.path, args, 120_000);
        if (!result.ok) {
            return this.errorResult(
                configPath,
                result.stderr || result.stdout || `omp ${args.join(" ")} failed`,
            );
        }
        const enabledAfter = listOmpPlugins(omp.path)?.some(
            (plugin) => plugin.name === OMP_PLUGIN_PACKAGE && plugin.enabled,
        );
        if (!enabledAfter) {
            // A project override can keep the plugin disabled even when the
            // global install/enable command exits 0. New installs are removed.
            // Existing installs restore the exact lockfile enable state; never
            // infer global state from the project-effective plugin list.
            if (!installed) {
                runOmpCommand(omp.path, ["plugin", "uninstall", OMP_PLUGIN_PACKAGE], 120_000);
            } else if (originalRuntimeEnabled !== undefined) {
                runOmpCommand(
                    omp.path,
                    ["plugin", originalRuntimeEnabled ? "enable" : "disable", OMP_PLUGIN_PACKAGE],
                    120_000,
                );
            }
            return this.errorResult(
                configPath,
                `${OMP_PLUGIN_PACKAGE} is still disabled in the current project after \`omp ${args.join(" ")}\``,
            );
        }
        return {
            ok: true,
            action: installed ? "updated" : "added",
            message: installed
                ? `Enabled ${OMP_PLUGIN_PACKAGE} in OMP.`
                : `Installed ${OMP_PLUGIN_PACKAGE} in OMP.`,
            configPath,
        };
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const configPath = getOmpPluginsLockPath();
        const omp = detectOmpBinary();
        if (!omp) return this.errorResult(configPath, "OMP binary not found");
        const plugins = listOmpPlugins(omp.path);
        if (plugins === null) {
            return this.errorResult(configPath, "`omp plugin list --json` failed");
        }
        const installed = plugins.some((plugin) => plugin.name === OMP_PLUGIN_PACKAGE);
        if (!installed) {
            return {
                ok: true,
                action: "already_present",
                message: `${OMP_PLUGIN_PACKAGE} is not installed in OMP.`,
                configPath,
            };
        }
        const result = runOmpCommand(
            omp.path,
            ["plugin", "uninstall", OMP_PLUGIN_PACKAGE],
            120_000,
        );
        if (!result.ok) {
            return this.errorResult(
                configPath,
                result.stderr || result.stdout || "OMP plugin uninstall failed",
            );
        }
        return {
            ok: true,
            action: "updated",
            message: `Uninstalled ${OMP_PLUGIN_PACKAGE} from OMP.`,
            configPath,
        };
    }

    getInstallHint(): string {
        return "Install OMP: https://omp.sh (npm: @oh-my-pi/pi-coding-agent)";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        const path = join(getOmpPluginsDir(), "cache");
        return { path, exists: existsSync(path), sizeBytes: dirSizeBytes(path) };
    }

    getLogPath(): string {
        // OMP executes the Pi-compatible runtime, which intentionally keeps the
        // existing `pi` DB/log discriminator for cross-host session semantics.
        return getMagicContextLogPath("pi");
    }

    getInstalledPluginVersion(): string | null {
        const omp = detectOmpBinary();
        if (!omp) return null;
        return (
            listOmpPlugins(omp.path)?.find((plugin) => plugin.name === OMP_PLUGIN_PACKAGE)
                ?.version ?? null
        );
    }

    private readRuntimeEnabled(configPath: string): boolean | undefined {
        try {
            const lock = JSON.parse(readFileSync(configPath, "utf-8")) as {
                plugins?: Record<string, { enabled?: unknown }>;
            };
            const enabled = lock.plugins?.[OMP_PLUGIN_PACKAGE]?.enabled;
            return typeof enabled === "boolean" ? enabled : undefined;
        } catch {
            return undefined;
        }
    }

    private errorResult(configPath: string, message: string): PluginEntryResult {
        return {
            ok: false,
            action: "error",
            message: `Failed to configure OMP: ${message}`,
            configPath,
        };
    }
}
