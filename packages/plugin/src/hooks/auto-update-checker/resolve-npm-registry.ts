import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NPM_REGISTRY_URL } from "./constants";

/**
 * Resolves the npm registry the update check should query.
 *
 * The checker used to hardcode registry.npmjs.org, which broke behind
 * registries an operator configures for npm/Bun (mirrors, private proxies):
 * installs already honor the configured registry because the spawned package
 * manager reads the .npmrc chain itself, only the check bypassed it.
 *
 * Resolution order mirrors npm's own precedence:
 *   1. `npm_config_registry` in the environment (npm and bun both export it
 *      to child processes when a registry is configured).
 *   2. `registry = <url>` in the project `.npmrc` (the OpenCode project
 *      directory).
 *   3. `registry = <url>` in the user `.npmrc`.
 *   4. The public default.
 *
 * Never throws: an unreadable or malformed .npmrc fails open to the next
 * source, so a broken config cannot take the update check down.
 */
export function resolveNpmRegistry(projectDir: string | null | undefined): string {
    const fromEnv = process.env.npm_config_registry?.trim();
    if (fromEnv) return normalizeRegistryUrl(fromEnv);

    for (const npmrcPath of npmrcCandidates(projectDir)) {
        const fromNpmrc = readRegistryFromNpmrc(npmrcPath);
        if (fromNpmrc) return normalizeRegistryUrl(fromNpmrc);
    }

    return NPM_REGISTRY_URL;
}

function npmrcCandidates(projectDir: string | null | undefined): string[] {
    const candidates: string[] = [];
    if (projectDir) candidates.push(join(projectDir, ".npmrc"));
    if (process.env.HOME) candidates.push(join(process.env.HOME, ".npmrc"));
    if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, ".npmrc"));
    return candidates;
}

/**
 * Extracts the `registry` value from an .npmrc-style file. Only the
 * top-level `registry` key matters here; scoped-registry keys
 * (`@scope:registry`) configure publication targets, not the package
 * metadata source for a specific package name.
 */
function readRegistryFromNpmrc(npmrcPath: string): string | null {
    if (!existsSync(npmrcPath)) return null;
    try {
        const lines = readFileSync(npmrcPath, "utf-8").split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(";") || line.startsWith("#")) continue;
            const match = /^registry\s*=\s*(\S+)\s*$/.exec(line);
            if (match?.[1]) return match[1];
        }
    } catch {
        return null;
    }
    return null;
}

function normalizeRegistryUrl(url: string): string {
    return url.replace(/\/+$/, "");
}
