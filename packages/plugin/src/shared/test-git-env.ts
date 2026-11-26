import { devNull } from "node:os";

/** Keep caller config, hooks, and repository paths out of fixture Git commands. */
export function isolatedTestGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    }
    return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", ...overrides };
}
