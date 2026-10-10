/**
 * Doctor check for a cached Magic Context copy that is older than the shared
 * database it opens.
 *
 * OpenCode 1 and OpenCode 2 keep separate plugin caches but open the same
 * `context.db`. When each host has a different Magic Context version cached,
 * the newer copy migrates the database on its first start, and from then on the
 * older copy's schema fence (`LATEST_SUPPORTED_VERSION`, compiled into its
 * dist) is below the database version, so that host fails closed on every
 * prompt. An `@latest` entry does not help: neither host replaces a cached
 * `@latest` install on its own.
 *
 * This check reads the fence compiled into every cached copy that follows a
 * dist-tag (OpenCode 1's `packages/` roots and OpenCode 2's `npm/` slots) and
 * names each cache directory whose fence is behind the database's newest
 * migration, with the host-specific way to refresh it. Version-pinned copies
 * are left to the pinned-entry fence check, since updating the cache cannot
 * change what a pin installs. A copy the host's config never loads (the config
 * loads Magic Context from a local checkout, or pins a version) cannot fail
 * that host closed, so it is skipped here; the plugin cache steps report it as
 * an unused copy. Nothing is removed here.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { getPersistedSchemaVersion } from "@magic-context/core/features/magic-context/storage-db";
import { openExistingDatabase } from "../lib/database-access";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
    getOpenCodeV2ActiveGeneration,
    isOpenCodePluginDistTag,
    listOpenCodeV2PluginCacheSlots,
    type OpenCodePluginCacheHost,
} from "../lib/opencode-plugin-cache";
import { readFenceFromDist } from "../lib/opencode-plugin-schema-fence";
import { readCachedPluginVersion } from "./doctor-opencode-cache";
import { OPENCODE_V2_PLUGIN_UPDATE_HINT } from "./doctor-opencode2-cache";

export type CachedPluginHost = OpenCodePluginCacheHost;

/** One cached Magic Context copy and the schema fence compiled into it. */
export interface CachedPluginFence {
    host: CachedPluginHost;
    /** The directory to refresh: the OpenCode 1 cache root or the OpenCode 2 slot. */
    directory: string;
    /** OpenCode 2 slot spec (`latest`, `beta`, ...); undefined for OpenCode 1. */
    spec?: string;
    version?: string;
    /** Highest database schema version the copy accepts; null when unreadable. */
    supportedVersion: number | null;
}

export interface CachedPluginFenceSources {
    /** OpenCode 1 cache roots to read; defaults to the real `packages/` roots. */
    openCodeV1Roots?: string[];
    /** OpenCode 2 `npm/` cache directory; defaults to the real one. */
    openCodeV2NpmCacheDir?: string;
    /**
     * Magic Context specs each host's config makes it load (see
     * `readReferencedOpenCodePluginSpecs`). A cached copy whose spec is not in
     * its host's set is never loaded and is left out. A host without a set
     * (config unreadable, or a caller that has no config) keeps every copy.
     */
    referencedSpecs?: Partial<Record<CachedPluginHost, ReadonlySet<string>>>;
}

function isReferenced(
    sources: CachedPluginFenceSources,
    host: CachedPluginHost,
    spec: string,
): boolean {
    const specs = sources.referencedSpecs?.[host];
    return specs === undefined || specs.has(spec);
}

