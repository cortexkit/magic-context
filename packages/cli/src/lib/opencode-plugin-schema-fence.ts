import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
    type ConfigSurface,
    findPluginEntry,
} from "@magic-context/core/hooks/auto-update-checker/checker";
import { resolveNpmRegistryUrl } from "@magic-context/core/shared/npm-registry";

import { OPENCODE_PLUGIN_NAME } from "./opencode-plugin-cache";
import { getOpenCodePluginCacheDir } from "./paths";

const PACKAGE_PATH_SEGMENTS = OPENCODE_PLUGIN_NAME.split("/");
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const NPM_TIMEOUT_MS = 5_000;
const FENCE_PATTERN = /\bLATEST_SUPPORTED_VERSION\s*=\s*(\d+)\b/g;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type PinnedPluginSchemaFenceStatus = "pass" | "fail" | "unknown";

export interface PinnedPluginSchemaFenceFinding {
    status: PinnedPluginSchemaFenceStatus;
    surface: ConfigSurface;
    specifier: string;
    configPath: string;
    pinnedVersion: string;
    databaseVersion: number;
    supportedVersion: number | null;
    source: "installed" | "npm-tarball" | null;
}

export interface InspectPinnedPluginSchemaFencesOptions {
    directory: string;
    databaseVersion: number;
}

export interface PinnedPluginSchemaFenceDeps {
    fetch?: typeof globalThis.fetch;
    findPluginEntry?: typeof findPluginEntry;
    getOpenCodePluginCacheDir?: () => string;
}

type ResolvedPluginFence = {
    version: string;
    supportedVersion: number;
    source: "installed" | "npm-tarball";
};

type InstalledPluginPackage = {
    directory: string;
    version: string;
};

function readPackageVersion(packageJsonPath: string): string | null {
    try {
        if (!existsSync(packageJsonPath)) return null;
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
            name?: unknown;
            version?: unknown;
        };
        if (packageJson.name !== OPENCODE_PLUGIN_NAME || typeof packageJson.version !== "string") {
            return null;
        }
        return packageJson.version;
    } catch {
        return null;
    }
}

function readFenceValue(text: string): number | null {
    const values = new Set<number>();
    for (const match of text.matchAll(FENCE_PATTERN)) {
        const version = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(version)) values.add(version);
    }
    return values.size === 1 ? ([...values][0] ?? null) : null;
}

/**
 * The schema fence (`LATEST_SUPPORTED_VERSION`) compiled into an installed
 * plugin package's `dist/`, or null when no single value can be found.
 */
export function readFenceFromDist(packageDirectory: string): number | null {
    const distDirectory = join(packageDirectory, "dist");
    if (!existsSync(distDirectory)) return null;

    const pending = [distDirectory];
    const fenceValues = new Set<number>();
    while (pending.length > 0) {
        const directory = pending.pop();
        if (!directory) continue;
        try {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) {
                    pending.push(path);
                    continue;
                }
                if (!entry.isFile() || !/\.(?:[cm]?js|ts)$/.test(entry.name)) continue;
                const fence = readFenceValue(readFileSync(path, "utf-8"));
                if (fence !== null) fenceValues.add(fence);
            }
        } catch {
            return null;
        }
    }
    return fenceValues.size === 1 ? ([...fenceValues][0] ?? null) : null;
}

