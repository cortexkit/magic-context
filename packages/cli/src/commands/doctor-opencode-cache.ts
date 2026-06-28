import { existsSync, readFileSync, rmSync } from "node:fs";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
} from "../lib/opencode-plugin-cache";

export interface PluginCacheResult {
    action: "cleared" | "up_to_date" | "not_found" | "check_unavailable" | "error";
    path: string;
    paths?: string[];
    cached?: string;
    latest?: string;
    error?: string;
}

function readCachedPluginVersion(pluginCacheDir: string): string | undefined {
    try {
        const installedPkgPath = getOpenCodePluginPackageJsonPath(pluginCacheDir);
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
    const pluginCacheRoots = getOpenCodePluginCacheRoots();
    const existingRoots = pluginCacheRoots.filter((root) => existsSync(root));

    if (existingRoots.length === 0) {
        return { action: "not_found", path: pluginCacheRoots[0] ?? "" };
    }

    const latestVersion = options.latestVersion ?? undefined;
    const cacheEntries = existingRoots.map((path) => ({
        path,
        cached: readCachedPluginVersion(path),
    }));

    if (options.force !== true && latestVersion === undefined) {
        const firstEntry = cacheEntries[0];
        return {
            action: "check_unavailable",
            path: firstEntry?.path ?? pluginCacheRoots[0] ?? "",
            paths: cacheEntries.map((entry) => entry.path),
            cached: firstEntry?.cached,
        };
    }

    const clearTargets = cacheEntries.filter(
        (entry) =>
            options.force === true || entry.cached === undefined || entry.cached !== latestVersion,
    );

    if (clearTargets.length === 0) {
        const firstEntry = cacheEntries[0];
        return {
            action: "up_to_date",
            path: firstEntry?.path ?? pluginCacheRoots[0] ?? "",
            paths: cacheEntries.map((entry) => entry.path),
            cached: firstEntry?.cached,
            latest: latestVersion,
        };
    }

    try {
        for (const entry of clearTargets) {
            rmSync(entry.path, { recursive: true, force: true });
        }
        const firstTarget = clearTargets[0];
        return {
            action: "cleared",
            path: firstTarget?.path ?? pluginCacheRoots[0] ?? "",
            paths: clearTargets.map((entry) => entry.path),
            cached: firstTarget?.cached,
            latest: latestVersion,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            action: "error",
            path: clearTargets[0]?.path ?? existingRoots[0] ?? "",
            error: message,
        };
    }
}
