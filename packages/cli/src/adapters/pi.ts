import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { getMagicContextLogPath, getPiAgentConfigDir, getPiUserExtensionsPath } from "../lib/paths";
import { detectPiBinary, PI_PACKAGE_SOURCE } from "../lib/pi-helpers";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

const PLUGIN_NAME = "@cortexkit/pi-magic-context";
const SETTINGS_BASENAME = "settings.json";

export class PiAdapter implements HarnessAdapter {
    readonly kind = "pi" as const;
    readonly displayName = "Pi";
    readonly pluginPackageName = PLUGIN_NAME;

    isInstalled(): boolean {
        return detectPiBinary() !== null;
    }

    hasPluginEntry(): boolean {
        const settings = readPiSettings();
        if (!settings) return false;
        const packages = (settings.packages ?? []) as unknown[];
        return packages.some((entry) => matchesPiPackage(entry));
    }

    getConfigPaths(): HarnessConfigPaths {
        const dir = getPiAgentConfigDir();
        return {
            configDir: dir,
            pluginConfigPath: getPiUserExtensionsPath(),
            magicContextConfigPath: `${dir}/magic-context.jsonc`,
            secondaryConfigPath: null,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const settingsPath = getPiUserExtensionsPath();
        try {
            const settings = readPiSettings() ?? {};
            const packages = Array.isArray(settings.packages)
                ? (settings.packages as unknown[])
                : [];

            const idx = packages.findIndex((entry) => matchesPiPackage(entry));
            if (idx === -1) {
                packages.push(PI_PACKAGE_SOURCE);
                settings.packages = packages;
                writePiSettings(settings);
                return {
                    ok: true,
                    action: "added",
                    message: `Added ${PI_PACKAGE_SOURCE} to ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            return {
                ok: true,
                action: "already_present",
                message: `Plugin entry already present in ${settingsPath}.`,
                configPath: settingsPath,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${settingsPath}: ${(err as Error).message}`,
                configPath: settingsPath,
            };
        }
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const settingsPath = getPiUserExtensionsPath();
        try {
            const settings = readPiSettings();
            if (!settings || !Array.isArray(settings.packages)) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `No packages array in ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            const before = settings.packages.length;
            settings.packages = settings.packages.filter(
                (entry: unknown) => !matchesPiPackage(entry),
            );
            if (settings.packages.length === before) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin entry not present in ${settingsPath}.`,
                    configPath: settingsPath,
                };
            }
            writePiSettings(settings);
            return {
                ok: true,
                action: "updated",
                message: `Removed ${PLUGIN_NAME} from ${settingsPath}.`,
                configPath: settingsPath,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${settingsPath}: ${(err as Error).message}`,
                configPath: settingsPath,
            };
        }
    }

    getInstallHint(): string {
        return "Install Pi: https://pi.coding/install (npm: @earendil-works/pi-coding-agent)";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        // Pi doesn't have a separate user-level plugin cache the way OpenCode
        // does — it shells out to npm at install time. Reporting as "no cache"
        // means doctor --clear will skip Pi cleanup, which is the correct
        // behavior since there's nothing for us to safely clear.
        return { path: null, exists: false, sizeBytes: 0 };
    }

    getLogPath(): string {
        return getMagicContextLogPath("pi");
    }

    getInstalledPluginVersion(): string | null {
        // Try to ask Pi for the package version.
        const piBin = detectPiBinary();
        if (!piBin) return null;
        try {
            const output = execFileSync(piBin.path, ["list"], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 5000,
            });
            // Pi's `list` output line shape varies; look for our package name
            // followed by a version number. Conservative — return null on
            // parse failure rather than risk wrong output.
            const re = new RegExp(
                `${PLUGIN_NAME.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}.*?(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)`,
            );
            const match = re.exec(output);
            if (match) return match[1] ?? null;
        } catch {
            // Pi binary might not support `list`, or call timed out.
        }
        return null;
    }
}

interface PiSettingsLike {
    packages?: unknown[];
    [k: string]: unknown;
}

function readPiSettings(): PiSettingsLike | null {
    const settingsPath = getPiUserExtensionsPath();
    if (!existsSync(settingsPath)) return null;
    try {
        const raw = readFileSync(settingsPath, "utf-8");
        const parsed = parseJsonc(raw) as PiSettingsLike | null;
        return parsed;
    } catch {
        return null;
    }
}

function writePiSettings(settings: PiSettingsLike): void {
    const settingsPath = getPiUserExtensionsPath();
    ensureDir(settingsPath);
    const text = stringifyJsonc(settings, null, 2);
    writeFileSync(settingsPath, `${text}\n`);
}

/**
 * Match a Pi packages array entry against our plugin source.
 *
 * Pi `packages` entries are sources like:
 *   - "npm:@cortexkit/pi-magic-context"
 *   - "npm:@cortexkit/pi-magic-context@1.0.0"
 *   - { name: "@cortexkit/pi-magic-context", source: "npm:..." }
 *   - "file:/path/to/local/dev"
 *
 * We accept anything that resolves to our package name. Local file paths
 * are intentionally NOT considered the same entry — a user installing the
 * published plugin while pointing at a local dev checkout is two separate
 * entries by design (so dev installs don't get silently overridden).
 */
function matchesPiPackage(entry: unknown): boolean {
    if (typeof entry === "string") {
        if (entry.startsWith("file:")) return false;
        return entry.includes(PLUGIN_NAME);
    }
    if (entry !== null && typeof entry === "object") {
        const obj = entry as { name?: unknown; source?: unknown };
        if (typeof obj.name === "string" && obj.name === PLUGIN_NAME) return true;
        if (typeof obj.source === "string") return matchesPiPackage(obj.source);
    }
    return false;
}

function ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        const { mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(dir, { recursive: true });
    }
}

// SETTINGS_BASENAME is exported for tests that need it.
export { SETTINGS_BASENAME };
