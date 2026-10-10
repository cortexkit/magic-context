/**
 * Doctor check for a stale Magic Context install in OpenCode 2's plugin cache.
 *
 * OpenCode 2 installs npm plugins under `<cache>/opencode/npm/<name>@<spec>/`
 * (one numbered generation per install) instead of the 1.x
 * `<cache>/opencode/packages/` tree. For an `@latest` (or bare) entry the host
 * installs once and then keeps loading that generation: at startup it only
 * flags the plugin `outdated`, and its "check for updates" action (ctrl+r in
 * the plugins dialog) refreshes that flag without touching the cache. A new
 * release is installed only when the user asks the host to update the plugin
 * (ctrl+u in the plugins dialog, or `opencode plugin update`), or when the
 * slot is missing at startup, in which case the host installs the current
 * `latest` into a fresh slot.
 *
 * This check reports a cached install older than the latest published version
 * and, under `doctor --fix` (or `--force`), removes Magic Context's own slot so
 * the next OpenCode start installs the current release. Only that one slot is
 * ever removed: other packages' slots and version-pinned Magic Context slots
 * are left alone. When the config entry follows another dist-tag (`@beta`,
 * `@next`), the slot checked and cleared is that tag's, compared against the
 * tag's current version. A slot the config never loads (the config loads Magic
 * Context from a local checkout, or pins a version) is reported as one
 * informational line and never cleared.
 *
 * The slot is never removed while an OpenCode process may be using it. A
 * running host keeps no file inside the slot open once the plugin is loaded
 * (the module is already in memory), so an open-file scan of the slot alone
 * cannot see it. What every running host does hold open is its session
 * database, so the probe asks `lsof` for any process holding the resolved
 * OpenCode database (or its `-wal`/`-shm` files) or any file inside the slot
 * (an install in progress). If `lsof` is unavailable or fails, use cannot be
 * ruled out and the slot is left in place.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { compareSemverCore } from "@magic-context/core/hooks/auto-update-checker/semver";
import { inspectWindowsProcessesSync } from "@magic-context/core/shared/rpc-utils";
import {
    describeUnusedOpenCodePluginCache,
    getOpenCodeV2PluginCacheSlot,
    isOpenCodePluginDistTag,
    readConfiguredOpenCodePluginSpec,
    readOpenCodeV2CachedPluginVersion,
} from "../lib/opencode-plugin-cache";
import { assertWindowsStoresClosed } from "./doctor-windows-holders";

export type HostUseProbe =
    | { status: "free" }
    | { status: "in_use"; pids: number[] }
    | { status: "unknown"; reason: string };

export interface HostUseProbeTargets {
    /** Files a running OpenCode host keeps open (its session database). */
    files: string[];
    /** Directories whose open files mean an install or load is in progress. */
    directories: string[];
}

type SpawnLike = (
    command: string,
    args: string[],
    options: { encoding: "utf-8"; timeout: number; windowsHide: true },
) => { status: number | null; stdout?: string | null; error?: Error };

function runLsof(args: string[], spawn: SpawnLike): { pids: number[] } | { error: string } {
    const result = spawn("lsof", args, { encoding: "utf-8", timeout: 15_000, windowsHide: true });
    if (result.error) return { error: result.error.message };
    // lsof exits 1 when no process matches; any other non-zero status is a failure.
    if (result.status !== 0 && result.status !== 1) {
        return { error: `lsof exited with status ${String(result.status)}` };
    }
    const pids = (result.stdout ?? "")
        .split(/\s+/)
        .filter((token) => /^\d+$/.test(token))
        .map((token) => Number(token))
        .filter((pid) => pid !== process.pid);
    return { pids };
}

