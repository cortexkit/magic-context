#!/usr/bin/env bun
/**
 * Build the Tauri updater manifest (latest.json) of a dashboard release from the
 * release's own assets.
 *
 * Usage: bun scripts/dashboard-updater-manifest.ts <asset-names.json> <signature-dir> <owner/repo> <out-file>
 *
 *   <asset-names.json>  JSON array of every asset name on the release, e.g. from
 *                       `gh release view <tag> --json assets --jq '[.assets[].name]'`
 *   <signature-dir>     directory holding the release's downloaded `.sig` assets
 *   <owner/repo>        repository the release belongs to, used in the asset URLs
 *   <out-file>          where to write latest.json
 *
 * The build legs of .github/workflows/dashboard-release.yml used to merge their
 * platforms into one latest.json asset on the release. Legs running in parallel
 * overwrote each other's entries, and re-running one leg rebuilt the file without
 * the platforms of the legs that were not re-run. The release's installers and
 * `.sig` files are complete once every leg has succeeded, so this script builds the
 * manifest from those instead. It fails, naming every affected platform, when an
 * installer or its `.sig` is missing, and ignores assets it has no entry for.
 *
 * The output has the shape tauri-action gave it before: the same platform keys,
 * each `.sig` file's content as the `signature`, `/releases/latest/download/` asset
 * URLs (the deploy job pins them to the release tag afterwards), the version from
 * `version` in packages/dashboard/src-tauri/tauri.conf.json, empty notes and the
 * current time as pub_date.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One updater artifact on the release and the manifest keys that point at it. */
export interface UpdaterArtifact {
    /** Release asset name; its signature is the asset `<asset>.sig`. */
    asset: string;
    /** latest.json platform keys whose entry is this asset. */
    keys: readonly string[];
}

const ASSET_PREFIX = "magic-context-dashboard";

/**
 * Every updater artifact a complete release carries. Asset names follow the build
 * legs' `assetNamePattern` (magic-context-dashboard-<platform>-<arch><ext>); the
 * keys are the ones tauri-action wrote: `<os>-<arch>` for the primary installer
 * and `<os>-<arch>-<bundle>` for each bundle. On Windows x64 the primary entry is
 * the NSIS `.exe`, as the legs' `updaterJsonPreferNsis: true` used to select.
 */
export const UPDATER_ARTIFACTS: readonly UpdaterArtifact[] = [
    {
        asset: `${ASSET_PREFIX}-darwin-arm64.app.tar.gz`,
        keys: ["darwin-aarch64", "darwin-aarch64-app"],
    },
    {
        asset: `${ASSET_PREFIX}-darwin-x64.app.tar.gz`,
        keys: ["darwin-x86_64", "darwin-x86_64-app"],
    },
    {
        asset: `${ASSET_PREFIX}-linux-arm64.AppImage`,
        keys: ["linux-aarch64", "linux-aarch64-appimage"],
    },
    { asset: `${ASSET_PREFIX}-linux-arm64.deb`, keys: ["linux-aarch64-deb"] },
    { asset: `${ASSET_PREFIX}-linux-arm64.rpm`, keys: ["linux-aarch64-rpm"] },
    {
        asset: `${ASSET_PREFIX}-linux-x64.AppImage`,
        keys: ["linux-x86_64", "linux-x86_64-appimage"],
    },
    { asset: `${ASSET_PREFIX}-linux-x64.deb`, keys: ["linux-x86_64-deb"] },
    { asset: `${ASSET_PREFIX}-linux-x64.rpm`, keys: ["linux-x86_64-rpm"] },
    {
        asset: `${ASSET_PREFIX}-windows-arm64.exe`,
        keys: ["windows-aarch64", "windows-aarch64-nsis"],
    },
    {
        asset: `${ASSET_PREFIX}-windows-x64.exe`,
        keys: ["windows-x86_64", "windows-x86_64-nsis"],
    },
    { asset: `${ASSET_PREFIX}-windows-x64.msi`, keys: ["windows-x86_64-msi"] },
];

export interface UpdaterPlatformEntry {
    signature: string;
    url: string;
}

export interface UpdaterManifest {
    version: string;
    notes: string;
    pub_date: string;
    platforms: Record<string, UpdaterPlatformEntry>;
}

