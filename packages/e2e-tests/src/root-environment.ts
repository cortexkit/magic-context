import { isAbsolute } from "node:path";

const ROOT_VARIABLES = [
    "TMPDIR", "TMP", "TEMP",
    "HOME", "USERPROFILE", "CFFIXED_USER_HOME",
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    "OPENCODE_DB", "OPENCODE_CONFIG_DIR", "PI_CODING_AGENT_DIR",
    "MAGIC_CONTEXT_STORAGE_DIR", "MAGIC_CONTEXT_TEST_DATA_DIR",
    "MC_E2E_FOUNDATION_HTTP_CACHE_DB",
] as const;

type RootEnvironment = Partial<Record<(typeof ROOT_VARIABLES)[number], string>>;

export function restoreEnvironmentVariable(key: string, previous: string | undefined, env = process.env): void {
    if (previous === undefined) delete env[key];
    else env[key] = previous;
}

export function e2eTempRoot(env = process.env): string {
    const root = env.TMPDIR;
    if (!root || root === "undefined" || !isAbsolute(root)) {
        throw new Error(`E2E TMPDIR must name an absolute throwaway root (got ${JSON.stringify(root)}); an earlier test file may have removed it or restored it incorrectly`);
    }
    return root;
}

export function snapshotRootEnvironment(env = process.env): RootEnvironment {
    return Object.fromEntries(ROOT_VARIABLES.map((key) => [key, env[key]]));
}

export function checkRootEnvironment(file: string, before: RootEnvironment, env = process.env): void {
    const changed = ROOT_VARIABLES.filter((key) => env[key] !== before[key]);
    if (changed.length === 0) return;
    // Attribute the failure to this file, then keep the next file's roots safe.
    for (const key of changed) restoreEnvironmentVariable(key, before[key], env);
    throw new Error(`${file} did not restore E2E root environment: ${changed.join(", ")}`);
}
