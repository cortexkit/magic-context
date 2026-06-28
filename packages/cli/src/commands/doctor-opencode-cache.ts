import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getOpenCodeCacheDir } from "@magic-context/core/shared/data-path";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY_WITH_VERSION = `${PLUGIN_NAME}@latest`;

export interface PluginCacheResult {
    action: "cleared" | "up_to_date" | "not_found" | "error";
    path: string;
    cached?: string;
    latest?: string;
    error?: string;
}

export function getOpenCodePluginCacheRoots(): string[] {
    const cacheDir = getOpenCodeCacheDir();
    return [
        join(cacheDir, "packages", PLUGIN_ENTRY_WITH_VERSION),
        join(cacheDir, "packages", PLUGIN_NAME),
    ];
}

function cachedPluginPackagePath(pluginCacheDir: string): string {
    return join(
        pluginCacheDir,
        "node_modules",
        "@cortexkit",
        "opencode-magic-context",
        "package.json",
    );
}

function readCachedPluginVersion(pluginCacheDir: string): string | undefined {
    try {
        const installedPkgPath = cachedPluginPackagePath(pluginCacheDir);
        if (!existsSync(installedPkgPath)) return undefined;
        const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

export async function clearPluginCache(
    options: { force?: boolean; latestVersion?: string | null } = {},
): Promise<PluginCacheResult> {
    const [pluginCacheDir] = getOpenCodePluginCacheRoots();

    if (!existsSync(pluginCacheDir)) {
        return { action: "not_found", path: pluginCacheDir };
    }

    const cachedVersion = readCachedPluginVersion(pluginCacheDir);
    const latestVersion = options.latestVersion ?? undefined;

    if (
        options.force !== true &&
        cachedVersion &&
        latestVersion &&
        cachedVersion === latestVersion
    ) {
        return {
            action: "up_to_date",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: latestVersion,
        };
    }

    try {
        rmSync(pluginCacheDir, { recursive: true, force: true });
        return {
            action: "cleared",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: latestVersion,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { action: "error", path: pluginCacheDir, error: message };
    }
}
