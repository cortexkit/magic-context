/**
 * Doctor check for the single Magic Context registration in the OpenCode
 * config: add it when missing, move a versionless entry to `@latest`, and
 * (under `--force`) move a version-pinned entry to `@latest`.
 *
 * Entries come in three shapes and every one must survive a rewrite with its
 * options intact:
 *   • a string                 "@cortexkit/opencode-magic-context@latest"
 *   • a tuple (OpenCode 1.x)    ["@cortexkit/opencode-magic-context@latest", { ...options }]
 *   • an object (OpenCode 2)    { package: "@cortexkit/opencode-magic-context@latest", options: { ... } }
 * plus local development paths, which are detected so `@latest` is not added
 * next to them but are never replaced, even under `--force`.
 */
import { isDevPathPluginEntry, matchesPluginEntry, pluginEntryPackage } from "../adapters/opencode";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    type OpenCodePluginConfigKey,
    readPluginEntries,
} from "../lib/opencode-plugin-registration";

/** True for an explicit version or tag other than `@latest`. */
export function isPinnedOpenCodePluginSpecifier(specifier: string): boolean {
    if (specifier === OPENCODE_PLUGIN_NAME || specifier === OPENCODE_PLUGIN_ENTRY_WITH_VERSION) {
        return false;
    }
    return specifier.startsWith(`${OPENCODE_PLUGIN_NAME}@`);
}

/**
 * The same entry pointing at `specifier`, keeping its shape and every other
 * field (tuple options, object options, and any other object keys).
 */
export function withPluginEntrySpecifier(entry: unknown, specifier: string): unknown {
    if (Array.isArray(entry) && entry.length >= 1) {
        const replacement = [...entry];
        replacement[0] = specifier;
        return replacement;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        return { ...(entry as Record<string, unknown>), package: specifier };
    }
    return specifier;
}

export interface PluginEntryCheckReporter {
    pass(message: string): void;
    warn(message: string): void;
    /** A change doctor made; counted as fixed. */
    fixed(message: string): void;
    /** Report that a pinned entry stops the auto-updater from moving. */
    autoUpdateStall(specifier: string): void;
}

export function isOpenCodePluginRegistered(
    config: Record<string, unknown>,
    configDir: string,
): boolean {
    return readPluginEntries(config).some(
        ({ entry }) =>
            matchesPluginEntry(entry, OPENCODE_PLUGIN_NAME) ||
            isDevPathPluginEntry(entry, configDir),
    );
}

/**
 * Check the Magic Context entry in a parsed config and apply the change in
 * place. Returns true when `config` changed and must be written back.
 */
export function checkOpenCodePluginEntry(
    config: Record<string, unknown>,
    configName: string,
    options: {
        force?: boolean;
        registrationKey: OpenCodePluginConfigKey;
        /** Directory of the config file, which relative checkout paths resolve against. */
        configDir: string;
    },
    report: PluginEntryCheckReporter,
): boolean {
    const allEntries = readPluginEntries(config);
    const found = allEntries.find(
        ({ entry }) =>
            matchesPluginEntry(entry, OPENCODE_PLUGIN_NAME) ||
            isDevPathPluginEntry(entry, options.configDir),
    );

    if (!found) {
        // A fresh registration goes under the running host's own key.
        const key = options.registrationKey;
        const list: unknown[] = Array.isArray(config[key]) ? (config[key] as unknown[]) : [];
        list.push(OPENCODE_PLUGIN_ENTRY_WITH_VERSION);
        config[key] = list;
        report.fixed(`Added plugin to ${configName}`);
        return true;
    }

    const list = config[found.key] as unknown[];
    const specifier = pluginEntryPackage(found.entry) ?? "";

    if (specifier === OPENCODE_PLUGIN_ENTRY_WITH_VERSION) {
        report.pass(`Plugin registered in ${configName}`);
        return false;
    }
    if (isDevPathPluginEntry(found.entry, options.configDir)) {
        report.pass(`Plugin registered in ${configName} (dev path: ${specifier})`);
        return false;
    }
    if (isPinnedOpenCodePluginSpecifier(specifier) && !options.force) {
        report.autoUpdateStall(specifier);
        report.warn(
            `Plugin pinned to ${specifier} in ${configName} — use 'doctor --force' to upgrade`,
        );
        return false;
    }

    // A versionless entry always moves to @latest; a pinned one only under --force.
    list[found.index] = withPluginEntrySpecifier(found.entry, OPENCODE_PLUGIN_ENTRY_WITH_VERSION);
    report.fixed(
        `Upgraded plugin entry in ${configName}: ${specifier} → ${OPENCODE_PLUGIN_ENTRY_WITH_VERSION}`,
    );
    return true;
}
