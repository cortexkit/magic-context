import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPluginEntries } from "./opencode-plugin-registration";
import { getOpenCodePluginCacheDir, getOpenCodeV2NpmCacheDir } from "./paths";

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

/**
 * OpenCode 2's cache slot for the entries that follow new releases. The host
 * keys a registry spec as `<name>@<spec>` and treats a bare package name as
 * `@latest`, so both `@cortexkit/opencode-magic-context` and
 * `@cortexkit/opencode-magic-context@latest` load from this one slot. A
 * version-pinned entry has its own immutable slot that is never stale.
 */
export function getOpenCodeV2PluginCacheSlot(
    npmCacheDir = getOpenCodeV2NpmCacheDir(),
    spec = "latest",
): string {
    return join(npmCacheDir, ...`${OPENCODE_PLUGIN_NAME}@${spec}`.split("/"));
}

/**
 * The spec OpenCode 2 keys a Magic Context entry's cache slot by: the text after
 * `<name>@`, or `latest` for a bare package name. Returns undefined for anything
 * that is not a registry entry for this package (local paths, other packages).
 */
export function openCodeV2PluginSpecOf(specifier: string): string | undefined {
    if (specifier === OPENCODE_PLUGIN_NAME) return "latest";
    const prefix = `${OPENCODE_PLUGIN_NAME}@`;
    if (!specifier.startsWith(prefix)) return undefined;
    const spec = specifier.slice(prefix.length);
    return spec.length > 0 ? spec : "latest";
}

/**
 * True when `spec` is an npm dist-tag (`latest`, `beta`, `next`, ...) rather
 * than a version or range. A tag slot follows new releases of that tag, while a
 * version slot is immutable and never goes stale. npm rejects tags that parse
 * as a version range, so a tag starts with a letter and has no range syntax.
 */
export function isOpenCodePluginDistTag(spec: string): boolean {
    // `x` and `v1.2.3`-style strings are ranges/versions to npm, not tags.
    return /^[A-Za-z][A-Za-z0-9._-]*$/.test(spec) && !/^(v\d|[xX]$)/.test(spec);
}

/**
 * The Magic Context spec the OpenCode config registers, read from both plugin
 * keys. Falls back to `latest` when the config has no registry entry for the
 * package, which is what setup writes.
 */
export function readConfiguredOpenCodePluginSpec(
    config: Record<string, unknown> | null | undefined,
): string {
    for (const { entry } of readPluginEntries(config)) {
        const specifier = pluginEntrySpecifier(entry);
        const spec = specifier === undefined ? undefined : openCodeV2PluginSpecOf(specifier);
        if (spec !== undefined) return spec;
    }
    return "latest";
}

/** Which OpenCode host generation a plugin cache belongs to. */
export type OpenCodePluginCacheHost = "opencode1" | "opencode2";

/**
 * Every Magic Context registry spec (`latest` for a bare entry, otherwise the
 * text after `<name>@`) that the config makes `host` load. OpenCode 1 reads only
 * the legacy `plugin` array; OpenCode 2 reads `plugin` and `plugins` together.
 * Local-path entries and other packages add nothing, because a host that loads
 * Magic Context from a checkout never reads its npm cache copy. An empty set
 * therefore means no cached copy of the package is loaded by that host.
 */
export function readReferencedOpenCodePluginSpecs(
    config: Record<string, unknown> | null | undefined,
    host: OpenCodePluginCacheHost,
): Set<string> {
    const specs = new Set<string>();
    for (const { key, entry } of readPluginEntries(config)) {
        if (host === "opencode1" && key !== "plugin") continue;
        const specifier = pluginEntrySpecifier(entry);
        const spec = specifier === undefined ? undefined : openCodeV2PluginSpecOf(specifier);
        if (spec !== undefined) specs.add(spec);
    }
    return specs;
}

/**
 * The single info line for a cached Magic Context copy the host never loads.
 * Such a copy can be stale without harming anything, so it is reported as
 * informational rather than as a warning or failure.
 */
export function describeUnusedOpenCodePluginCache(input: {
    host: "OpenCode 1" | "OpenCode 2";
    /** The spec the unused copy follows, normally `latest`. */
    spec: string;
    cached?: string;
    paths: string[];
    /** The local path the config loads Magic Context from instead, if any. */
    loadedFrom?: string;
}): string {
    const why = input.loadedFrom
        ? `the config loads Magic Context from ${input.loadedFrom}`
        : `no ${input.host} plugin entry in the config references it`;
    return `${input.host} plugin cache: unused cached copy of ${OPENCODE_PLUGIN_NAME}@${input.spec} (cached: ${input.cached ?? "unreadable"}); ${input.host} never loads it because ${why}. Informational, nothing breaks; safe to delete: ${input.paths.join(", ")}`;
}

function pluginEntrySpecifier(entry: unknown): string | undefined {
    if (typeof entry === "string") return entry;
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
    if (entry !== null && typeof entry === "object") {
        const pkg = (entry as { package?: unknown }).package;
        if (typeof pkg === "string") return pkg;
    }
    return undefined;
}

/** A Magic Context install slot found in OpenCode 2's plugin cache. */
export interface OpenCodeV2PluginCacheSlot {
    /** The spec the slot is keyed by: `latest`, a dist-tag, or a version. */
    spec: string;
    slot: string;
    /** Version in the generation the host would load, if readable. */
    version?: string;
}