/** Check whether processes use the target files or directories before changing them. */
export function probeHostProcessesUsing(
    targets: HostUseProbeTargets,
    spawn: SpawnLike = spawnSync as unknown as SpawnLike,
): HostUseProbe {
    if (process.platform === "win32") {
        try {
            assertWindowsStoresClosed(
                targets.files.filter((path) => !/-(?:wal|shm)$/.test(path)),
                inspectWindowsProcessesSync(),
            );
            if (targets.directories.some(existsSync))
                return {
                    status: "unknown",
                    reason: "Windows cannot rule out open files in plugin cache directories",
                };
            return { status: "free" };
        } catch (error) {
            return {
                status: "unknown",
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const files = targets.files.filter((file) => existsSync(file));
    const directories = targets.directories.filter((directory) => existsSync(directory));
    const queries: string[][] = [];
    // -w silences warnings about unrelated unreadable mounts; -t prints bare pids.
    if (files.length > 0) queries.push(["-w", "-t", "--", ...files]);
    for (const directory of directories) queries.push(["-w", "-t", "+D", directory]);

    const pids = new Set<number>();
    for (const args of queries) {
        const result = runLsof(args, spawn);
        if ("error" in result) {
            return { status: "unknown", reason: `could not run lsof (${result.error})` };
        }
        for (const pid of result.pids) pids.add(pid);
    }
    if (pids.size > 0) return { status: "in_use", pids: [...pids].sort((a, b) => a - b) };
    return { status: "free" };
}

export interface OpenCodeV2CacheResult {
    action:
        | "not_found"
        | "up_to_date"
        | "stale"
        | "check_unavailable"
        | "cleared"
        | "in_use"
        | "in_use_unknown"
        | "error"
        /** The config never makes OpenCode 2 load this slot; it is left alone. */
        | "unused";
    slot: string;
    cached?: string;
    latest?: string;
    pids?: number[];
    reason?: string;
    error?: string;
    /** Cleared only because of `--force`: the install was not known to be outdated. */
    forced?: boolean;
    /**
     * Set when the slot follows a dist-tag other than `latest`; `latest` then
     * holds that tag's current version.
     */
    distTag?: string;
    /**
     * Set on `not_found` when the config does not reference the slot either,
     * so a missing install is expected rather than pending.
     */
    unused?: boolean;
}

/**
 * Semver precedence of two prerelease strings (`beta.1` vs `beta.3`), where an
 * empty string is a release and ranks above any prerelease of the same core.
 */
function comparePrerelease(a: string, b: string): number {
    if (a === b) return 0;
    if (a === "") return 1;
    if (b === "") return -1;
    const left = a.split(".");
    const right = b.split(".");
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i];
        const y = right[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) return Number(x) - Number(y);
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function prereleaseOf(version: string): string {
    const withoutBuild = version.split("+", 1)[0] ?? "";
    const dash = withoutBuild.indexOf("-");
    return dash === -1 ? "" : withoutBuild.slice(dash + 1);
}

/**
 * Semver precedence of two versions: negative when `a` is older, positive
 * when newer, 0 when equal. Within one core version a prerelease ranks below
 * the release (0.44.0-beta.1 < 0.44.0-beta.3 < 0.44.0). Null when either is
 * not a semver version.
 */
export function compareSemverPrecedence(a: string, b: string): number | null {
    const comparison = compareSemverCore(a, b);
    if (comparison === null || comparison !== 0) return comparison;
    return comparePrerelease(prereleaseOf(a), prereleaseOf(b));
}

/** True when the cached install is older than `latest` or unreadable. */
function isStale(cached: string | undefined, latest: string): boolean {
    if (cached === undefined) return true;
    if (cached === latest) return false;
    const comparison = compareSemverPrecedence(cached, latest);
    // Unparseable versions that differ are treated as stale; a newer cached
    // build (for example a prerelease ahead of `latest`) is left alone. Same
    // core: prerelease order decides, which matters for a `@beta` or `@next`
    // slot (0.44.0-beta.1 is older than 0.44.0-beta.3).
    if (comparison === null) return true;
    return comparison < 0;
}

export interface OpenCodeV2SlotRemovalDeps {
    probe?: (targets: HostUseProbeTargets) => HostUseProbe;
    remove?: (path: string) => void;
}

export type OpenCodeV2SlotRemoval =
    | { action: "cleared" }
    | { action: "in_use"; pids: number[] }
    | { action: "in_use_unknown"; reason: string }
    | { action: "error"; error: string };

/**
 * Remove one OpenCode 2 cache slot unless an OpenCode process may be using it:
 * any process holding one of `hostFiles` (the session database) or any file in
 * the slot keeps it in place, and so does a probe that cannot tell. Shared by
 * `doctor --fix` and `doctor --clear` so both apply the same guard.
 */
export function removeOpenCodeV2PluginCacheSlot(
    slot: string,
    hostFiles: string[],
    deps: OpenCodeV2SlotRemovalDeps = {},
): OpenCodeV2SlotRemoval {
    const probe = deps.probe ?? probeHostProcessesUsing;
    const use = probe({ files: hostFiles, directories: [slot] });
    if (use.status === "in_use") return { action: "in_use", pids: use.pids };
    if (use.status === "unknown") return { action: "in_use_unknown", reason: use.reason };

    const remove =
        deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
    try {
        remove(slot);
    } catch (err) {
        return { action: "error", error: err instanceof Error ? err.message : String(err) };
    }
    return { action: "cleared" };
}

/** The session database files a running OpenCode host keeps open. */
export function openCodeHostDatabaseFiles(databasePaths: string[]): string[] {
    return databasePaths
        .filter((path) => path !== ":memory:")
        .flatMap((path) => ["", "-wal", "-shm"].map((suffix) => `${path}${suffix}`));
}

/**
 * The dist-tag other than `latest` that the configured Magic Context entry
 * follows (`beta` for `@cortexkit/opencode-magic-context@beta`), or undefined
 * for a bare, `@latest` or version-pinned entry.
 */
export function configuredOpenCodeV2DistTag(
    config: Record<string, unknown> | null | undefined,
): string | undefined {
    const spec = readConfiguredOpenCodePluginSpec(config);
    return spec !== "latest" && isOpenCodePluginDistTag(spec) ? spec : undefined;
}

export function checkOpenCodeV2PluginCache(
    options: {
        fix?: boolean;
        force?: boolean;
        /** Current version of the dist-tag the slot follows (`latest` unless `distTag` says otherwise). */
        latestVersion: string | null;
        /** Files a running host holds open, normally the resolved OpenCode database. */
        hostFiles: string[];
        /**
         * The dist-tag the configured entry follows when it is not `latest`
         * (for example `beta`). The slot checked is that tag's slot, and
         * `latestVersion` must be that tag's current version.
         */
        distTag?: string;
        /**
         * Magic Context specs the config makes OpenCode 2 load (see
         * `readReferencedOpenCodePluginSpecs`). A slot whose spec is not in the
         * set is never loaded, so it is reported as unused and never cleared.
         * Undefined when the config could not be read; the slot then counts.
         */
        referencedSpecs?: ReadonlySet<string>;
    },
    deps: OpenCodeV2SlotRemovalDeps & { slot?: string } = {},
): OpenCodeV2CacheResult {
    const distTag = options.distTag && options.distTag !== "latest" ? options.distTag : undefined;
    const slot = deps.slot ?? getOpenCodeV2PluginCacheSlot(undefined, distTag ?? "latest");
    const tagged = distTag ? { distTag } : {};
    if (
        options.referencedSpecs !== undefined &&
        !options.referencedSpecs.has(distTag ?? "latest")
    ) {
        return existsSync(slot)
            ? { action: "unused", slot, cached: readOpenCodeV2CachedPluginVersion(slot), ...tagged }
            : { action: "not_found", slot, unused: true, ...tagged };
    }
    if (!existsSync(slot)) return { action: "not_found", slot, ...tagged };

    const cached = readOpenCodeV2CachedPluginVersion(slot);
    const latest = options.latestVersion ?? undefined;
    const force = options.force === true;

    if (latest === undefined && !force) {
        return { action: "check_unavailable", slot, cached, ...tagged };
    }
    const stale = latest !== undefined && isStale(cached, latest);
    if (!stale && !force) return { action: "up_to_date", slot, cached, latest, ...tagged };
    if (!force && options.fix !== true) {
        return { action: "stale", slot, cached, latest, ...tagged };
    }

    const removal = removeOpenCodeV2PluginCacheSlot(slot, options.hostFiles, deps);
    switch (removal.action) {
        case "in_use":
            return { action: "in_use", slot, cached, latest, pids: removal.pids, ...tagged };
        case "in_use_unknown":
            return {
                action: "in_use_unknown",
                slot,
                cached,
                latest,
                reason: removal.reason,
                ...tagged,
            };
        case "error":
            return { action: "error", slot, cached, latest, error: removal.error, ...tagged };
        case "cleared":
            return { action: "cleared", slot, cached, latest, forced: !stale, ...tagged };
    }
}

/**
 * How a user updates the plugin through OpenCode 2 itself. `opencode plugin
 * update` without a target updates every outdated plugin, which avoids having
 * to repeat the entry exactly as written in the config (bare or `@latest`).
 */
export const OPENCODE_V2_PLUGIN_UPDATE_HINT =
    "update it from OpenCode: open /plugins, select Magic Context and press ctrl+u (ctrl+r only re-checks), or run `opencode plugin update`";

export interface OpenCodeV2CacheReporter {
    pass(message: string): void;
    warn(message: string): void;
    info(message: string): void;
}

/**
 * Print a cache result. Returns whether the step fixed something and whether
 * it left an issue that needs the user's attention.
 */
export function reportOpenCodeV2PluginCache(
    result: OpenCodeV2CacheResult,
    report: OpenCodeV2CacheReporter,
    options: {
        reportMissing: boolean;
        /** The local path the config loads Magic Context from, for the unused-copy line. */
        loadedFrom?: string;
    },
): { fixed: boolean; issue: boolean } {
    const tag = result.distTag ?? "latest";
    const versions = `cached: ${result.cached ?? "unreadable"}${result.latest ? `, ${tag}: ${result.latest}` : ""}`;
    // Name the slot only when it is not the default one, so `@latest` output is unchanged.
    const slotName = result.distTag ? ` @${result.distTag}` : "";
    switch (result.action) {
        case "not_found":
            if (options.reportMissing && !result.unused) {
                report.pass(
                    `OpenCode 2 plugin cache has no Magic Context${slotName} install yet (OpenCode installs it on next start)`,
                );
            }
            return { fixed: false, issue: false };
        case "up_to_date":
            report.pass(`OpenCode 2 plugin cache${slotName} up to date (v${result.cached})`);
            return { fixed: false, issue: false };
        case "check_unavailable":
            report.warn(
                `OpenCode 2 plugin cache${slotName} version check unavailable; preserving cached plugin${result.cached ? ` (cached: ${result.cached})` : ""}. Use doctor --force to reinstall it.`,
            );
            return { fixed: false, issue: false };
        case "stale":
            report.warn(
                `OpenCode 2 is running an outdated Magic Context${slotName} (${versions}); OpenCode does not install new releases on its own`,
            );
            report.info(`  To upgrade, ${OPENCODE_V2_PLUGIN_UPDATE_HINT},`);
            report.info(
                "  or quit OpenCode (including `opencode service stop`) and run `magic-context doctor --fix`.",
            );
            // An available update is advice, not a broken install: OpenCode's own
            // plugins dialog shows it the same way, so doctor warns without failing.
            return { fixed: false, issue: false };
        case "in_use":
            report.warn(
                `Outdated Magic Context in the OpenCode 2 plugin cache (${versions}) was not cleared: OpenCode is running (pid ${result.pids?.join(", ")})`,
            );
            report.info(
                `  Quit OpenCode (and \`opencode service stop\`) and rerun doctor --fix, or ${OPENCODE_V2_PLUGIN_UPDATE_HINT}.`,
            );
            report.info(`  ${result.slot}`);
            return { fixed: false, issue: false };
        case "in_use_unknown":
            report.warn(
                `Outdated Magic Context in the OpenCode 2 plugin cache (${versions}) was not cleared: ${result.reason ?? "could not tell whether OpenCode is running"}`,
            );
            report.info(
                `  Quit OpenCode and delete ${result.slot} by hand, or ${OPENCODE_V2_PLUGIN_UPDATE_HINT}.`,
            );
            return { fixed: false, issue: false };
        case "cleared":
            report.pass(
                `Cleared ${result.forced ? "" : "outdated "}Magic Context${slotName} from the OpenCode 2 plugin cache (${versions}${result.forced ? ", --force" : ""}) — OpenCode installs the ${result.distTag ? `current ${tag} release` : "latest"} on next start`,
            );
            report.info(`  ${result.slot}`);
            return { fixed: true, issue: false };
        case "unused":
            report.info(
                describeUnusedOpenCodePluginCache({
                    host: "OpenCode 2",
                    spec: tag,
                    cached: result.cached,
                    paths: [result.slot],
                    loadedFrom: options.loadedFrom,
                }),
            );
            return { fixed: false, issue: false };
        case "error":
            report.warn(`Could not clear the OpenCode 2 plugin cache: ${result.error}`);
            report.info(`  Manually delete: ${result.slot}`);
            return { fixed: false, issue: true };
    }
}