function findInstalledPluginPackage(
    cacheDirectory: string,
    specifier: string,
    requestedVersion: string,
): InstalledPluginPackage | null {
    const directCacheRoot = join(cacheDirectory, specifier);
    const candidates = [directCacheRoot];
    try {
        for (const entry of readdirSync(cacheDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = join(cacheDirectory, entry.name);
            if (!candidates.includes(candidate)) candidates.push(candidate);
        }
    } catch {
        // The direct cache root is still worth probing when the parent cannot be read.
    }

    for (const cacheRoot of candidates) {
        const directory = join(cacheRoot, "node_modules", ...PACKAGE_PATH_SEGMENTS);
        const version = readPackageVersion(join(directory, "package.json"));
        if (!version) continue;
        if (
            cacheRoot === directCacheRoot ||
            (EXACT_VERSION_PATTERN.test(requestedVersion) && version === requestedVersion)
        ) {
            return { directory, version };
        }
    }
    return null;
}

function readTarText(bytes: Uint8Array, offset: number, length: number): string {
    const end = Math.min(offset + length, bytes.length);
    let nul = offset;
    while (nul < end && bytes[nul] !== 0) nul++;
    return new TextDecoder().decode(bytes.subarray(offset, nul));
}

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number | null {
    const value = readTarText(bytes, offset, length).trim();
    if (!/^[0-7]+$/.test(value)) return null;
    const parsed = Number.parseInt(value, 8);
    return Number.isFinite(parsed) ? parsed : null;
}

function readFenceFromNpmTarball(tarball: Uint8Array): number | null {
    let archive: Uint8Array;
    try {
        archive = gunzipSync(tarball);
    } catch {
        return null;
    }

    const fenceValues = new Set<number>();
    for (let offset = 0; offset + 512 <= archive.length; ) {
        const name = readTarText(archive, offset, 100);
        if (!name) break;
        const prefix = readTarText(archive, offset + 345, 155);
        const path = prefix ? `${prefix}/${name}` : name;
        const size = readTarOctal(archive, offset + 124, 12);
        if (size === null) return null;
        const contentStart = offset + 512;
        const contentEnd = contentStart + size;
        if (contentEnd > archive.length) return null;

        if (/^package\/dist\/.+\.(?:[cm]?js|ts)$/.test(path)) {
            const fence = readFenceValue(
                new TextDecoder().decode(archive.subarray(contentStart, contentEnd)),
            );
            if (fence !== null) fenceValues.add(fence);
        }
        offset = contentStart + Math.ceil(size / 512) * 512;
    }
    return fenceValues.size === 1 ? ([...fenceValues][0] ?? null) : null;
}

function npmPackageVersionUrl(version: string): string {
    const packagePath = encodeURIComponent(OPENCODE_PLUGIN_NAME).replace("%2F", "/");
    return `${resolveNpmRegistryUrl()}/${packagePath}/${encodeURIComponent(version)}`;
}

async function resolveFenceFromNpmTarball(
    requestedVersion: string,
    fetchImpl: typeof globalThis.fetch,
): Promise<ResolvedPluginFence | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NPM_TIMEOUT_MS);
    try {
        const metadataResponse = await fetchImpl(npmPackageVersionUrl(requestedVersion), {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!metadataResponse.ok) return null;
        const metadata = (await metadataResponse.json()) as {
            version?: unknown;
            dist?: { tarball?: unknown };
        };
        if (typeof metadata.version !== "string" || typeof metadata.dist?.tarball !== "string") {
            return null;
        }

        const tarballUrl = new URL(metadata.dist.tarball);
        if (tarballUrl.protocol !== "https:") return null;
        const tarballResponse = await fetchImpl(tarballUrl, { signal: controller.signal });
        if (!tarballResponse.ok) return null;
        const contentLength = Number(tarballResponse.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_TARBALL_BYTES) return null;
        const tarball = new Uint8Array(await tarballResponse.arrayBuffer());
        if (tarball.byteLength > MAX_TARBALL_BYTES) return null;
        const supportedVersion = readFenceFromNpmTarball(tarball);
        return supportedVersion === null
            ? null
            : { version: metadata.version, supportedVersion, source: "npm-tarball" };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function resolvePluginFence(
    specifier: string,
    requestedVersion: string,
    deps: Required<Pick<PinnedPluginSchemaFenceDeps, "fetch" | "getOpenCodePluginCacheDir">>,
): Promise<ResolvedPluginFence | null> {
    const installed = findInstalledPluginPackage(
        deps.getOpenCodePluginCacheDir(),
        specifier,
        requestedVersion,
    );
    if (installed) {
        const supportedVersion = readFenceFromDist(installed.directory);
        if (supportedVersion !== null) {
            return { version: installed.version, supportedVersion, source: "installed" };
        }
    }
    return resolveFenceFromNpmTarball(requestedVersion, deps.fetch);
}

/**
 * Resolve pinned server and TUI entries using the same precedence rules as the
 * runtime updater, then inspect the selected package artifact rather than the
 * CLI bundle. A health probe must validate the artifact that will run, not the
 * artifact doing the probing.
 */
export async function inspectPinnedOpenCodePluginSchemaFences(
    options: InspectPinnedPluginSchemaFencesOptions,
    deps: PinnedPluginSchemaFenceDeps = {},
): Promise<PinnedPluginSchemaFenceFinding[]> {
    const findEntry = deps.findPluginEntry ?? findPluginEntry;
    const resolutionDeps = {
        fetch: deps.fetch ?? globalThis.fetch,
        getOpenCodePluginCacheDir: deps.getOpenCodePluginCacheDir ?? getOpenCodePluginCacheDir,
    };
    const resolvedBySpecifier = new Map<string, Promise<ResolvedPluginFence | null>>();
    const findings: PinnedPluginSchemaFenceFinding[] = [];

    for (const surface of ["server", "tui"] as const) {
        const entry = findEntry(options.directory, surface);
        if (!entry?.isPinned || !entry.pinnedVersion) continue;

        let resolved = resolvedBySpecifier.get(entry.entry);
        if (!resolved) {
            resolved = resolvePluginFence(entry.entry, entry.pinnedVersion, resolutionDeps);
            resolvedBySpecifier.set(entry.entry, resolved);
        }
        const fence = await resolved;
        const supportedVersion = fence?.supportedVersion ?? null;
        findings.push({
            status:
                supportedVersion === null
                    ? "unknown"
                    : supportedVersion < options.databaseVersion
                      ? "fail"
                      : "pass",
            surface,
            specifier: entry.entry,
            configPath: entry.configPath,
            pinnedVersion: fence?.version ?? entry.pinnedVersion,
            databaseVersion: options.databaseVersion,
            supportedVersion,
            source: fence?.source ?? null,
        });
    }

    return findings;
}
