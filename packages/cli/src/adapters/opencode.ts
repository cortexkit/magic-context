import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeJsoncArrayEntries } from "@magic-context/core/shared/jsonc-edit";
import {
    type OpenCodeHostGeneration,
    openCodeHostGenerationFromVersion,
    resolveOpenCodeDbPath,
} from "@magic-context/core/shared/opencode-db-path";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    type HostUseProbe,
    type HostUseProbeTargets,
    openCodeHostDatabaseFiles,
    removeOpenCodeV2PluginCacheSlot,
} from "../commands/doctor-opencode2-cache";
import { writeFileAtomic } from "../lib/atomic-write";
import { readJsoncTextForEdit } from "../lib/jsonc-config";
import { detectOpenCode } from "../lib/opencode-detect";
import { getOpenCodeVersion } from "../lib/opencode-helpers";
import {
    getOpenCodePluginPackageJsonPaths,
    getOpenCodeV2PluginCacheSlot,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
    readConfiguredOpenCodePluginSpec,
    readOpenCodeV2CachedPluginVersion,
} from "../lib/opencode-plugin-cache";
import {
    type OpenCodePluginConfigKey,
    pluginConfigKeyFor,
    readPluginEntries,
} from "../lib/opencode-plugin-registration";
import {
    detectConfigPaths,
    dirSizeBytes,
    getMagicContextLogPath,
    getOpenCodePluginCacheDir,
} from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheClearResult,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

export interface OpenCodeAdapterOptions {
    /**
     * Which config key a fresh registration is written under. OpenCode 2 reads
     * `plugins` natively and still loads the legacy `plugin` array, so the writer
     * must target the running host's own key or the plugin loads twice.
     */
    hostGeneration?: OpenCodeHostGeneration;
    /**
     * Asks which processes hold the host database or a cache slot open before
     * `doctor --clear` removes an OpenCode 2 slot. Defaults to `lsof`.
     */
    probeHostUse?: (targets: HostUseProbeTargets) => HostUseProbe;
}

export class OpenCodeAdapter implements HarnessAdapter {
    readonly kind = "opencode" as const;
    readonly displayName = "OpenCode";
    readonly pluginPackageName = PLUGIN_NAME;
    private hostGeneration: OpenCodeHostGeneration | undefined;
    private readonly probeHostUse: ((targets: HostUseProbeTargets) => HostUseProbe) | undefined;

    constructor(options: OpenCodeAdapterOptions = {}) {
        this.hostGeneration = options.hostGeneration;
        this.probeHostUse = options.probeHostUse;
    }

    /**
     * Resolved on first use, not at construction: the registry instantiates
     * adapters at import time and running `opencode --version` there would cost
     * every command a process spawn. A Desktop install without a runnable
     * bundled sidecar has no binary to version and counts as 1.x.
     */
    private get resolvedHostGeneration(): OpenCodeHostGeneration {
        if (this.hostGeneration) return this.hostGeneration;
        const detection = detectOpenCode();
        this.hostGeneration =
            detection.kind === "cli"
                ? openCodeHostGenerationFromVersion(getOpenCodeVersion(detection.binary))
                : "v1";
        return this.hostGeneration;
    }

    private get writeKey(): OpenCodePluginConfigKey {
        return pluginConfigKeyFor(this.resolvedHostGeneration);
    }

    isInstalled(): boolean {
        // A Desktop-only install (no CLI on PATH) still counts as installed:
        // OpenCode Desktop ships no invocable `opencode` binary, so a binary
        // check alone would wrongly report OpenCode as absent.
        return detectOpenCode().kind !== "none";
    }

    hasPluginEntry(): boolean {
        const paths = detectConfigPaths();
        if (paths.opencodeConfigFormat === "none") return false;
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const cfg = parseJsonc(raw) as Record<string, unknown> | null;
            return readPluginEntries(cfg).some(({ entry }) =>
                matchesPluginEntry(entry, PLUGIN_NAME),
            );
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
                    [this.writeKey]: [PLUGIN_ENTRY],
                };
                ensureDir(target);
                writeFileAtomic(target, `${JSON.stringify(initial, null, 4)}\n`);
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

            // Both keys are read: OpenCode 2 loads `plugin` and `plugins` together,
            // so an entry under either is a live registration.
            const entries = readPluginEntries(cfg);
            const existing = entries.find(({ entry }) => matchesPluginEntry(entry, PLUGIN_NAME));
            const existingDev = entries.find(({ entry }) =>
                isDevPathPluginEntry(entry, dirname(target)),
            );