export interface AssembleInput {
    /** Names of every asset on the release. */
    assetNames: readonly string[];
    /** Content of the named `.sig` asset, or undefined when it was not downloaded. */
    readSignature: (sigAssetName: string) => string | undefined;
    /** `owner/repo` of the release. */
    repo: string;
    version: string;
    /** ISO 8601 timestamp for `pub_date`. */
    pubDate: string;
}

/** Thrown when the release lacks an updater artifact or its signature. */
export class UpdaterManifestError extends Error {
    constructor(readonly problems: readonly string[]) {
        super(`cannot assemble latest.json:\n${problems.map((p) => `  ${p}`).join("\n")}`);
        this.name = "UpdaterManifestError";
    }
}

/**
 * Build latest.json from the release's asset names and `.sig` contents. Throws
 * UpdaterManifestError listing every platform whose installer or signature is
 * missing or empty; assets outside UPDATER_ARTIFACTS are ignored.
 */
export function assembleUpdaterManifest(input: AssembleInput): UpdaterManifest {
    const names = new Set(input.assetNames);
    const problems: string[] = [];
    const platforms: Record<string, UpdaterPlatformEntry> = {};

    for (const { asset, keys } of UPDATER_ARTIFACTS) {
        const sigName = `${asset}.sig`;
        const keyList = keys.join(", ");
        const missing = [asset, sigName].filter((name) => !names.has(name));
        if (missing.length > 0) {
            problems.push(`${keyList}: release has no ${missing.join(" or ")}`);
            continue;
        }
        const signature = input.readSignature(sigName);
        if (signature === undefined) {
            problems.push(`${keyList}: ${sigName} is on the release but was not downloaded`);
            continue;
        }
        if (signature.trim().length === 0) {
            problems.push(`${keyList}: ${sigName} is empty`);
            continue;
        }
        const url = `https://github.com/${input.repo}/releases/latest/download/${asset}`;
        for (const key of keys) {
            platforms[key] = { signature, url };
        }
    }

    if (problems.length > 0) {
        throw new UpdaterManifestError(problems);
    }
    return { version: input.version, notes: "", pub_date: input.pubDate, platforms };
}

/**
 * The dashboard version tauri-action put in latest.json: `version` in
 * tauri.conf.json, which this project sets to a plain version string.
 */
export function readDashboardVersion(confPath: string): string {
    const conf = JSON.parse(readFileSync(confPath, "utf8")) as { version?: unknown };
    const version = conf.version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
        throw new Error(`no plain version string in ${confPath}: ${JSON.stringify(version)}`);
    }
    return version;
}

export interface CliOptions {
    confPath?: string;
    now?: () => Date;
}

/** Run the command line; returns the process exit code. */
export function runCli(args: readonly string[], options: CliOptions = {}): number {
    const [namesPath, sigDir, repo, outPath] = args;
    if (!namesPath || !sigDir || !repo || !outPath || args.length !== 4) {
        console.error(
            "usage: bun scripts/dashboard-updater-manifest.ts <asset-names.json> <signature-dir> <owner/repo> <out-file>",
        );
        return 2;
    }

    const assetNames = JSON.parse(readFileSync(namesPath, "utf8")) as unknown;
    if (!Array.isArray(assetNames) || !assetNames.every((n) => typeof n === "string")) {
        console.error(`${namesPath} is not a JSON array of asset names`);
        return 1;
    }

    const confPath =
        options.confPath ??
        join(import.meta.dir, "../packages/dashboard/src-tauri/tauri.conf.json");
    const now = options.now ?? (() => new Date());

    let manifest: UpdaterManifest;
    try {
        manifest = assembleUpdaterManifest({
            assetNames,
            readSignature: (sigName) => {
                const path = join(sigDir, sigName);
                return existsSync(path) ? readFileSync(path, "utf8") : undefined;
            },
            repo,
            version: readDashboardVersion(confPath),
            pubDate: now().toISOString(),
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }

    writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    console.log(
        `wrote ${outPath}: version ${manifest.version}, ${Object.keys(manifest.platforms).length} platform entries`,
    );
    return 0;
}

if (import.meta.main) {
    process.exit(runCli(process.argv.slice(2)));
}
