import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    detectConfigPaths,
    dirSizeBytes,
    getMagicContextLogPath,
    getOpenCodePluginCacheDir,
} from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY = `${PLUGIN_NAME}@latest`;

export class OpenCodeAdapter implements HarnessAdapter {
    readonly kind = "opencode" as const;
    readonly displayName = "OpenCode";
    readonly pluginPackageName = PLUGIN_NAME;

    isInstalled(): boolean {
        // Stock OpenCode install location takes priority. Use os.homedir()
        // (not process.env.HOME) and OS-specific binary name so this works
        // on Windows where HOME is typically undefined and binaries end in
        // `.exe`.
        const isWindows = process.platform === "win32";
        const stockBin = isWindows
            ? join(homedir(), ".opencode", "bin", "opencode.exe")
            : join(homedir(), ".opencode", "bin", "opencode");
        if (existsSync(stockBin)) return true;

        // Probe PATH. `command -v` is a Bash builtin that doesn't exist in
        // PowerShell/CMD; use `where.exe opencode` on Windows. Both forms
        // exit non-zero when the binary is absent, which is our cue.
        const probe = isWindows
            ? { cmd: "where", args: ["opencode"] }
            : { cmd: "command", args: ["-v", "opencode"] };
        try {
            // Note: on POSIX, `command -v` is a shell builtin and execFileSync
            // can't run it directly. Fall back to a real binary lookup via
            // `which` instead.
            if (!isWindows) {
                execFileSync("which", ["opencode"], { stdio: "ignore" });
            } else {
                execFileSync(probe.cmd, probe.args, { stdio: "ignore" });
            }
            return true;
        } catch {
            return false;
        }
    }

