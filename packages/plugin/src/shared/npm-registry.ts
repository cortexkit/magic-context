import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export interface NpmRegistryOptions {
    /** Package name. A scoped package honors `@scope:registry`. */
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

function firstSet(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed) return trimmed;
    }
    return undefined;
}

/** npm's user config: npm_config_userconfig or NPM_CONFIG_USERCONFIG, else ~/.npmrc. */
export function resolveUserNpmrcPath(env: NodeJS.ProcessEnv = process.env): string {
    return (
        firstSet(env.npm_config_userconfig, env.NPM_CONFIG_USERCONFIG) ??
        join(env.HOME?.trim() || homedir(), ".npmrc")
    );
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

/**
 * Decode an ini value as npm's `ini` parser does: a fully quoted value is
 * taken literally, otherwise an unescaped `;` or `#` starts a comment and
 * `\;`, `\#` and `\\` are escapes.
 */
function decodeIniValue(value: string): string {
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
        if (value[0] === '"') {
            try {
                return JSON.parse(value) as string;
            } catch {}
        }
        return value.slice(1, -1);
    }
    let decoded = "";
    let escaping = false;
    for (const char of value) {
        if (escaping) {
            decoded += "\\;#".includes(char) ? char : `\\${char}`;
            escaping = false;
        } else if (char === ";" || char === "#") {
            break;
        } else if (char === "\\") {
            escaping = true;
        } else {
            decoded += char;
        }
    }
    return (escaping ? `${decoded}\\` : decoded).trim();
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
        const value = expandEnv(decodeIniValue(line.slice(separator + 1).trim()), env)?.trim();
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
 * Select the registry for a metadata check from the environment, then the
 * user's .npmrc, then public npm. Within each source, a registry for the
 * package's scope takes priority over the default registry. A repository's
 * project .npmrc and npm's global config are deliberately not read: the
 * check runs automatically, and a cloned repository must not choose where it
 * goes.
 */
export function resolveNpmRegistryUrl(
    env: NodeJS.ProcessEnv = process.env,
    options: NpmRegistryOptions = {},
): string {
    const read = options.readFile ?? readTextFile;
    const scope = packageScope(options.packageName);
    const sources: Array<() => RegistryKeys> = [
        () => ({
            registry: firstSet(env.npm_config_registry, env.NPM_CONFIG_REGISTRY),
            scoped:
                scope === null
                    ? undefined
                    : firstSet(
                          env[`npm_config_${scope}:registry`],
                          env[`NPM_CONFIG_${scope}:registry`],
                      ),
        }),
        () => readRegistryKeys(read(resolveUserNpmrcPath(env)), scope, env),
    ];
    for (const source of sources) {
        const keys = source();
        const selected = keys.scoped || keys.registry;
        if (selected) return selected.replace(/\/+$/, "");
    }
    return NPM_REGISTRY_URL;
}
