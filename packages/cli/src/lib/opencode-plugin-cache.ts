import { join } from "node:path";
import { getOpenCodePluginCacheDir } from "./paths";

export const OPENCODE_PLUGIN_NAME = "@cortexkit/opencode-magic-context";
export const OPENCODE_PLUGIN_ENTRY_WITH_VERSION = `${OPENCODE_PLUGIN_NAME}@latest`;

export function getOpenCodePluginCacheRoots(): string[] {
    const cacheDir = getOpenCodePluginCacheDir();
    return [
        join(cacheDir, OPENCODE_PLUGIN_ENTRY_WITH_VERSION),
        join(cacheDir, OPENCODE_PLUGIN_NAME),
    ];
}

export function getOpenCodePluginPackageJsonPath(pluginCacheRoot: string): string {
    return join(
        pluginCacheRoot,
        "node_modules",
        ...OPENCODE_PLUGIN_NAME.split("/"),
        "package.json",
    );
}

export function getOpenCodePluginPackageJsonPaths(): string[] {
    return getOpenCodePluginCacheRoots().map(getOpenCodePluginPackageJsonPath);
}