    hasPluginEntry(): boolean {
        const paths = detectConfigPaths();
        if (paths.opencodeConfigFormat === "none") return false;
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            const plugin = cfg?.plugin;
            if (!Array.isArray(plugin)) return false;
            return plugin.some((entry) => matchesPluginEntry(entry, PLUGIN_NAME));
        } catch {
            return false;
        }
    }

    getConfigPaths(): HarnessConfigPaths {
        const paths = detectConfigPaths();
        return {
            configDir: paths.configDir,
            pluginConfigPath: paths.opencodeConfig,
            magicContextConfigPath: paths.magicContextConfig,
            secondaryConfigPath: paths.tuiConfig,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const paths = detectConfigPaths();
        const target = paths.opencodeConfig;
        try {
            const exists = paths.opencodeConfigFormat !== "none";
            if (!exists) {
                // Brand-new opencode.jsonc with our plugin entry.
                const initial = {
                    $schema: "https://opencode.ai/config.json",
                    plugin: [PLUGIN_ENTRY],
                };
                ensureDir(target);
                writeFileSync(target, `${JSON.stringify(initial, null, 4)}\n`);
                return {
                    ok: true,
                    action: "added",
                    message: `Created ${target} with plugin entry.`,
                    configPath: target,
                };
            }

            const raw = readFileSync(target, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            if (cfg === null || typeof cfg !== "object") {
                return {
                    ok: false,
                    action: "error",
                    message: `Could not parse ${target}.`,
                    configPath: target,
                };
            }

            const plugin = Array.isArray(cfg.plugin) ? cfg.plugin : [];
            const existingIdx = plugin.findIndex((e) => matchesPluginEntry(e, PLUGIN_NAME));
            const existingDevIdx = plugin.findIndex((e) => isDevPathPluginEntry(e));

            // Local dev-path entries are recognized so we don't double-add
            // an @latest entry on top, but they are NEVER replaced by setup.
            // Replacing a developer worktree path with the npm package would
            // silently swap their local plugin instance for the published
            // one — a surprising behavior change setup must avoid.
            if (existingIdx === -1 && existingDevIdx === -1) {
                plugin.push(PLUGIN_ENTRY);
                cfg.plugin = plugin;
                writeFileSync(target, `${stringifyJsonc(cfg, null, 4)}\n`);
                return {
                    ok: true,
                    action: "added",
                    message: `Added ${PLUGIN_ENTRY} to ${target}.`,
                    configPath: target,
                };
            }

            if (existingDevIdx !== -1) {
                const devEntry = String(plugin[existingDevIdx]);
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin already present (dev path: ${devEntry}) in ${target}.`,
                    configPath: target,
                };
            }

            // Already present as an npm entry — check whether it's pinned to an old version.
            const current = plugin[existingIdx];
            if (typeof current === "string" && current !== PLUGIN_ENTRY) {
                plugin[existingIdx] = PLUGIN_ENTRY;
                cfg.plugin = plugin;
                writeFileSync(target, `${stringifyJsonc(cfg, null, 4)}\n`);
                return {
                    ok: true,
                    action: "updated",
                    message: `Updated plugin entry to ${PLUGIN_ENTRY} in ${target}.`,
                    configPath: target,
                };
            }

            return {
                ok: true,
                action: "already_present",
                message: `Plugin entry already present in ${target}.`,
                configPath: target,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${target}: ${(err as Error).message}`,
                configPath: target,
            };
        }
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const paths = detectConfigPaths();
        const target = paths.opencodeConfig;
        if (paths.opencodeConfigFormat === "none") {
            return {
                ok: true,
                action: "already_present",
                message: `No ${target} to remove from.`,
                configPath: target,
            };
        }
        try {
            const raw = readFileSync(target, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            if (cfg === null || typeof cfg !== "object" || !Array.isArray(cfg.plugin)) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `No plugin array in ${target}.`,
                    configPath: target,
                };
            }
            const pluginArr = cfg.plugin as unknown[];
            const before = pluginArr.length;
            cfg.plugin = pluginArr.filter((e) => !matchesPluginEntry(e, PLUGIN_NAME));
            if ((cfg.plugin as unknown[]).length === before) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin entry not present in ${target}.`,
                    configPath: target,
                };
            }
            writeFileSync(target, `${stringifyJsonc(cfg, null, 4)}\n`);
            return {
                ok: true,
                action: "updated",
                message: `Removed ${PLUGIN_NAME} from ${target}.`,
                configPath: target,
            };
        } catch (err) {
            return {
                ok: false,
                action: "error",
                message: `Failed to update ${target}: ${(err as Error).message}`,
                configPath: target,
            };
        }
    }

    getInstallHint(): string {
        return "Install OpenCode: curl -fsSL https://opencode.ai/install | bash";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        const path = getOpenCodePluginCacheDir();
        return {
            path,
            exists: existsSync(path),
            sizeBytes: dirSizeBytes(path),
        };
    }

    getLogPath(): string {
        return getMagicContextLogPath();
    }

    getInstalledPluginVersion(): string | null {
        // Look in OpenCode's plugin cache for the installed package version.
        const cacheDir = getOpenCodePluginCacheDir();
        const candidates = [
            `${cacheDir}/${PLUGIN_NAME}@latest/node_modules/${PLUGIN_NAME}/package.json`,
            `${cacheDir}/${PLUGIN_NAME}/node_modules/${PLUGIN_NAME}/package.json`,
        ];
        for (const candidate of candidates) {
            if (!existsSync(candidate)) continue;
            try {
                const raw = readFileSync(candidate, "utf-8");
                const pkg = JSON.parse(raw) as { version?: string };
                if (typeof pkg.version === "string") return pkg.version;
            } catch {
                // try next
            }
        }
        return null;
    }
}

/**
 * Match a plugin entry that resolves to a local dev checkout of magic-context:
 *   - "file:///abs/path/.../opencode-magic-context"
 *   - "/abs/path/.../opencode-magic-context/packages/plugin"
 *   - "./relative/path/.../opencode-magic-context"
 *
 * Tuple entries `["file://...", { options }]` are also recognized.
 *
 * Setup and doctor must detect these so they don't double-add @latest, but
 * must NEVER replace them — that would silently disable the developer's
 * local plugin instance.
 *
 * Exported because both `setup-opencode.ts` and `doctor-opencode.ts` need this
 * exact same logic; previous duplication caused drift (e.g. one path matching
 * `opencode-magic-context` only, the other also matching bare `magic-context`).
 */
export function isDevPathPluginEntry(entry: unknown): boolean {
    let candidate: string | null = null;
    if (typeof entry === "string") candidate = entry;
    else if (Array.isArray(entry) && typeof entry[0] === "string") candidate = entry[0];
    if (!candidate) return false;
    const isPath =
        candidate.startsWith("file://") || candidate.startsWith("/") || candidate.startsWith("./");
    if (!isPath) return false;
    return candidate.includes("opencode-magic-context") || candidate.includes("magic-context");
}

/**
 * Match a plugin array entry against a package name. Plugin entries can be:
 *   - a string: "@cortexkit/opencode-magic-context@latest" or "@cortexkit/opencode-magic-context"
 *   - a tuple: ["@cortexkit/opencode-magic-context@latest", { ... options }]
 *   - a file URL: "file:///path/to/local/dev/checkout"
 *
 * For matching purposes we strip everything after `@` (after the first `@org/pkg`
 * segment) so versioned and unversioned entries are equivalent.
 *
 * Returns false for `file://` entries so dev paths are not classified as
 * "the published plugin". Use `isDevPathPluginEntry` for that detection.
 *
 * Exported for reuse across setup and doctor flows.
 */
export function matchesPluginEntry(entry: unknown, pkgName: string): boolean {
    let candidate: string | null = null;
    if (typeof entry === "string") candidate = entry;
    else if (Array.isArray(entry) && typeof entry[0] === "string") candidate = entry[0];
    if (!candidate) return false;
    if (candidate.startsWith("file://")) return false;
    // Strip version tag: "@cortexkit/foo@latest" → "@cortexkit/foo"
    const at = candidate.lastIndexOf("@");
    const head = at > 0 ? candidate.slice(0, at) : candidate;
    return head === pkgName;
}

function ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        const { mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(dir, { recursive: true });
    }
}
