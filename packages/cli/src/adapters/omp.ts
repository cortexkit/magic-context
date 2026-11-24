import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCacheClearPath } from "../lib/cache-clear-path";
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
    getOmpPluginsLockPath,
    getOmpUserConfigPath,
    resolveOmpPaths,
} from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

export interface OmpAdapterDeps {
    detectOmpBinary: typeof detectOmpBinary;
    listOmpPlugins: typeof listOmpPlugins;
    runOmpCommand: typeof runOmpCommand;
}

const DEFAULT_DEPS: OmpAdapterDeps = {
    detectOmpBinary,
    listOmpPlugins,
    runOmpCommand,
};

export class OmpAdapter implements HarnessAdapter {
    readonly kind = "omp" as const;
    readonly displayName = "Oh My Pi (OMP)";
    readonly pluginPackageName = OMP_PLUGIN_PACKAGE;
    private readonly deps: OmpAdapterDeps;

    constructor(deps: Partial<OmpAdapterDeps> = {}) {
        this.deps = { ...DEFAULT_DEPS, ...deps };
    }

    isInstalled(): boolean {
        return this.deps.detectOmpBinary() !== null;
    }

    hasPluginEntry(): boolean {
        const omp = this.deps.detectOmpBinary();
        if (!omp) return false;
        return (
            this.deps
                .listOmpPlugins(omp.path)
                ?.some((plugin) => plugin.name === OMP_PLUGIN_PACKAGE && plugin.enabled) ?? false
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
        const omp = this.deps.detectOmpBinary();
        if (!omp) return this.errorResult(configPath, "OMP binary not found");
        const plugins = this.deps.listOmpPlugins(omp.path);
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
        const result = this.deps.runOmpCommand(omp.path, args, 120_000);
        if (!result.ok) {
            return this.errorResult(
                configPath,
                result.stderr || result.stdout || `omp ${args.join(" ")} failed`,
            );
        }
        const enabledAfter = this.deps
            .listOmpPlugins(omp.path)
            ?.some((plugin) => plugin.name === OMP_PLUGIN_PACKAGE && plugin.enabled);
        if (!enabledAfter) {
            // A project override can keep the plugin disabled even when the
            // global install/enable command exits 0. New installs are removed.
            // Existing installs restore the exact lockfile enable state; never
            // infer global state from the project-effective plugin list.
            if (!installed) {
                this.deps.runOmpCommand(
                    omp.path,
                    ["plugin", "uninstall", OMP_PLUGIN_PACKAGE],
                    120_000,
                );
            } else if (originalRuntimeEnabled !== undefined) {
                this.deps.runOmpCommand(
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
        const omp = this.deps.detectOmpBinary();
        if (!omp) return this.errorResult(configPath, "OMP binary not found");
        const plugins = this.deps.listOmpPlugins(omp.path);
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
        const result = this.deps.runOmpCommand(
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

    getPluginCacheInfo(): PluginCacheInfo[] {
        const { dataRoot, pluginsDir } = resolveOmpPaths();
        const path = join(pluginsDir, "cache");
        const check = checkCacheClearPath(dataRoot, path);
        return [
            {
                path,
                cacheRoot: dataRoot,
                exists: check.allowed || check.reason !== "missing",
                sizeBytes: check.allowed ? dirSizeBytes(check.path) : 0,
            },
        ];
    }

    getLogPath(): string {
        return getMagicContextLogPath("omp");
    }

    getInstalledPluginVersion(): string | null {
        const omp = this.deps.detectOmpBinary();
        if (!omp) return null;
        return (
            this.deps.listOmpPlugins(omp.path)?.find((plugin) => plugin.name === OMP_PLUGIN_PACKAGE)
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