            // Local dev-path entries are recognized so we don't double-add
            // an @latest entry on top, but they are NEVER replaced by setup.
            // Replacing a developer worktree path with the npm package would
            // silently swap their local plugin instance for the published
            // one — a surprising behavior change setup must avoid.
            if (!existing && !existingDev) {
                const list = Array.isArray(cfg[this.writeKey])
                    ? (cfg[this.writeKey] as unknown[])
                    : [];
                list.push(PLUGIN_ENTRY);
                cfg[this.writeKey] = list;
                writeFileAtomic(target, `${stringifyJsonc(cfg, null, 4)}\n`);
                return {
                    ok: true,
                    action: "added",
                    message: `Added ${PLUGIN_ENTRY} to ${target}.`,
                    configPath: target,
                };
            }

            if (existingDev) {
                const devEntry = String(existingDev.entry);
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin already present (dev path: ${devEntry}) in ${target}.`,
                    configPath: target,
                };
            }

            // Already present as an npm entry — check whether it's pinned to an old version.
            // The upgrade rewrites the entry in place, under the key it was found in.
            const found = existing as NonNullable<typeof existing>;
            const current = found.entry;
            if (typeof current === "string" && current !== PLUGIN_ENTRY) {
                (cfg[found.key] as unknown[])[found.index] = PLUGIN_ENTRY;
                writeFileAtomic(target, `${stringifyJsonc(cfg, null, 4)}\n`);
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
            if (cfg === null || typeof cfg !== "object") {
                return {
                    ok: true,
                    action: "already_present",
                    message: `No plugin array in ${target}.`,
                    configPath: target,
                };
            }
            // Edit the text rather than re-serializing the parsed config, so
            // comments inside the plugin arrays survive the removal.
            const document = readJsoncTextForEdit(target);
            let text = document.text;
            let removed = false;
            for (const key of ["plugin", "plugins"] as const) {
                if (!Array.isArray(cfg[key])) continue;
                const result = removeJsoncArrayEntries(text, [key], (entry) =>
                    matchesPluginEntry(entry, PLUGIN_NAME),
                );
                if (result.removed) {
                    text = result.text;
                    removed = true;
                }
            }
            if (!removed) {
                return {
                    ok: true,
                    action: "already_present",
                    message: `Plugin entry not present in ${target}.`,
                    configPath: target,
                };
            }
            writeFileAtomic(target, document.bom + text);
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

    /**
     * OpenCode 1 keeps plugins under `<cache>/opencode/packages/`; OpenCode 2
     * under `<cache>/opencode/npm/<name>@<spec>/`. Both can exist on one
     * machine, so each one present is reported. From the OpenCode 2 tree only
     * Magic Context's own `@latest` slot is offered: other packages' slots are
     * not ours to remove, and a dist-tag or pinned slot is what the user chose.
     */
    getPluginCacheInfo(): PluginCacheInfo[] {
        const legacyPath = getOpenCodePluginCacheDir();
        const legacyExists = existsSync(legacyPath);
        const slot = getOpenCodeV2PluginCacheSlot();
        const slotExists = existsSync(slot);
        const caches: PluginCacheInfo[] = [];
        // With neither present, the 1.x path is still reported (as missing) so
        // callers keep seeing where OpenCode's cache would be.
        if (legacyExists || !slotExists) {
            caches.push({
                path: legacyPath,
                exists: legacyExists,
                sizeBytes: dirSizeBytes(legacyPath),
                label: "OpenCode 1 plugin packages",
            });
        }
        if (slotExists) {
            caches.push({
                path: slot,
                exists: true,
                sizeBytes: dirSizeBytes(slot),
                label: "OpenCode 2 Magic Context @latest install",
                clear: () => this.clearOpenCodeV2Slot(slot),
            });
        }
        return caches;
    }

    /**
     * Same guard as `doctor --fix`: the slot stays while any process holds an
     * OpenCode session database (either host generation's) or a file in the
     * slot, or when that cannot be checked.
     */
    private clearOpenCodeV2Slot(slot: string): PluginCacheClearResult {
        let databases: string[];
        try {
            databases = [
                ...new Set([resolveOpenCodeDbPath("v1").path, resolveOpenCodeDbPath("v2").path]),
            ];
        } catch (err) {
            return {
                cleared: false,
                reason: `could not locate the OpenCode database to check whether OpenCode is running (${err instanceof Error ? err.message : String(err)})`,
            };
        }
        const removal = removeOpenCodeV2PluginCacheSlot(
            slot,
            openCodeHostDatabaseFiles(databases),
            {
                probe: this.probeHostUse,
            },
        );
        switch (removal.action) {
            case "cleared":
                return { cleared: true };
            case "in_use":
                return {
                    cleared: false,
                    reason: `OpenCode is running (pid ${removal.pids.join(", ")}); quit it (and \`opencode service stop\`) first`,
                };
            case "in_use_unknown":
                return { cleared: false, reason: removal.reason };
            case "error":
                return { cleared: false, reason: removal.error };
        }
    }

    getLogPath(): string {
        return getMagicContextLogPath("opencode");
    }

    /** The spec the config registers Magic Context under; `latest` when unreadable. */
    private configuredPluginSpec(): string {
        const paths = detectConfigPaths();
        if (paths.opencodeConfigFormat === "none") return "latest";
        try {
            const cfg = parseJsonc(readFileSync(paths.opencodeConfig, "utf-8")) as Record<
                string,
                unknown
            > | null;
            return readConfiguredOpenCodePluginSpec(cfg);
        } catch {
            return "latest";
        }
    }

    getInstalledPluginVersion(): string | null {
        if (this.resolvedHostGeneration === "v2") {
            // OpenCode 2 loads the slot keyed by the configured spec (`@latest`,
            // a dist-tag, or a pinned version); the 1.x tree is not read by it.
            const slot = getOpenCodeV2PluginCacheSlot(undefined, this.configuredPluginSpec());
            return readOpenCodeV2CachedPluginVersion(slot) ?? null;
        }
        // Look in OpenCode 1's plugin cache for the installed package version.
        for (const candidate of getOpenCodePluginPackageJsonPaths()) {
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
 * The package reference inside a plugin entry, whichever shape the host
 * accepts. OpenCode 1.x `plugin` entries are a string or a `[package, options]`
 * tuple; OpenCode 2 `plugins` entries are a string or a `{ package, options }`
 * object (core 2.0.11 decodes the legacy tuple into that object and
 * concatenates both lists). A matcher that only knows the tuple reads a native
 * v2 object entry as "not registered" and appends a duplicate.
 */
export function pluginEntryPackage(entry: unknown): string | null {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const pkg = (entry as { package?: unknown }).package;
        if (typeof pkg === "string") return pkg;
    }
    return null;
}

export function isLocalPathPluginEntry(entry: unknown): boolean {
    const candidate = pluginEntryPackage(entry);
    if (!candidate) return false;
    return (
        candidate.startsWith("file://") ||
        isAbsolute(candidate) ||
        candidate.startsWith("./") ||
        candidate.startsWith("../")
    );
}

/**
 * Match a local plugin entry only when its nearest package.json identifies the
 * OpenCode Magic Context package. `configDir` is the directory of the config
 * file the entry came from. A basename substring is not sufficient: paths
 * such as `magic-context-theme` must not suppress the real plugin registration.
 */
export function isDevPathPluginEntry(entry: unknown, configDir: string): boolean {
    const candidate = pluginEntryPackage(entry);
    if (!candidate || !isLocalPathPluginEntry(entry)) return false;

    let localPath: string;
    try {
        if (candidate.startsWith("file://")) {
            localPath = fileURLToPath(candidate);
        } else {
            // OpenCode resolves a relative entry against the directory of the
            // config file that declares it, so the CLI's working directory
            // must play no part (otherwise setup adds a second registration).
            localPath = resolve(configDir, candidate);
        }

        if (statSync(localPath).isFile()) localPath = dirname(localPath);
        const root = parsePath(localPath).root;
        while (localPath !== root) {
            const packagePath = resolve(localPath, "package.json");
            if (existsSync(packagePath)) {
                const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
                return pkg.name === PLUGIN_NAME;
            }
            localPath = dirname(localPath);
        }
    } catch {
        // An unreadable or unresolved path cannot prove that our plugin is installed.
    }
    return false;
}

/**
 * Match a plugin array entry against a package name. Plugin entries can be:
 *   - a string: "@cortexkit/opencode-magic-context@latest" or "@cortexkit/opencode-magic-context"
 *   - a tuple (OpenCode 1.x): ["@cortexkit/opencode-magic-context@latest", { ... options }]
 *   - an object (OpenCode 2): { package: "@cortexkit/opencode-magic-context@latest", options: { ... } }
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
    const candidate = pluginEntryPackage(entry);
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
