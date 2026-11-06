import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export interface NpmRegistryOptions {
    /** Directory used to find the project .npmrc. Defaults to the process cwd. */
    cwd?: string;
    /** Package name. A scoped package honors `@scope:registry` as npm does. */
    packageName?: string;
    /** Test seam: returns file contents, or null when the file is unreadable. */
    readFile?: (path: string) => string | null;
}

type RegistryKeys = { registry?: string; scoped?: string };

function readTextFile(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

/** npm's user config: NPM_CONFIG_USERCONFIG, else ~/.npmrc. */
export function resolveUserNpmrcPath(env: NodeJS.ProcessEnv = process.env): string {
    const custom = env.npm_config_userconfig?.trim() || env.NPM_CONFIG_USERCONFIG?.trim();
    if (custom) return custom;
    return join(env.HOME?.trim() || homedir(), ".npmrc");
}

/**
 * npm's project config lives in its local prefix: the nearest ancestor with a
 * package.json or node_modules, or the starting directory when there is none.
 */
export function resolveProjectNpmrcPath(cwd: string): string {
    let directory = cwd;
    while (true) {
        if (
            existsSync(join(directory, "package.json")) ||
            existsSync(join(directory, "node_modules"))
        ) {
            return join(directory, ".npmrc");
        }
        const parent = dirname(directory);
        if (parent === directory) return join(cwd, ".npmrc");
        directory = parent;
    }
}

/** Replace ${VAR} as npm does. An unset variable makes the value unusable. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string | null {
    let missing = false;
    const expanded = value.replace(
        /(\\*)\$\{([^}?]+)(\?)?\}/g,
        (match, escapes, name, optional) => {
            if (escapes.length % 2 === 1) return match.slice(1);
            const replacement = env[name];
            if (replacement === undefined && !optional) missing = true;
            return `${escapes}${replacement ?? ""}`;
        },
    );
    return missing ? null : expanded;
}

function unquote(value: string): string {
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Read only the registry keys from an .npmrc. Other keys, including auth
 * tokens, are never retained or reported.
 */
function readRegistryKeys(
    text: string | null,
    scope: string | null,
    env: NodeJS.ProcessEnv,
): RegistryKeys {
    const keys: RegistryKeys = {};
    if (text === null) return keys;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        const isRegistry = key === "registry";
        const isScoped = scope !== null && key === `${scope}:registry`;
        if (!isRegistry && !isScoped) continue;
        const value = expandEnv(unquote(line.slice(separator + 1).trim()), env)?.trim();
        if (!value) continue;
        if (isRegistry) keys.registry = value;
        else keys.scoped = value;
    }
    return keys;
}

function packageScope(packageName: string | undefined): string | null {
    if (!packageName?.startsWith("@")) return null;
    const slash = packageName.indexOf("/");
    return slash > 1 ? packageName.slice(0, slash) : null;
}

/**
 * Select the registry npm would use, without running npm: the environment,
 * then the project .npmrc, then the user .npmrc, then public npm. As in npm,
 * each key resolves through those layers and a scoped registry for the
 * package's scope takes priority over the default registry.
 */
export function resolveNpmRegistryUrl(
    env: NodeJS.ProcessEnv = process.env,
    options: NpmRegistryOptions = {},
): string {
    const read = options.readFile ?? readTextFile;
    const scope = packageScope(options.packageName);
    const layers: RegistryKeys[] = [
        {
            registry:
                env.npm_config_registry?.trim() || env.NPM_CONFIG_REGISTRY?.trim() || undefined,
        },
        readRegistryKeys(read(resolveProjectNpmrcPath(options.cwd ?? process.cwd())), scope, env),
        readRegistryKeys(read(resolveUserNpmrcPath(env)), scope, env),
    ];
    const scoped = layers.find((layer) => layer.scoped)?.scoped;
    const registry = layers.find((layer) => layer.registry)?.registry;
    return (scoped || registry || NPM_REGISTRY_URL).replace(/\/+$/, "");
}
