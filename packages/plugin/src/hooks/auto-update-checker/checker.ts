import { spawn } from "node:child_process";
import {
    accessSync,
    existsSync,
    constants as fsConstants,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "comment-json";

import { log } from "../../shared/logger";
import {
    NPM_FETCH_TIMEOUT,
    PACKAGE_NAME,
    resolveNpmRegistryUrl,
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
} from "./constants";
import { isValidSemver } from "./semver";
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

export type ConfigSurface = "server" | "tui";

function getSurfaceConfigPaths(directory: string, surface: ConfigSurface): string[] {
    const name = surface === "server" ? "opencode" : "tui";
    const globalDir = dirname(USER_OPENCODE_CONFIG);
    const dirs = [
        globalDir,
        directory,
        join(directory, ".opencode"),
        process.env.OPENCODE_CONFIG_DIR,
    ].filter((value): value is string => Boolean(value));
    const paths: string[] = [];
    for (const dir of dirs) {
        for (const extension of ["json", "jsonc"]) {
            const path = join(dir, `${name}.${extension}`);
            if (!paths.includes(path)) paths.push(path);
        }
    }
    return paths;
}

function getWinningConfig(
    directory: string,
    surface: ConfigSurface,
): {
    path: string;
    entries: string[];
} | null {
    let winner: { path: string; entries: string[] } | null = null;
    for (const path of getSurfaceConfigPaths(directory, surface)) {
        try {
            if (!existsSync(path)) continue;
            const parsed = parseJsonConfig(readFileSync(path, "utf-8"));
            const entries = getPluginEntries(parsed);
            if (
                entries.some(
                    (entry) => entry === PACKAGE_NAME || entry.startsWith(`${PACKAGE_NAME}@`),
                )
            ) {
                if (winner) {
                    log(
                        `[auto-update-checker] ${surface} config ${winner.path} is shadowed by ${path}`,
                    );
                }
                winner = { path, entries };
            }
        } catch {
            // An unreadable lower-precedence file does not block higher origins.
        }
    }
    return winner;
}

function getConfigPaths(directory: string): string[] {
    return getSurfaceConfigPaths(directory, "server");
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

/**
 * Resolve the plugin entry that OpenCode will use for one runtime surface.
 * Config paths are ordered by OpenCode precedence so diagnostics and the
 * auto-updater agree about the artifact that actually runs.
 */
export function findPluginEntry(
    directory: string,
    surface: ConfigSurface = "server",
): PluginEntryInfo | null {
    const winner = getWinningConfig(directory, surface);
    if (!winner) return null;
    const entry = winner.entries.find(
        (value) => value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`),
    );
    if (!entry) return null;
    const pinnedVersion = entry.startsWith(`${PACKAGE_NAME}@`)
        ? entry.slice(PACKAGE_NAME.length + 1)
        : null;
    return {
        entry,
        isPinned: pinnedVersion !== null && pinnedVersion !== "latest",
        pinnedVersion: pinnedVersion && pinnedVersion !== "latest" ? pinnedVersion : null,
        configPath: winner.path,
    };
}

type ConfigSnapshot = { path: string; original: string; updated: string };

export interface PreparedConfigUpdate {
    spec: string;
    configPaths: [string, string];
}

export function hasExplicitNonExactPluginVersion(spec: string): boolean {
    if (!spec.startsWith(`${PACKAGE_NAME}@`)) return false;
    return !isValidSemver(spec.slice(PACKAGE_NAME.length + 1));
}

function isExactOrBarePluginSpec(spec: string): boolean {
    return (
        spec === PACKAGE_NAME ||
        (spec.startsWith(`${PACKAGE_NAME}@`) && !hasExplicitNonExactPluginVersion(spec))
    );
}

function configUpdateContent(content: string, version: string): string | null {
    const parsed = parseJsonConfig(content);
    if (!parsed) return null;
    const entries = getPluginEntries(parsed);
    const current = entries.find(
        (entry) => entry === PACKAGE_NAME || entry.startsWith(`${PACKAGE_NAME}@`),
    );
    if (!current || !isExactOrBarePluginSpec(current)) return null;

    const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entryRegex = new RegExp(`(["'])${escaped}\\1`);
    const nextSpec = `${PACKAGE_NAME}@${version}`;
    if (!entryRegex.test(content)) return null;
    return content.replace(entryRegex, `$1${nextSpec}$1`);
}

function preflightConfigUpdates(paths: [string, string], version: string): ConfigSnapshot[] | null {
    const snapshots: ConfigSnapshot[] = [];
    for (const path of paths) {
        try {
            accessSync(path, fsConstants.W_OK);
            const original = readFileSync(path, "utf-8");
            const updated = configUpdateContent(original, version);
            if (!updated) return null;
            snapshots.push({ path, original, updated });
        } catch (err) {
            warn(`[auto-update-checker] Config preflight failed for ${path}: ${String(err)}`);
            return null;
        }
    }
    return snapshots;
}

function writeConfig(path: string, content: string): void {
    const tmp = `${path}.mc-tmp-${process.pid}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
}

function restoreConfigs(snapshots: ConfigSnapshot[]): void {
    for (const snapshot of snapshots) {
        try {
            writeConfig(snapshot.path, snapshot.original);
        } catch (err) {
            warn(`[auto-update-checker] Failed to roll back ${snapshot.path}: ${String(err)}`);
        }
    }
}

function configsHaveSpec(paths: [string, string], spec: string): boolean {
    return paths.every((path) => {
        try {
            const parsed = parseJsonConfig(readFileSync(path, "utf-8"));
            return getPluginEntries(parsed).includes(spec);
        } catch {
            return false;
        }
    });
}

type HostInstallResult = { resolved: boolean; successful: boolean };

function runHostPluginInstall(
    spec: string,
    signal?: AbortSignal,
    timeoutMs = 60_000,
): Promise<HostInstallResult> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve({ resolved: true, successful: false });
        let processStarted = false;
        let settled = false;
        const timer: ReturnType<typeof setTimeout> | null = setTimeout(
            () => finish(false),
            timeoutMs,
        );
        const finish = (ok: boolean, resolved = processStarted) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve({ resolved, successful: ok });
        };
        const onAbort = () => finish(false);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const proc = inRootAsyncContext(() =>
                spawn("opencode", ["plugin", spec, "--global", "--force"], {
                    windowsHide: true,
                    stdio: "ignore",
                }),
            );
            processStarted = true;
            proc.on("error", () => finish(false, false));
            proc.on("exit", (code) => finish(code === 0));
            if (signal?.aborted) finish(false);
        } catch {
            finish(false, false);
        }
    });
}

export async function preparePluginUpdate(
    directory: string,
    _pluginInfo: PluginEntryInfo,
    version: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PreparedConfigUpdate | null> {
    if (!isValidSemver(version)) {
        warn(`[auto-update-checker] Refusing to pin invalid version "${version}"`);
        return null;
    }
    const serverWinner = getWinningConfig(directory, "server");
    const tuiWinner = getWinningConfig(directory, "tui");
    if (!serverWinner || !tuiWinner) {
        warn("[auto-update-checker] Could not find winning server and TUI configs");
        return null;
    }
    const paths: [string, string] = [serverWinner.path, tuiWinner.path];
    const preflight = preflightConfigUpdates(paths, version);
    if (!preflight) return null;
    const spec = `${PACKAGE_NAME}@${version}`;

    // Prefer OpenCode's own installer for global entries. It owns cache naming
    // and installs both server and TUI trees before patching either config.
    const globalServerPaths = [USER_OPENCODE_CONFIG, USER_OPENCODE_CONFIG_JSONC];
    const globalTuiPaths = globalServerPaths.map((path) => join(dirname(path), "tui.json"));
    globalTuiPaths.push(...globalServerPaths.map((path) => join(dirname(path), "tui.jsonc")));
    const isGlobal = globalServerPaths.includes(paths[0]) && globalTuiPaths.includes(paths[1]);
    if (isGlobal) {
        const hostResult = await runHostPluginInstall(spec, options.signal, options.timeoutMs);
        if (hostResult.successful && configsHaveSpec(paths, spec)) {
            return { spec, configPaths: paths };
        }
        restoreConfigs(preflight);
        // A resolved command that failed or patched only one surface is not
        // retried manually: both snapshots remain restored and no update-ready
        // announcement is emitted. Manual fallback is only for ENOENT/path
        // resolution failure, where the host installer never ran.
        if (hostResult.resolved) return null;
    }

    // Manual fallback is deliberately config-only. OpenCode installs the exact
    // spec into its own new cache directory at the next boot; this code never
    // guesses cache names or mutates an active cache tree.
    const snapshots = preflightConfigUpdates(paths, version);
    if (!snapshots) return null;
    try {
        writeConfig(snapshots[0].path, snapshots[0].updated);
        writeConfig(snapshots[1].path, snapshots[1].updated);
        if (!configsHaveSpec(paths, spec)) throw new Error("config verification mismatch");
        return { spec, configPaths: paths };
    } catch (err) {
        warn(`[auto-update-checker] Config update failed: ${String(err)}`);
        restoreConfigs(snapshots);
        return null;
    }
}

let cachedPackageVersion: string | null = null;

export function getCachedVersion(_spec?: string | null): string | null {
    if (!_spec && cachedPackageVersion) return cachedPackageVersion;

    const candidates = [getCurrentRuntimePackageJsonPath()].filter(isString);

    for (const packageJsonPath of candidates) {
        try {
            if (!existsSync(packageJsonPath)) continue;
            const pkg = PackageJsonSchema.safeParse(
                JSON.parse(readFileSync(packageJsonPath, "utf-8")),
            );
            if (pkg.success && pkg.data.version) {
                if (!_spec) cachedPackageVersion = pkg.data.version;
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

        // Validate the version before substituting it verbatim into the user's
        // config. newVersion comes from the npm registry envelope (Zod-parsed as
        // a shape, but not as semver), so a malformed/crafted value must never
        // reach the JSONC. Shared strict-semver check (same guard the auto-update
        // prepare path uses).
        if (!isValidSemver(newVersion)) {
            warn(`[auto-update-checker] Refusing to pin invalid version "${newVersion}"`);
            return false;
        }

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

        // Atomic write: stage to a temp file in the same directory then rename.
        // A direct writeFileSync that crashes mid-write would truncate the
        // user's OpenCode config (which holds all their plugin/model settings).
        // rename is atomic on the same filesystem, so a crash leaves either the
        // old or the new file intact — never a half-written one.
        const tmpPath = `${configPath}.mc-tmp-${process.pid}`;
        writeFileSync(tmpPath, updatedContent, "utf-8");
        renameSync(tmpPath, configPath);
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
    options: {
        registryUrl?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
        fetch?: typeof fetch;
    } = {},
): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? NPM_FETCH_TIMEOUT);
    const abortHandler = () => controller.abort();
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
        if (options.signal?.aborted) return null;
        const response = await (options.fetch ?? fetch)(
            buildRegistryUrl(
                options.registryUrl ??
                    resolveNpmRegistryUrl(process.env, { packageName: PACKAGE_NAME }),
            ),
            {
                signal: controller.signal,
                headers: { Accept: "application/json" },
            },
        );
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

import { inRootAsyncContext } from "../../shared/sqlite";