/**
 * Every Magic Context slot in OpenCode 2's plugin cache (`@latest`, dist-tags
 * such as `@beta`, and pinned versions), `@latest` first and the rest by name.
 */
export function listOpenCodeV2PluginCacheSlots(
    npmCacheDir = getOpenCodeV2NpmCacheDir(),
): OpenCodeV2PluginCacheSlot[] {
    const [scope = "", name = ""] = OPENCODE_PLUGIN_NAME.split("/");
    const scopeDir = join(npmCacheDir, scope);
    let names: string[];
    try {
        names = readdirSync(scopeDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${name}@`))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
    return names
        .map((dirName) => {
            const slot = join(scopeDir, dirName);
            return {
                spec: dirName.slice(name.length + 1),
                slot,
                version: readOpenCodeV2CachedPluginVersion(slot),
            };
        })
        .sort((a, b) => {
            if (a.spec === "latest" || b.spec === "latest") return a.spec === "latest" ? -1 : 1;
            return a.spec.localeCompare(b.spec);
        });
}

/**
 * The install generation OpenCode 2 loads from a slot: the numerically
 * highest all-digit directory name, matching the host's own selection.
 */
export function getOpenCodeV2ActiveGeneration(slot: string): string | undefined {
    try {
        const generations = readdirSync(slot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => Number(a) - Number(b));
        const newest = generations.at(-1);
        return newest === undefined ? undefined : join(slot, newest);
    } catch {
        return undefined;
    }
}

export type OpenCodeHostGeneration = "v1" | "v2";

/**
 * The name OpenCode 2 gives the cache slot of `spec`: on Windows the host
 * replaces `< > : " | ? *` and control characters in the spec with `_`, so a
 * range spec such as `>=0.49` lives in `_=0.49`.
 */
export function openCodeV2SlotSpec(spec: string, platform: NodeJS.Platform = process.platform) {
    if (platform !== "win32") return spec;
    return Array.from(spec, (char) =>
        '<>:"|?*'.includes(char) || char.charCodeAt(0) < 32 ? "_" : char,
    ).join("");
}

/**
 * Every directory holding an installed copy of Magic Context that a host could
 * load, as the directory that owns that copy's `node_modules`: for OpenCode 1
 * the two `packages/` roots, for OpenCode 2 the newest install generation of
 * each `npm/<name>@<spec>/` slot (the one the host loads). The host generation
 * doctor found comes first, and on OpenCode 2 the slot of the spec the config
 * registers leads it. The other generation's copies follow, because both
 * layouts share one cache root and can sit side by side after an upgrade.
 */
export function getOpenCodePluginInstallRoots(
    hostGeneration: OpenCodeHostGeneration,
    config?: Record<string, unknown> | null,
    npmCacheDir = getOpenCodeV2NpmCacheDir(),
    platform: NodeJS.Platform = process.platform,
): string[] {
    const configured = openCodeV2SlotSpec(readConfiguredOpenCodePluginSpec(config), platform);
    const v2 = listOpenCodeV2PluginCacheSlots(npmCacheDir)
        .sort((a, b) => Number(b.spec === configured) - Number(a.spec === configured))
        .map((slot) => getOpenCodeV2ActiveGeneration(slot.slot))
        .filter((generation): generation is string => generation !== undefined);
    const v1 = getOpenCodePluginCacheRoots();
    return hostGeneration === "v2" ? [...v2, ...v1] : [...v1, ...v2];
}

/**
 * The installed copy of Magic Context the host actually loads, and every other
 * copy on disk. On OpenCode 2 the loaded copy is the newest install generation
 * of the configured spec's slot (none when that slot is not installed); on
 * OpenCode 1 it is the `packages/` tree, whose two root names belong to
 * different OpenCode 1 versions of one install. Checks that describe the
 * running plugin, such as the local embedding runtime, must look only at
 * `loaded`: a healthy copy the host never reads cannot stand in for a broken
 * loaded one. `others` are listed for information only.
 */
export function getOpenCodeLoadedPluginInstallRoots(
    hostGeneration: OpenCodeHostGeneration,
    config?: Record<string, unknown> | null,
    npmCacheDir = getOpenCodeV2NpmCacheDir(),
    platform: NodeJS.Platform = process.platform,
): { loaded: string[]; others: string[] } {
    let loaded: string[];
    if (hostGeneration === "v2") {
        const configured = openCodeV2SlotSpec(readConfiguredOpenCodePluginSpec(config), platform);
        const generation = getOpenCodeV2ActiveGeneration(
            getOpenCodeV2PluginCacheSlot(npmCacheDir, configured),
        );
        loaded = generation === undefined ? [] : [generation];
    } else {
        loaded = getOpenCodePluginCacheRoots();
    }
    const others = getOpenCodePluginInstallRoots(
        hostGeneration,
        config,
        npmCacheDir,
        platform,
    ).filter((root) => !loaded.includes(root));
    return { loaded, others };
}

/** Version of the Magic Context package OpenCode 2 would load from `slot`, if readable. */
export function readOpenCodeV2CachedPluginVersion(slot: string): string | undefined {
    const generation = getOpenCodeV2ActiveGeneration(slot);
    if (!generation) return undefined;
    try {
        const pkg = JSON.parse(
            readFileSync(getOpenCodePluginPackageJsonPath(generation), "utf-8"),
        ) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}
