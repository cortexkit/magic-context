import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "comment-json";

import { log } from "../../shared/logger";
import {
    CACHE_DIR,
    NPM_FETCH_TIMEOUT,
    NPM_REGISTRY_URL,
    PACKAGE_NAME,
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
} from "./constants";
import {
    NpmPackageEnvelopeSchema,
    OpencodeConfigSchema,
    PackageJsonSchema,
    type PluginEntryInfo,
} from "./types";

function warn(message: string): void {
    log(`WARN: ${message}`);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function pluginSpecifier(entry: string | readonly [string, Record<string, unknown>]): string {
    return typeof entry === "string" ? entry : entry[0];
}

function getPluginEntries(config: unknown): string[] {
    const parsed = OpencodeConfigSchema.safeParse(config);
    if (!parsed.success) return [];
    return (parsed.data.plugin ?? []).map(pluginSpecifier).filter(isString);
}

function parseJsonConfig(content: string): unknown | null {
    try {
        return parseJsonc(content);
    } catch (err) {
        warn(`[auto-update-checker] Failed to parse OpenCode config: ${String(err)}`);
        return null;
    }
}

function isPrereleaseVersion(version: string): boolean {
    return version.includes("-");
}

function isDistTag(version: string): boolean {
    return !/^\d/.test(version);
}

export function extractChannel(version: string | null): string {
    if (!version) return "latest";

    if (isDistTag(version)) return version;

    if (isPrereleaseVersion(version)) {
        const prereleasePart = version.split("-")[1];
        const channelMatch = prereleasePart?.match(/^(alpha|beta|rc|canary|next)/);
        if (channelMatch?.[1]) return channelMatch[1];
    }

    return "latest";
}

function getConfigPaths(directory: string): string[] {
    return [
        join(directory, ".opencode", "opencode.json"),
        join(directory, ".opencode", "opencode.jsonc"),
        USER_OPENCODE_CONFIG,
        USER_OPENCODE_CONFIG_JSONC,
    ];
}

function resolvePathPluginSpec(spec: string, configPath: string): string {
    if (spec.startsWith("file://")) {
        try {
            return fileURLToPath(spec);
        } catch {
            return spec.replace(/^file:\/\//, "");
        }
    }
    if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return spec;
    return resolve(dirname(configPath), spec);
}

function findPackageJsonUp(startPath: string): string | null {
    try {
        const stat = statSync(startPath);
        let dir = stat.isDirectory() ? startPath : dirname(startPath);

        for (let i = 0; i < 10; i++) {
            const pkgPath = join(dir, "package.json");
            if (existsSync(pkgPath)) {
                try {
                    const pkg = PackageJsonSchema.safeParse(
                        JSON.parse(readFileSync(pkgPath, "utf-8")),
                    );
                    if (pkg.success && pkg.data.name === PACKAGE_NAME) return pkgPath;
                } catch {
                    // Continue walking upward.
                }
            }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch {
        // Missing path or unreadable package metadata.
    }
    return null;
}

function getLocalDevPath(directory: string): string | null {
    for (const configPath of getConfigPaths(directory)) {
        try {
            if (!existsSync(configPath)) continue;
            const rawConfig = parseJsonConfig(readFileSync(configPath, "utf-8"));
            const plugins = getPluginEntries(rawConfig);

            for (const entry of plugins) {
                if (entry === PACKAGE_NAME || entry.startsWith(`${PACKAGE_NAME}@`)) continue;
                if (entry.startsWith("file://") || entry.startsWith(".") || isAbsolute(entry)) {
                    const localPath = resolvePathPluginSpec(entry, configPath);
                    const pkgPath = findPackageJsonUp(localPath);
                    if (!pkgPath) continue;
                    const pkg = PackageJsonSchema.safeParse(
                        JSON.parse(readFileSync(pkgPath, "utf-8")),
                    );
                    if (pkg.success && pkg.data.name === PACKAGE_NAME) return localPath;
                }
            }
        } catch {
            // Config probing must never block plugin startup.
        }
    }
    return null;
}

export function getLocalDevVersion(directory: string): string | null {
    const localPath = getLocalDevPath(directory);
    if (!localPath) return null;

    try {
        const pkgPath = findPackageJsonUp(localPath);
        if (!pkgPath) return null;
        const pkg = PackageJsonSchema.safeParse(JSON.parse(readFileSync(pkgPath, "utf-8")));
        return pkg.success ? (pkg.data.version ?? null) : null;
    } catch {
        return null;
    }
}

export function getCurrentRuntimePackageJsonPath(
    currentModuleUrl: string = import.meta.url,
): string | null {
    try {
        return findPackageJsonUp(dirname(fileURLToPath(currentModuleUrl)));
    } catch (err) {
        warn(`[auto-update-checker] Failed to resolve runtime package path: ${String(err)}`);
        return null;
    }
}

export function findPluginEntry(directory: string): PluginEntryInfo | null {
    for (const configPath of getConfigPaths(directory)) {
        try {
            if (!existsSync(configPath)) continue;
            const rawConfig = parseJsonConfig(readFileSync(configPath, "utf-8"));
            const plugins = getPluginEntries(rawConfig);

            for (const entry of plugins) {
                if (entry === PACKAGE_NAME) {
                    return { entry, isPinned: false, pinnedVersion: null, configPath };
                }
                if (entry.startsWith(`${PACKAGE_NAME}@`)) {
                    const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1);
                    const isPinned = pinnedVersion !== "latest";
                    return {
                        entry,
                        isPinned,
                        pinnedVersion: isPinned ? pinnedVersion : null,
                        configPath,
                    };
                }
            }
        } catch {
            // Ignore unreadable configs and keep scanning lower-priority paths.
        }
    }
    return null;
}

let cachedPackageVersion: string | null = null;

function getSpecCachePackageJsonPath(spec: string): string {
    return join(CACHE_DIR, spec, "node_modules", PACKAGE_NAME, "package.json");
}

export function getCachedVersion(spec?: string | null): string | null {
    if (!spec && cachedPackageVersion) return cachedPackageVersion;

    const candidates = [
        getCurrentRuntimePackageJsonPath(),
        spec ? getSpecCachePackageJsonPath(spec) : null,
        getSpecCachePackageJsonPath(`${PACKAGE_NAME}@latest`),
        join(homedir(), ".cache", "opencode", "node_modules", PACKAGE_NAME, "package.json"),
    ].filter(isString);

    for (const packageJsonPath of candidates) {
        try {
            if (!existsSync(packageJsonPath)) continue;
            const pkg = PackageJsonSchema.safeParse(
                JSON.parse(readFileSync(packageJsonPath, "utf-8")),
            );
            if (pkg.success && pkg.data.version) {
                if (!spec) cachedPackageVersion = pkg.data.version;
                return pkg.data.version;
            }
        } catch {
            // Try the next known OpenCode cache location.
        }
    }

    return null;
}

export function updatePinnedVersion(
    configPath: string,
    oldEntry: string,
    newVersion: string,
): boolean {
    try {
        if (!existsSync(configPath)) return false;

        const content = readFileSync(configPath, "utf-8");
        const newEntry = `${PACKAGE_NAME}@${newVersion}`;
        const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const entryRegex = new RegExp(`(["'])${escapedOldEntry}\\1`, "g");

        if (!entryRegex.test(content)) {
            log(`[auto-update-checker] Entry "${oldEntry}" not found in ${configPath}`);
            return false;
        }

        const updatedContent = content.replace(entryRegex, `$1${newEntry}$1`);
        if (updatedContent === content) return false;

        writeFileSync(configPath, updatedContent, "utf-8");
        log(`[auto-update-checker] Updated ${configPath}: ${oldEntry} → ${newEntry}`);
        return true;
    } catch (err) {
        warn(`[auto-update-checker] Failed to update config file ${configPath}: ${String(err)}`);
        return false;
    }
}

function buildRegistryUrl(registryUrl: string): string {
    return `${registryUrl.replace(/\/+$/, "")}/${encodeURIComponent(PACKAGE_NAME).replace("%2F", "/")}`;
}

export async function getLatestVersion(
    channel = "latest",
    options: { registryUrl?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? NPM_FETCH_TIMEOUT);
    const abortHandler = () => controller.abort();
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
        if (options.signal?.aborted) return null;
        const response = await fetch(buildRegistryUrl(options.registryUrl ?? NPM_REGISTRY_URL), {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;

        const data = NpmPackageEnvelopeSchema.safeParse(await response.json());
        if (!data.success) return null;
        return data.data["dist-tags"][channel] ?? data.data["dist-tags"].latest ?? null;
    } catch {
        return null;
    } finally {
        options.signal?.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutId);
    }
}
