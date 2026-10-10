import { existsSync, readFileSync, rmSync } from "node:fs";
import { isDevPathPluginEntry, pluginEntryPackage } from "../adapters/opencode";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
    type OpenCodePluginCacheHost,
    readReferencedOpenCodePluginSpecs,
} from "../lib/opencode-plugin-cache";
import { readPluginEntries } from "../lib/opencode-plugin-registration";
import {
    type HostUseProbe,
    type HostUseProbeTargets,
    probeHostProcessesUsing,
} from "./doctor-opencode2-cache";

export interface PluginCacheResult {
    action:
        | "cleared"
        | "up_to_date"
        | "not_found"
        | "check_unavailable"
        | "in_use"
        | "in_use_unknown"
        | "error"
        /**
         * The user's OpenCode config (opencode.json/opencode.jsonc) has no
         * `@cortexkit/opencode-magic-context` or `...@latest` entry in the
         * `plugin` array OpenCode 1 reads (for example it loads a local
         * checkout or pins a version), so OpenCode 1 never loads this cached
         * copy and it is left alone.
         */
        | "unused";
    path: string;
    /** Processes holding the OpenCode database or a cache file (`in_use`). */
    pids?: number[];
    /** Why use could not be ruled out (`in_use_unknown`). */
    reason?: string;
    paths?: string[];
    clearedPaths?: string[];
    failedPaths?: string[];
    cached?: string;
    latest?: string;
    error?: string;
}

/** Version of the Magic Context package installed under an OpenCode 1 cache root, if readable. */
export function readCachedPluginVersion(pluginCacheDir: string): string | undefined {
    try {
        const installedPkgPath = getOpenCodePluginPackageJsonPath(pluginCacheDir);
        if (!existsSync(installedPkgPath)) return undefined;
        const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

/** Where a parsed OpenCode config makes each host load Magic Context from. */
export interface OpenCodePluginConfigUse {
    /** Registry specs per host; a cached copy outside its host's set is never loaded. */
    referencedSpecs: Record<OpenCodePluginCacheHost, Set<string>>;
    /** The local checkout entry each host loads Magic Context from, if any. */
    loadedFrom: Partial<Record<OpenCodePluginCacheHost, string>>;
}

/**
 * Read which Magic Context sources the config gives each host. OpenCode 1
 * reads only the `plugin` array and OpenCode 2 reads `plugin` and `plugins`,
 * so the two hosts can load from different places out of one config file.
 * `configDir` is the config file's directory, which relative paths resolve against.
 */
export function readOpenCodePluginConfigUse(
    config: Record<string, unknown>,
    configDir: string,
): OpenCodePluginConfigUse {
    const use: OpenCodePluginConfigUse = {
        referencedSpecs: {
            opencode1: readReferencedOpenCodePluginSpecs(config, "opencode1"),
            opencode2: readReferencedOpenCodePluginSpecs(config, "opencode2"),
        },
        loadedFrom: {},
    };
    for (const { key, entry } of readPluginEntries(config)) {
        if (!isDevPathPluginEntry(entry, configDir)) continue;
        const specifier = pluginEntryPackage(entry) ?? undefined;
        if (key === "plugin") use.loadedFrom.opencode1 ??= specifier;
        use.loadedFrom.opencode2 ??= specifier;
    }
    return use;
}

export async function clearPluginCache(
    options: {
        force?: boolean;
        latestVersion?: string | null;
        /** Files a running OpenCode keeps open, normally its session database. */
        hostFiles?: string[];
        /**
         * Magic Context specs the config makes OpenCode 1 load (see
         * `readReferencedOpenCodePluginSpecs`). Both cache roots hold the
         * `latest` install, so without `latest` in the set they are unused.
         * Undefined when the config could not be read; every root then counts.
         */
        referencedSpecs?: ReadonlySet<string>;
    } = {},
    deps: {
        remove?: (path: string) => void;
        probe?: (targets: HostUseProbeTargets) => HostUseProbe;
    } = {},
): Promise<PluginCacheResult> {
    // Injected remover keeps the per-root deletion failure path deterministically
    // testable; defaults to a real recursive remove.
    const remove =
        deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
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

    // A copy the host never loads cannot break it or fall behind for it, so it
    // is neither compared with npm nor removed (not even under --force, which
    // would only spend an lsof probe and a warning on a directory nothing reads).
    if (options.referencedSpecs !== undefined && !options.referencedSpecs.has("latest")) {
        const firstEntry = cacheEntries[0];
        return {
            action: "unused",
            path: firstEntry?.path ?? pluginCacheRoots[0] ?? "",
            paths: cacheEntries.map((entry) => entry.path),
            cached: firstEntry?.cached,
        };
    }

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

    // A running OpenCode 1 loads some plugin files (workers) lazily from the
    // cache, so deleting it under a live host breaks that host later. Apply the
    // same guard as the OpenCode 2 slot: any process holding the host database
    // or a file in a root keeps every root in place, and so does a probe that
    // cannot tell.
    const probe = deps.probe ?? probeHostProcessesUsing;
    const use = probe({
        files: options.hostFiles ?? [],
        directories: clearTargets.map((entry) => entry.path),
    });
    if (use.status !== "free") {
        const firstTarget = clearTargets[0];
        return {
            action: use.status === "in_use" ? "in_use" : "in_use_unknown",
            path: firstTarget?.path ?? pluginCacheRoots[0] ?? "",
            paths: clearTargets.map((entry) => entry.path),
            cached: firstTarget?.cached,
            latest: latestVersion,
            ...(use.status === "in_use" ? { pids: use.pids } : { reason: use.reason }),
        };
    }

    // Clear each root independently so one root's failure neither aborts the
    // others nor mislabels an already-deleted path as the one needing manual
    // cleanup. The error result points at the root that actually failed.
    const cleared: typeof clearTargets = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const entry of clearTargets) {
        try {
            remove(entry.path);
            cleared.push(entry);
        } catch (err: unknown) {
            failed.push({
                path: entry.path,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (failed.length > 0) {
        const firstFailure = failed[0];
        return {
            action: "error",
            path: firstFailure?.path ?? clearTargets[0]?.path ?? existingRoots[0] ?? "",
            paths: failed.map((entry) => entry.path),
            clearedPaths: cleared.map((entry) => entry.path),
            failedPaths: failed.map((entry) => entry.path),
            error: firstFailure?.error,
        };
    }

    const firstTarget = cleared[0];
    return {
        action: "cleared",
        path: firstTarget?.path ?? pluginCacheRoots[0] ?? "",
        paths: cleared.map((entry) => entry.path),
        cached: firstTarget?.cached,
        latest: latestVersion,
    };
}
