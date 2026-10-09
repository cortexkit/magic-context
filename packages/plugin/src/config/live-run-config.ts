import { log } from "../shared/logger";
import { loadPluginConfigDetailed, type MagicContextPluginConfig } from "./index";
import { LiveConfigReader } from "./live-snapshot";
import { LIVE_RELOAD_CONFIG_PATHS, type MagicContextConfig } from "./schema/magic-context";

/** Copy only schema-marked live paths from fresh config; other settings retain boot values. */
export function sampleLiveConfig<T extends MagicContextConfig>(boot: T, fresh: T): T {
    const result = { ...boot } as Record<string, unknown>;
    result.cacheTtlConfigured = fresh.cacheTtlConfigured;
    for (const path of LIVE_RELOAD_CONFIG_PATHS) {
        const parts = path.split(".");
        let value: unknown = fresh;
        for (const part of parts) value = (value as Record<string, unknown> | undefined)?.[part];
        if (value === undefined) {
            // An unset live path must not create its parent objects. An empty `omp`
            // block, for example, shadows the `pi` block it would otherwise fall back
            // to, and the historian and dreamer lose their configured model. Only
            // clear a leaf the boot config actually has, so removing a key live works.
            removeLeaf(result, parts);
            continue;
        }
        let target = result;
        for (const part of parts.slice(0, -1)) {
            const child = target[part];
            const copy =
                child && typeof child === "object" && !Array.isArray(child)
                    ? { ...(child as Record<string, unknown>) }
                    : {};
            target[part] = copy;
            target = copy;
        }
        const leaf = parts.at(-1);
        if (leaf !== undefined) target[leaf] = value;
    }
    return result as T;
}

function removeLeaf(root: Record<string, unknown>, parts: string[]): void {
    const parents = parts.slice(0, -1);
    let node: Record<string, unknown> = root;
    for (const part of parents) {
        const child = node[part];
        if (!child || typeof child !== "object" || Array.isArray(child)) return;
        node = child as Record<string, unknown>;
    }
    const leaf = parts.at(-1);
    if (leaf === undefined || !Object.hasOwn(node, leaf)) return;
    // Copy the parent chain before deleting so the boot config object is never mutated.
    let target = root;
    for (const part of parents) {
        const copy = { ...(target[part] as Record<string, unknown>) };
        target[part] = copy;
        target = copy;
    }
    delete target[leaf];
}

export function changedLiveKeys(previous: MagicContextConfig, next: MagicContextConfig): string[] {
    const at = (config: MagicContextConfig, path: string): unknown =>
        path
            .split(".")
            .reduce<unknown>(
                (node, part) => (node as Record<string, unknown> | undefined)?.[part],
                config,
            );
    return LIVE_RELOAD_CONFIG_PATHS.filter(
        (path) => JSON.stringify(at(previous, path)) !== JSON.stringify(at(next, path)),
    );
}

export const historianRunConfig = sampleLiveConfig;
export const dreamerRunConfig = sampleLiveConfig;

const pluginReaders = new Map<string, LiveConfigReader<MagicContextPluginConfig>>();

/** Shared by all OpenCode entry points for one project in this process. */
export function pluginConfigReader(directory: string, boot: MagicContextPluginConfig) {
    let reader = pluginReaders.get(directory);
    if (!reader) {
        reader = new LiveConfigReader(
            directory,
            boot,
            () => {
                const loaded = loadPluginConfigDetailed(directory, false);
                if (
                    loaded.loadOutcome === "project-file-parse-error" ||
                    loaded.loadOutcome === "project-file-io-error" ||
                    loaded.loadOutcome === "schema-recovery"
                ) {
                    throw new Error(
                        `invalid configuration: ${loaded.config.configWarnings?.join("; ") ?? loaded.loadOutcome}`,
                    );
                }
                return loaded.config;
            },
            // Into our own log file: console output lands in the host's stdout/stderr
            // (for `opencode serve`, the terminal or service log the user reads).
            (message) => log(`[config] ${message}`),
            changedLiveKeys,
        );
        reader.poll();
        pluginReaders.set(directory, reader);
    }
    return reader;
}

export function currentPluginConfigReader(directory: string) {
    return pluginReaders.get(directory);
}