/** Read every dist-tag Magic Context copy cached by OpenCode 1 and OpenCode 2. */
export function listCachedOpenCodePluginFences(
    sources: CachedPluginFenceSources = {},
): CachedPluginFence[] {
    const fences: CachedPluginFence[] = [];
    // Both OpenCode 1 roots (`<name>@latest` and the bare `<name>`) hold the
    // install that follows `latest`.
    const v1Referenced = isReferenced(sources, "opencode1", "latest");
    for (const root of v1Referenced
        ? (sources.openCodeV1Roots ?? getOpenCodePluginCacheRoots())
        : []) {
        const packageJson = getOpenCodePluginPackageJsonPath(root);
        if (!existsSync(packageJson)) continue;
        fences.push({
            host: "opencode1",
            directory: root,
            version: readCachedPluginVersion(root),
            supportedVersion: readFenceFromDist(dirname(packageJson)),
        });
    }
    for (const slot of listOpenCodeV2PluginCacheSlots(sources.openCodeV2NpmCacheDir)) {
        if (!isOpenCodePluginDistTag(slot.spec)) continue;
        if (!isReferenced(sources, "opencode2", slot.spec)) continue;
        // The host loads the newest generation, so that is the copy whose fence matters.
        const generation = getOpenCodeV2ActiveGeneration(slot.slot);
        if (!generation) continue;
        fences.push({
            host: "opencode2",
            directory: slot.slot,
            spec: slot.spec,
            version: slot.version,
            supportedVersion: readFenceFromDist(
                dirname(getOpenCodePluginPackageJsonPath(generation)),
            ),
        });
    }
    return fences;
}

/**
 * The newest upstream migration recorded in `context.db`, or null when the
 * file is missing or unreadable. Opened read-only without this CLI's own
 * schema fence, so a database newer than the CLI is still measured.
 */
export function readContextDbSchemaVersion(path: string): number | null {
    let db: ReturnType<typeof openExistingDatabase> = null;
    try {
        db = openExistingDatabase(path, { readonly: true });
        return db === null ? null : getPersistedSchemaVersion(db);
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

export type CachedPluginFenceStatus = "behind" | "supported" | "unknown";

export interface CachedPluginFenceFinding extends CachedPluginFence {
    status: CachedPluginFenceStatus;
    databaseVersion: number;
}

/** Classify each cached copy against the database's newest migration. */
export function compareCachedPluginFences(
    fences: CachedPluginFence[],
    databaseVersion: number,
): CachedPluginFenceFinding[] {
    return fences.map((fence) => ({
        ...fence,
        databaseVersion,
        status:
            fence.supportedVersion === null
                ? "unknown"
                : fence.supportedVersion < databaseVersion
                  ? "behind"
                  : "supported",
    }));
}

function hostLabel(fence: CachedPluginFence): string {
    if (fence.host === "opencode1") return "OpenCode 1";
    return fence.spec && fence.spec !== "latest" ? `OpenCode 2 (@${fence.spec})` : "OpenCode 2";
}

export interface CachedPluginFenceReporter {
    pass(message: string): void;
    fail(message: string): void;
    info(message: string): void;
}

/** Print the findings. Returns how many cached copies are behind the database. */
export function reportCachedPluginFences(
    findings: CachedPluginFenceFinding[],
    report: CachedPluginFenceReporter,
): { behind: number } {
    const supported: string[] = [];
    let behind = 0;
    for (const finding of findings) {
        const label = hostLabel(finding);
        const version = finding.version ?? "unknown version";
        if (finding.status === "supported") {
            supported.push(`${label} ${version} (fence v${finding.supportedVersion})`);
            continue;
        }
        if (finding.status === "unknown") {
            report.info(
                `${label} plugin cache: could not read the schema fence of Magic Context ${version}, so doctor cannot tell whether it supports context.db v${finding.databaseVersion}`,
            );
            report.info(`  ${finding.directory}`);
            continue;
        }
        behind++;
        report.fail(
            `${label} has Magic Context ${version} cached, which supports context.db only through schema v${finding.supportedVersion}, but the shared context.db is at v${finding.databaseVersion}. A newer Magic Context (usually the other OpenCode host) migrated it, so ${label} fails closed on every prompt; an @latest entry does not refresh this cached copy.`,
        );
        report.info(`  ${finding.directory}`);
        report.info(
            finding.host === "opencode1"
                ? "  To fix: quit OpenCode 1 and delete that directory; OpenCode 1 installs the current release on its next start."
                : `  To fix, ${OPENCODE_V2_PLUGIN_UPDATE_HINT}, then restart OpenCode 2.`,
        );
    }
    if (supported.length > 0) {
        report.pass(
            `Cached Magic Context copies support context.db v${findings[0]?.databaseVersion}: ${supported.join(", ")}`,
        );
    }
    return { behind };
}
